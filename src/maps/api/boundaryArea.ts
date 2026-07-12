import { area as turfArea } from "@turf/turf";

import { fetchRawBoundaryPolygon } from "./polygonsOsmFr";

/**
 * Exact play-area size from the REAL OSM relation boundary, in km².
 *
 * The setup wizard's game-size suggestion originally approximated area
 * from the Photon bounding box (`estimateAreaKm2`, bbox × fill factor)
 * because measuring the true polygon meant an extra round-trip. But by
 * the time the user reaches the size step, `PlayAreaPreviewMap` has
 * already fetched each area's real boundary (`fetchRawBoundaryPolygon`,
 * worker-R2-backed + in-flight-deduped), so the exact geometry is warm
 * and `turf.area` over it is essentially free — no reason to keep
 * guessing from the bbox.
 *
 * Results are memoised per relation id (area doesn't change), so the
 * wizard can call this every render without re-fetching or re-measuring.
 */
const areaCacheKm2 = new Map<number, number | null>();

export async function fetchExactAreaKm2(
    osmId: number,
    signal?: AbortSignal,
): Promise<number | null> {
    if (areaCacheKm2.has(osmId)) return areaCacheKm2.get(osmId) ?? null;
    let geom: GeoJSON.Polygon | GeoJSON.MultiPolygon | null = null;
    try {
        geom = await fetchRawBoundaryPolygon(osmId, signal);
    } catch {
        geom = null;
    }
    if (!geom) return null; // transient miss — don't poison the cache
    let km2: number | null = null;
    try {
        const m2 = turfArea(geom as never);
        km2 = Number.isFinite(m2) && m2 > 0 ? m2 / 1_000_000 : null;
    } catch {
        km2 = null;
    }
    // Only cache a real measurement (a null here is a geometry/measure
    // failure we'd rather retry than lock in).
    if (km2 !== null) areaCacheKm2.set(osmId, km2);
    return km2;
}

/** Synchronous read of an already-measured area (km²), or undefined if
 *  it hasn't been fetched/measured yet. */
export function getCachedExactAreaKm2(osmId: number): number | undefined {
    const v = areaCacheKm2.get(osmId);
    return v === null ? undefined : v;
}
