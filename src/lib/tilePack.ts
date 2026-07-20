/**
 * City tile packs (v336).
 *
 * A "city pack" is a small self-contained PMTiles archive — the master
 * basemap `pmtiles extract`ed over one play area's bbox at z0..15. The
 * client downloads it WHOLE (one request), holds it in memory, and
 * serves basemap tiles from it with zero per-tile network. This
 * replaces the map-preload bucket's thousands of byte-range requests
 * (Trondheim planned 6,621 tiles at z13 alone) with a single ~10-40 MB
 * download.
 *
 * Why a custom MapLibre protocol rather than just pointing the source
 * at the pack: a pack only covers the city bbox + zoom range, so a
 * seeker who pans outside it (or zooms past z15) would see blank tiles.
 * The `jlhsmerge://` protocol here serves PACK-FIRST then falls back to
 * the MASTER archive for anything the pack doesn't have — so coverage
 * is never worse than today, only faster inside the city.
 *
 * Safety model: the merge scheme is only used by the style when a pack
 * is actually active (see protomapsStyle.ts). With no pack the existing
 * `pmtiles://` path runs untouched, so the default render path for
 * non-curated cities / pre-pack deploys is byte-identical to before.
 * Even when a pack IS active, every uncertain branch (pack miss, pack
 * error, out-of-zoom) falls through to the master, so a bad pack can
 * only fail to accelerate — never blank the map.
 *
 * This module owns NO React state beyond the `activeTilePackId` atom
 * (which the style reads to pick the scheme). The master/pack PMTiles
 * handles are plain module-level refs consulted by the protocol.
 */

import maplibregl from "maplibre-gl";
import { atom } from "nanostores";
import { PMTiles, type RangeResponse, type Source } from "pmtiles";

import { mapGeoLocation } from "@/lib/context";
import { lastPreloadDiag } from "@/lib/debugState";
import { TILE_PACK_BASE } from "@/maps/api/constants";

/** Custom MapLibre protocol scheme. Style source URLs of the form
 *  `jlhsmerge://<masterUrl>` resolve through `mergeTileHandler`. */
export const MERGE_SCHEME = "jlhsmerge";

/**
 * OSM relation id of the currently-active pack, or null when none.
 * The map style reads this (`useStore`) to decide whether to build its
 * basemap source with the merge scheme. Flipping it triggers a single
 * style rebuild — done intentionally only once, when a pack finishes
 * downloading during the hiding-period preload.
 */
export const activeTilePackId = atom<number | null>(null);

/* ── Protocol internals (not reactive UI state) ────────────────────── */

interface ActivePack {
    osmId: number;
    pmtiles: PMTiles;
    minZoom: number;
    maxZoom: number;
}

let masterPMTiles: PMTiles | null = null;
let masterUrl: string | null = null;
let activePack: ActivePack | null = null;

/** Lazily (re)build the master PMTiles handle for a given master URL.
 *  The merge protocol learns the master URL from the style source URL,
 *  so we don't need it injected up front. */
function ensureMaster(url: string): PMTiles {
    if (!masterPMTiles || masterUrl !== url) {
        masterPMTiles = new PMTiles(url);
        masterUrl = url;
    }
    return masterPMTiles;
}

/** In-memory pmtiles Source over a downloaded ArrayBuffer. `getBytes`
 *  slices the buffer — copies are tiny (a tile is ~10 KB, a directory
 *  a few KB) so this is cheap. The whole buffer stays referenced while
 *  the pack is active and is released by `clearTilePack`. */
class BufferSource implements Source {
    constructor(
        private buf: ArrayBuffer,
        private key: string,
    ) {}
    getKey(): string {
        return this.key;
    }
    async getBytes(offset: number, length: number): Promise<RangeResponse> {
        return { data: this.buf.slice(offset, offset + length) };
    }
}

let mergeRegistered = false;

/**
 * Register the `jlhsmerge://` protocol with MapLibre. Idempotent.
 * Mirrors the pmtiles library's own `Protocol.tilev4` minimal form
 * (no metadata read — our basemap style layers carry `source-layer`
 * names, so the tilejson doesn't need `vector_layers`), with a
 * pack-first lookup wedged in front of the master.
 */
export function registerMergeProtocol(): void {
    if (mergeRegistered) return;
    maplibregl.addProtocol(MERGE_SCHEME, async (params, abortController) => {
        // params.url: "jlhsmerge://<masterUrl>" (tilejson) or
        //             "jlhsmerge://<masterUrl>/{z}/{x}/{y}" (tile).
        const body = params.url.slice(MERGE_SCHEME.length + 3); // strip scheme://
        const tileMatch = body.match(/^(.+)\/(\d+)\/(\d+)\/(\d+)$/);

        if (!tileMatch) {
            // TileJSON request. Return the same minimal shape the
            // pmtiles Protocol returns in non-metadata mode, with the
            // MASTER's zoom range + bounds so MapLibre requests tiles
            // across the whole world and the per-tile handler decides
            // pack-vs-master.
            const master = ensureMaster(body);
            const h = await master.getHeader();
            abortController.signal.throwIfAborted();
            return {
                data: {
                    tiles: [`${params.url}/{z}/{x}/{y}`],
                    minzoom: h.minZoom,
                    maxzoom: h.maxZoom,
                    bounds: [h.minLon, h.minLat, h.maxLon, h.maxLat],
                },
            };
        }

        const mUrl = tileMatch[1];
        const z = Number(tileMatch[2]);
        const x = Number(tileMatch[3]);
        const y = Number(tileMatch[4]);
        const master = ensureMaster(mUrl);

        // Pack-first. getZxy returns undefined (no throw) for
        // out-of-zoom / out-of-bbox tiles, so a city pack naturally
        // declines anything it doesn't hold and we fall through.
        const pack = activePack;
        if (pack && z >= pack.minZoom && z <= pack.maxZoom) {
            try {
                const r = await pack.pmtiles.getZxy(
                    z,
                    x,
                    y,
                    abortController.signal,
                );
                if (r) {
                    return {
                        data: new Uint8Array(r.data),
                        cacheControl: r.cacheControl,
                        expires: r.expires,
                    };
                }
            } catch (e) {
                if ((e as Error)?.name === "AbortError") throw e;
                // Any other pack error: fall through to master so a
                // corrupt/partial pack can never blank a tile.
            }
        }

        const r = await master.getZxy(z, x, y, abortController.signal);
        if (r) {
            return {
                data: new Uint8Array(r.data),
                cacheControl: r.cacheControl,
                expires: r.expires,
            };
        }
        // Missing everywhere → empty vector tile (MapLibre renders
        // blank, same as the stock pmtiles protocol's behaviour).
        return { data: new Uint8Array() };
    });
    mergeRegistered = true;
}

export type TilePackLoadStatus =
    | "loaded"
    | "absent"
    | "skipped"
    | "error";

export interface TilePackLoadResult {
    status: TilePackLoadStatus;
    osmId?: number;
    bytes?: number;
}

/** Build the pack URL for an OSM relation id. */
export function tilePackUrl(osmId: number): string {
    return `${TILE_PACK_BASE}/${osmId}.pmtiles`;
}

/**
 * Look up the on-disk byte size of the city pack for an OSM relation,
 * WITHOUT downloading it — a HEAD (falling back to a 1-byte range read
 * of `Content-Range`) so the lobby can show a real "~N MB" preload
 * estimate. Returns the byte count, or `null` when there's no pack for
 * this city (404), the size can't be read, or the request fails. Cheap
 * and abortable; safe to call speculatively.
 */
export async function fetchTilePackBytes(
    osmId: number,
    signal?: AbortSignal,
): Promise<number | null> {
    const url = tilePackUrl(osmId);
    try {
        const head = await fetch(url, { method: "HEAD", signal });
        if (head.status === 404) return null;
        if (head.ok) {
            const len = Number(head.headers.get("Content-Length"));
            if (Number.isFinite(len) && len > 0) return len;
        }
        // Some hosts don't answer HEAD with a length — read the total
        // from a 1-byte range response's `Content-Range: bytes 0-0/<total>`.
        const range = await fetch(url, {
            headers: { Range: "bytes=0-0" },
            signal,
        });
        if (range.status === 404) return null;
        const cr = range.headers.get("Content-Range");
        if (cr) {
            const total = Number(cr.split("/")[1]);
            if (Number.isFinite(total) && total > 0) return total;
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * Download + activate the city pack for the current play area, if one
 * exists. Returns:
 *   - "skipped"  — play area isn't an OSM relation (custom polygon),
 *                  or the pack for this area is already active.
 *   - "absent"   — no pack uploaded for this city (404). Expected for
 *                  non-curated areas; caller falls back to the range
 *                  walk preload.
 *   - "loaded"   — pack downloaded + active; the live map now serves
 *                  city tiles from it.
 *   - "error"    — network/parse failure; caller falls back.
 *
 * `onProgress(loaded, total)` fires while streaming so the preload UI
 * can show a real download bar.
 */
export async function loadTilePackForPlayArea(opts?: {
    onProgress?: (loaded: number, total: number | null) => void;
    signal?: AbortSignal;
}): Promise<TilePackLoadResult> {
    const loc = mapGeoLocation.get();
    const osmIdRaw = (loc?.properties as { osm_id?: number | string })?.osm_id;
    const osmType = (loc?.properties as { osm_type?: string })?.osm_type;
    // Packs are keyed on OSM relation ids; custom-drawn polygons and
    // node/way play areas can't have one.
    if (osmIdRaw === undefined || osmIdRaw === null || osmType !== "R") {
        return { status: "skipped" };
    }
    const osmId = Number(osmIdRaw);
    if (!Number.isFinite(osmId)) return { status: "skipped" };

    // Already active for this exact play area — nothing to do.
    if (activePack && activePack.osmId === osmId) {
        return { status: "loaded", osmId, bytes: 0 };
    }

    const url = tilePackUrl(osmId);
    try {
        const dl = await downloadPackRanged(url, opts?.onProgress, opts?.signal);
        if (!dl.ok) {
            if (dl.status === 404) {
                // No pack for this city. Make sure we're not holding a
                // stale pack from a previous play area.
                clearTilePack();
                return { status: "absent" };
            }
            return { status: "error" };
        }
        const buf = dl.buffer;
        const pmtiles = new PMTiles(new BufferSource(buf, url));
        const h = await pmtiles.getHeader();
        // Swap in the new pack, then flip the atom so the style
        // rebuilds with the pack already available to the protocol.
        activePack = {
            osmId,
            pmtiles,
            minZoom: h.minZoom,
            maxZoom: h.maxZoom,
        };
        activeTilePackId.set(osmId);
        return { status: "loaded", osmId, bytes: buf.byteLength };
    } catch (e) {
        if ((e as Error)?.name === "AbortError") return { status: "skipped" };
        console.warn("[tilePack] load failed:", e);
        return { status: "error" };
    }
}

/** Drop the active pack (frees the in-memory archive) and revert the
 *  style to the plain master source on the next rebuild. Safe to call
 *  when no pack is active. */
export function clearTilePack(): void {
    activePack = null;
    if (activeTilePackId.get() !== null) {
        activeTilePackId.set(null);
    }
}

/** Read a Response body to an ArrayBuffer, reporting progress against
 *  Content-Length when a progress callback is supplied. Falls back to
 *  `resp.arrayBuffer()` when there's no body stream or no callback. */
async function readBodyWithProgress(
    resp: Response,
    total: number | null,
    onProgress?: (loaded: number, total: number | null) => void,
): Promise<ArrayBuffer> {
    if (!resp.body || !onProgress) {
        return resp.arrayBuffer();
    }
    const reader = resp.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
            chunks.push(value);
            received += value.length;
            onProgress(received, total);
        }
    }
    const out = new Uint8Array(received);
    let offset = 0;
    for (const c of chunks) {
        out.set(c, offset);
        offset += c.length;
    }
    return out.buffer;
}

/** Per-request byte span for the chunked pack download (below). */
const PACK_CHUNK_BYTES = 8 * 1024 * 1024; // 8 MB
/** v1033: how many times to retry a single failed chunk before giving up.
 *  A big city pack pages in many chunks (London ≈ 129 MB = ~16), so on mobile
 *  5G the odds of at least ONE transient chunk failure across the run are high
 *  — and a single failure used to abort the WHOLE download to the slow z12
 *  range walk (the reported London flakiness). Retrying each chunk makes the
 *  download survive a blip. */
const PACK_CHUNK_RETRIES = 3;

/** Fetch one byte range, retrying on a transient failure (network throw or a
 *  non-206/200 status). Rejects (never resolves non-ok) only after exhausting
 *  the retries, so the caller can decide to fall back. Honours abort. */
async function fetchChunkWithRetry(
    url: string,
    start: number,
    end: number,
    signal: AbortSignal | undefined,
    onAttemptFail: (attempt: number, reason: string) => void,
): Promise<Uint8Array> {
    let lastReason = "unknown";
    for (let attempt = 1; attempt <= PACK_CHUNK_RETRIES; attempt++) {
        if (signal?.aborted) throw new DOMException("aborted", "AbortError");
        try {
            const resp = await fetch(url, {
                signal,
                headers: { Range: `bytes=${start}-${end}` },
            });
            if (resp.status === 206 || resp.status === 200) {
                return new Uint8Array(await resp.arrayBuffer());
            }
            lastReason = `status ${resp.status}`;
        } catch (e) {
            if ((e as Error)?.name === "AbortError") throw e;
            lastReason = (e as Error)?.message ?? "fetch threw";
        }
        onAttemptFail(attempt, lastReason);
        if (attempt < PACK_CHUNK_RETRIES) {
            // Small backoff before the retry (200ms, 400ms).
            await new Promise((r) => setTimeout(r, 200 * attempt));
        }
    }
    throw new Error(`chunk ${start}-${end} failed after ${PACK_CHUNK_RETRIES}: ${lastReason}`);
}

/**
 * Download a full tile pack via BOUNDED RANGED requests instead of one
 * whole-object GET.
 *
 * Why: the worker's `/tiles/<key>` route serves a whole-object
 * `env.TILES.get(key)` (no range) by streaming the R2 body — but for a LARGE
 * multipart-uploaded pack (a big city like NYC/London, ~100+ MB) that non-ranged
 * get throws inside R2 and the worker returns 503 ("R2 unreachable"), so the
 * plain `fetch(url)` failed and the preloader fell back to the slow per-tile
 * range walk. The LIVE map never hit this because the pmtiles protocol only ever
 * issues small byte-RANGE reads — which the worker's ranged path
 * (`env.TILES.get(key, {range})`) serves fine. So we download the whole pack
 * the same proven way: a first `bytes=0-N` request learns the total from
 * `Content-Range`, then we page the rest in `PACK_CHUNK_BYTES` chunks and
 * assemble one buffer. A server that ignores the range (small pack → 200)
 * degrades to a straight whole-body read.
 *
 * v1033: each chunk RETRIES on a transient failure (`fetchChunkWithRetry`), and
 * the whole run reports a diagnostic (total, chunk count, retries, failure) to
 * `lastPreloadDiag` + the `[preload]` console, so a big-city download surviving
 * (or failing at) a 5G blip is visible on-device.
 */
async function downloadPackRanged(
    url: string,
    onProgress?: (loaded: number, total: number | null) => void,
    signal?: AbortSignal,
): Promise<
    { ok: true; buffer: ArrayBuffer } | { ok: false; status: 404 | "error" }
> {
    let retries = 0;
    const noteRetry = (chunkStart: number, attempt: number, reason: string) => {
        retries++;
        console.warn(
            `[preload] pack chunk @${chunkStart} retry ${attempt}/${PACK_CHUNK_RETRIES}: ${reason}`,
        );
    };
    const first = await fetch(url, {
        signal,
        headers: { Range: `bytes=0-${PACK_CHUNK_BYTES - 1}` },
    });
    if (first.status === 404) return { ok: false, status: 404 };
    // Server ignored the Range (small pack / no range support) — read whole.
    if (first.status === 200) {
        if (!first.ok) return { ok: false, status: "error" };
        const total = Number(first.headers.get("Content-Length")) || null;
        const buffer = await readBodyWithProgress(first, total, onProgress);
        lastPreloadDiag.set(
            `map pack ok (whole-body, ${(buffer.byteLength / 1e6).toFixed(1)} MB)`,
        );
        return { ok: true, buffer };
    }
    if (first.status !== 206) return { ok: false, status: "error" };

    // "bytes START-END/TOTAL" → TOTAL.
    const cr = first.headers.get("Content-Range");
    const total = cr ? Number(/\/(\d+)\s*$/.exec(cr)?.[1]) : NaN;
    const firstChunk = new Uint8Array(await first.arrayBuffer());
    if (!Number.isFinite(total) || total <= 0) {
        // No usable total — return what we got (a single sub-chunk pack).
        return { ok: true, buffer: firstChunk.buffer };
    }

    const chunkCount = Math.ceil(total / PACK_CHUNK_BYTES);
    console.debug(
        `[preload] pack ranged download: ${(total / 1e6).toFixed(1)} MB in ${chunkCount} chunks`,
    );
    const out = new Uint8Array(total);
    out.set(firstChunk, 0);
    let received = firstChunk.length;
    onProgress?.(received, total);

    try {
        while (received < total) {
            const start = received;
            const end = Math.min(start + PACK_CHUNK_BYTES, total) - 1;
            const chunk = await fetchChunkWithRetry(
                url,
                start,
                end,
                signal,
                (attempt, reason) => noteRetry(start, attempt, reason),
            );
            if (chunk.length === 0) break; // guard against a stuck loop at EOF
            out.set(chunk, received);
            received += chunk.length;
            onProgress?.(received, total);
        }
    } catch (e) {
        if ((e as Error)?.name === "AbortError") throw e;
        // A chunk failed even after retries — fall back to the range walk.
        lastPreloadDiag.set(
            `map pack FELL BACK: ${(total / 1e6).toFixed(1)} MB pack, got ${(received / 1e6).toFixed(1)} MB, ${retries} retries, then ${(e as Error)?.message ?? "chunk failed"}`,
        );
        console.warn("[preload] pack download failed after retries:", e);
        return { ok: false, status: "error" };
    }
    lastPreloadDiag.set(
        `map pack ok (${(total / 1e6).toFixed(1)} MB, ${chunkCount} chunks, ${retries} retries)`,
    );
    return { ok: true, buffer: out.buffer };
}
