import * as turf from "@turf/turf";
import type { FeatureCollection, MultiPolygon, Polygon } from "geojson";
import { describe, expect, it } from "vitest";

import {
    prepareZoneCircles,
    styleZoneStations,
} from "../src/lib/zonePipeline";
import type { StationCircle, StationPlace } from "../src/maps/api/types";

/** A station point feature the pipeline expects (StationPlace shape). */
function station(id: string, lng: number, lat: number): StationPlace {
    return {
        type: "Feature",
        geometry: { type: "Point", coordinates: [lng, lat] },
        properties: { id, name: `Station ${id}` },
    } as StationPlace;
}

/** A simple square area FC around (0,0), side ~2*halfDeg degrees. */
function squareArea(
    halfDeg: number,
): FeatureCollection<Polygon | MultiPolygon> {
    return turf.featureCollection([
        turf.polygon([
            [
                [-halfDeg, -halfDeg],
                [halfDeg, -halfDeg],
                [halfDeg, halfDeg],
                [-halfDeg, halfDeg],
                [-halfDeg, -halfDeg],
            ],
        ]),
    ]) as FeatureCollection<Polygon | MultiPolygon>;
}

describe("prepareZoneCircles", () => {
    it("keeps stations whose circle intersects the area, drops the rest", () => {
        const area = squareArea(0.05); // ~5.5 km half-side at the equator
        const inside = station("in", 0, 0);
        // ~55 km east — its 500 m circle can't touch the square.
        const outside = station("out", 0.5, 0);
        const circles = prepareZoneCircles(
            [inside, outside],
            0.5,
            "kilometers",
            area,
        );
        expect(circles).toHaveLength(1);
        expect((circles[0].properties as StationPlace).properties?.id).toBe(
            "in",
        );
    });

    it("keeps a boundary-straddling station (intersects, not within)", () => {
        const area = squareArea(0.05);
        // Just outside the east edge; a 1 km circle pokes into the square.
        const straddling = station("edge", 0.052, 0);
        const circles = prepareZoneCircles(
            [straddling],
            1,
            "kilometers",
            area,
        );
        expect(circles).toHaveLength(1);
    });

    it("builds 512-step circles carrying the station as properties", () => {
        const area = squareArea(0.05);
        const circles = prepareZoneCircles(
            [station("a", 0, 0)],
            0.5,
            "kilometers",
            area,
        );
        const ring = (circles[0].geometry as Polygon).coordinates[0];
        expect(ring.length).toBeGreaterThanOrEqual(512);
        expect((circles[0].properties as StationPlace).properties?.id).toBe(
            "a",
        );
    });

    it("throws when the area union fails (empty area FC)", () => {
        const empty = {
            type: "FeatureCollection",
            features: [],
        } as unknown as FeatureCollection<Polygon | MultiPolygon>;
        expect(() =>
            prepareZoneCircles([station("a", 0, 0)], 0.5, "kilometers", empty),
        ).toThrow();
    });
});

describe("styleZoneStations", () => {
    const area = squareArea(0.2);
    const circles = prepareZoneCircles(
        [station("a", 0, 0), station("b", 0.001, 0), station("c", 0.1, 0.1)],
        0.5,
        "kilometers",
        area,
    ) as StationCircle[];

    it("no-display → empty FC", () => {
        const out = styleZoneStations(circles, "no-display");
        expect((out as FeatureCollection).features).toHaveLength(0);
    });

    it("no-overlap → a single unioned feature", () => {
        const out = styleZoneStations(circles, "no-overlap");
        expect(out.type).toBe("Feature");
    });

    it("stations → one union polygon + one point per station", () => {
        const out = styleZoneStations(
            circles,
            "stations",
        ) as FeatureCollection;
        // 1 union + 3 station points.
        expect(out.features).toHaveLength(4);
        const points = out.features.filter(
            (f) => f.geometry?.type === "Point",
        );
        expect(points).toHaveLength(3);
    });

    it("zones → every circle + every point", () => {
        const out = styleZoneStations(circles, "zones") as FeatureCollection;
        expect(out.features).toHaveLength(6);
    });

    it("handles 0 and 1 circles without throwing", () => {
        expect(
            (styleZoneStations([], "stations") as FeatureCollection).features,
        ).toHaveLength(0);
        const one = circles.slice(0, 1);
        const out = styleZoneStations(one, "stations") as FeatureCollection;
        expect(out.features).toHaveLength(2); // the circle itself + its point
        expect(
            (styleZoneStations([], "no-overlap") as FeatureCollection)
                .features,
        ).toHaveLength(0);
    });
});
