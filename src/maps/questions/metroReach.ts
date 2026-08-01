import * as turf from "@turf/turf";

import { haversineMeters } from "@/lib/geo";
import type { Units } from "@/maps/schema";

/**
 * PURE metro-tentacle geometry — the nearest-LINE Voronoi partition of the reach
 * circle. Deliberately worker-safe: imports ONLY turf + the pure `haversineMeters`
 * helper + the `Units` TYPE (erased), so it can run in the geometry Web Worker
 * (off the main thread — the sampling + Voronoi + per-line union is a multi-second
 * block for a dense metro like NYC) AND on the main thread as the fallback. No
 * atoms, no network, no React reach here. `tentacles.ts` does the fetch and the
 * diagnostic-atom write; this module only computes.
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

// v1260: ADAPTIVE sampling — emit spacing scales with distance to the nearest
// OTHER line: dense where lines are contested (near a boundary), coarse where a
// line is isolated (the whole area is that line regardless of spacing).
const METRO_STEP_M = 100; // fine walk granularity (adaptive emit decision)
const METRO_COARSE_REF_M = 200; // reference sampling of ALL lines (nearest-other query)
const METRO_GRID_M = 300; // spatial-grid cell size for the nearest-other query
// v1264: emit spacing ≈ K × distance-to-nearest-other-line. LOWERED 0.7→0.45: the
// nearest-SAMPLE-POINT boundary zigzags at ~spacing, so where two lines run close
// (Brooklyn junctions) the region boundary alternates into small cells instead of
// following the lines smoothly. A smaller K densifies contested boundaries so they
// converge toward the smooth nearest-LINE midline. Affordable now that the compute
// is memoised (runs once, not 4×) + off-thread.
const METRO_ADAPT_K = 0.45;
const METRO_MIN_SPACING_M = 110; // densest emit spacing (contested corridors)
const METRO_MAX_SPACING_M = 900; // coarsest emit spacing (isolated stretches)
const METRO_MAX_SEARCH_M = 1400; // beyond this a line is "isolated" → max spacing
// v1263: emit spacing on a SHARED/stacked track — RAISED 500→1200 m. NYC runs so
// much parallel/shared track that ~76% of steps are "shared"; at 500 m that
// pushed the point count to ~8700 and the per-line union to ~8 s. Coarser shared
// sampling keeps the track claimed (no wrong-trunk bleed) + the lateral split,
// with far fewer points → a tractable union.
const METRO_SHARED_SPACING_M = 1000;

// v1246/v1260: distance (m) under which two DIFFERENT lines are treated as a
// SHARED/stacked track (NYC's A/C/E on 8th Ave, the Bronx 2+5).
const METRO_CONVERGENCE_M = 150;

// v1262: on a SHARED track, offset each service's seeds PERPENDICULAR to the track
// by a deterministic per-line amount, so two services sharing a track land on
// OPPOSITE sides and the Voronoi splits the corridor lengthwise (one each side)
// instead of alternating along it — a stable division all players agree on.
const METRO_LATERAL_BUCKETS = [-330, -220, -110, 110, 220, 330];
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

/** ADAPTIVE sample points along each line (name-tagged) — the seed set for the
 *  nearest-LINE Voronoi. Returns the FC + a diagnostic info string. */
function metroSamplePoints(lines: MetroLine[]): {
    fc: GeoJSON.FeatureCollection<GeoJSON.Point>;
    info: string;
} {
    // Pass 1: coarse reference points of ALL lines → a spatial grid, for the
    // "distance to the nearest OTHER line" query that drives adaptive spacing.
    const coarse = walkLinesAtStep(lines, METRO_COARSE_REF_M);
    const totalLen = coarse.totalLen;
    interface RP {
        lng: number;
        lat: number;
        name: string;
    }
    const refPts: RP[] = [];
    let refLat = 0;
    for (const w of coarse.walks)
        for (const p of w.pts) {
            if (refPts.length === 0) refLat = p[1];
            refPts.push({ lng: p[0], lat: p[1], name: w.name });
        }
    const cos = Math.cos((refLat * Math.PI) / 180) || 1e-6;
    const cellLat = METRO_GRID_M / 111320;
    const cellLng = METRO_GRID_M / (111320 * cos);
    const grid = new Map<string, RP[]>();
    for (const p of refPts) {
        const k = `${Math.floor(p.lng / cellLng)},${Math.floor(p.lat / cellLat)}`;
        const arr = grid.get(k);
        if (arr) arr.push(p);
        else grid.set(k, [p]);
    }
    const maxRings = Math.ceil(METRO_MAX_SEARCH_M / METRO_GRID_M);
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

    // Pass 2: fine walk; emit adaptively (coarse + laterally-offset on shared).
    const fine = walkLinesAtStep(lines, METRO_STEP_M);
    const feats: GeoJSON.Feature<GeoJSON.Point>[] = [];
    let emitted = 0;
    let shared = 0;
    for (const w of fine.walks) {
        const lateral = lineLateralOffsetM(w.name);
        let distSince = METRO_MAX_SPACING_M; // emit near the start
        let prev: [number, number] | null = null;
        for (let pi = 0; pi < w.pts.length; pi++) {
            const p = w.pts[pi];
            const D = nearestOther(p[0], p[1], w.name);
            distSince += METRO_STEP_M;
            const stacked = D < METRO_CONVERGENCE_M;
            if (stacked) shared++;
            const target = stacked
                ? METRO_SHARED_SPACING_M
                : !Number.isFinite(D)
                  ? METRO_MAX_SPACING_M
                  : Math.min(
                        METRO_MAX_SPACING_M,
                        Math.max(METRO_MIN_SPACING_M, METRO_ADAPT_K * D),
                    );
            if (distSince >= target) {
                let ep = p;
                if (stacked) {
                    const from = prev ?? p;
                    const to = prev
                        ? p
                        : pi + 1 < w.pts.length
                          ? w.pts[pi + 1]
                          : p;
                    const dxm = (to[0] - from[0]) * 111320 * cos;
                    const dym = (to[1] - from[1]) * 111320;
                    const len = Math.hypot(dxm, dym);
                    if (len > 1e-6) {
                        const offx = (-dym / len) * lateral;
                        const offy = (dxm / len) * lateral;
                        ep = [
                            p[0] + offx / (111320 * cos),
                            p[1] + offy / 111320,
                        ];
                    }
                }
                feats.push(turf.point(ep, { name: w.name }));
                distSince = 0;
                emitted++;
            }
            prev = p;
        }
    }
    const info = `len=${Math.round(totalLen / 1000)}km adaptive ref=${refPts.length} emit=${emitted} shared=${shared}`;
    return { fc: turf.featureCollection(feats), info };
}

/** turf.union of a FeatureCollection, short-circuiting the single-feature case. */
function safeUnionFC(
    fc: GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon>,
): GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> | null {
    if (fc.features.length === 0) return null;
    if (fc.features.length === 1) return fc.features[0];
    return turf.union(fc) as GeoJSON.Feature<
        GeoJSON.Polygon | GeoJSON.MultiPolygon
    > | null;
}

/**
 * The metro reach partitioned into ONE region per LINE (nearest-line Voronoi),
 * each clipped to the reach circle, PLUS the reachable lines' geometry. PURE — no
 * fetch, no atom. Returns the result + the geometry diagnostic string (the caller
 * prepends the fetch part and writes the atom). The SINGLE producer used by the
 * configure preview, the elimination, and the draft planning overlay.
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
    const { fc: rawPts, info } = metroSamplePoints(lines);
    // v1245: DEDUP coincident points before turf.voronoi (d3-voronoi throws on
    // coincident sites; both directions of a line trace the same track).
    const seenCoord = new Set<string>();
    const dedup: GeoJSON.Feature<GeoJSON.Point>[] = [];
    for (const f of rawPts.features) {
        const c = f.geometry.coordinates;
        const key = `${c[0].toFixed(5)},${c[1].toFixed(5)}`;
        if (seenCoord.has(key)) continue;
        seenCoord.add(key);
        dedup.push(f);
    }
    const pts = turf.featureCollection(dedup);
    if (pts.features.length < 2)
        return { result: { cells: [], lines: drawLines }, diag: `${info} <2 pts` };
    // v1244/v1256: planar turf.voronoi over a bbox that contains the points AND
    // the whole reach circle (so the outer cells fill the circle → full coverage).
    const pb = turf.bbox(pts);
    const rb = turf.bbox(reach);
    const bb: [number, number, number, number] = [
        Math.min(pb[0], rb[0]),
        Math.min(pb[1], rb[1]),
        Math.max(pb[2], rb[2]),
        Math.max(pb[3], rb[3]),
    ];
    const padX = (bb[2] - bb[0]) * 0.05 + 0.01;
    const padY = (bb[3] - bb[1]) * 0.05 + 0.01;
    let voronoi: GeoJSON.FeatureCollection<GeoJSON.Polygon>;
    try {
        voronoi = turf.voronoi(pts, {
            bbox: [bb[0] - padX, bb[1] - padY, bb[2] + padX, bb[3] + padY],
        });
    } catch (e) {
        return {
            result: { cells: [], lines: drawLines },
            diag: `${info} pts=${pts.features.length} voronoi THREW: ${String(e).slice(0, 60)}`,
        };
    }
    // Group cells by line name (index-mapped to the input points), union each
    // line's cells, clip to the reach circle.
    const groups = new Map<string, GeoJSON.Feature<GeoJSON.Polygon>[]>();
    voronoi.features.forEach((cell, i) => {
        if (!cell?.geometry) return;
        const name = (pts.features[i]?.properties as { name?: string })?.name;
        if (typeof name !== "string") return;
        const arr = groups.get(name);
        if (arr) arr.push(cell);
        else groups.set(name, [cell]);
    });
    const unionStart =
        typeof performance !== "undefined" ? performance.now() : 0;
    const regionByName = new Map<
        string,
        GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>
    >();
    for (const [name, group] of groups) {
        let region: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> =
            group[0];
        if (group.length > 1) {
            try {
                region = safeUnionFC(turf.featureCollection(group)) ?? region;
            } catch {
                for (let gi = 1; gi < group.length; gi++) {
                    try {
                        const merged = turf.union(
                            turf.featureCollection([
                                region as GeoJSON.Feature<
                                    GeoJSON.Polygon | GeoJSON.MultiPolygon
                                >,
                                group[gi],
                            ]),
                        );
                        if (merged)
                            region = merged as GeoJSON.Feature<
                                GeoJSON.Polygon | GeoJSON.MultiPolygon
                            >;
                    } catch {
                        /* skip this cell only */
                    }
                }
            }
        }
        regionByName.set(name, region);
    }
    const unionMs =
        typeof performance !== "undefined"
            ? Math.round(performance.now() - unionStart)
            : 0;
    const cells: MetroReachCell[] = [];
    for (const [name, region] of regionByName) {
        try {
            const clipped = turf.intersect(
                turf.featureCollection([
                    region as GeoJSON.Feature<
                        GeoJSON.Polygon | GeoJSON.MultiPolygon
                    >,
                    reach,
                ]),
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
            /* skip this line's cell */
        }
    }
    // Diagnostic: partition quality (sum/circle ~1 = clean partition).
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
    const diag = `${info} pts=${rawPts.features.length}→${dedup.length} vCells=${voronoi.features.length} named=${regionByName.size} drawn=${cells.length} union=${unionMs}ms sum/circle=${ratio.toFixed(2)} giants=${giants} colors=${colors.size} top=[${top}]`;
    return { result: { cells, lines: drawLines }, diag };
}
