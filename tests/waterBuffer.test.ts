import {
    area as turfArea,
    bboxPolygon,
    booleanPointInPolygon,
    difference,
    featureCollection,
    intersect,
    point,
} from "@turf/turf";
import type { Feature, MultiPolygon, Polygon } from "geojson";
import { describe, expect, it } from "vitest";

import {
    bufferAndUnionImpl,
    bufferWaterGridImpl,
} from "@/lib/geometry/worker";

/**
 * Regression tests for the body-of-water buffer — specifically whether the
 * GEOGRAPHIC CHUNKING (`bufferWaterGridImpl`, v1141) produces the SAME "closer
 * than my nearest water" region as the non-chunked `bufferAndUnionImpl`.
 *
 * The reported bug (v1141–v1144, NYC + adjacents): the overlay counted inland
 * ponds but IGNORED the open ocean/shoreline. These tests reproduce that with
 * synthetic geometry — a big OCEAN polygon on the right + a small inland POND —
 * fed as ONE dissolved MultiPolygon (exactly how `getDissolvedBasemapWater`
 * hands it to the buffer). A point INSIDE the ocean has distance 0 to water, so
 * it MUST be in the "closer" region regardless of the buffer radius; if chunking
 * drops the ocean, that assertion fails.
 */

// Axis-aligned rectangle ring [ [lng,lat], ... ] (closed).
function rect(
    w: number,
    s: number,
    e: number,
    n: number,
): number[][] {
    return [
        [w, s],
        [e, s],
        [e, n],
        [w, n],
        [w, s],
    ];
}

// The dissolved basemap water = ONE MultiPolygon feature: a big OCEAN (right
// half) + a small inland POND (left).
const OCEAN = rect(0.6, 0, 1, 1);
const POND = rect(0.2, 0.2, 0.24, 0.24);
const water: Feature<MultiPolygon> = {
    type: "Feature",
    properties: {},
    geometry: {
        type: "MultiPolygon",
        coordinates: [[OCEAN], [POND]],
    },
};

const BBOX: [number, number, number, number] = [0, 0, 1, 1];
// Seeker on land, ~0.1° (≈11 km) west of the ocean shore (x=0.6).
const SEEKER = { lat: 0.5, lng: 0.5 };

const inside = (
    region: Feature<Polygon | MultiPolygon> | null,
    lng: number,
    lat: number,
): boolean =>
    region != null && booleanPointInPolygon(point([lng, lat]), region as never);

/** Symmetric-difference area ÷ reference area — how much the chunked region
 *  deviates from the non-chunked ground truth. Artifacts (notches / channels /
 *  seams) show up as a large ratio even when point-coverage tests pass. */
function symDiffRatio(
    chunked: Feature<Polygon | MultiPolygon> | null,
    truth: Feature<Polygon | MultiPolygon> | null,
): number {
    if (!chunked || !truth) return 1;
    const refA = turfArea(truth as never);
    if (refA <= 0) return 1;
    let sym = 0;
    try {
        const a = difference(
            featureCollection([chunked as never, truth as never]),
        );
        const b = difference(
            featureCollection([truth as never, chunked as never]),
        );
        sym =
            (a ? turfArea(a as never) : 0) + (b ? turfArea(b as never) : 0);
    } catch {
        return 1;
    }
    return sym / refA;
}

// A jagged, CONCAVE shoreline (the real failure — clean rectangles hid the
// artifacts). The ocean is the right side; its shore (left edge) is a fine
// zigzag, and there are a couple of inland ponds.
function jaggedWater(): Feature<MultiPolygon> {
    const shoreRing: number[][] = [];
    const STEPS = 200;
    for (let k = 0; k <= STEPS; k++) {
        const lat = (k / STEPS) * 1;
        const lng = 0.6 + 0.04 * Math.sin(lat * 40) + 0.02 * Math.sin(lat * 13);
        shoreRing.push([lng, lat]);
    }
    // Close the ocean polygon around the right side.
    shoreRing.push([1, 1], [1, 0], shoreRing[0]);
    return {
        type: "Feature",
        properties: {},
        geometry: {
            type: "MultiPolygon",
            coordinates: [
                [shoreRing],
                [rect(0.2, 0.2, 0.24, 0.24)],
                [rect(0.35, 0.7, 0.38, 0.73)],
            ],
        },
    };
}

describe("body-of-water buffer", () => {
    it("non-chunked (bufferAndUnion) covers the ocean interior + shore band", () => {
        const region = bufferAndUnionImpl({ features: [water], seeker: SEEKER });
        expect(region).not.toBeNull();
        // Deep inside the ocean → distance 0 → always "closer".
        expect(inside(region, 0.8, 0.5)).toBe(true);
        expect(inside(region, 0.95, 0.5)).toBe(true);
        // Inland pond interior → distance 0 → "closer".
        expect(inside(region, 0.22, 0.22)).toBe(true);
        // Land just west of the ocean shore (≈5.5 km < r) → "closer".
        expect(inside(region, 0.55, 0.5)).toBe(true);
        // Far corner, beyond r from all water → NOT "closer".
        expect(inside(region, 0.02, 0.98)).toBe(false);
    });

    it("chunked (bufferWaterGrid, 4x4) covers the ocean interior + shore band", () => {
        const region = bufferWaterGridImpl({
            features: [water],
            bbox: BBOX,
            seeker: SEEKER,
            grid: 4,
        });
        expect(region).not.toBeNull();
        // THE CRITICAL ASSERTION: the ocean must not be dropped by chunking.
        expect(inside(region, 0.8, 0.5)).toBe(true);
        expect(inside(region, 0.95, 0.5)).toBe(true);
        expect(inside(region, 0.22, 0.22)).toBe(true);
        expect(inside(region, 0.55, 0.5)).toBe(true);
        expect(inside(region, 0.02, 0.98)).toBe(false);
    });

    it("chunked covers an ocean that has an ISLAND HOLE", () => {
        // Ocean (right half) with an island hole in the middle of it — the real
        // sea has islands, which become holes in the water polygon.
        const oceanWithHole: Feature<Polygon> = {
            type: "Feature",
            properties: {},
            geometry: {
                type: "Polygon",
                coordinates: [OCEAN, rect(0.75, 0.45, 0.8, 0.5)],
            },
        };
        const region = bufferWaterGridImpl({
            features: [oceanWithHole],
            bbox: BBOX,
            seeker: SEEKER,
            grid: 4,
        });
        expect(region).not.toBeNull();
        // Open ocean away from the island hole → covered.
        expect(inside(region, 0.9, 0.9)).toBe(true);
        expect(inside(region, 0.65, 0.1)).toBe(true);
    });

    it("chunked covers an ocean that is ONE MultiPolygon with MANY members", () => {
        // The REAL failure shape (v1145 diag: sub=1158): the dissolved water is
        // ONE feature whose geometry is a MultiPolygon with hundreds of members
        // (the ocean + a big grid of tile-fragment pieces). Per-cell
        // intersect(hugeMultiPolygon, box) must still clip the ocean member.
        const members: number[][][] = [];
        // A 24×24 grid of small adjacent squares tiling the RIGHT half (ocean),
        // as separate MultiPolygon members (≈576, real order of magnitude).
        for (let gx = 0; gx < 24; gx++) {
            for (let gy = 0; gy < 24; gy++) {
                const w0 = 0.6 + (gx / 24) * 0.4;
                const e0 = 0.6 + ((gx + 1) / 24) * 0.4;
                const s0 = (gy / 24) * 1;
                const n0 = ((gy + 1) / 24) * 1;
                members.push([rect(w0, s0, e0, n0)]);
            }
        }
        members.push([POND]);
        const bigMulti: Feature<MultiPolygon> = {
            type: "Feature",
            properties: {},
            geometry: { type: "MultiPolygon", coordinates: members },
        };
        const region = bufferWaterGridImpl({
            features: [bigMulti],
            bbox: BBOX,
            seeker: SEEKER,
            grid: 4,
        });
        expect(region).not.toBeNull();
        // The ocean interior MUST be covered.
        expect(inside(region, 0.8, 0.5)).toBe(true);
        expect(inside(region, 0.95, 0.5)).toBe(true);
        expect(inside(region, 0.7, 0.9)).toBe(true);
    });

    it("chunked matches the NON-chunked region on a jagged shoreline (no artifacts)", () => {
        // THE SHAPE TEST: the chunked buffer must produce ~the same region as the
        // non-chunked ground truth. Notches / channels / seams from chunking show
        // up as a large symmetric difference even though point-coverage passes.
        const w = jaggedWater();
        const truthRaw = bufferAndUnionImpl({ features: [w], seeker: SEEKER });
        const chunked = bufferWaterGridImpl({
            features: [w],
            bbox: BBOX,
            seeker: SEEKER,
            grid: 4,
        });
        expect(truthRaw).not.toBeNull();
        expect(chunked).not.toBeNull();
        // The chunked result is bbox-clipped (cells tile the bbox); the
        // non-chunked buffer extends r beyond the bbox. Clip the ground truth to
        // the bbox so we compare the SAME extent — otherwise the out-of-bbox band
        // dwarfs any real artifact.
        const box = bboxPolygon(BBOX);
        const truth = intersect(
            featureCollection([truthRaw as never, box as never]),
        ) as Feature<Polygon | MultiPolygon> | null;
        const ratio = symDiffRatio(chunked, truth);
        // Allow a small margin for the global simplify; artifacts would blow this
        // well past a few percent.
        expect(ratio).toBeLessThan(0.05);
    });

    it("chunked counts MANY separate small ponds (z13-style) with a clean shape", () => {
        // z13 reads small park ponds as many SEPARATE small polygon features
        // (undissolved). The per-cell-dissolve path must count every one AND match
        // the non-chunked region (no artifacts from the separate pieces).
        const ponds: Feature<Polygon>[] = [];
        const centres: Array<[number, number]> = [];
        for (let a = 0; a < 5; a++) {
            for (let b = 0; b < 5; b++) {
                const cx = 0.12 + a * 0.18;
                const cy = 0.12 + b * 0.18;
                ponds.push({
                    type: "Feature",
                    properties: { kind: "water" },
                    geometry: {
                        type: "Polygon",
                        coordinates: [rect(cx, cy, cx + 0.015, cy + 0.015)],
                    },
                });
                centres.push([cx + 0.007, cy + 0.007]);
            }
        }
        const truthRaw = bufferAndUnionImpl({ features: ponds, seeker: SEEKER });
        const chunked = bufferWaterGridImpl({
            features: ponds,
            bbox: BBOX,
            seeker: SEEKER,
            grid: 4,
        });
        expect(chunked).not.toBeNull();
        // Every pond interior (distance 0) must be in the region.
        for (const [lng, lat] of centres) {
            expect(inside(chunked, lng, lat)).toBe(true);
        }
        // And the shape matches the non-chunked ground truth (bbox-clipped).
        const box = bboxPolygon(BBOX);
        const truth = intersect(
            featureCollection([truthRaw as never, box as never]),
        ) as Feature<Polygon | MultiPolygon> | null;
        expect(symDiffRatio(chunked, truth)).toBeLessThan(0.05);
    });

    it("chunked covers an ocean supplied as MANY tile-piece features (undissolved)", () => {
        // If the dissolve fails upstream, the buffer gets the RAW tile pieces:
        // many separate small polygon features that together form the ocean.
        const pieces: Feature<Polygon>[] = [];
        for (let gx = 6; gx < 10; gx++) {
            for (let gy = 0; gy < 10; gy++) {
                pieces.push({
                    type: "Feature",
                    properties: { kind: "ocean" },
                    geometry: {
                        type: "Polygon",
                        coordinates: [
                            rect(gx / 10, gy / 10, (gx + 1) / 10, (gy + 1) / 10),
                        ],
                    },
                });
            }
        }
        const region = bufferWaterGridImpl({
            features: pieces,
            bbox: BBOX,
            seeker: SEEKER,
            grid: 4,
        });
        expect(region).not.toBeNull();
        expect(inside(region, 0.8, 0.5)).toBe(true);
        expect(inside(region, 0.95, 0.5)).toBe(true);
    });
});
