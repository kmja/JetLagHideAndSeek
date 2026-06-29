import * as turf from "@turf/turf";

import { hiderMode } from "@/lib/context";
import { zoneBufferKm } from "@/lib/houseRules";
import { safeUnion } from "@/maps/geo-utils";
import { geoSpatialVoronoi } from "@/maps/geo-utils/voronoi";
import type { ThermometerQuestion } from "@/maps/schema";

export const adjustPerThermometer = (
    question: ThermometerQuestion,
    mapData: any,
) => {
    if (mapData === null) return;

    const pointA = turf.point([question.lngA, question.latA]);
    const pointB = turf.point([question.lngB, question.latB]);

    const voronoi = geoSpatialVoronoi(turf.featureCollection([pointA, pointB]));

    // The kept half-plane is the side of the perpendicular bisector the
    // hider was on. `zoneRadiusBuffer` house rule (km): widen that side by
    // the hiding-zone radius so a zone straddling the bisector isn't
    // wrongly eliminated when the hider answered from one edge of it.
    let kept = question.warmer ? voronoi.features[1] : voronoi.features[0];
    const bufKm = zoneBufferKm();
    if (bufKm > 0) {
        try {
            const widened = turf.buffer(kept as any, bufKm, {
                units: "kilometers",
            });
            if (widened) kept = widened as typeof kept;
        } catch {
            // Degenerate geometry — fall back to the exact half-plane.
        }
    }

    return turf.intersect(
        turf.featureCollection([safeUnion(mapData), kept]),
    );
};

export const hiderifyThermometer = (question: ThermometerQuestion) => {
    const $hiderMode = hiderMode.get();
    if ($hiderMode === false) {
        return question;
    }

    const pointA = turf.point([question.lngA, question.latA]);
    const pointB = turf.point([question.lngB, question.latB]);

    const voronoi = geoSpatialVoronoi(turf.featureCollection([pointA, pointB]));

    const hiderPoint = turf.point([$hiderMode.longitude, $hiderMode.latitude]);
    const hiderRegion = turf.booleanPointInPolygon(
        hiderPoint,
        voronoi.features[1],
    )
        ? 1
        : 0;

    if (hiderRegion === 1) {
        question.warmer = true;
    } else {
        question.warmer = false;
    }

    return question;
};

export const thermometerPlanningPolygon = (question: ThermometerQuestion) => {
    const pointA = turf.point([question.lngA, question.latA]);
    const pointB = turf.point([question.lngB, question.latB]);

    const voronoi = geoSpatialVoronoi(turf.featureCollection([pointA, pointB]));

    return turf.featureCollection(
        voronoi.features
            .map((x: any) => turf.polygonToLine(x))
            .flatMap((line) =>
                line.type === "FeatureCollection" ? line.features : [line],
            ),
    );
};
