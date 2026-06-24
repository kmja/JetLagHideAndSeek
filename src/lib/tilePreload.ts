import * as turf from "@turf/turf";
import type { FeatureCollection, MultiPolygon, Polygon } from "geojson";
import {
    FetchSource,
    PMTiles,
    type RangeResponse,
    type Source,
} from "pmtiles";

import { recordBytes } from "@/lib/bandwidthMeter";
import { mapGeoLocation, polyGeoJSON } from "@/lib/context";
import { preloadMapProgress } from "@/lib/gameSetup";
import { pmtilesUrl } from "@/lib/protomapsStyle";

/**
 * Pre-fetch the basemap PMTiles ranges for the play-area bbox at the
 * gameplay-relevant zoom levels.
 *
 * Why this exists: the basemap is a single 127 GB PMTiles file on R2.
 * The `pmtiles://` maplibre protocol fetches only the byte ranges for
 * the current viewport's tiles, on demand — great for cold start,
 * miserable for the user who already "preloaded the map" but then sees
 * a fresh batch of range fetches the first time they zoom in.
 *
 * The fix is to do that fetch up front: walk every tile inside the
 * play-area bbox at z11..z14 (and z15 for smaller areas) and issue the
 * same range request the live map would later. The service worker's
 * PMTiles range cache (see `sw.ts`) persists each `bytes=…` response
 * under a synthetic key, so once a range is walked it's stored durably
 * and every subsequent zoom paints from Cache Storage with zero network
 * round-trips. (We used to lean on the browser's native HTTP cache for
 * this, but it persists 206 partial responses unreliably — mobile Chrome
 * especially — so "preloaded" tiles kept getting re-fetched.)
 *
 * Wire-byte honesty: we wrap pmtiles' FetchSource in a counting shim
 * so the bandwidth meter (and the "Downloaded — XX MB" label on the
 * Map preload bucket) reports actual wire bytes — directory + tiles
 * combined — instead of decompressed in-memory size.
 *
 * Bounded: each zoom level caps at MAX_TILES_PER_ZOOM. A country-scale
 * play area at z15 would otherwise be tens of thousands of tiles — the
 * cap means we degrade to overview-only coverage for huge areas
 * (preloading street-detail for an entire country isn't useful anyway,
 * the seeker zooms to specific cities).
 */

const DEFAULT_MIN_ZOOM = 11;
const DEFAULT_MAX_ZOOM = 15;
/**
 * Per-zoom tile cap. The user-visible street zoom is z15 (PMTiles
 * source ceiling — everything above oversamples from z15), so this is
 * the level the user feels most when it's missing. v262 set the cap at
 * 2,500 which busted on the first major-metro test: London is ~4,800
 * tiles at z15, so the entire street zoom was skipped and the live map
 * fell back to on-demand range requests the moment the user zoomed in.
 *
 * v263: 8,000 comfortably covers London / São Paulo / Tokyo admin
 * extents and any city we curate. Country-scale bboxes still skip
 * deep zooms — preloading street detail across a whole country would
 * be tens of MB of throwaway and the seeker zooms to specific cities
 * on demand anyway.
 */
const MAX_TILES_PER_ZOOM = 8000;
/** HTTP/2 multiplexes well past 100 streams over a single connection,
 *  so the practical ceiling isn't the per-origin connection cap —
 *  it's the user's bandwidth (a city's worth of 10-30 KB tiles
 *  saturates a typical mobile pipe well before this number),
 *  browser-internal request scheduling (Firefox/Chrome queue past
 *  ~20-30 in flight), and the worker's R2-range-read cost
 *  (~5-10 ms each). 32 sits comfortably inside all three: short
 *  preload wall-clock on a fast connection, no benefit from pushing
 *  higher in my testing. Past ~64 measurements stop improving
 *  altogether. */
// v470: dropped 32 → 6. At 32-way concurrency the preload saturated the
// connection to the PMTiles archive and starved the LIVE map's own range
// requests for the same archive — they'd abort (NS_BINDING_ABORTED),
// the basemap watchdog saw "no tiles in the grace window", and (before
// v470's fallback fix) flipped every map to the 404 demo bucket. Even
// with that flip gone, a flood of aborted live fetches makes the visible
// map paint late. 6 leaves comfortable headroom for the live map while
// still preloading in the background; the preload just takes a bit
// longer, which is invisible (it runs during the lobby / hiding period).
const CONCURRENCY = 6;

/** Web Mercator: lng/lat → tile XY at a given integer zoom. */
function lngLatToTile(
    lng: number,
    lat: number,
    z: number,
): [number, number] {
    const n = Math.pow(2, z);
    const x = Math.floor(((lng + 180) / 360) * n);
    const latRad = (lat * Math.PI) / 180;
    const y = Math.floor(
        ((1 -
            Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) /
                Math.PI) /
            2) *
            n,
    );
    return [
        Math.max(0, Math.min(n - 1, x)),
        Math.max(0, Math.min(n - 1, y)),
    ];
}

function tilesInBbox(
    bbox: [number, number, number, number],
    z: number,
): Array<[number, number, number]> {
    const [minLng, minLat, maxLng, maxLat] = bbox;
    const [x0, y0] = lngLatToTile(minLng, maxLat, z); // top-left
    const [x1, y1] = lngLatToTile(maxLng, minLat, z); // bottom-right
    const out: Array<[number, number, number]> = [];
    for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
            out.push([z, x, y]);
        }
    }
    return out;
}

/** Inverse of `lngLatToTile`: tile XY at integer zoom → top-left lng/lat
 *  corner. Used to compute a tile's bbox for polygon-intersection
 *  filtering in `clipTilesToPolygon`. */
function tileToLngLat(x: number, y: number, z: number): [number, number] {
    const n = Math.pow(2, z);
    const lng = (x / n) * 360 - 180;
    const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
    const lat = (latRad * 180) / Math.PI;
    return [lng, lat];
}

/**
 * Drop tiles whose own bbox doesn't touch the play polygon. Big
 * irregular play areas (coastal cities, river deltas) have many tiles
 * inside the bounding rectangle but outside the actual polygon —
 * Trondheim fits in ~half a giant rectangular bbox once you exclude
 * the fjord + outlying water — so this often cuts the per-zoom count
 * by 30-60 % on the kinds of areas that were slowest to preload.
 *
 * Bbox-only test (not point-in-polygon) so a tile clipped to even a
 * sliver of land is kept — we want better-safe-than-sorry coverage of
 * the rendered area, not a Voronoi-tight crop.
 *
 * `polyFC` is the play polygon FeatureCollection (Polygon /
 * MultiPolygon); the caller passes null when no polygon is set, in
 * which case this function is a passthrough.
 */
function clipTilesToPolygon(
    tiles: Array<[number, number, number]>,
    polyFC: FeatureCollection<Polygon | MultiPolygon> | null,
): Array<[number, number, number]> {
    if (!polyFC || polyFC.features.length === 0) return tiles;
    // Pre-merge the play polygon into a single (Multi)Polygon so
    // turf.booleanIntersects only runs once per tile. For typical
    // single-feature play areas this is a no-op.
    const merged =
        polyFC.features.length === 1
            ? polyFC.features[0]
            : (turf.combine(polyFC).features[0] as
                  | GeoJSON.Feature<Polygon | MultiPolygon>
                  | undefined);
    if (!merged) return tiles;
    const kept: Array<[number, number, number]> = [];
    for (const [z, x, y] of tiles) {
        const [w, n] = tileToLngLat(x, y, z);
        const [e, s] = tileToLngLat(x + 1, y + 1, z);
        const tileBbox = turf.bboxPolygon([w, s, e, n]);
        if (turf.booleanIntersects(tileBbox, merged as any)) {
            kept.push([z, x, y]);
        }
    }
    return kept;
}

/**
 * Counting wrapper around pmtiles' FetchSource. Every byte that crosses
 * the network (or is read from the browser HTTP cache) flows through
 * getBytes; recording it here keeps the bandwidth meter honest. Cache
 * hits on second runs are normal — `recordBytes` is wire-bytes-only by
 * convention (cf. cache.ts), so we only count when the response wasn't
 * served from our in-process pmtiles cache. We can't reliably tell a
 * browser-HTTP-cache hit from a fresh fetch from inside fetch() in
 * Firefox; the existing references/transit meter has the same caveat.
 */
class CountingSource implements Source {
    private inner: FetchSource;
    private onBytes: (n: number) => void;
    constructor(url: string, onBytes: (n: number) => void) {
        this.inner = new FetchSource(url);
        this.onBytes = onBytes;
    }
    getKey(): string {
        return this.inner.getKey();
    }
    async getBytes(
        offset: number,
        length: number,
        signal?: AbortSignal,
        etag?: string,
    ): Promise<RangeResponse> {
        const r = await this.inner.getBytes(offset, length, signal, etag);
        if (r?.data?.byteLength) this.onBytes(r.data.byteLength);
        return r;
    }
}

export interface PreloadTilesResult {
    tilesAttempted: number;
    tilesSucceeded: number;
    bytesFetched: number;
    zoomLevelsCovered: number[];
    zoomLevelsSkipped: number[];
}

/**
 * Run the tile preload for the currently-selected play area. No-op
 * (returns zeros) when there's no play area, no extent, or the
 * PMTiles archive is unreachable. Best-effort and silent: failures
 * downgrade to fewer tiles, never to a user-visible error.
 */
export async function preloadTilesForPlayArea(opts?: {
    minZoom?: number;
    maxZoom?: number;
    signal?: AbortSignal;
}): Promise<PreloadTilesResult> {
    const empty: PreloadTilesResult = {
        tilesAttempted: 0,
        tilesSucceeded: 0,
        bytesFetched: 0,
        zoomLevelsCovered: [],
        zoomLevelsSkipped: [],
    };

    // v335: bbox source priority.
    //   1. polyGeoJSON's bbox if a play polygon is set — this is the
    //      LAND-CLIPPED user polygon, which for coastal/irregular
    //      areas (Trondheim, Stockholm, San Francisco) is dramatically
    //      smaller than Photon's OSM relation extent. For Trondheim
    //      the relation extent reaches county-scale, while the actual
    //      polygon is the municipal land area — orders of magnitude
    //      fewer tiles to fetch.
    //   2. mapGeoLocation.extent (Photon's bbox) as the fallback
    //      when no play polygon has been set yet (early in setup).
    //
    // Either way we also clip tiles to the polygon via
    // `clipTilesToPolygon` so per-zoom tile counts drop further for
    // irregular shapes — see that function for the bbox-only logic.
    const polyFC = polyGeoJSON.get();
    let bbox: [number, number, number, number] | null = null;
    if (polyFC && polyFC.features.length > 0) {
        const b = turf.bbox(polyFC);
        if (
            b.length === 4 &&
            [b[0], b[1], b[2], b[3]].every((v) => Number.isFinite(v))
        ) {
            bbox = [b[0], b[1], b[2], b[3]];
        }
    }
    if (!bbox) {
        const loc = mapGeoLocation.get();
        if (!loc) return empty;
        const extent = (loc.properties as { extent?: number[] } | undefined)
            ?.extent;
        if (!extent || extent.length !== 4) return empty;
        // Photon extent shape: [maxLat, minLng, minLat, maxLng].
        const [maxLat, minLng, minLat, maxLng] = extent;
        bbox = [minLng, minLat, maxLng, maxLat];
    }

    const url = pmtilesUrl.get();
    let bytesFetched = 0;
    const source = new CountingSource(url, (n) => {
        bytesFetched += n;
        recordBytes(n);
    });
    const archive = new PMTiles(source);

    // Publish a "we're reading the archive header" phase so the UI can
    // show something useful before per-tile counts arrive. The header
    // read is a single tiny range request but on a cold network it can
    // still take a noticeable beat.
    preloadMapProgress.set({
        tilesDone: 0,
        tilesTotal: 0,
        currentZoom: 0,
        bytesFetched: 0,
        phase: "header",
    });

    let header;
    try {
        header = await archive.getHeader();
    } catch (e) {
        console.warn("[tilePreload] header read failed:", e);
        preloadMapProgress.set(null);
        return { ...empty, bytesFetched };
    }
    if (opts?.signal?.aborted) {
        preloadMapProgress.set(null);
        return { ...empty, bytesFetched };
    }

    const minZ = Math.max(opts?.minZoom ?? DEFAULT_MIN_ZOOM, header.minZoom ?? 0);
    const maxZ = Math.min(opts?.maxZoom ?? DEFAULT_MAX_ZOOM, header.maxZoom ?? 15);

    // Plan every zoom level up front so the total reflects what we
    // ACTUALLY intend to fetch (capped zooms are excluded). Honest
    // total means the progress bar reaches 100 % at the end instead
    // of stopping at some fraction the user can't predict.
    const covered: number[] = [];
    const skipped: number[] = [];
    const plan: Array<{ z: number; tiles: Array<[number, number, number]> }> =
        [];
    let tilesAttempted = 0;
    for (let z = minZ; z <= maxZ; z++) {
        const rawTiles = tilesInBbox(bbox, z);
        const tiles = clipTilesToPolygon(rawTiles, polyFC);
        const droppedByClip = rawTiles.length - tiles.length;
        if (tiles.length === 0) continue;
        if (tiles.length > MAX_TILES_PER_ZOOM) {
            console.warn(
                `[tilePreload] z${z}: ${tiles.length} tiles (after clip, was ${rawTiles.length}) exceeds cap ${MAX_TILES_PER_ZOOM}, SKIPPING (zoom-in will lag at this level)`,
            );
            skipped.push(z);
            continue;
        }
        if (droppedByClip > 0) {
            console.debug(
                `[tilePreload] z${z}: clipped ${droppedByClip} tiles to play polygon (${rawTiles.length} → ${tiles.length})`,
            );
        }
        plan.push({ z, tiles });
        covered.push(z);
        tilesAttempted += tiles.length;
    }
    console.info(
        `[tilePreload] bbox ${bbox.map((v) => v.toFixed(3)).join(",")} — planning ${tilesAttempted} tiles across ${plan.length} zoom levels:`,
        Object.fromEntries(plan.map((p) => [`z${p.z}`, p.tiles.length])),
    );

    // Switch to the per-tile phase before the loop kicks off so the
    // UI can flip the bar on immediately, even if z11 takes a beat to
    // schedule its first request.
    preloadMapProgress.set({
        tilesDone: 0,
        tilesTotal: tilesAttempted,
        currentZoom: plan[0]?.z ?? minZ,
        bytesFetched,
        phase: "tiles",
    });

    let tilesSucceeded = 0;
    let tilesCompleted = 0;
    // Throttle the atom writes: at 32-way concurrency on a fast
    // connection we'd otherwise dispatch a few thousand React renders
    // a second for no visible benefit. Flush every N tiles and at
    // every zoom-level boundary so the count never feels stale.
    const PROGRESS_FLUSH_EVERY = 10;
    let unflushedSinceLastWrite = 0;
    const flushProgress = (currentZoom: number) => {
        preloadMapProgress.set({
            tilesDone: tilesCompleted,
            tilesTotal: tilesAttempted,
            currentZoom,
            bytesFetched,
            phase: "tiles",
        });
        unflushedSinceLastWrite = 0;
    };

    for (const { z, tiles } of plan) {
        if (opts?.signal?.aborted) break;
        let next = 0;
        flushProgress(z);
        const work = async () => {
            while (next < tiles.length) {
                if (opts?.signal?.aborted) return;
                const i = next++;
                const [tz, tx, ty] = tiles[i];
                try {
                    const r = await archive.getZxy(tz, tx, ty, opts?.signal);
                    if (r) tilesSucceeded++;
                } catch {
                    /* best-effort: missing tiles, network blips, the
                       tile just not existing in the archive — all
                       silently swallowed. The map's own on-demand
                       fetch path still covers misses. */
                }
                tilesCompleted++;
                unflushedSinceLastWrite++;
                if (unflushedSinceLastWrite >= PROGRESS_FLUSH_EVERY) {
                    flushProgress(z);
                }
            }
        };
        await Promise.all(
            Array.from({ length: CONCURRENCY }, () => work()),
        );
        // Force a flush at every zoom boundary so the count + zoom
        // label both land together — even when this level finished
        // mid-throttle-window.
        flushProgress(z);
    }

    // Clear progress so the panel flips back to the "Downloaded" card
    // on the next render. The caller writes preloadBucketBytes /
    // preloadBucketTimestamps as part of the same return path.
    preloadMapProgress.set(null);

    return {
        tilesAttempted,
        tilesSucceeded,
        bytesFetched,
        zoomLevelsCovered: covered,
        zoomLevelsSkipped: skipped,
    };
}
