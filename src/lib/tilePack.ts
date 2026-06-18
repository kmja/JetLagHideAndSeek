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
        const resp = await fetch(url, { signal: opts?.signal });
        if (resp.status === 404) {
            // No pack for this city. Make sure we're not holding a
            // stale pack from a previous play area.
            clearTilePack();
            return { status: "absent" };
        }
        if (!resp.ok) {
            return { status: "error" };
        }
        const total = Number(resp.headers.get("Content-Length")) || null;
        const buf = await readBodyWithProgress(
            resp,
            total,
            opts?.onProgress,
        );
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
