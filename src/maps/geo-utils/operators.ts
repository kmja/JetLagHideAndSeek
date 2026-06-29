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
    /**
     * Optional hiding-zone radius (km) for the `zoneRadiusBuffer` house
     * rule. When > 0 the question's constraint region is widened by this
     * amount so the cut is interpreted at the ZONE level rather than as an
     * exact point: a region is only eliminated when no point within the
     * radius could satisfy the answer. 0 / omitted = the original exact
     * behaviour. See `src/lib/houseRules.ts`.
     */
    zoneBufferKm = 0,
) => {
    let safeModifications =
        "features" in modifications ? safeUnion(modifications) : modifications;

    if (zoneBufferKm > 0) {
        // KEEP-INSIDE (within): dilate the kept region outward — a zone
        // counts as consistent if any point within its radius lands
        // inside. KEEP-OUTSIDE: erode the EXCLUDED region inward by the
        // same amount (its complement dilates), so a zone is only
        // eliminated when it sits entirely inside the excluded shape.
        try {
            const buffered = turf.buffer(
                safeModifications as Feature<Polygon | MultiPolygon>,
                withinModifications ? zoneBufferKm : -zoneBufferKm,
                { units: "kilometers" },
            ) as Feature<Polygon | MultiPolygon> | undefined;
            if (withinModifications) {
                if (buffered) safeModifications = buffered;
            } else {
                // Eroded to nothing → the excluded region vanishes, so
                // nothing is eliminated: return the map unchanged.
                if (!buffered || buffered.geometry == null) {
                    return safeUnion(mapData);
                }
                safeModifications = buffered;
            }
        } catch {
            // Buffer failed (degenerate geometry) — fall back to the exact
            // cut rather than dropping the question's elimination.
        }
    }

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
