import * as turf from "@turf/turf";
import type { Feature, Polygon } from "geojson";
import { describe, expect, it } from "vitest";

import {
    clipPolygonToLandWith,
    type LandPoly,
} from "@/lib/geometry/clipCore";

/** A rectangle polygon with `segs` intermediate points along each edge, so we
 *  can dial its local vertex density up or down. */
function denseRect(
    minLng: number,
    minLat: number,
    maxLng: number,
    maxLat: number,
    segs: number,
): Feature<Polygon> {
    const ring: [number, number][] = [];
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
    const edge = (
        ax: number,
        ay: number,
        bx: number,
        by: number,
    ) => {
        for (let i = 0; i < segs; i++) {
            const t = i / segs;
            ring.push([lerp(ax, bx, t), lerp(ay, by, t)]);
        }
    };
    edge(minLng, minLat, maxLng, minLat);
    edge(maxLng, minLat, maxLng, maxLat);
    edge(maxLng, maxLat, minLng, maxLat);
    edge(minLng, maxLat, minLng, minLat);
    ring.push(ring[0]);
    return turf.polygon([ring]);
}

function asLandPoly(f: Feature<Polygon>): LandPoly {
    return {
        feature: f,
        bbox: turf.bbox(f) as [number, number, number, number],
    };
}

describe("clipPolygonToLandWith resolution guard", () => {
    it("skips the clip when the boundary out-details the coarse land mask", () => {
        // Detailed boundary spanning x 0..20 (its right half is over 'water');
        // coarse land mask covers only x 0..10 with few vertices — the NYC case
        // (real coastal boundary vs a 1:50m mask). The clip must be SKIPPED so
        // the accurate boundary isn't coarsened / partly erased.
        const boundary = denseRect(0, 0, 20, 10, 40); // ~160 local vertices
        const coarseLand = denseRect(0, 0, 10, 10, 1); // 4-vertex square
        const out = clipPolygonToLandWith(boundary, [asLandPoly(coarseLand)], []);
        expect(out).not.toBeNull();
        // Unchanged: still spans into x>10 (area preserved), not trimmed to land.
        expect(turf.area(out!)).toBeCloseTo(turf.area(boundary), -1);
    });

    it("still clips a coarse jurisdictional boundary against a detailed coast", () => {
        // Coarse boundary (few vertices) spanning x 0..20; detailed land mask
        // covers only x 0..10 with high vertex density. The mask out-details the
        // boundary, so the clip SHOULD run and trim the x>10 'water' half.
        const boundary = denseRect(0, 0, 20, 10, 1); // 4-vertex square
        const detailedLand = denseRect(0, 0, 10, 10, 40); // ~160 vertices
        const out = clipPolygonToLandWith(
            boundary,
            [asLandPoly(detailedLand)],
            [],
        );
        expect(out).not.toBeNull();
        // Trimmed to ~the left half (land only).
        expect(turf.area(out!)).toBeLessThan(turf.area(boundary) * 0.75);
    });
});
