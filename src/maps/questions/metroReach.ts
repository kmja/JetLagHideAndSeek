import * as turf from "@turf/turf";

import { haversineMeters } from "@/lib/geo";
import type { Units } from "@/maps/schema";

/**
 * PURE metro-tentacle geometry — the nearest-LINE partition of the reach circle,
 * as a Voronoi over points sampled along each TRUNK line. Deliberately worker-safe:
 * imports ONLY turf + the pure `haversineMeters` helper + the `Units` TYPE
 * (erased), so it can run in the geometry Web Worker (off the main thread) AND on
 * the main thread as the fallback. No atoms, no network, no React reach here.
 * `tentacles.ts` does the fetch (INCLUDING the v1271 grouping of services into
 * trunks by colour) + the diagnostic-atom write; this module only computes.
 *
 * v1272 — reverted the v1268 grid/distance-transform partition back to a Voronoi.
 * The grid existed because 30 interleaved SERVICES broke the sample-point Voronoi
 * (sparse-area wedges, junction mosaic); now that `tentacles.ts` groups services
 * into ~7 TRUNKS (v1271), the sampling is dense relative to the trunk spacing so
 * the sample-point Voronoi ≈ the true nearest-line partition — and it renders as
 * clean straight-edged cells instead of the grid's blocky/blobby regions. SHARED
 * tracks (two DIFFERENT-coloured trunks on one physical track — the Bronx red-2 vs
 * green-5) are split lengthwise by offsetting each trunk's seeds perpendicular to
 * the track.
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

// Uniform sampling spacing along each trunk (adaptive to keep the point count
// bounded on a big/dense metro). Dense relative to the ~250 m+ trunk spacing, so
// the nearest-SAMPLE-POINT Voronoi converges to the nearest-LINE partition.
// v1273: DENSE test config — sampling this fine makes the sample-point Voronoi
// converge to the true nearest-line boundary (kills the mosaic between close
// parallel trunks). Slow on a dense metro (heavy union); a perf pass follows once
// the overlay looks right. Runs in the geometry worker + memoised, so the UI
// never blocks — it just takes longer to settle.
const METRO_SAMPLE_M = 45;
const METRO_SAMPLE_BUDGET = 30000; // cap total sample points (spacing grows past it)
const METRO_COARSE_REF_M = 120; // coarse ref sampling for the nearest-other query
const METRO_GRID_M = 300; // spatial-grid cell for the nearest-other query
// A shared/stacked track: two DIFFERENT trunks within this distance.
const METRO_CONVERGENCE_M = 150;
// On a shared track, offset each trunk's seeds PERPENDICULAR by a deterministic
// per-name amount so two trunks sharing a track split the corridor lengthwise.
const METRO_LATERAL_BUCKETS = [-260, -160, 160, 260];
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

/** "Distance to the nearest OTHER trunk" query over a coarse spatial grid — drives
 *  the shared-track detection (whether to offset a point). */
function buildNearestOther(
    lines: MetroLine[],
    refLat: number,
): (lng: number, lat: number, name: string) => number {
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
    const maxRings = Math.max(
        1,
        Math.ceil((METRO_CONVERGENCE_M * 2) / METRO_GRID_M),
    );
    return (lng: number, lat: number, name: string): number => {
        const gx = Math.floor(lng / cellLng);
        const gy = Math.floor(lat / cellLat);
        let best = Infinity;
        for (let r = 0; r <= maxRings; r++) {
            if (Number.isFinite(best) && best <= (r - 1) * METRO_GRID_M) break;
            for (let dx = -r; dx <= r; dx++)
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
        return best;
    };
}

/** Uniformly sample points along each trunk (name-tagged), offsetting on shared
 *  track. The seed set for the nearest-line Voronoi. */
function metroSamplePoints(
    lines: MetroLine[],
    refLat: number,
    totalLen: number,
): { fc: GeoJSON.FeatureCollection<GeoJSON.Point>; shared: number } {
    const cos = Math.cos((refLat * Math.PI) / 180) || 1e-6;
    const spacing = Math.max(METRO_SAMPLE_M, totalLen / METRO_SAMPLE_BUDGET);
    const nearestOther = buildNearestOther(lines, refLat);
    const walk = walkLinesAtStep(lines, spacing);
    const feats: GeoJSON.Feature<GeoJSON.Point>[] = [];
    let shared = 0;
    for (const w of walk.walks) {
        const lateral = lineLateralOffsetM(w.name);
        for (let pi = 0; pi < w.pts.length; pi++) {
            const p = w.pts[pi];
            let lng = p[0];
            let lat = p[1];
            if (nearestOther(lng, lat, w.name) < METRO_CONVERGENCE_M) {
                shared++;
                const from = pi > 0 ? w.pts[pi - 1] : p;
                const to = pi + 1 < w.pts.length ? w.pts[pi + 1] : p;
                const dxm = (to[0] - from[0]) * 111320 * cos;
                const dym = (to[1] - from[1]) * 111320;
                const len = Math.hypot(dxm, dym);
                if (len > 1e-6) {
                    lng += ((-dym / len) * lateral) / (111320 * cos);
                    lat += ((dxm / len) * lateral) / 111320;
                }
            }
            feats.push(turf.point([lng, lat], { name: w.name }));
        }
    }
    return { fc: turf.featureCollection(feats), shared };
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
            /* skip this cell only */
        }
    }
    return region;
}

/**
 * The metro reach partitioned into ONE region per TRUNK (nearest-line Voronoi),
 * each clipped to the reach circle, PLUS the reachable trunks' geometry. PURE — no
 * fetch, no atom. Returns the result + a geometry diagnostic string (the caller
 * prepends the fetch part + writes the atom). The SINGLE producer used by the
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

    let totalLen = 0;
    for (const l of lines)
        for (const seg of l.segments)
            for (let i = 1; i < seg.length; i++)
                totalLen += haversineMeters(
                    seg[i - 1][1],
                    seg[i - 1][0],
                    seg[i][1],
                    seg[i][0],
                );
    const { fc: rawPts, shared } = metroSamplePoints(lines, centerLat, totalLen);
    // Dedup coincident points (d3-voronoi throws on coincident sites; both
    // directions of a trunk trace the same track).
    const seen = new Set<string>();
    const dedup: GeoJSON.Feature<GeoJSON.Point>[] = [];
    for (const f of rawPts.features) {
        const c = f.geometry.coordinates;
        const key = `${c[0].toFixed(5)},${c[1].toFixed(5)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        dedup.push(f);
    }
    const pts = turf.featureCollection(dedup);
    if (pts.features.length < 2)
        return {
            result: { cells: [], lines: drawLines },
            diag: `pts=${rawPts.features.length} <2`,
        };
    // Voronoi over a bbox covering the points AND the whole reach circle (so the
    // outer cells fill the circle → full coverage).
    const pb = turf.bbox(pts);
    const rbb = turf.bbox(reach);
    const bb: [number, number, number, number] = [
        Math.min(pb[0], rbb[0]),
        Math.min(pb[1], rbb[1]),
        Math.max(pb[2], rbb[2]),
        Math.max(pb[3], rbb[3]),
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
            diag: `pts=${pts.features.length} voronoi THREW: ${String(e).slice(0, 50)}`,
        };
    }
    // Group cells by trunk name (index-mapped to the input points), union each
    // trunk's cells, clip to the reach circle.
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
    const cells: MetroReachCell[] = [];
    for (const [name, group] of groups) {
        const region = safeUnion(group);
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
            /* skip this trunk's cell */
        }
    }
    const unionMs =
        typeof performance !== "undefined"
            ? Math.round(performance.now() - unionStart)
            : 0;

    // Diagnostic: partition quality (sum/circle ≈ 1 = clean full cover).
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
    const diag = `len=${Math.round(totalLen / 1000)}km pts=${rawPts.features.length}→${dedup.length} shared=${shared} vCells=${voronoi.features.length} named=${groups.size} drawn=${cells.length} union=${unionMs}ms sum/circle=${ratio.toFixed(2)} giants=${giants} colors=${colors.size} top=[${top}]`;
    return { result: { cells, lines: drawLines }, diag };
}
