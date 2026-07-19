import * as turf from "@turf/turf";
import type { Feature, LineString, MultiLineString } from "geojson";
import { describe, expect, it } from "vitest";

import { seaFromCoastline } from "@/maps/questions/seaFromCoastline";

const FRAME: [number, number, number, number] = [0, 0, 1, 1];

function coast(
    coords: [number, number][],
): Feature<LineString | MultiLineString> {
    return turf.lineString(coords) as Feature<LineString | MultiLineString>;
}

describe("seaFromCoastline", () => {
    it("labels the east (right) half as water for a north-going vertical coast", () => {
        // Coastline runs south→north (up) along x=0.5. Right of travel = east,
        // so WATER is the east half, LAND the west half.
        const line = coast([
            [0.5, 0],
            [0.5, 1],
        ]);
        const seeker = { lng: 0.25, lat: 0.5 }; // in the WEST (land) half
        const sea = seaFromCoastline([line], FRAME, seeker);
        expect(sea).not.toBeNull();
        // A point in the east half is inside the sea.
        expect(
            turf.booleanPointInPolygon(turf.point([0.75, 0.5]), sea!),
        ).toBe(true);
        // A point in the west (land) half — and the seeker — are NOT.
        expect(
            turf.booleanPointInPolygon(turf.point([0.25, 0.5]), sea!),
        ).toBe(false);
        expect(
            turf.booleanPointInPolygon(turf.point([seeker.lng, seeker.lat]), sea!),
        ).toBe(false);
        // Sea is ~half the frame.
        expect(turf.area(sea!)).toBeLessThan(turf.area(turf.bboxPolygon(FRAME)));
        expect(turf.area(sea!)).toBeGreaterThan(
            turf.area(turf.bboxPolygon(FRAME)) * 0.3,
        );
    });

    it("reverses the water side when the coast direction is reversed", () => {
        // Coastline runs north→south (down) along x=0.5. Right of travel = west,
        // so WATER is the west half now.
        const line = coast([
            [0.5, 1],
            [0.5, 0],
        ]);
        const seeker = { lng: 0.75, lat: 0.5 }; // in the EAST (land) half
        const sea = seaFromCoastline([line], FRAME, seeker);
        expect(sea).not.toBeNull();
        expect(
            turf.booleanPointInPolygon(turf.point([0.25, 0.5]), sea!),
        ).toBe(true);
        expect(
            turf.booleanPointInPolygon(turf.point([0.75, 0.5]), sea!),
        ).toBe(false);
    });

    it("trusts the seeker as land — flood-fill labels the seeker's side land regardless of winding (v994)", () => {
        // North-going coast → the WINDING says water is east. But the seeker is
        // placed in the east half, and a real player is always on LAND, so the
        // seeker-seeded flood-fill 2-coloring labels the EAST (seeker) side land
        // and the WEST side water — winding-independent. (The old winding test
        // returned null here; the flood-fill is authoritative on seeker=land.)
        const line = coast([
            [0.5, 0],
            [0.5, 1],
        ]);
        const seeker = { lng: 0.75, lat: 0.5 };
        const sea = seaFromCoastline([line], FRAME, seeker);
        expect(sea).not.toBeNull();
        // Water = the WEST half (opposite the seeker); the seeker's east is land.
        expect(
            turf.booleanPointInPolygon(turf.point([0.25, 0.5]), sea!),
        ).toBe(true);
        expect(
            turf.booleanPointInPolygon(turf.point([0.75, 0.5]), sea!),
        ).toBe(false);
    });

    it("returns null for empty coastline input", () => {
        expect(seaFromCoastline([], FRAME, { lng: 0.25, lat: 0.5 })).toBeNull();
    });

    it("returns null when the coastline is entirely outside the frame", () => {
        // A line far to the east of [0,0,1,1] clips to nothing.
        const line = coast([
            [5, 0],
            [5, 1],
        ]);
        const sea = seaFromCoastline([line], FRAME, { lng: 0.25, lat: 0.5 });
        expect(sea).toBeNull();
    });

    it("labels the correct corner as water for an L-shaped coast", () => {
        // Two segments cutting off the bottom-right corner:
        //   (1,0.5) -> (0.5,0.5) -> (0.5,0)
        // Travelling left then down. For the horizontal leg (going west,
        // d=(-0.5,0)), right normal = (d.lat,-d.lng) = (0, 0.5) → points NORTH,
        // so water is north. For the vertical leg (going south, d=(0,-0.5)),
        // right normal = (-0.5, 0) → points WEST, so water is west. Both point
        // into the big L-shaped face (everything except the bottom-right
        // square), so that whole face is water; the bottom-right square is land.
        const line = coast([
            [1, 0.5],
            [0.5, 0.5],
            [0.5, 0],
        ]);
        // Seeker must be on land: the small bottom-right square [0.5..1]x[0..0.5].
        const seeker = { lng: 0.75, lat: 0.25 };
        const sea = seaFromCoastline([line], FRAME, seeker);
        expect(sea).not.toBeNull();
        // Bottom-left interior is water.
        expect(
            turf.booleanPointInPolygon(turf.point([0.25, 0.25]), sea!),
        ).toBe(true);
        // The bottom-right corner (where the seeker is) is land, not water.
        expect(
            turf.booleanPointInPolygon(turf.point([0.75, 0.25]), sea!),
        ).toBe(false);
    });
});
