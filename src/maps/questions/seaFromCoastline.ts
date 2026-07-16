import * as turf from "@turf/turf";
import type {
    Feature,
    LineString,
    MultiLineString,
    MultiPolygon,
    Polygon,
    Position,
} from "geojson";

/**
 * Build a SEA (water) polygon from OSM `natural=coastline` LINES, clipped to a
 * play-area frame.
 *
 * Coastal cities (e.g. NYC) tag the open sea / harbour as `natural=coastline`
 * rather than `natural=water`, so the "is X closer to water than the seeker"
 * question needs a real water polygon derived from those lines. OSM's coastline
 * convention is: **LAND is on the LEFT of the way direction, WATER is on the
 * RIGHT** (Overpass `out geom` preserves way/node order, so the input
 * coordinates are in way order and carry that direction).
 *
 * The strategy: node the clipped coastline against the frame ring, polygonize
 * the result into faces that tile the frame, then label each face using the
 * right-hand rule (sample a point just to the RIGHT of each coastline segment;
 * whichever face contains it is water). Union the water faces.
 *
 * Returns `null` (never throws) whenever the result is missing, degenerate, or
 * fails a sanity guard — the caller is expected to fall back (e.g. treat the
 * city as inland).
 */

// Tolerance for deciding a coordinate lies on the frame boundary.
const BOUNDARY_EPS = 1e-9;

export function seaFromCoastline(
    coastlineLines: Feature<LineString | MultiLineString>[],
    frameBbox: [number, number, number, number], // [minLng, minLat, maxLng, maxLat]
    seeker: { lng: number; lat: number },
): Feature<Polygon | MultiPolygon> | null {
    try {
        // 1. No coastline → nothing to do.
        if (!coastlineLines || coastlineLines.length === 0) return null;

        const [minLng, minLat, maxLng, maxLat] = frameBbox;
        // 2. The frame polygon we clip and tile against.
        const framePoly = turf.bboxPolygon(frameBbox);

        // 3. Clip every coastline line to the frame, flattening MultiLineStrings
        //    into individual LineStrings and PRESERVING coordinate order (the
        //    OSM way direction that encodes which side is water).
        const clippedSegments: Position[][] = [];
        for (const line of coastlineLines) {
            let clipped: Feature<LineString | MultiLineString>;
            try {
                clipped = turf.bboxClip(line, frameBbox) as Feature<
                    LineString | MultiLineString
                >;
            } catch {
                continue;
            }
            if (!clipped || !clipped.geometry) continue;
            const geom = clipped.geometry;
            if (geom.type === "LineString") {
                if (geom.coordinates.length >= 2)
                    clippedSegments.push(geom.coordinates);
            } else if (geom.type === "MultiLineString") {
                for (const part of geom.coordinates) {
                    if (part.length >= 2) clippedSegments.push(part);
                }
            }
        }

        // 4. No coast inside the frame → caller handles the inland case.
        if (clippedSegments.length === 0) return null;

        // 5. Collect the clipped-segment endpoints that land ON the frame
        //    boundary, then split the frame ring's 4 edges at those points so the
        //    ring shares EXACT coordinates with the coastline endpoints. Without
        //    shared nodes, polygonize can't close faces along the boundary.
        const onBoundary = (p: Position): boolean =>
            Math.abs(p[0] - minLng) < BOUNDARY_EPS ||
            Math.abs(p[0] - maxLng) < BOUNDARY_EPS ||
            Math.abs(p[1] - minLat) < BOUNDARY_EPS ||
            Math.abs(p[1] - maxLat) < BOUNDARY_EPS;

        const boundaryPoints: Position[] = [];
        for (const seg of clippedSegments) {
            for (const end of [seg[0], seg[seg.length - 1]]) {
                if (onBoundary(end)) boundaryPoints.push(end);
            }
        }

        // The 4 frame corners, in CCW order matching bboxPolygon's ring.
        const corners: Record<string, Position[]> = {
            bottom: [
                [minLng, minLat],
                [maxLng, minLat],
            ],
            right: [
                [maxLng, minLat],
                [maxLng, maxLat],
            ],
            top: [
                [maxLng, maxLat],
                [minLng, maxLat],
            ],
            left: [
                [minLng, maxLat],
                [minLng, minLat],
            ],
        };

        // Which edge a boundary point belongs to, and its scalar param along it.
        const nearlyEq = (a: number, b: number) => Math.abs(a - b) < BOUNDARY_EPS;
        const frameEdges: Position[][] = [];
        for (const [edge, ends] of Object.entries(corners)) {
            const [start, end] = ends;
            // Points on this edge (including endpoints), deduped, sorted by param.
            const pts: Position[] = [start, end];
            for (const bp of boundaryPoints) {
                let on = false;
                if (edge === "bottom" && nearlyEq(bp[1], minLat)) on = true;
                else if (edge === "top" && nearlyEq(bp[1], maxLat)) on = true;
                else if (edge === "left" && nearlyEq(bp[0], minLng)) on = true;
                else if (edge === "right" && nearlyEq(bp[0], maxLng)) on = true;
                if (on) pts.push(bp);
            }
            // Sort along the edge direction (start → end).
            const dx = end[0] - start[0];
            const dy = end[1] - start[1];
            const param = (p: Position) =>
                (p[0] - start[0]) * dx + (p[1] - start[1]) * dy;
            pts.sort((a, b) => param(a) - param(b));
            // Dedupe consecutive near-identical points.
            const uniq: Position[] = [];
            for (const p of pts) {
                const last = uniq[uniq.length - 1];
                if (
                    !last ||
                    !nearlyEq(last[0], p[0]) ||
                    !nearlyEq(last[1], p[1])
                ) {
                    uniq.push(p);
                }
            }
            // Emit consecutive sub-edges.
            for (let i = 0; i < uniq.length - 1; i++) {
                frameEdges.push([uniq[i], uniq[i + 1]]);
            }
        }

        // 6. Polygonize (coastline segments + frame sub-edges) into faces.
        const lineFeatures: Feature<LineString>[] = [
            ...clippedSegments.map((c) => turf.lineString(c)),
            ...frameEdges.map((e) => turf.lineString(e)),
        ];
        let faces: Feature<Polygon>[];
        try {
            const polygonized = turf.polygonize(
                turf.featureCollection(lineFeatures),
            );
            faces = polygonized.features as Feature<Polygon>[];
        } catch {
            return null;
        }
        if (!faces || faces.length === 0) return null;

        // 7. LABEL each face by ITS OWN geometry relative to the coastline
        //    NEAREST TO IT (OSM land-left / water-right). This replaced the old
        //    "sample 44 m to the right of every segment and flood the containing
        //    face" approach (v896): in dense real-world coast (NYC's harbour +
        //    tidal rivers) a single stray or mis-directed segment flooded a big
        //    INLAND face as water, so an inland area far from any water got
        //    marked "closer to water" than the seeker. Classifying each face by
        //    the coast nearest to it makes a distant segment unable to influence
        //    a face it doesn't bound: an inland face's nearest coast puts it on
        //    the LAND side, so it stays land.
        //
        //    Flatten the clipped coastline into a list of directed segments
        //    once; for a query point q, find the nearest segment a→b and test
        //    which side of it q lies on. The RIGHT-hand (water) normal of a→b in
        //    (lng,lat) is (Δlat, −Δlng), so q is on the water side iff
        //    (q−a)·(Δlat,−Δlng) = (q.lng−a.lng)·Δlat − (q.lat−a.lat)·Δlng > 0.
        const segList: { a: Position; b: Position; len: number }[] = [];
        for (const seg of clippedSegments) {
            for (let i = 0; i < seg.length - 1; i++) {
                const a = seg[i];
                const b = seg[i + 1];
                const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
                if (len === 0) continue; // zero-length
                segList.push({ a, b, len });
            }
        }
        if (segList.length === 0) return null;

        // Side of the coastline NEAREST to q. Returns the SUMMED signed
        // perpendicular offset (normalised per segment) over every segment at
        // the minimum distance; > 0 ⇒ RIGHT (water) side. Summing matters at a
        // shared VERTEX, where q's nearest point is a corner touched by two
        // segments and a single-segment side test is degenerate (q can be
        // collinear with one of them) — adding the two normalised crosses is
        // the angle-bisector rule, correct for convex and reflex corners alike.
        const waterSide = (q: Position): number => {
            const d2s = new Array<number>(segList.length);
            let dmin = Infinity;
            for (let i = 0; i < segList.length; i++) {
                const { a, b } = segList[i];
                const abx = b[0] - a[0];
                const aby = b[1] - a[1];
                const apx = q[0] - a[0];
                const apy = q[1] - a[1];
                const len2 = abx * abx + aby * aby;
                let t = len2 > 0 ? (apx * abx + apy * aby) / len2 : 0;
                if (t < 0) t = 0;
                else if (t > 1) t = 1;
                const dx = q[0] - (a[0] + t * abx);
                const dy = q[1] - (a[1] + t * aby);
                const d2 = dx * dx + dy * dy;
                d2s[i] = d2;
                if (d2 < dmin) dmin = d2;
            }
            const tol = dmin * 1e-6 + 1e-18;
            let sum = 0;
            for (let i = 0; i < segList.length; i++) {
                if (d2s[i] > dmin + tol) continue;
                const { a, b, len } = segList[i];
                const abx = b[0] - a[0];
                const aby = b[1] - a[1];
                const apx = q[0] - a[0];
                const apy = q[1] - a[1];
                // (q−a)·(Δlat,−Δlng): right-hand normal of a→b, per-unit-length.
                sum += (apx * aby - apy * abx) / len;
            }
            return sum;
        };

        // A point guaranteed to be STRICTLY inside a (possibly concave) face:
        // the centroid when it's inside, else the centroid of the face's
        // largest triangle (triangles are convex, so a triangle centroid is
        // always interior). `pointOnFeature` is NOT reliable here — for a
        // concave face whose centroid falls outside it, it returns a boundary
        // VERTEX, which classifies ambiguously.
        const interiorPoint = (face: Feature<Polygon>): Position | null => {
            try {
                const c = turf.centroid(face).geometry.coordinates as Position;
                // STRICTLY inside — a centroid landing on the boundary (e.g. a
                // concave face whose centroid sits on the shared coast vertex)
                // would classify degenerately (side 0), so fall through to a
                // triangle centroid, which is always strictly interior.
                if (
                    turf.booleanPointInPolygon(turf.point(c), face, {
                        ignoreBoundary: true,
                    })
                )
                    return c;
            } catch {
                // fall through to triangulation
            }
            try {
                const tri = turf.tesselate(face);
                let best: Position | null = null;
                let bestA = -Infinity;
                for (const t of tri.features) {
                    const a = turf.area(t);
                    if (a > bestA) {
                        bestA = a;
                        best = turf.centroid(t).geometry
                            .coordinates as Position;
                    }
                }
                if (best) return best;
            } catch {
                // fall through
            }
            try {
                return turf.pointOnFeature(face).geometry
                    .coordinates as Position;
            } catch {
                return null;
            }
        };

        // Bias near-boundary faces toward LAND (don't over-claim water — the
        // reported failure was the opposite direction).
        const SIDE_EPS = 1e-12;
        const waterFaces: Feature<Polygon>[] = [];
        for (const face of faces) {
            const q = interiorPoint(face);
            if (!q) continue;
            if (waterSide(q) > SIDE_EPS) waterFaces.push(face);
        }

        if (waterFaces.length === 0) return null;

        // 8. Union the water faces into a single sea polygon.
        let sea: Feature<Polygon | MultiPolygon> | null = null;
        try {
            if (waterFaces.length === 1) {
                sea = waterFaces[0];
            } else {
                sea = turf.union(
                    turf.featureCollection(waterFaces),
                ) as Feature<Polygon | MultiPolygon> | null;
            }
        } catch {
            return null;
        }

        // 9. GUARDS — return null so the caller falls back.
        if (!sea || !sea.geometry) return null;
        let seaArea = 0;
        try {
            seaArea = turf.area(sea);
        } catch {
            return null;
        }
        // (a) empty / zero-area sea.
        if (seaArea <= 0) return null;
        // (b) the seeker is on LAND, so a correctly-wound sea must NOT contain
        //     them. If it does, we mislabeled / inverted the winding.
        try {
            if (turf.booleanPointInPolygon(turf.point([seeker.lng, seeker.lat]), sea))
                return null;
        } catch {
            return null;
        }
        // (c) sea covering essentially the whole frame is degenerate.
        let frameArea = 0;
        try {
            frameArea = turf.area(framePoly);
        } catch {
            return null;
        }
        if (frameArea > 0 && seaArea > 0.98 * frameArea) return null;

        return sea;
    } catch {
        // Never throw — any unexpected failure means "no usable sea".
        return null;
    }
}
