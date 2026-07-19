import * as turf from "@turf/turf";
import type { Feature, LineString, MultiLineString } from "geojson";
import { describe, expect, it } from "vitest";

import { filterCoastlineByStraitRule } from "@/maps/questions/coastlineStrait";

// ~55 km × 55 km frame near the equator (1° ≈ 111 km), so the 2 km
// strait rule operates at realistic scale.
const FRAME: [number, number, number, number] = [0, 0, 0.5, 0.5];

function coast(
    coords: [number, number][],
): Feature<LineString | MultiLineString> {
    return turf.lineString(coords) as Feature<LineString | MultiLineString>;
}

function totalLengthKm(lines: Feature<LineString>[]): number {
    return lines.reduce(
        (sum, l) => sum + turf.length(l, { units: "kilometers" }),
        0,
    );
}

describe("filterCoastlineByStraitRule", () => {
    it("keeps open-sea coastline (frame-connected water qualifies)", () => {
        // North-going vertical coast at x=0.25 → water is the east half,
        // ~27 km wide, touching the frame edge (open sea).
        const line = coast([
            [0.25, 0],
            [0.25, 0.5],
        ]);
        const seeker = { lng: 0.1, lat: 0.25 };
        const out = filterCoastlineByStraitRule([line], FRAME, seeker);
        expect(out).not.toBeNull();
        expect(out!.length).toBeGreaterThan(0);
        // Essentially the whole ~55 km coast survives.
        expect(totalLengthKm(out!)).toBeGreaterThan(45);
    });

    it("drops the shoreline of a sub-2 km inlet but keeps the open coast", () => {
        // Same open sea to the east, plus a narrow slot (~1.1 km wide)
        // poking ~17 km west into the land between y=0.24 and y=0.25.
        // Water stays on the right of travel throughout.
        const line = coast([
            [0.25, 0],
            [0.25, 0.24],
            [0.1, 0.24],
            [0.1, 0.25],
            [0.25, 0.25],
            [0.25, 0.5],
        ]);
        const seeker = { lng: 0.05, lat: 0.4 };
        const out = filterCoastlineByStraitRule([line], FRAME, seeker);
        expect(out).not.toBeNull();
        expect(out!.length).toBeGreaterThan(0);
        // No kept chunk sits deep inside the slot (west of x=0.2 the
        // dilated qualifying water can't reach).
        for (const c of out!) {
            const mid =
                c.geometry.coordinates[
                    Math.floor(c.geometry.coordinates.length / 2)
                ];
            expect(mid[0]).toBeGreaterThan(0.2);
        }
        // The ~33 km of slot wall was dropped: kept length is well under
        // the input's ~88 km but the open coast (~55 km) survives.
        const kept = totalLengthKm(out!);
        expect(kept).toBeGreaterThan(40);
        expect(kept).toBeLessThan(65);
    });

    it("returns [] when the only water is a narrow channel (no coastline exists)", () => {
        // A ~1.1 km wide east-west river crossing the whole frame. Both
        // banks are coastline in OSM terms, but the rulebook says a
        // waterway under 2 km across produces NO coastline.
        const south = coast([
            [0.5, 0.24],
            [0, 0.24],
        ]); // water north of travel-west line
        const north = coast([
            [0, 0.25],
            [0.5, 0.25],
        ]); // water south of travel-east line
        const seeker = { lng: 0.25, lat: 0.1 };
        const out = filterCoastlineByStraitRule([south, north], FRAME, seeker);
        expect(out).not.toBeNull();
        expect(out!.length).toBe(0);
    });

    it("returns null for a fully-interior lake ring (polygonize limitation → caller falls back)", () => {
        // A closed ring entirely inside the frame — a lake with no frame-edge
        // contact. The strait rule uses the PRECISE polygonize path (its 1 km
        // erosion/dilation needs smooth geometry, so it deliberately does NOT
        // use the blocky raster flood-fill that body-of-water/same-landmass
        // use). On a fully-interior ring polygonize degenerates (the outer face
        // gets mislabeled and trips the seeker-in-sea guard) → `seaFromCoastline`
        // returns null → the strait filter returns null. The caller
        // (`measuring.ts` coastline subtype) then falls back to the UNfiltered
        // coastline lines, which is the safe documented behaviour. (A real great
        // lake / open sea crosses the frame edge and is handled by the open-sea
        // test above; body-of-water's raster path resolves interior water via
        // its own useRaster build.)
        const ring = coast([
            [0.1, 0.37],
            [0.37, 0.37],
            [0.37, 0.1],
            [0.1, 0.1],
            [0.1, 0.37],
        ]);
        const seeker = { lng: 0.45, lat: 0.45 };
        const out = filterCoastlineByStraitRule([ring], FRAME, seeker);
        expect(out).toBeNull();
    });

    it("returns null for empty input (caller falls back to unfiltered)", () => {
        expect(
            filterCoastlineByStraitRule([], FRAME, { lng: 0.1, lat: 0.1 }),
        ).toBeNull();
    });
});
