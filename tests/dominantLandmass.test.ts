import { describe, expect, it } from "vitest";

import {
    clipGeometryToDominantLandmass,
    collectCoordGroups,
    dominantExtentFromGroups,
    type PhotonExtent,
} from "../src/maps/geo-utils/dominantLandmass";

/** A dense rectangular ring of `n` vertices around [cLng,cLat] with half-span h. */
function denseRing(
    cLng: number,
    cLat: number,
    h: number,
    n: number,
): [number, number][] {
    const g: [number, number][] = [];
    for (let i = 0; i < n; i++) {
        const t = (i / n) * 2 * Math.PI;
        g.push([cLng + h * Math.cos(t), cLat + h * Math.sin(t)]);
    }
    return g;
}

describe("dominantExtentFromGroups", () => {
    it("returns the identical full bbox for a normal compact city (no-op)", () => {
        // Manhattan-ish: ~0.15° × 0.2°, well under the oversize threshold.
        const groups = [
            denseRing(-73.97, 40.78, 0.08, 400),
            denseRing(-73.95, 40.74, 0.05, 120),
        ];
        const ext = dominantExtentFromGroups(groups)!;
        // Full bbox over both rings.
        let minLng = Infinity,
            minLat = Infinity,
            maxLng = -Infinity,
            maxLat = -Infinity;
        for (const g of groups)
            for (const [lng, lat] of g) {
                minLng = Math.min(minLng, lng);
                minLat = Math.min(minLat, lat);
                maxLng = Math.max(maxLng, lng);
                maxLat = Math.max(maxLat, lat);
            }
        const expected: PhotonExtent = [maxLat, minLng, minLat, maxLng];
        expect(ext).toEqual(expected);
    });

    it("drops far sparse ocean islands from an oversized island-owning relation (Tokyo)", () => {
        // Dense mainland Tokyo ~35.7N,139.7E (thousands of verts) + far sparse
        // Izu/Ogasawara island scatter reaching down to ~27N and out to ~142E.
        const mainland = denseRing(139.7, 35.72, 0.35, 3000);
        // Izu Ōshima with a DETAILED (high-vertex) coastline — must still be
        // dropped (proximity-only keep; a vertex-count keep wrongly retained it).
        const izu1 = denseRing(139.5, 34.7, 0.05, 2500);
        const izu2 = denseRing(139.3, 33.1, 0.03, 400);
        const ogasawara1 = denseRing(142.2, 27.1, 0.02, 25);
        const ogasawara2 = denseRing(142.1, 26.6, 0.02, 25);
        const ext = dominantExtentFromGroups([
            mainland,
            izu1,
            izu2,
            ogasawara1,
            ogasawara2,
        ])!;
        const [n, w, s, e] = ext;
        // Should tightly frame the mainland ring only (~35.37–36.07 N, 139.35–140.05 E).
        expect(s).toBeGreaterThan(35.0); // did NOT include the 27N islands
        expect(n).toBeLessThan(36.2);
        expect(e).toBeLessThan(140.5); // did NOT include the 142E islands
        expect(w).toBeGreaterThan(139.0);
        // Span is now city-scale, not ocean-scale.
        expect(n - s).toBeLessThan(1);
        expect(e - w).toBeLessThan(1);
    });

    it("keeps a nearby second landmass of the same metro (bay islands)", () => {
        // Oversized overall (a far speck forces the clip on), but two nearby dense
        // landmasses ~0.3° apart should both survive.
        const a = denseRing(139.7, 35.7, 0.3, 2000);
        const b = denseRing(139.7, 35.2, 0.3, 1500); // ~0.5° away, comparably dense
        const farSpeck = denseRing(142.0, 27.0, 0.01, 15);
        const ext = dominantExtentFromGroups([a, b, farSpeck])!;
        const [n, , s] = ext;
        expect(s).toBeLessThan(35.0); // included landmass b (down to ~34.9)
        expect(n).toBeGreaterThan(35.9); // included landmass a (up to ~36.0)
        expect(n).toBeLessThan(36.2); // did NOT include the 27N speck
    });

    it("returns null for empty / coordinate-less input", () => {
        expect(dominantExtentFromGroups([])).toBeNull();
        expect(dominantExtentFromGroups([[]])).toBeNull();
    });
});

function ringPoly(
    cLng: number,
    cLat: number,
    h: number,
    n: number,
): GeoJSON.Feature<GeoJSON.Polygon> {
    return {
        type: "Feature",
        properties: {},
        geometry: { type: "Polygon", coordinates: [denseRing(cLng, cLat, h, n)] },
    };
}

describe("clipGeometryToDominantLandmass", () => {
    it("drops far island parts, keeping the mainland (Tokyo)", () => {
        const fc: GeoJSON.FeatureCollection = {
            type: "FeatureCollection",
            features: [
                {
                    type: "Feature",
                    properties: {},
                    geometry: {
                        type: "MultiPolygon",
                        coordinates: [
                            [denseRing(139.7, 35.72, 0.35, 3000)], // mainland
                            [denseRing(139.4, 34.0, 0.02, 20)], // Izu
                            [denseRing(142.2, 27.0, 0.02, 25)], // Ogasawara
                        ],
                    },
                },
            ],
        };
        const out = clipGeometryToDominantLandmass(fc);
        // One MultiPolygon of just the mainland part.
        expect(out.features).toHaveLength(1);
        const geom = out.features[0].geometry as GeoJSON.MultiPolygon;
        expect(geom.type).toBe("MultiPolygon");
        expect(geom.coordinates).toHaveLength(1);
        // Its bbox is the mainland, not the ocean.
        const ext = dominantExtentFromGroups(
            geom.coordinates.map((p) => p[0] as [number, number][]),
        )!;
        expect(ext[0]).toBeLessThan(36.2); // north
        expect(ext[2]).toBeGreaterThan(35.0); // south (no 27N island)
    });

    it("leaves a normal compact multi-part city unchanged (no-op)", () => {
        const fc: GeoJSON.FeatureCollection = {
            type: "FeatureCollection",
            features: [ringPoly(-74.0, 40.7, 0.1, 500), ringPoly(-73.9, 40.6, 0.08, 300)],
        };
        const out = clipGeometryToDominantLandmass(fc);
        expect(out).toBe(fc); // same reference — untouched
    });
});

describe("collectCoordGroups", () => {
    it("splits Overpass out-geom member ways into per-way groups", () => {
        const boundary = {
            elements: [
                {
                    type: "relation",
                    members: [
                        {
                            type: "way",
                            geometry: [
                                { lat: 35.7, lon: 139.7 },
                                { lat: 35.8, lon: 139.8 },
                            ],
                        },
                        {
                            type: "way",
                            geometry: [
                                { lat: 27.1, lon: 142.2 },
                                { lat: 27.0, lon: 142.1 },
                            ],
                        },
                    ],
                },
            ],
        };
        const groups = collectCoordGroups(boundary);
        expect(groups.length).toBe(2);
        expect(groups[0]).toEqual([
            [139.7, 35.7],
            [139.8, 35.8],
        ]);
    });

    it("splits a GeoJSON MultiPolygon into per-part rings", () => {
        const geo = {
            type: "MultiPolygon",
            coordinates: [
                [
                    [
                        [139.7, 35.7],
                        [139.8, 35.7],
                        [139.8, 35.8],
                        [139.7, 35.7],
                    ],
                ],
                [
                    [
                        [142.2, 27.1],
                        [142.3, 27.1],
                        [142.3, 27.2],
                        [142.2, 27.1],
                    ],
                ],
            ],
        };
        const groups = collectCoordGroups(geo);
        // Two rings (one per polygon part).
        expect(groups.length).toBe(2);
        expect(groups[0][0]).toEqual([139.7, 35.7]);
    });
});
