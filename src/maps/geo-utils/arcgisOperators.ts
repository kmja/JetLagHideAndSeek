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
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            turf.feature(arcgisToGeoJSON(bufferedGeometry[0] as any)),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ]) as any,
    ).features[0] as Feature<MultiPolygon>;
};

export const arcBufferToPointImpl = async (
    geometry: FeatureCollection,
    lat: number,
    lng: number,
) => {
    const point = new Point({
        latitude: lat,
        longitude: lng,
    });

    const arcgisGeometry = geometry.features.map((x) =>
        geometryJsonUtils.fromJSON(geojsonToArcGIS(x.geometry)),
    ) as unionTypes.GeometryUnion[];

    await geodeticDistanceOperator.load();

    const distances = arcgisGeometry.map((x) =>
        geodeticDistanceOperator.execute(x, point, {
            unit: DEFAULT_BUFFER_UNIT,
        }),
    );

    return innateArcBuffer(arcgisGeometry, Math.min(...distances));
};
