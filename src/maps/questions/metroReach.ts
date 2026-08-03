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
 * is nearest-SAMPLE-POINT, not nearest-LINE, and diverges badly (open-area spikes;
 * midlines that only land if both lines are dotted at identical density/phase).
 *
 * v1285 — SMOOTH boundaries via ISO-CONTOURING (marching squares), not a blocky
 * label grid + Chaikin. The nearest-trunk field is sampled on grid NODES (corners),
 * and a region boundary is placed at the EXACT sub-cell point where two trunks are
 * equidistant — the true bisector — by linearly interpolating the distance
 * difference to zero along each grid edge. So the boundary FOLLOWS the bisector like
 * a curve (the way the water/coast BUFFER follows a shoreline) instead of stepping
 * along grid squares and being rounded by a smoothing hack. Interior cells (all four
 * corners the same trunk) still merge into rectangles (cheap union); only BOUNDARY
 * cells are split at the sub-cell crossings — a straight chord between the two
 * crossings for the common 2-region cell, a fan through the cell centre for a 3-/4-
 * region junction cell. Adjacent cells share the same edge-crossing point, so the
 * partition stays gap-free + overlap-free by construction, with NO smoothing pass.
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
// clamped and total cells capped. The iso-contour places boundaries at sub-cell
// crossings, so the grid no longer needs to be ultra-fine to hide stairs — its
// resolution now just controls how faithfully a curvy bisector is sampled. Modest
// (was 360/30 m for the stair-hiding era). Runs in the worker + memoised.
const GRID_TARGET_COLS = 200;
const GRID_MIN_CELL_M = 60;
const GRID_MAX_CELL_M = 220;
const GRID_MAX_CELLS = 60000;

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

    // --- Nearest-trunk field on grid NODES (corners) -----------------------
    // Marching squares reads the field at grid NODES so a boundary can be placed
    // at the EXACT sub-cell point where two trunks are equidistant (not off blocky
    // cell labels). Per node: nearest trunk + its distSq (bbox-sort + early-out).
    const T = trunks.length;
    const NC = cols + 1;
    const NR = rows + 1;
    const nlabel = new Int16Array(NC * NR).fill(-1);
    const ndist2 = new Float64Array(NC * NR);
    const order = new Int32Array(T);
    const bboxDist = new Float64Array(T);
    const dtStart = typeof performance !== "undefined" ? performance.now() : 0;
    const nearestAt = (px: number, py: number): [number, number] => {
        for (let t = 0; t < T; t++) {
            const tr = trunks[t];
            const dx =
                px < tr.minx ? tr.minx - px : px > tr.maxx ? px - tr.maxx : 0;
            const dy =
                py < tr.miny ? tr.miny - py : py > tr.maxy ? py - tr.maxy : 0;
            bboxDist[t] = dx * dx + dy * dy;
            order[t] = t;
        }
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
            if (bboxDist[t] > best) break;
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
        return [bestT, best];
    };
    for (let r = 0; r < NR; r++) {
        const py = r * cellM;
        for (let c = 0; c < NC; c++) {
            const [t, d2] = nearestAt(c * cellM, py);
            const idx = r * NC + c;
            nlabel[idx] = t;
            ndist2[idx] = d2;
        }
    }
    const dtMs =
        typeof performance !== "undefined"
            ? Math.round(performance.now() - dtStart)
            : 0;

    // dist² from a metre point to a SPECIFIC trunk (for the bisector crossing).
    const distToTrunk2 = (px: number, py: number, t: number): number => {
        const s = trunks[t].seg;
        const n = trunks[t].segCount * 4;
        let best = Infinity;
        for (let k = 0; k < n; k += 4) {
            const d = ptSegDistSq(px, py, s[k], s[k + 1], s[k + 2], s[k + 3]);
            if (d < best) best = d;
        }
        return best;
    };
    const nodeLng = (c: number) => minLng + c * cellLng;
    const nodeLat = (r: number) => minLat + r * cellLat;
    // The sub-cell point on edge A(la)→B(lb) where d_la == d_lb — the TRUE bisector
    // crossing — by linearly interpolating the distance difference to zero.
    const crossWorld = (
        ca: number,
        ra: number,
        la: number,
        cb: number,
        rb: number,
        lb: number,
    ): [number, number] => {
        const dAA = Math.sqrt(ndist2[ra * NC + ca]); // la is nearest at A
        const dBB = Math.sqrt(ndist2[rb * NC + cb]); // lb is nearest at B
        const dBA = Math.sqrt(distToTrunk2(ca * cellM, ra * cellM, lb));
        const dAB = Math.sqrt(distToTrunk2(cb * cellM, rb * cellM, la));
        const fA = dAA - dBA; // ≤ 0
        const fB = dAB - dBB; // ≥ 0
        let tt = fA !== fB ? fA / (fA - fB) : 0.5;
        tt = tt < 0 ? 0 : tt > 1 ? 1 : tt;
        return [
            nodeLng(ca) + tt * (nodeLng(cb) - nodeLng(ca)),
            nodeLat(ra) + tt * (nodeLat(rb) - nodeLat(ra)),
        ];
    };

    // --- Classify cells: interior (pure) vs boundary; build boundary fans ---
    let fragCount = 0;
    const fragmentsByLabel = new Map<
        number,
        GeoJSON.Feature<GeoJSON.Polygon>[]
    >();
    const pushFrag = (L: number, poly: GeoJSON.Feature<GeoJSON.Polygon>) => {
        fragCount++;
        const arr = fragmentsByLabel.get(L);
        if (arr) arr.push(poly);
        else fragmentsByLabel.set(L, [poly]);
    };
    const cellPure = new Int32Array(N).fill(-2); // -2 = mixed (boundary) cell
    for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++) {
            const L0 = nlabel[r * NC + c];
            const L1 = nlabel[r * NC + (c + 1)];
            const L2 = nlabel[(r + 1) * NC + (c + 1)];
            const L3 = nlabel[(r + 1) * NC + c];
            if (L0 === L1 && L1 === L2 && L2 === L3) {
                cellPure[r * cols + c] = L0;
                continue;
            }
            // Boundary cell → ring of corners + edge crossings, CCW.
            const cn = [
                { c, r, L: L0 },
                { c: c + 1, r, L: L1 },
                { c: c + 1, r: r + 1, L: L2 },
                { c, r: r + 1, L: L3 },
            ];
            const ring: {
                pt: [number, number];
                L: number;
                cross: boolean;
            }[] = [];
            for (let i = 0; i < 4; i++) {
                const a = cn[i];
                const b = cn[(i + 1) % 4];
                ring.push({
                    pt: [nodeLng(a.c), nodeLat(a.r)],
                    L: a.L,
                    cross: false,
                });
                if (a.L !== b.L)
                    ring.push({
                        pt: crossWorld(a.c, a.r, a.L, b.c, b.r, b.L),
                        L: -1,
                        cross: true,
                    });
            }
            const crossIdx: number[] = [];
            for (let i = 0; i < ring.length; i++)
                if (ring[i].cross) crossIdx.push(i);
            if (crossIdx.length < 2) continue; // never for a genuinely mixed cell
            const center: [number, number] = [
                minLng + (c + 0.5) * cellLng,
                minLat + (r + 0.5) * cellLat,
            ];
            // 2 crossings → a STRAIGHT chord between them; 3–4 → a junction fan
            // through the cell centre. Adjacent cells share the same edge crossing,
            // so the partition is gap-free + overlap-free with no smoothing.
            const useCenter = crossIdx.length > 2;
            for (let j = 0; j < crossIdx.length; j++) {
                const a = crossIdx[j];
                const b = crossIdx[(j + 1) % crossIdx.length];
                const pts: [number, number][] = [];
                if (useCenter) pts.push(center);
                pts.push(ring[a].pt);
                let i = (a + 1) % ring.length;
                let runLabel = -1;
                while (i !== b) {
                    const e = ring[i];
                    if (!e.cross) {
                        pts.push(e.pt);
                        runLabel = e.L;
                    }
                    i = (i + 1) % ring.length;
                }
                pts.push(ring[b].pt);
                pts.push(useCenter ? center : ring[a].pt);
                if (runLabel < 0 || pts.length < 4) continue;
                try {
                    pushFrag(runLabel, turf.polygon([pts]));
                } catch {
                    /* skip a degenerate fragment */
                }
            }
        }

    // --- Interior (pure) cells → maximal-rectangle merge (cheap union) ------
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
            const L = cellPure[i];
            if (L < 0 || consumed[i]) continue;
            let c1 = col;
            while (
                c1 + 1 < cols &&
                !consumed[row * cols + c1 + 1] &&
                cellPure[row * cols + c1 + 1] === L
            )
                c1++;
            let r1 = row;
            let grow = true;
            while (grow && r1 + 1 < rows) {
                const rr = r1 + 1;
                for (let cc = col; cc <= c1; cc++) {
                    const j = rr * cols + cc;
                    if (consumed[j] || cellPure[j] !== L) {
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

    // --- Per trunk: union(interior rects + boundary fragments) → clip ------
    const unionStart =
        typeof performance !== "undefined" ? performance.now() : 0;
    const cells: MetroReachCell[] = [];
    const allLabels = new Set<number>([
        ...rectsByLabel.keys(),
        ...fragmentsByLabel.keys(),
    ]);
    for (const L of allLabels) {
        const name = trunks[L].name;
        const parts = [
            ...(rectsByLabel.get(L) ?? []),
            ...(fragmentsByLabel.get(L) ?? []),
        ];
        const region = safeUnion(parts);
        if (!region) continue;
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
    const diag = `iso-contour grid=${cols}x${rows}@${Math.round(cellM)}m trunks=${T} frags=${fragCount} drawn=${cells.length} dt=${dtMs}ms union=${unionMs}ms sum/circle=${ratio.toFixed(2)} giants=${giants} colors=${colors.size} top=[${top}]`;
    return { result: { cells, lines: drawLines }, diag };
}
