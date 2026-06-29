import * as turf from "@turf/turf";
import { expect, test } from "vitest";

import {
    geoSpatialVoronoi,
    modifyMapData,
} from "@/maps/geo-utils/operators";

// Big play-area square (±1° ≈ ±111 km around the origin) used as the
// `mapData` base for the zone-buffer tests below.
const SQUARE = turf.featureCollection([
    turf.polygon([
        [
            [-1, -1],
            [1, -1],
            [1, 1],
            [-1, 1],
            [-1, -1],
        ],
    ]),
]) as any;
// A 5 km radar circle centred at the origin.
const CIRCLE = turf.circle([0, 0], 5, { units: "kilometers" }) as any;
const at = (km: number) =>
    turf.destination(turf.point([0, 0]), km, 90, { units: "kilometers" });

test("zoneBuffer widens a keep-inside (within:true) region by the radius", () => {
    const justOutside = at(5.5); // 5.5 km — outside the 5 km circle
    const exact = modifyMapData(SQUARE, CIRCLE, true, 0)!;
    const buffered = modifyMapData(SQUARE, CIRCLE, true, 1)!; // +1 km → ~6 km
    expect(turf.booleanPointInPolygon(justOutside, exact)).toBe(false);
    expect(turf.booleanPointInPolygon(justOutside, buffered)).toBe(true);
});

test("zoneBuffer shrinks a keep-outside (within:false) elimination by the radius", () => {
    const justInside = at(4.5); // 4.5 km — inside the 5 km circle
    const exact = modifyMapData(SQUARE, CIRCLE, false, 0)!;
    const buffered = modifyMapData(SQUARE, CIRCLE, false, 1)!; // erode to ~4 km
    // Exact cut eliminates everything inside the circle.
    expect(turf.booleanPointInPolygon(justInside, exact)).toBe(false);
    // Buffered cut only eliminates the eroded core, so 4.5 km is kept.
    expect(turf.booleanPointInPolygon(justInside, buffered)).toBe(true);
});

test("zoneBuffer eroding the whole excluded region keeps the entire map", () => {
    // Erode the 5 km circle by 10 km → nothing excluded → full map kept.
    const result = modifyMapData(SQUARE, CIRCLE, false, 10)!;
    expect(turf.booleanPointInPolygon(turf.point([0, 0]), result)).toBe(true);
    expect(turf.booleanPointInPolygon(at(50), result)).toBe(true);
});

test("zoneBuffer of 0 leaves the exact cut unchanged", () => {
    const a = modifyMapData(SQUARE, CIRCLE, true, 0)!;
    const b = modifyMapData(SQUARE, CIRCLE, true)!;
    expect(turf.area(a)).toBeCloseTo(turf.area(b), 0);
});

test("voronoi diagram", () => {
    const BASE_POINT_COUNT = 25;
    const TEST_POINT_COUNT = 500;

    const basePoints = turf.randomPoint(BASE_POINT_COUNT);
    const voronoi = geoSpatialVoronoi(basePoints);

    expect(voronoi).toBeDefined();
    expect(voronoi.features.length).toBe(BASE_POINT_COUNT);

    const testPoints = turf.randomPoint(TEST_POINT_COUNT);

    testPoints.features.forEach((point) => {
        const voronoiIndex = voronoi.features.findIndex((feature) =>
            turf.booleanPointInPolygon(point, feature),
        );
        const nearestBasePoint = turf.nearestPoint(point, basePoints);
        const basePointIndex = basePoints.features.findIndex(
            (feature) =>
                feature.geometry.coordinates[0] ===
                    nearestBasePoint.geometry.coordinates[0] &&
                feature.geometry.coordinates[1] ===
                    nearestBasePoint.geometry.coordinates[1],
        );

        if (voronoiIndex === -1) {
            return; // A glitch with turf where overlapping polygons can cause this
        }

        expect(voronoiIndex).toBe(basePointIndex);
    });
});
