import * as turf from "@turf/turf";
import type {
    Feature,
    FeatureCollection,
    MultiPolygon,
    Polygon,
} from "geojson";

import { cacheFetch } from "@/maps/api/cache";
import { CacheType } from "@/maps/api/types";

/**
 * Trim a play-area polygon to the land portion only, using the bundled
 * Natural Earth 1:50m coastline as the world's land mask.
 *
 * Why this exists: OSM admin boundaries (the source of the play-area
 * polygons) follow legal jurisdictions, not coastlines — so something
 * like Nagasaki Prefecture sweeps tens of kilometres into the ocean
 * because the prefecture's legal extent includes territorial waters.
 * Drawing that on the map makes ~50 % of the play area look like
 * playable space when in fact it's empty sea. This module clips the
 * polygon against actual land so what the seeker sees IS the playable
 * surface.
 *
 * Data source: `public/coastline50.geojson` (Natural Earth 1:50m
 * coastline). 1405 of its 1429 features are already closed loops
 * (islands + continent outlines, stored as LineStrings) — we treat
 * those as land polygons. The 24 open lines are continental fragments
 * around the antimeridian; skipped here. The dataset's ~5 km
 * resolution is plenty for "snap the polygon to the coast" — anything
 * finer wouldn't change the visible silhouette at lobby zoom.
 *
 * Performance notes:
 *   - The land FC is loaded once per session (cacheFetch +
 *     PERMANENT_CACHE), then memoized at module scope.
 *   - For each clip call, we bbox-filter the global FC (1429
 *     features) down to overlapping ones (typically 1-20) before any
 *     turf.intersect — those are the only ones that matter for the
 *     play area's region.
 *   - Each intersect is sub-second on a county-sized polygon.
 *   - Resulting clipped polygons are unioned into a single feature so
 *     downstream code (the elimination mask, the lobby preview) gets
 *     the same shape it would from a raw OSM boundary.
 */

/** Memoized land polygons. Each entry carries a precomputed bbox so
 *  the per-clip overlap filter is O(n) instead of O(n*m). */
type LandPoly = {
    feature: Feature<Polygon>;
    bbox: [number, number, number, number];
};
let landPolysPromise: Promise<LandPoly[]> | null = null;

async function loadLandPolys(): Promise<LandPoly[]> {
    if (landPolysPromise) return landPolysPromise;
    landPolysPromise = (async () => {
        const url =
            (import.meta.env.BASE_URL ?? "/") + "coastline50.geojson";
        const resp = await cacheFetch(
            url,
            undefined,
            CacheType.PERMANENT_CACHE,
        );
        const fc = (await resp.json()) as FeatureCollection;
        const out: LandPoly[] = [];
        for (const f of fc.features) {
            const g = f.geometry;
            if (!g) continue;
            if (g.type === "LineString") {
                const coords = g.coordinates;
                if (coords.length < 4) continue;
                const first = coords[0];
                const last = coords[coords.length - 1];
                if (first[0] !== last[0] || first[1] !== last[1]) {
                    // Open line — continent fragment around the
                    // antimeridian. Closing it would produce a
                    // bogus polygon, so skip.
                    continue;
                }
                const poly: Feature<Polygon> = {
                    type: "Feature",
                    properties: {},
                    geometry: { type: "Polygon", coordinates: [coords] },
                };
                out.push({
                    feature: poly,
                    bbox: turf.bbox(poly) as [
                        number,
                        number,
                        number,
                        number,
                    ],
                });
            }
            // Natural Earth's coastline file is pure LineString;
            // no Polygon / MultiLineString cases to handle.
        }
        return out;
    })();
    return landPolysPromise;
}

function bboxesOverlap(
    a: [number, number, number, number],
    b: [number, number, number, number],
): boolean {
    return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
}

/**
 * Clip a play-area polygon (Polygon or MultiPolygon) to land only.
 * Returns the clipped geometry as a Feature, or `null` if the input
 * was malformed / the clip pipeline failed (caller should treat as
 * "leave the original polygon alone"). Best-effort and safe — never
 * throws.
 */
export async function clipPolygonToLand(
    polygon: Feature<Polygon | MultiPolygon>,
): Promise<Feature<Polygon | MultiPolygon> | null> {
    try {
        const polys = await loadLandPolys();
        const playBbox = turf.bbox(polygon) as [
            number,
            number,
            number,
            number,
        ];
        const relevant = polys.filter((p) => bboxesOverlap(playBbox, p.bbox));
        if (relevant.length === 0) return null;

        const pieces: Feature<Polygon | MultiPolygon>[] = [];
        for (const land of relevant) {
            try {
                const inter = turf.intersect(
                    turf.featureCollection([polygon, land.feature]),
                ) as Feature<Polygon | MultiPolygon> | null;
                if (inter && inter.geometry) {
                    pieces.push(inter);
                }
            } catch {
                /* skip any pair that fails the topology check */
            }
        }
        if (pieces.length === 0) return null;
        if (pieces.length === 1) return pieces[0];

        // Union the per-island clips so downstream code (mask,
        // preview, hiding-zone checks) sees a single Feature.
        let acc: Feature<Polygon | MultiPolygon> = pieces[0];
        for (let i = 1; i < pieces.length; i++) {
            try {
                const u = turf.union(
                    turf.featureCollection([acc, pieces[i]]),
                ) as Feature<Polygon | MultiPolygon> | null;
                if (u) acc = u;
            } catch {
                /* skip any pair that fails the topology check */
            }
        }
        return acc;
    } catch (e) {
        console.warn("clipPolygonToLand failed:", e);
        return null;
    }
}
