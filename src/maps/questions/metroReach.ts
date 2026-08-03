import * as turf from "@turf/turf";

import { haversineMeters } from "@/lib/geo";
import type { Units } from "@/maps/schema";

/**
 * PURE metro-tentacle geometry — the nearest-LINE partition of the reach circle.
 * Deliberately worker-safe: imports ONLY turf + the pure `haversineMeters` helper
 * + the `Units` TYPE (erased), so it can run in the geometry Web Worker (off the
 * main thread) AND on the main thread as the fallback. No atoms, no network, no
 * React reach here. `tentacles.ts` does the fetch + the diagnostic-atom write;
 * this module only computes.
 *
 * v1268 — DEFINITIVE partition (replaces the sample-point Voronoi). The old
 * approach was a Voronoi over sampled points ALONG the lines, so it computed
 * nearest-SAMPLE-POINT, not nearest-LINE — which diverges where seed density is
 * uneven: sparse isolated lines radiated huge wedges, dense junctions shattered
 * into a mosaic. Now we compute the TRUE nearest-line field on a grid: rasterize
 * every line into grid cells, then a vector distance transform (4SED / Danielsson)
 * propagates each cell's nearest SEED cell → every cell is labelled by its
 * genuinely-nearest line. A point ON a line is always in that line's region, so
 * there are no wedges and no mosaic — the regions follow the lines by construction.
 * Per line we then merge its cells into maximal rectangles, union them, and clip to
 * the reach circle (so coverage is the whole circle, sum/circle ≈ 1). SHARED tracks
 * (two services on one physical track) are split lengthwise by offsetting each
 * service's seeds perpendicular to the track (a stable division all players agree
 * on, since identical geometry is genuinely ambiguous).
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

// Grid resolution — aim for ~this many columns across the reach-circle bbox, with
// the cell size clamped and the total cell count capped so a huge (25 km-radius)
// tentacle stays tractable. A metro partition needs no fine detail (the map zoom
// hides sub-200 m stair-steps, and the per-line intersect-with-circle smooths the
// outer rim), so a coarse grid is both fast and visually clean.
const GRID_TARGET_COLS = 240;
const GRID_MIN_CELL_M = 75;
const GRID_MAX_CELL_M = 300;
const GRID_MAX_CELLS = 60000;
// v1269: Chaikin iterations that round the grid stair-steps into smooth curves.
// 2 = 4× boundary vertices, plenty smooth without ballooning the intersect cost.
const METRO_SMOOTH_ITERS = 2;

// v1246: distance (m) under which two DIFFERENT lines are a SHARED/stacked track
// (NYC's A/C/E on 8th Ave, the Bronx 2+5). Only on a shared segment do we offset.
const METRO_CONVERGENCE_M = 150;
// Coarse reference sampling of ALL lines, for the "distance to nearest OTHER line"
// query that decides whether a point is on a shared track.
const METRO_COARSE_REF_M = 120;
const METRO_GRID_M = 300; // spatial-grid cell size for that nearest-other query

// v1262: on a SHARED track, offset each service's seeds PERPENDICULAR to the track
// by a deterministic per-line amount, so two services sharing a track rasterize
// into adjacent cell rows and the partition splits the corridor lengthwise (one
// service each side) instead of alternating along it.
const METRO_LATERAL_BUCKETS = [-300, -180, 180, 300];
function lineLateralOffsetM(name: string): number {
    let h = 0;
    for (let i = 0; i < name.length; i++)
        h = (h * 31 + name.charCodeAt(i)) | 0;
    return METRO_LATERAL_BUCKETS[Math.abs(h) % METRO_LATERAL_BUCKETS.length];
}

/** Walk every line at `stepM` and return ordered positions per line, continuously
 *  (accumulator carried across per-way segments so a line split into many tiny
 *  member ways isn't over-sampled at seams). Also returns the total length. */
function walkLinesAtStep(
    lines: MetroLine[],
    stepM: number,
): { walks: { name: string; pts: [number, number][] }[]; totalLen: number } {
    const walks: { name: string; pts: [number, number][] }[] = [];
    let totalLen = 0;
    for (const { name, segments } of lines) {
        const pts: [number, number][] = [];
        let acc = 0;
        let placed = false;
        for (const seg of segments) {
            for (let i = 1; i < seg.length; i++) {
                const a = seg[i - 1];
                const b = seg[i];
                const d = haversineMeters(a[1], a[0], b[1], b[0]);
                if (d === 0) continue;
                totalLen += d;
                if (!placed) {
                    pts.push([a[0], a[1]]);
                    placed = true;
                    acc = 0;
                }
                let pos = stepM - acc;
                while (pos <= d) {
                    const f = pos / d;
                    pts.push([
                        a[0] + (b[0] - a[0]) * f,
                        a[1] + (b[1] - a[1]) * f,
                    ]);
                    pos += stepM;
                }
                acc = (acc + d) % stepM;
            }
        }
        if (pts.length) walks.push({ name, pts });
    }
    return { walks, totalLen };
}

/** Build a "distance to the nearest OTHER line" query over a coarse spatial grid
 *  of all lines' reference points. Returns a function metres→nearest-other. */
function buildNearestOther(
    lines: MetroLine[],
    refLat: number,
): { nearestOther: (lng: number, lat: number, name: string) => number } {
    const coarse = walkLinesAtStep(lines, METRO_COARSE_REF_M);
    const cos = Math.cos((refLat * Math.PI) / 180) || 1e-6;
    const cellLat = METRO_GRID_M / 111320;
    const cellLng = METRO_GRID_M / (111320 * cos);
    interface RP {
        lng: number;
        lat: number;
        name: string;
    }
    const grid = new Map<string, RP[]>();
    for (const w of coarse.walks)
        for (const p of w.pts) {
            const rp: RP = { lng: p[0], lat: p[1], name: w.name };
            const k = `${Math.floor(rp.lng / cellLng)},${Math.floor(rp.lat / cellLat)}`;
            const arr = grid.get(k);
            if (arr) arr.push(rp);
            else grid.set(k, [rp]);
        }
    // Only the shared-track question matters, so search out to a couple of grid
    // rings around the convergence threshold — plenty to detect a stacked track.
    const maxRings = Math.max(1, Math.ceil((METRO_CONVERGENCE_M * 2) / METRO_GRID_M));
    const nearestOther = (lng: number, lat: number, name: string): number => {
        const gx = Math.floor(lng / cellLng);
        const gy = Math.floor(lat / cellLat);
        let best = Infinity;
        for (let r = 0; r <= maxRings; r++) {
            if (Number.isFinite(best) && best <= (r - 1) * METRO_GRID_M) break;
            for (let dx = -r; dx <= r; dx++) {
                for (let dy = -r; dy <= r; dy++) {
                    if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
                    const cell = grid.get(`${gx + dx},${gy + dy}`);
                    if (!cell) continue;
                    for (const q of cell) {
                        if (q.name === name) continue;
                        const my = (q.lat - lat) * 111320;
                        const mx = (q.lng - lng) * 111320 * cos;
                        const dd = Math.sqrt(mx * mx + my * my);
                        if (dd < best) best = dd;
                    }
                }
            }
        }
        return best;
    };
    return { nearestOther };
}

/** Chaikin corner-cutting of a CLOSED ring (first === last). Rounds the grid
 *  stair-steps into smooth curves. Because two neighbouring regions share the
 *  IDENTICAL grid-corner vertices along their boundary and Chaikin is a local
 *  linear operation on consecutive vertices, both regions smooth that shared run
 *  to the SAME curve — so the partition stays gap-free + overlap-free. */
function chaikinClosed(ring: number[][], iters: number): number[][] {
    let pts = ring;
    for (let it = 0; it < iters; it++) {
        const src = pts.slice(0, Math.max(0, pts.length - 1)); // unique verts
        const n = src.length;
        if (n < 4) break;
        const out: number[][] = [];
        for (let i = 0; i < n; i++) {
            const a = src[i];
            const b = src[(i + 1) % n];
            out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
            out.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
        }
        out.push([out[0][0], out[0][1]]); // close
        pts = out;
    }
    return pts;
}

/** Chaikin-smooth every ring of a (Multi)Polygon feature. */
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
        /* fall through to the raw feature */
    }
    return f;
}

/** turf.union of a FeatureCollection, short-circuiting the single-feature case and
 *  falling back to an incremental fold if the one-shot union throws. */
function safeUnion(
    polys: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>[],
): GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> | null {
    if (polys.length === 0) return null;
    if (polys.length === 1) return polys[0];
    try {
        const u = turf.union(turf.featureCollection(polys));
        if (u)
            return u as GeoJSON.Feature<
                GeoJSON.Polygon | GeoJSON.MultiPolygon
            >;
    } catch {
        /* fall through to incremental */
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
 * The metro reach partitioned into ONE region per LINE (nearest-LINE grid
 * partition), each clipped to the reach circle, PLUS the reachable lines'
 * geometry. PURE — no fetch, no atom. Returns the result + a geometry diagnostic
 * string (the caller prepends the fetch part + writes the atom). The SINGLE
 * producer used by the configure preview, the elimination, and the draft planning
 * overlay.
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
            steps: 64,
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

    // --- Rasterize seeds (with shared-track lateral offset) ----------------
    const seedLabel = new Int16Array(N).fill(-1);
    const names: string[] = lines.map((l) => l.name);
    const nameToIdx = new Map<string, number>();
    names.forEach((n, i) => {
        if (!nameToIdx.has(n)) nameToIdx.set(n, i);
    });
    const { nearestOther } = buildNearestOther(lines, centerLat);
    const walkStep = Math.min(cellM * 0.5, 60);
    const fine = walkLinesAtStep(lines, walkStep);
    let sharedPts = 0;
    let seedCells = 0;
    for (const w of fine.walks) {
        const idx = nameToIdx.get(w.name) ?? 0;
        const lateral = lineLateralOffsetM(w.name);
        for (let pi = 0; pi < w.pts.length; pi++) {
            const p = w.pts[pi];
            let lng = p[0];
            let lat = p[1];
            const D = nearestOther(lng, lat, w.name);
            if (D < METRO_CONVERGENCE_M) {
                sharedPts++;
                // perpendicular offset by `lateral` metres
                const from = pi > 0 ? w.pts[pi - 1] : p;
                const to = pi + 1 < w.pts.length ? w.pts[pi + 1] : p;
                const dxm = (to[0] - from[0]) * 111320 * cos;
                const dym = (to[1] - from[1]) * 111320;
                const len = Math.hypot(dxm, dym);
                if (len > 1e-6) {
                    const offx = (-dym / len) * lateral;
                    const offy = (dxm / len) * lateral;
                    lng += offx / (111320 * cos);
                    lat += offy / 111320;
                }
            }
            let gx = Math.floor((lng - minLng) / cellLng);
            let gy = Math.floor((lat - minLat) / cellLat);
            if (gx < 0) gx = 0;
            else if (gx >= cols) gx = cols - 1;
            if (gy < 0) gy = 0;
            else if (gy >= rows) gy = rows - 1;
            const ci = gy * cols + gx;
            if (seedLabel[ci] === -1) seedCells++;
            seedLabel[ci] = idx; // last writer wins on a shared cell
        }
    }
    if (seedCells === 0)
        return {
            result: { cells: [], lines: drawLines },
            diag: "no seeds rasterized",
        };

    // --- Vector distance transform (4SED / Danielsson) ---------------------
    // Each cell adopts the nearest SEED cell's grid coords, so its label is the
    // label of its genuinely-nearest line (true nearest-line partition).
    const nx = new Int32Array(N).fill(-1);
    const ny = new Int32Array(N).fill(-1);
    for (let i = 0; i < N; i++)
        if (seedLabel[i] !== -1) {
            nx[i] = i % cols;
            ny[i] = (i / cols) | 0;
        }
    const dtStart = typeof performance !== "undefined" ? performance.now() : 0;
    const better = (i: number, col: number, row: number, j: number): void => {
        const sx = nx[j];
        if (sx === -1) return;
        const sy = ny[j];
        const cx = nx[i];
        const cand = (col - sx) * (col - sx) + (row - sy) * (row - sy);
        if (cx === -1) {
            nx[i] = sx;
            ny[i] = sy;
            return;
        }
        const cy = ny[i];
        const cur = (col - cx) * (col - cx) + (row - cy) * (row - cy);
        if (cand < cur) {
            nx[i] = sx;
            ny[i] = sy;
        }
    };
    // Forward pass (top-left → bottom-right)
    for (let row = 0; row < rows; row++)
        for (let col = 0; col < cols; col++) {
            const i = row * cols + col;
            if (col > 0) better(i, col, row, i - 1);
            if (row > 0) better(i, col, row, i - cols);
            if (row > 0 && col > 0) better(i, col, row, i - cols - 1);
            if (row > 0 && col < cols - 1) better(i, col, row, i - cols + 1);
        }
    // Backward pass (bottom-right → top-left)
    for (let row = rows - 1; row >= 0; row--)
        for (let col = cols - 1; col >= 0; col--) {
            const i = row * cols + col;
            if (col < cols - 1) better(i, col, row, i + 1);
            if (row < rows - 1) better(i, col, row, i + cols);
            if (row < rows - 1 && col < cols - 1)
                better(i, col, row, i + cols + 1);
            if (row < rows - 1 && col > 0) better(i, col, row, i + cols - 1);
        }
    const label = new Int16Array(N);
    for (let i = 0; i < N; i++) {
        const sx = nx[i];
        label[i] = sx === -1 ? -1 : seedLabel[ny[i] * cols + sx];
    }
    const dtMs =
        typeof performance !== "undefined"
            ? Math.round(performance.now() - dtStart)
            : 0;

    // --- Per-line: maximal-rectangle merge → union → clip to reach ---------
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
            if (L === -1 || consumed[i]) continue;
            // extend right
            let c1 = col;
            while (
                c1 + 1 < cols &&
                !consumed[row * cols + c1 + 1] &&
                label[row * cols + c1 + 1] === L
            )
                c1++;
            // extend down (each candidate row must be fully L + unconsumed)
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
        const name = names[L];
        const union = safeUnion(rects);
        if (!union) continue;
        // Smooth the blocky grid boundary; neighbouring regions share vertices so
        // the shared boundary stays matched (no gaps/overlaps). Then clip to the
        // reach circle (which keeps its own crisp 64-step edge).
        const region = smoothPolyFeature(union, METRO_SMOOTH_ITERS);
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
            /* skip this line's region */
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
    const diag = `grid=${cols}x${rows}@${Math.round(cellM)}m seeds=${seedCells} shared=${sharedPts} lines=${rectsByLabel.size} drawn=${cells.length} dt=${dtMs}ms union=${unionMs}ms sum/circle=${ratio.toFixed(2)} giants=${giants} colors=${colors.size} top=[${top}]`;
    return { result: { cells, lines: drawLines }, diag };
}
