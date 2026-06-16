import {
    FetchSource,
    PMTiles,
    type RangeResponse,
    type Source,
} from "pmtiles";

import { recordBytes } from "@/lib/bandwidthMeter";
import { mapGeoLocation } from "@/lib/context";
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
 * same range request the live map would later. The worker serves tiles
 * `Cache-Control: immutable, max-age=1y`, so once a range lands in the
 * browser HTTP cache, every subsequent zoom paints from disk with zero
 * network round-trips.
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
const MAX_TILES_PER_ZOOM = 2500;
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

    const loc = mapGeoLocation.get();
    if (!loc) return empty;
    const extent = (loc.properties as { extent?: number[] } | undefined)
        ?.extent;
    if (!extent || extent.length !== 4) return empty;
    // Photon extent shape: [maxLat, minLng, minLat, maxLng].
    const [maxLat, minLng, minLat, maxLng] = extent;
    const bbox: [number, number, number, number] = [
        minLng,
        minLat,
        maxLng,
        maxLat,
    ];

    const url = pmtilesUrl.get();
    let bytesFetched = 0;
    const source = new CountingSource(url, (n) => {
        bytesFetched += n;
        recordBytes(n);
    });
    const archive = new PMTiles(source);

    let header;
    try {
        header = await archive.getHeader();
    } catch (e) {
        console.warn("[tilePreload] header read failed:", e);
        return { ...empty, bytesFetched };
    }
    if (opts?.signal?.aborted) return { ...empty, bytesFetched };

    const minZ = Math.max(opts?.minZoom ?? DEFAULT_MIN_ZOOM, header.minZoom ?? 0);
    const maxZ = Math.min(opts?.maxZoom ?? DEFAULT_MAX_ZOOM, header.maxZoom ?? 15);

    const covered: number[] = [];
    const skipped: number[] = [];
    let tilesAttempted = 0;
    let tilesSucceeded = 0;

    for (let z = minZ; z <= maxZ; z++) {
        if (opts?.signal?.aborted) break;
        const tiles = tilesInBbox(bbox, z);
        if (tiles.length === 0) continue;
        if (tiles.length > MAX_TILES_PER_ZOOM) {
            console.debug(
                `[tilePreload] z${z}: ${tiles.length} tiles exceeds cap ${MAX_TILES_PER_ZOOM}, skipping`,
            );
            skipped.push(z);
            continue;
        }
        covered.push(z);
        tilesAttempted += tiles.length;
        let next = 0;
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
            }
        };
        await Promise.all(
            Array.from({ length: CONCURRENCY }, () => work()),
        );
    }

    return {
        tilesAttempted,
        tilesSucceeded,
        bytesFetched,
        zoomLevelsCovered: covered,
        zoomLevelsSkipped: skipped,
    };
}
