/**
 * The ArcGIS-backed half of `operators.ts`. Kept in a separate file
 * so the surrounding turf-only helpers can stay statically imported
 * while the `@arcgis/core` dependency (≈1.5 MB minified) only ships
 * to the browser the first time a question actually needs a geodesic
 * buffer.
 *
 * Callers go through `arcBuffer` / `arcBufferToPoint` in
 * `./operators.ts`, which dynamic-import this module on demand.
 */

import * as units from "@arcgis/core/core/units.js";
import * as geodesicBufferOperator from "@arcgis/core/geometry/operators/geodesicBufferOperator.js";
import * as geodeticDistanceOperator from "@arcgis/core/geometry/operators/geodeticDistanceOperator.js";
import Point from "@arcgis/core/geometry/Point.js";
import * as geometryJsonUtils from "@arcgis/core/geometry/support/jsonUtils.js";
import * as unionTypes from "@arcgis/core/unionTypes.js";
import { arcgisToGeoJSON, geojsonToArcGIS } from "@terraformer/arcgis";
import * as turf from "@turf/turf";
import type { Feature, FeatureCollection, MultiPolygon } from "geojson";

const DEFAULT_BUFFER_UNIT = "miles";

/** v972: only features with at least this many vertices are simplified on
 *  the throw-retry path — smaller features (individual ponds/lakes) are
 *  left intact so a coarse simplify can't collapse and drop them. */
const SIMPLIFY_MIN_VERTICES = 40;

/** Rough vertex count of any GeoJSON geometry (for the simplify gate). */
function countPositions(f: { geometry?: unknown } | null | undefined): number {
    const g = (f as { geometry?: { coordinates?: unknown } } | null)?.geometry;
    const coords = (g as { coordinates?: unknown })?.coordinates;
    let n = 0;
    const walk = (a: unknown): void => {
        if (!Array.isArray(a)) return;
        if (typeof a[0] === "number") {
            n++;
            return;
        }
        for (const x of a) walk(x);
    };
    walk(coords);
    return n;
}

export const arcBufferImpl = (
    geometry: FeatureCollection,
    distance: number,
    unit: units.LengthUnit & turf.Units = DEFAULT_BUFFER_UNIT,
) => {
    const arcgisGeometry = geometry.features.map((x) =>
        geometryJsonUtils.fromJSON(geojsonToArcGIS(x.geometry)),
    ) as unionTypes.GeometryUnion[];

    return innateArcBuffer(arcgisGeometry, distance, unit);
};

const innateArcBuffer = async (
    arcgisGeometry: unionTypes.GeometryUnion[],
    distance: number,
    unit: units.LengthUnit & turf.Units = DEFAULT_BUFFER_UNIT,
) => {
    await geodesicBufferOperator.load();

    const bufferedGeometry = geodesicBufferOperator.executeMany(
        arcgisGeometry,
        Array(arcgisGeometry.length).fill(distance),
        {
            union: true,
            unit: unit,
            // Tight tolerance keeps small radii (e.g. a 500m radar circle)
            // visibly smooth at high zoom. The math: segments ≈ π / √(2·d/r);
            // at r=500m, d=0.15m → ~180 segments — looks like a true circle.
            // At r=160km, ~3300 segments — still trivial for the renderer.
            maxDeviation: turf.convertLength(0.5, "feet", unit),
        },
    );

    return turf.combine(
        turf.featureCollection([
             
            turf.feature(arcgisToGeoJSON(bufferedGeometry[0] as any)),
             
        ]) as any,
    ).features[0] as Feature<MultiPolygon>;
};

export const arcBufferToPointImpl = async (
    geometry: FeatureCollection,
    lat: number,
    lng: number,
): Promise<Feature<MultiPolygon> | null> => {
    const point = new Point({ latitude: lat, longitude: lng });
    await geodeticDistanceOperator.load();

    // Build the arcgis geometry + buffer distance at a given simplification
    // tolerance. Returns null when the input is degenerate (no finite
    // distance to any feature — e.g. an empty multipolygon sentinel).
    const attempt = async (
        tolerance: number,
    ): Promise<Feature<MultiPolygon> | null> => {
        const feats =
            tolerance > 0
                ? geometry.features.map((f) => {
                      // v972: simplify ONLY heavy features (a dense sea/river
                      // geometry is what makes the buffer throw). Small
                      // water polygons are left untouched — coarse-simplifying
                      // a small pond collapses it to a degenerate ring, which
                      // then drops out of the buffered "closer" region and
                      // paints real water as "further" (the reported bug).
                      if (countPositions(f) < SIMPLIFY_MIN_VERTICES) return f;
                      try {
                          const s = turf.simplify(f as any, {
                              tolerance,
                              highQuality: false,
                              mutate: false,
                          });
                          // A simplify that collapsed the feature below a
                          // valid ring is worse than the original — keep it.
                          return countPositions(s) >= 4 ? s : f;
                      } catch {
                          return f;
                      }
                  })
                : geometry.features;
        const arc = feats.map((x) =>
            geometryJsonUtils.fromJSON(geojsonToArcGIS(x.geometry)),
        ) as unionTypes.GeometryUnion[];
        const distances = arc
            .map((x) =>
                geodeticDistanceOperator.execute(x, point, {
                    unit: DEFAULT_BUFFER_UNIT,
                }),
            )
            .filter((d): d is number => Number.isFinite(d));
        // Degenerate input (no measurable geometry) — nothing to buffer.
        if (distances.length === 0) return null;
        return innateArcBuffer(arc, Math.min(...distances));
    };

    // A pathologically DENSE geometry (a dense metro's full OSM coastline +
    // every river + the sea-as-area polygon for body-of-water) can make the
    // arcgis geodesic buffer THROW — and since v933 no longer caches that
    // failure, it just retried and the overlay/elimination never appeared
    // (the reported "body of water shows no overlay"). Retry with
    // progressively coarser turf.simplify (≈33 m / ≈110 m at these
    // tolerances — negligible against a hundreds-of-metres buffer) so a
    // dense metro still yields a region instead of nothing; give up (null)
    // only if even the coarse attempt throws.
    for (const tolerance of [0, 0.0003, 0.001]) {
        try {
            return await attempt(tolerance);
        } catch (e) {
            if (tolerance === 0.001) {
                console.warn(
                    "[arcBufferToPoint] geodesic buffer failed after simplify:",
                    e,
                );
                return null;
            }
        }
    }
    return null;
};
