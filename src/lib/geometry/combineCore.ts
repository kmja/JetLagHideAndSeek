// Named imports (not `import * as turf`) so this geometry-worker bundle
// tree-shakes to just the functions it uses — matching the sibling workers.
import {
    combine,
    coordAll,
    difference,
    featureCollection,
    simplify,
    union,
} from "@turf/turf";
import type {
    Feature,
    FeatureCollection,
    MultiPolygon,
    Polygon,
} from "geojson";

/**
 * Pure, synchronous compute core for the boundary-combine pipeline:
 * union the added play-area pieces, subtract the excluded ones,
 * simplify a pathologically large result, and combine into a single
 * MultiPolygon FeatureCollection.
 *
 * Extracted from `determineMapBoundaries` (overpass.ts) so this CPU-
 * heavy turf work can run inside the geometry Web Worker instead of on
 * the main thread — the union/difference/simplify steps over a huge
 * multi-area boundary were a freeze source. No DOM / fetch / React here
 * (the only side channel is the optional `onPhase` progress callback),
 * so it's safe to import from a worker.
 */

const isPolygonal = (f: any): boolean =>
    f?.geometry?.type === "Polygon" || f?.geometry?.type === "MultiPolygon";

/** Inlined union (the real `safeUnion` lives in geo-utils, which pulls
 *  in the whole `@/maps/api` graph — too heavy + main-thread-only for a
 *  worker). Behaviour is identical: single feature passes through,
 *  otherwise union, throw if union is empty. */
function localSafeUnion(
    input: FeatureCollection<Polygon | MultiPolygon>,
): Feature<Polygon | MultiPolygon> {
    if (input.features.length === 1) return input.features[0];
    const merged = union(input);
    if (merged) return merged;
    throw new Error("No features");
}

/**
 * Combine the fetched boundary pieces into the final play-area
 * geometry. `addedFeatures` are unioned to form the base; any
 * `subtractFeatures` are differenced out. Mirrors the original inline
 * pipeline exactly (including the "Tokyo Metropolis" fast-mode simplify
 * guard at >10k coordinates).
 */
export function combineBoundaryGeometry(
    addedFeatures: Feature<Polygon | MultiPolygon>[],
    subtractFeatures: Feature<Polygon | MultiPolygon>[],
    onPhase?: (phase: string) => void,
): FeatureCollection<MultiPolygon> {
    const added = addedFeatures.filter(isPolygonal);
    if (added.length === 0) {
        throw new Error("Boundary fetch returned no usable polygon features.");
    }

    let mapGeoData = featureCollection([
        localSafeUnion(featureCollection(added) as any),
    ]);

    const subs = subtractFeatures.filter(isPolygonal);
    if (subs.length > 0) {
        onPhase?.("Subtracting excluded areas…");
        const diff = difference(
            featureCollection([mapGeoData.features[0], ...subs]),
        );
        // difference returns null when subtractions covered the
        // whole base — preserve the original boundary in that case.
        if (diff) {
            mapGeoData = featureCollection([diff]);
        }
    }

    if (coordAll(mapGeoData).length > 10000) {
        onPhase?.("Simplifying geometry…");
        // Fast (non-highQuality) Douglas-Peucker. highQuality is
        // O(n^2)-ish and on a 1000 km boundary (Tokyo Metropolis →
        // Ogasawara) it runs for many seconds; fast mode is plenty for
        // a play-area outline and dramatically cheaper.
        simplify(mapGeoData, {
            tolerance: 0.0005,
            highQuality: false,
            mutate: true,
        });
    }

    return combine(mapGeoData) as FeatureCollection<MultiPolygon>;
}
