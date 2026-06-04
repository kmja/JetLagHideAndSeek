import * as turf from "@turf/turf";
import type {
    Feature,
    FeatureCollection,
    MultiPolygon,
    Polygon,
} from "geojson";

import { BLANK_GEOJSON } from "@/maps/api";

export { geoSpatialVoronoi } from "@/maps/geo-utils/voronoi";

export const safeUnion = (input: FeatureCollection<Polygon | MultiPolygon>) => {
    if (input.features.length === 1) return input.features[0];
    const union = turf.union(input);
    if (union) return union;
    throw new Error("No features");
};

export const holedMask = (
    input:
        | Feature<Polygon | MultiPolygon>
        | FeatureCollection<Polygon | MultiPolygon>,
) => {
    return turf.difference(
        turf.featureCollection([
            BLANK_GEOJSON.features[0] as Feature<Polygon>,
            "features" in input ? safeUnion(input) : input,
        ]),
    );
};

export const modifyMapData = (
    mapData: FeatureCollection<Polygon | MultiPolygon>,
    modifications:
        | FeatureCollection<Polygon | MultiPolygon>
        | Feature<Polygon | MultiPolygon>,
    withinModifications: boolean,
) => {
    const safeModifications =
        "features" in modifications ? safeUnion(modifications) : modifications;

    if (withinModifications) {
        return turf.intersect(
            turf.featureCollection([safeUnion(mapData), safeModifications]),
        );
    }
    return turf.intersect(
        turf.featureCollection([
            safeUnion(mapData),
            holedMask(safeModifications)!,
        ]),
    );
};

// Dynamic-import the ArcGIS-using half so the ~1.5 MB @arcgis/core
// chunk only loads the first time a question actually needs a
// geodesic buffer. Both call sites already await the return value.
let arcgisModulePromise:
    | Promise<typeof import("./arcgisOperators")>
    | undefined;
const loadArcgisModule = () => {
    if (!arcgisModulePromise) {
        arcgisModulePromise = import("./arcgisOperators");
    }
    return arcgisModulePromise;
};

// Re-exported via the wrapper functions below. We keep the original
// signatures (loose `turf.Units` accepted as the unit param) so the
// callers in src/maps/questions/* don't need any type-import dance.
export const arcBuffer = async (
    geometry: FeatureCollection,
    distance: number,
    unit?: turf.Units,
) => {
    const m = await loadArcgisModule();
     
    return m.arcBufferImpl(geometry, distance, unit as any);
};

export const arcBufferToPoint = async (
    geometry: FeatureCollection,
    lat: number,
    lng: number,
) => {
    const m = await loadArcgisModule();
    return m.arcBufferToPointImpl(geometry, lat, lng);
};
