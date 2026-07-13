// Named imports (not `import * as turf`) so this geometry-worker bundle
// tree-shakes to just the functions it uses — matching the sibling workers
// (hidingZonesUnion / seekerZones) and shrinking the worker's Rollup chunk.
import {
    area,
    bbox,
    centroid,
    difference,
    distance,
    featureCollection,
    intersect,
    rewind,
    union,
} from "@turf/turf";
import type {
    Feature,
    FeatureCollection,
    MultiPolygon,
    Polygon,
} from "geojson";

/**
 * Pure, synchronous compute core for clipping a play-area polygon to
 * land. Extracted from `landClip.ts` so the SAME algorithm can run in
 * two places without duplication:
 *
 *   - on the main thread (`landClip.ts`, the fallback path), and
 *   - inside the geometry Web Worker (`geometry/worker.ts`), so a huge
 *     boundary (e.g. Tokyo Metropolis sweeping ~1000 km to the
 *     Ogasawara Islands) can no longer FREEZE the UI while turf grinds
 *     through hundreds of intersect/union calls.
 *
 * Everything here is turf-only + plain data — no `fetch`, no Cache API,
 * no DOM, no React. The land/lake masks are passed in already parsed
 * (see `parseLandPolys` / `parseLakePolys`), so the caller owns I/O and
 * this core stays trivially worker-safe.
 *
 * The behaviour mirrors the original `clipPolygonToLand` exactly — see
 * the long-form rationale comments in `landClip.ts`.
 */

/** A land polygon with a precomputed bbox for O(n) overlap filtering. */
export type LandPoly = {
    feature: Feature<Polygon>;
    bbox: [number, number, number, number];
};

/** An inland-lake polygon with a precomputed bbox. */
export type LakePoly = {
    feature: Feature<Polygon | MultiPolygon>;
    bbox: [number, number, number, number];
};

/**
 * Turn the bundled Natural Earth 1:50m coastline FeatureCollection into
 * closed land polygons with precomputed bboxes. The file is pure
 * LineString; closed loops (islands + continents) become polygons,
 * open continental fragments around the antimeridian are skipped.
 */
export function parseLandPolys(fc: FeatureCollection): LandPoly[] {
    const out: LandPoly[] = [];
    for (const f of fc.features) {
        const g = f.geometry;
        if (!g) continue;
        if (g.type === "LineString") {
            const coords = g.coordinates;
            if (coords.length < 4) continue;
            const first = coords[0];
            const last = coords[coords.length - 1];
            if (first[0] !== last[0] || first[1] !== last[1]) {
                // Open line — continent fragment around the
                // antimeridian. Closing it would produce a bogus
                // polygon, so skip.
                continue;
            }
            // Natural Earth coastlines wind CW around land, the
            // opposite of GeoJSON's outer-ring convention (CCW).
            // Without rewinding, the "polygon" would represent the
            // OCEAN instead of the land (the v149 Sweden bug).
            let poly: Feature<Polygon> = {
                type: "Feature",
                properties: {},
                geometry: { type: "Polygon", coordinates: [coords] },
            };
            try {
                poly = rewind(poly, {
                    reverse: false,
                }) as Feature<Polygon>;
            } catch {
                /* malformed ring — fall through with raw orientation */
            }
            out.push({
                feature: poly,
                bbox: bbox(poly) as [number, number, number, number],
            });
        }
    }
    return out;
}

/**
 * Turn the bundled Natural Earth 1:50m lakes FeatureCollection into
 * polygons with precomputed bboxes. Malformed features are skipped.
 */
export function parseLakePolys(fc: FeatureCollection): LakePoly[] {
    const out: LakePoly[] = [];
    for (const f of fc.features) {
        const g = f.geometry;
        if (!g || (g.type !== "Polygon" && g.type !== "MultiPolygon")) {
            continue;
        }
        const feature = f as Feature<Polygon | MultiPolygon>;
        try {
            out.push({
                feature,
                bbox: bbox(feature) as [number, number, number, number],
            });
        } catch {
            /* skip malformed lake */
        }
    }
    return out;
}

function bboxesOverlap(
    a: [number, number, number, number],
    b: [number, number, number, number],
): boolean {
    return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
}

/** Min size of a piece relative to the largest piece, for the keep
 *  decision below. Tokyo's Izu islands sit at 1-15 % of mainland. */
const MIN_RELATIVE_AREA = 0.1;
/** Max centroid distance from the largest piece, in km, for a piece
 *  to be kept under the "small but close" branch. */
const MAX_PIECE_DISTANCE_KM = 60;

/**
 * Keep only the meaningful pieces of a freshly-land-clipped play-area:
 * the largest piece, plus any other that's substantial on its own
 * merits OR close enough to the main piece to be reachable. Drops
 * far-flung legal exclaves (Tokyo's Pacific island chain) while
 * preserving cases like the UK + Northern Ireland.
 */
function filterMeaningfulPieces(
    pieces: Feature<Polygon | MultiPolygon>[],
): Feature<Polygon | MultiPolygon>[] {
    if (pieces.length <= 1) return pieces;
    let withMeta: {
        piece: Feature<Polygon | MultiPolygon>;
        area: number;
        center: Feature<{ type: "Point"; coordinates: [number, number] }> | null;
    }[];
    try {
        withMeta = pieces.map((p) => {
            const a = area(p);
            let c: any = null;
            try {
                c = centroid(p);
            } catch {
                c = null;
            }
            return { piece: p, area: a, center: c };
        });
    } catch {
        return pieces;
    }
    withMeta.sort((a, b) => b.area - a.area);
    const largest = withMeta[0];
    if (!largest.center || largest.area <= 0) return pieces;

    const largestCenter = largest.center;
    const kept = withMeta.filter((it, idx) => {
        if (idx === 0) return true;
        if (it.area / largest.area >= MIN_RELATIVE_AREA) return true;
        if (!it.center) return false;
        try {
            const km = distance(largestCenter, it.center, {
                units: "kilometers",
            });
            return km <= MAX_PIECE_DISTANCE_KM;
        } catch {
            return false;
        }
    });
    if (kept.length === withMeta.length) return pieces;
    return kept.map((it) => it.piece);
}

/** Subtract every overlapping lake from a (land-clipped) feature.
 *  Synchronous; best-effort. */
function subtractLakes(
    feature: Feature<Polygon | MultiPolygon>,
    lakes: LakePoly[],
): Feature<Polygon | MultiPolygon> {
    if (lakes.length === 0) return feature;
    const fBbox = bbox(feature) as [number, number, number, number];
    const overlapping = lakes.filter((l) => bboxesOverlap(fBbox, l.bbox));
    if (overlapping.length === 0) return feature;
    let acc = feature;
    for (const lake of overlapping) {
        try {
            const diff = difference(
                featureCollection([acc, lake.feature]),
            ) as Feature<Polygon | MultiPolygon> | null;
            // null means the lake fully covers the feature — that'd
            // mean the whole play area is water, which is never right,
            // so keep the previous accumulator.
            if (diff && diff.geometry) acc = diff;
        } catch {
            /* skip any lake that fails the topology check */
        }
    }
    return acc;
}

/** Keep at least this fraction of the input area, else treat the clip
 *  as a bug and bail (fall back to the raw polygon). */
const MIN_KEEP = 0.4;

/** Count coordinate vertices of a geometry that fall inside `bbox`
 *  ([minLng, minLat, maxLng, maxLat]). Used to compare the LOCAL detail of
 *  the boundary vs the land mask — a whole-feature count is useless because a
 *  "relevant" land feature can be a continent-sized polygon. */
function countVerticesInBbox(
    geom: Polygon | MultiPolygon,
    bbox: [number, number, number, number],
): number {
    let n = 0;
    const [minLng, minLat, maxLng, maxLat] = bbox;
    const walk = (c: unknown): void => {
        if (Array.isArray(c) && typeof c[0] === "number") {
            const [lng, lat] = c as number[];
            if (lng >= minLng && lng <= maxLng && lat >= minLat && lat <= maxLat)
                n++;
            return;
        }
        if (Array.isArray(c)) for (const x of c) walk(x);
    };
    walk(geom.coordinates);
    return n;
}

/**
 * Clip a play-area polygon to land only, given the already-parsed land
 * + lake masks. Pure and synchronous. Returns the clipped geometry, or
 * `null` if the input was malformed / the clip looks wrong (caller
 * should keep the original polygon). Never throws.
 */
export function clipPolygonToLandWith(
    polygon: Feature<Polygon | MultiPolygon>,
    landPolys: LandPoly[],
    lakePolys: LakePoly[],
): Feature<Polygon | MultiPolygon> | null {
    try {
        const playBbox = bbox(polygon) as [
            number,
            number,
            number,
            number,
        ];
        const relevant = landPolys.filter((p) =>
            bboxesOverlap(playBbox, p.bbox),
        );
        if (relevant.length === 0) return null;

        // Resolution guard (v746): the bundled land mask is Natural Earth
        // 1:50m — extremely coarse (~41 vertices across ALL of NYC). Clipping a
        // boundary that ALREADY follows the real coast in detail against this
        // coarse mask only COARSENS it (straight-edge artifacts) and, worse,
        // DROPS narrow real land the mask can't resolve (at 1:50m the Hudson /
        // East River aren't rendered, so Manhattan reads as "water" and gets
        // clipped away — the "NYC boundary is so wrong" bug). The clip exists to
        // trim JURISDICTIONAL water from boundaries that DON'T follow the coast
        // (few vertices out over the sea); a boundary with MORE local coastline
        // detail than the mask already follows the coast, so keep it verbatim.
        // Compared within the play bbox so a continent-sized land feature's
        // global vertex count doesn't swamp the local comparison.
        const polyVerts = countVerticesInBbox(polygon.geometry, playBbox);
        const maskVerts = relevant.reduce(
            (sum, p) => sum + countVerticesInBbox(p.feature.geometry, playBbox),
            0,
        );
        if (polyVerts > maskVerts) return polygon;

        const pieces: Feature<Polygon | MultiPolygon>[] = [];
        for (const land of relevant) {
            try {
                const inter = intersect(
                    featureCollection([polygon, land.feature]),
                ) as Feature<Polygon | MultiPolygon> | null;
                if (inter && inter.geometry) {
                    pieces.push(inter);
                }
            } catch {
                /* skip any pair that fails the topology check */
            }
        }
        if (pieces.length === 0) return null;
        let acc: Feature<Polygon | MultiPolygon>;
        if (pieces.length === 1) {
            acc = pieces[0];
        } else {
            const filtered = filterMeaningfulPieces(pieces);
            acc = filtered[0];
            for (let i = 1; i < filtered.length; i++) {
                try {
                    const u = union(
                        featureCollection([acc, filtered[i]]),
                    ) as Feature<Polygon | MultiPolygon> | null;
                    if (u) acc = u;
                } catch {
                    /* skip any pair that fails the topology check */
                }
            }
        }

        acc = subtractLakes(acc, lakePolys);

        try {
            const inArea = area(polygon);
            const outArea = area(acc);
            if (inArea > 0 && outArea / inArea < MIN_KEEP) {
                console.warn(
                    `clipPolygonToLand kept only ${(
                        (outArea / inArea) *
                        100
                    ).toFixed(
                        1,
                    )}% of input area — likely a bad clip; falling back to raw polygon.`,
                );
                return null;
            }
        } catch {
            /* area comparison failed — proceed with the clip */
        }
        return acc;
    } catch (e) {
        console.warn("clipPolygonToLandWith failed:", e);
        return null;
    }
}
