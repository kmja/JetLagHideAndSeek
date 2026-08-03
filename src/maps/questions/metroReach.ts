import * as turf from "@turf/turf";

import { haversineMeters } from "@/lib/geo";
import type { Units } from "@/maps/schema";

/**
 * PURE metro-tentacle geometry — the TRUE nearest-LINE partition of the reach
 * circle. Deliberately worker-safe: imports ONLY turf + the pure `haversineMeters`
 * helper + the `Units` TYPE (erased), so it runs in the geometry Web Worker (off
 * the main thread) AND on the main thread as the fallback. No atoms, no network,
 * no React reach here. `tentacles.ts` does the fetch (INCLUDING the v1271 grouping
 * of services into trunks by colour) + the diagnostic-atom write; this only computes.
 *
 * v1282 — compute what the EYE does: for every point, the distance to the actual
 * LINE geometry (not to sampled dots), assign it to the nearest line. Every prior
 * attempt sampled points ALONG the lines and ran a Voronoi over those DOTS — which
 * is nearest-SAMPLE-POINT, not nearest-LINE, and diverges badly: in open areas far
 * from any line the boundaries become radial slivers between individual dots (the
 * "sunburst" spikes), and between two parallel lines the boundary only lands on the
 * midline if both are dotted at identical density/phase (they never are). Here we
 * evaluate the real point→polyline distance on a grid, so the boundary between two
 * parallel lines is the true perpendicular bisector — the MIDLINE — by construction,
 * and spikes are impossible (a lone line's region is bounded by real bisectors).
 * Per trunk we merge its cells into rectangles, union, and SIMPLIFY (Douglas–Peucker
 * collapses the grid stair-steps toward straight edges — NOT Chaikin, which blobbed).
 */

export interface MetroLine {
    name: string;
    /** Flat vertex list (all member ways concatenated) — sampling + reach filter. */
    coords: [number, number][];
    /** Per-way vertex lists — for drawing without joining disjoint way pieces. */
    segments: [number, number][][];
    /** The line's OSM `colour`, if tagged. */
    color?: string;
}

export interface MetroReachCell {
    cell: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>;
    name: string;
    color?: string;
}
export interface MetroReachResult {
    cells: MetroReachCell[];
    lines: Array<{
        name: string;
        segments: [number, number][][];
        color?: string;
    }>;
}

// Grid resolution — ~this many columns across the reach-circle bbox, cell size
// clamped and total cells capped so a big (25 km-radius) tentacle stays tractable.
const GRID_TARGET_COLS = 220;
const GRID_MIN_CELL_M = 50;
const GRID_MAX_CELL_M = 280;
const GRID_MAX_CELLS = 70000;

/** Squared distance (in the local metre plane) from a point to a segment. */
function ptSegDistSq(
    px: number,
    py: number,
    ax: number,
    ay: number,
    bx: number,
    by: number,
): number {
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy;
    if (l2 === 0) {
        const ex = px - ax;
        const ey = py - ay;
        return ex * ex + ey * ey;
    }
    let t = ((px - ax) * dx + (py - ay) * dy) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = ax + t * dx;
    const cy = ay + t * dy;
    const ex = px - cx;
    const ey = py - cy;
    return ex * ex + ey * ey;
}

/** Chaikin corner-cutting of a CLOSED ring — rounds the grid stair-steps. It is
 *  PARTITION-PRESERVING: two neighbouring regions share the identical grid-corner
 *  vertices along their boundary, and Chaikin is a local linear op, so both smooth
 *  that shared run to the SAME curve → no gaps, no overlaps (unlike DP-simplify,
 *  which straightens each region independently and pulls their shared edge apart). */
function chaikinClosed(ring: number[][], iters: number): number[][] {
    let pts = ring;
    for (let it = 0; it < iters; it++) {
        const src = pts.slice(0, Math.max(0, pts.length - 1));
        const n = src.length;
        if (n < 4) break;
        const out: number[][] = [];
        for (let i = 0; i < n; i++) {
            const a = src[i];
            const b = src[(i + 1) % n];
            out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
            out.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
        }
        out.push([out[0][0], out[0][1]]);
        pts = out;
    }
    return pts;
}
function smoothPolyFeature(
    f: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>,
    iters: number,
): GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> {
    const g = f.geometry;
    try {
        if (g.type === "Polygon")
            return {
                ...f,
                geometry: {
                    type: "Polygon",
                    coordinates: g.coordinates.map((r) =>
                        chaikinClosed(r, iters),
                    ),
                },
            };
        if (g.type === "MultiPolygon")
            return {
                ...f,
                geometry: {
                    type: "MultiPolygon",
                    coordinates: g.coordinates.map((poly) =>
                        poly.map((r) => chaikinClosed(r, iters)),
                    ),
                },
            };
    } catch {
        /* fall through */
    }
    return f;
}

/** turf.union of polygons, short-circuiting the single-feature case and falling
 *  back to an incremental fold if the one-shot union throws. */
function safeUnion(
    polys: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>[],
): GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> | null {
    if (polys.length === 0) return null;
    if (polys.length === 1) return polys[0];
    try {
        const u = turf.union(turf.featureCollection(polys));
        if (u)
            return u as GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>;
    } catch {
        /* fall through */
    }
    let region = polys[0];
    for (let i = 1; i < polys.length; i++) {
        try {
            const merged = turf.union(
                turf.featureCollection([region, polys[i]]),
            );
            if (merged)
                region = merged as GeoJSON.Feature<
                    GeoJSON.Polygon | GeoJSON.MultiPolygon
                >;
        } catch {
            /* skip this rectangle only */
        }
    }
    return region;
}

/**
 * The metro reach partitioned into ONE region per TRUNK (TRUE nearest-line grid
 * partition), each clipped to the reach circle, PLUS the reachable trunks'
 * geometry. PURE — no fetch, no atom. Returns the result + a geometry diagnostic
 * string (the caller prepends the fetch part + writes the atom). The SINGLE
 * producer used by the configure preview, the elimination, and the draft overlay.
 */
export function computeMetroReachCellsFromLines(
    lines: MetroLine[],
    centerLat: number,
    centerLng: number,
    radius: number,
    unit: Units,
): { result: MetroReachResult; diag: string } {
    const drawLines = lines.map((l) => ({
        name: l.name,
        segments: l.segments,
        color: l.color,
    }));
    if (lines.length === 0)
        return { result: { cells: [], lines: drawLines }, diag: "no lines" };
    const colorByName = new Map<string, string>();
    for (const l of lines) if (l.color) colorByName.set(l.name, l.color);
    let reach: GeoJSON.Feature<GeoJSON.Polygon>;
    try {
        reach = turf.circle([centerLng, centerLat], radius, {
            units: unit,
            steps: 96,
        }) as GeoJSON.Feature<GeoJSON.Polygon>;
    } catch {
        return {
            result: { cells: [], lines: drawLines },
            diag: "reach circle FAILED",
        };
    }
    if (lines.length === 1)
        return {
            result: {
                cells: [
                    { cell: reach, name: lines[0].name, color: lines[0].color },
                ],
                lines: drawLines,
            },
            diag: "single line",
        };

    // --- Grid over the reach-circle bbox -----------------------------------
    const rb = turf.bbox(reach); // [minLng, minLat, maxLng, maxLat]
    const minLng = rb[0];
    const minLat = rb[1];
    const cos = Math.cos((centerLat * Math.PI) / 180) || 1e-6;
    const widthM = (rb[2] - rb[0]) * 111320 * cos;
    const heightM = (rb[3] - rb[1]) * 111320;
    let cellM = Math.min(
        GRID_MAX_CELL_M,
        Math.max(GRID_MIN_CELL_M, widthM / GRID_TARGET_COLS),
    );
    let cols = Math.max(1, Math.ceil(widthM / cellM));
    let rows = Math.max(1, Math.ceil(heightM / cellM));
    if (cols * rows > GRID_MAX_CELLS) {
        cellM *= Math.sqrt((cols * rows) / GRID_MAX_CELLS);
        cols = Math.max(1, Math.ceil(widthM / cellM));
        rows = Math.max(1, Math.ceil(heightM / cellM));
    }
    const cellLng = cellM / (111320 * cos);
    const cellLat = cellM / 111320;
    const N = cols * rows;

    // Local metre-plane: x = (lng-minLng)·111320·cos, y = (lat-minLat)·111320.
    const toX = (lng: number) => (lng - minLng) * 111320 * cos;
    const toY = (lat: number) => (lat - minLat) * 111320;
    // Per-trunk flattened segments (metre plane) + trunk bbox.
    interface Trunk {
        seg: Float64Array; // [ax,ay,bx,by, …]
        segCount: number;
        minx: number;
        miny: number;
        maxx: number;
        maxy: number;
        name: string;
    }
    const trunks: Trunk[] = [];
    for (const l of lines) {
        const pairs: number[] = [];
        let minx = Infinity,
            miny = Infinity,
            maxx = -Infinity,
            maxy = -Infinity;
        for (const seg of l.segments) {
            for (let i = 1; i < seg.length; i++) {
                const ax = toX(seg[i - 1][0]);
                const ay = toY(seg[i - 1][1]);
                const bx = toX(seg[i][0]);
                const by = toY(seg[i][1]);
                if (ax === bx && ay === by) continue;
                pairs.push(ax, ay, bx, by);
                minx = Math.min(minx, ax, bx);
                miny = Math.min(miny, ay, by);
                maxx = Math.max(maxx, ax, bx);
                maxy = Math.max(maxy, ay, by);
            }
        }
        if (pairs.length === 0) continue;
        trunks.push({
            seg: Float64Array.from(pairs),
            segCount: pairs.length / 4,
            minx,
            miny,
            maxx,
            maxy,
            name: l.name,
        });
    }
    if (trunks.length < 2)
        return {
            result: { cells: [], lines: drawLines },
            diag: `only ${trunks.length} trunk with geometry`,
        };

    // --- TRUE nearest-line label grid --------------------------------------
    // Per cell: the trunk whose LINE geometry is nearest to the cell centre. To
    // stay fast, sort trunks by bbox distance and stop scanning once a trunk's
    // bbox is farther than the current best (no closer segment possible).
    const label = new Int16Array(N).fill(-1);
    const T = trunks.length;
    const order = new Int32Array(T);
    const bboxDist = new Float64Array(T);
    const dtStart = typeof performance !== "undefined" ? performance.now() : 0;
    for (let row = 0; row < rows; row++) {
        const py = (row + 0.5) * cellM;
        for (let col = 0; col < cols; col++) {
            const px = (col + 0.5) * cellM;
            // bbox distance² per trunk
            for (let t = 0; t < T; t++) {
                const tr = trunks[t];
                const dx =
                    px < tr.minx
                        ? tr.minx - px
                        : px > tr.maxx
                          ? px - tr.maxx
                          : 0;
                const dy =
                    py < tr.miny
                        ? tr.miny - py
                        : py > tr.maxy
                          ? py - tr.maxy
                          : 0;
                bboxDist[t] = dx * dx + dy * dy;
                order[t] = t;
            }
            // insertion sort order[] by bboxDist (T is small)
            for (let i = 1; i < T; i++) {
                const v = order[i];
                const dv = bboxDist[v];
                let j = i - 1;
                while (j >= 0 && bboxDist[order[j]] > dv) {
                    order[j + 1] = order[j];
                    j--;
                }
                order[j + 1] = v;
            }
            let best = Infinity;
            let bestT = -1;
            for (let oi = 0; oi < T; oi++) {
                const t = order[oi];
                if (bboxDist[t] > best) break; // no closer trunk possible
                const s = trunks[t].seg;
                const n = trunks[t].segCount * 4;
                for (let k = 0; k < n; k += 4) {
                    const d = ptSegDistSq(px, py, s[k], s[k + 1], s[k + 2], s[k + 3]);
                    if (d < best) {
                        best = d;
                        bestT = t;
                    }
                }
            }
            label[row * cols + col] = bestT;
        }
    }
    const dtMs =
        typeof performance !== "undefined"
            ? Math.round(performance.now() - dtStart)
            : 0;

    // --- Per-trunk: maximal-rectangle merge → union → simplify → clip ------
    const rectPoly = (
        c0: number,
        r0: number,
        c1: number,
        r1: number,
    ): GeoJSON.Feature<GeoJSON.Polygon> => {
        const x0 = minLng + c0 * cellLng;
        const x1 = minLng + (c1 + 1) * cellLng;
        const y0 = minLat + r0 * cellLat;
        const y1 = minLat + (r1 + 1) * cellLat;
        return turf.polygon([
            [
                [x0, y0],
                [x1, y0],
                [x1, y1],
                [x0, y1],
                [x0, y0],
            ],
        ]);
    };
    const consumed = new Uint8Array(N);
    const rectsByLabel = new Map<number, GeoJSON.Feature<GeoJSON.Polygon>[]>();
    for (let row = 0; row < rows; row++)
        for (let col = 0; col < cols; col++) {
            const i = row * cols + col;
            const L = label[i];
            if (L < 0 || consumed[i]) continue;
            let c1 = col;
            while (
                c1 + 1 < cols &&
                !consumed[row * cols + c1 + 1] &&
                label[row * cols + c1 + 1] === L
            )
                c1++;
            let r1 = row;
            let grow = true;
            while (grow && r1 + 1 < rows) {
                const rr = r1 + 1;
                for (let cc = col; cc <= c1; cc++) {
                    const j = rr * cols + cc;
                    if (consumed[j] || label[j] !== L) {
                        grow = false;
                        break;
                    }
                }
                if (grow) r1 = rr;
            }
            for (let rr = row; rr <= r1; rr++)
                for (let cc = col; cc <= c1; cc++) consumed[rr * cols + cc] = 1;
            const arr = rectsByLabel.get(L);
            const poly = rectPoly(col, row, c1, r1);
            if (arr) arr.push(poly);
            else rectsByLabel.set(L, [poly]);
        }

    const unionStart =
        typeof performance !== "undefined" ? performance.now() : 0;
    const cells: MetroReachCell[] = [];
    for (const [L, rects] of rectsByLabel) {
        const name = trunks[L].name;
        let region = safeUnion(rects);
        if (!region) continue;
        // Partition-preserving Chaikin (NOT DP-simplify — that pulls shared edges
        // apart into gaps/overlaps). Rounds the grid stairs; neighbours share the
        // exact grid-corner vertices so the smoothed boundary stays matched.
        region = smoothPolyFeature(region, 2);
        try {
            const clipped = turf.intersect(
                turf.featureCollection([region, reach]),
            );
            if (clipped)
                cells.push({
                    cell: clipped as GeoJSON.Feature<
                        GeoJSON.Polygon | GeoJSON.MultiPolygon
                    >,
                    name,
                    color: colorByName.get(name),
                });
        } catch {
            /* skip this trunk's region */
        }
    }
    const unionMs =
        typeof performance !== "undefined"
            ? Math.round(performance.now() - unionStart)
            : 0;

    // --- Diagnostic: partition quality (sum/circle ≈ 1 = clean full cover) --
    let circleArea = 0;
    let sumArea = 0;
    let giants = 0;
    const colors = new Set<string>();
    const areaByCell = cells.map((c) => {
        let a = 0;
        try {
            a = turf.area(c.cell);
        } catch {
            a = 0;
        }
        return { name: c.name, a, color: c.color };
    });
    try {
        circleArea = turf.area(reach);
    } catch {
        circleArea = 0;
    }
    for (const ci of areaByCell) {
        sumArea += ci.a;
        if (circleArea > 0 && ci.a > 0.5 * circleArea) giants++;
        colors.add(ci.color ?? "none");
    }
    const ratio = circleArea > 0 ? sumArea / circleArea : 0;
    const top = [...areaByCell]
        .sort((x, y) => y.a - x.a)
        .slice(0, 4)
        .map(
            (ci) =>
                `${ci.name}=${circleArea > 0 ? Math.round((ci.a / circleArea) * 100) : "?"}%${ci.color ? "" : "·nocol"}`,
        )
        .join(",");
    const diag = `nearest-LINE grid=${cols}x${rows}@${Math.round(cellM)}m trunks=${T} drawn=${cells.length} dt=${dtMs}ms union=${unionMs}ms sum/circle=${ratio.toFixed(2)} giants=${giants} colors=${colors.size} top=[${top}]`;
    return { result: { cells, lines: drawLines }, diag };
}
