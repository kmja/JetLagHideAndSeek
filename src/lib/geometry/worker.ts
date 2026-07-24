/// <reference lib="webworker" />
import type {
    Feature,
    FeatureCollection,
    MultiPolygon,
    Polygon,
} from "geojson";

import {
    area,
    bboxPolygon,
    booleanPointInPolygon,
    buffer as turfBuffer,
    circle as turfCircle,
    difference,
    distance as turfDistance,
    featureCollection,
    point as turfPoint,
    pointToLineDistance,
    polygon,
    polygonToLine,
    simplify as turfSimplify,
    union,
} from "@turf/turf";

import { seaFromCoastline } from "../../maps/questions/seaFromCoastline";
import {
    clipPolygonToLandWith,
    parseLandPolys,
    parseLakePolys,
    type LakePoly,
    type LandPoly,
} from "./clipCore";
import { combineBoundaryGeometry } from "./combineCore";

/**
 * Geometry Web Worker. Runs the two CPU-heavy turf pipelines —
 * clip-to-land and boundary-combine — OFF the main thread, so no
 * play area, however large (Tokyo Metropolis, Greater Tokyo + many
 * adjacents, …), can freeze the UI while turf grinds.
 *
 * Self-contained: it fetches the bundled coastline/lakes masks itself
 * (plain `fetch`, memoized for the worker's lifetime — these are
 * permanent static assets the browser HTTP-caches), and imports only
 * the pure compute cores. No cacheFetch/toast/React reaches here.
 *
 * Message protocol (see geometry/client.ts):
 *   in  { id, type: "clip",    payload: { polygon } }
 *   in  { id, type: "combine", payload: { addedFeatures, subtractFeatures } }
 *   out { id, ok: true,  result }     — success
 *   out { id, ok: false, error }      — failure (client falls back)
 *   out { id, phase }                 — progress (combine only)
 */

const BASE = (import.meta.env.BASE_URL ?? "/") as string;

let landPromise: Promise<LandPoly[]> | null = null;
let lakePromise: Promise<LakePoly[]> | null = null;

async function getLand(): Promise<LandPoly[]> {
    if (!landPromise) {
        landPromise = (async () => {
            const resp = await fetch(BASE + "coastline50.geojson");
            const fc = (await resp.json()) as FeatureCollection;
            return parseLandPolys(fc);
        })().catch((e) => {
            // Reset so a transient failure can be retried on the next call.
            landPromise = null;
            throw e;
        });
    }
    return landPromise;
}

async function getLake(): Promise<LakePoly[]> {
    if (!lakePromise) {
        lakePromise = (async () => {
            try {
                const resp = await fetch(BASE + "lakes50.geojson");
                const fc = (await resp.json()) as FeatureCollection;
                return parseLakePolys(fc);
            } catch (e) {
                // Lakes are best-effort — a clip without lake subtraction
                // is still correct, just keeps inland water.
                console.warn("[geometry.worker] lakes load failed", e);
                return [] as LakePoly[];
            }
        })();
    }
    return lakePromise;
}

type ClipPayload = {
    polygon: Feature<Polygon | MultiPolygon>;
};
type CombinePayload = {
    addedFeatures: Feature<Polygon | MultiPolygon>[];
    subtractFeatures: Feature<Polygon | MultiPolygon>[];
};
type LandFromCoastPayload = {
    lines: Feature[];
    bbox: [number, number, number, number];
    seeker: { lat: number; lng: number };
};
type SeaFromCoastPayload = {
    lines: Feature[];
    bbox: [number, number, number, number];
    seeker: { lat: number; lng: number };
};
type HoledMaskPayload = {
    input:
        | Feature<Polygon | MultiPolygon>
        | FeatureCollection<Polygon | MultiPolygon>;
};
type BufferPointsPayload = {
    points: [number, number][];
    seeker: { lat: number; lng: number };
};
type BufferAndUnionPayload = {
    features: Feature[];
    seeker: { lat: number; lng: number };
};
type LandFromWaterPayload = {
    water: Feature[];
    bbox: [number, number, number, number];
    seeker: { lat: number; lng: number };
};
type InMessage =
    | { id: number; type: "clip"; payload: ClipPayload }
    | { id: number; type: "combine"; payload: CombinePayload }
    | { id: number; type: "landFromCoast"; payload: LandFromCoastPayload }
    | { id: number; type: "seaFromCoast"; payload: SeaFromCoastPayload }
    | { id: number; type: "holedMask"; payload: HoledMaskPayload }
    | { id: number; type: "bufferPoints"; payload: BufferPointsPayload }
    | {
          id: number;
          type: "bufferAndUnion";
          payload: BufferAndUnionPayload;
      }
    | {
          id: number;
          type: "landFromWater";
          payload: LandFromWaterPayload;
      }
    | {
          id: number;
          type: "dissolveWater";
          payload: { features: Feature[] };
      };

// The world rectangle we punch the play area out of — byte-identical to
// `BLANK_GEOJSON.features[0]` (src/maps/api/constants.ts), inlined so the
// worker doesn't import the (main-thread) constants module.
const WORLD_RING: [number, number][] = [
    [-180, -90],
    [180, -90],
    [180, 90],
    [-180, 90],
    [-180, -90],
];

/**
 * v899: the dimming MASK (world rectangle MINUS the play area), OFF the main
 * thread. A world-scale `turf.difference` over a dense play-area multipolygon
 * (a whole county / big metro / many adjacents) blocks the main thread for a
 * noticeable beat every time an answer shrinks the remaining area — the "froze
 * then came back" during elimination render. Pure turf; `null` when there's
 * nothing to punch out (caller draws no mask). Mirrors `operators.holedMask`.
 */
function holedMaskImpl(p: HoledMaskPayload): Feature | null {
    const world = polygon([WORLD_RING]);
    const input = p.input;
    let inner: Feature<Polygon | MultiPolygon> | null;
    if ("features" in input) {
        const feats = input.features;
        if (feats.length === 0) return null;
        inner =
            feats.length === 1
                ? feats[0]
                : (union(input) as Feature<Polygon | MultiPolygon> | null);
    } else {
        inner = input;
    }
    if (!inner) return null;
    return difference(
        featureCollection([world, inner] as never),
    ) as Feature | null;
}

/**
 * v875: per-city LAND polygons (play-area frame MINUS the sea built from the
 * OSM coastline) — the heavy `seaFromCoastline` node/polygonize/union + the
 * world-frame `turf.difference`. Runs HERE so a dense metro's coastline
 * (NYC harbour + tidal rivers) can't freeze the UI while the same-landmass
 * question / configure preview computes. Pure turf; `null` on any
 * degeneracy (caller keeps its main-thread fallback / global bundle).
 */
function landFromCoastImpl(
    p: LandFromCoastPayload,
): Feature<Polygon | MultiPolygon> | null {
    const sea = seaFromCoastline(
        p.lines as never,
        p.bbox,
        { lng: p.seeker.lng, lat: p.seeker.lat },
        { useRaster: true }, // v996: robust raster for same-landmass
    );
    if (!sea) return null;
    try {
        const frame = bboxPolygon(p.bbox);
        const land = difference(
            featureCollection([frame, sea] as never),
        ) as Feature<Polygon | MultiPolygon> | null;
        if (!land || !land.geometry) return null;
        if (area(land) <= 0) return null;
        return land;
    } catch {
        return null;
    }
}

/**
 * v978: the "closer than my nearest X" region for a POINT-reference measuring
 * question (park / mountain / rail station / any *-full POI), OFF the main
 * thread. The elimination is the union of a disk of radius = the seeker's
 * distance to the NEAREST reference around EVERY reference. arcgis's geodesic
 * buffer (`arcBufferToPoint`) did this in ONE synchronous WASM `executeMany`
 * over hundreds/thousands of point-circles, which froze the app for seconds on
 * a dense metro (NYC's parks / stations / peaks — the reported freezes). Here
 * it's pure turf (circles + union), so it runs off-thread like the hiding-zone
 * union. The hider grades measuring by DISTANCE, not by this polygon, so the
 * cut geometry moving from arcgis to turf changes only which map pixels dim (by
 * sub-metre at km scale), never an answer. `null` on a degenerate input
 * (caller keeps the arcgis fallback).
 */
function bufferPointsImpl(
    p: BufferPointsPayload,
): Feature<Polygon | MultiPolygon> | null {
    const pts = p.points.filter(
        (c) =>
            Array.isArray(c) &&
            Number.isFinite(c[0]) &&
            Number.isFinite(c[1]),
    );
    if (pts.length === 0) return null;
    const seeker = turfPoint([p.seeker.lng, p.seeker.lat]);
    let minKm = Infinity;
    for (const c of pts) {
        const d = turfDistance(seeker, turfPoint(c), { units: "kilometers" });
        if (Number.isFinite(d) && d < minKm) minKm = d;
    }
    if (!Number.isFinite(minKm)) return null;
    // A zero/near-zero radius (the seeker sits on a reference) still needs a
    // sliver so the region isn't empty; clamp to ~10 m.
    const radiusKm = Math.max(minKm, 0.01);
    const circles: Feature<Polygon>[] = [];
    for (const c of pts) {
        try {
            circles.push(
                turfCircle(c, radiusKm, {
                    steps: 48,
                    units: "kilometers",
                }) as Feature<Polygon>,
            );
        } catch {
            /* skip a malformed point */
        }
    }
    if (circles.length === 0) return null;
    if (circles.length === 1) return circles[0];
    try {
        const merged = union(
            featureCollection(circles) as never,
        ) as Feature<Polygon | MultiPolygon> | null;
        return merged ?? circles[0];
    } catch {
        return circles[0];
    }
}

/** Geodesic-ish distance (km) from a point to ANY geometry — 0 if the point
 *  is inside a polygon, else the distance to its boundary; the along-line
 *  distance for lines; the point distance for points. */
function distanceToFeatureKm(
    seeker: Feature<import("geojson").Point>,
    f: Feature,
): number {
    const g = f.geometry;
    if (!g) return Infinity;
    try {
        if (g.type === "Point") {
            return turfDistance(seeker, f as never, { units: "kilometers" });
        }
        if (g.type === "MultiPoint") {
            let best = Infinity;
            for (const c of g.coordinates) {
                const d = turfDistance(seeker, turfPoint(c), {
                    units: "kilometers",
                });
                if (d < best) best = d;
            }
            return best;
        }
        if (g.type === "LineString" || g.type === "MultiLineString") {
            return pointToLineDistance(seeker, f as never, {
                units: "kilometers",
            });
        }
        if (g.type === "Polygon" || g.type === "MultiPolygon") {
            if (booleanPointInPolygon(seeker, f as never)) return 0;
            const line = polygonToLine(f as never);
            const lines =
                (line as { type?: string }).type === "FeatureCollection"
                    ? (line as FeatureCollection).features
                    : [line as Feature];
            let best = Infinity;
            for (const l of lines) {
                // v1013: polygonToLine yields a MultiLineString for a ring set
                // with holes (a sea with island holes), and pointToLineDistance
                // THROWS on a MultiLineString — which left `best` at Infinity, so
                // the caller's minKm was non-finite and it never buffered the sea
                // (coastline fell to the slow arcgis path). Flatten each part to a
                // LineString so every ring contributes a distance.
                const lg = l.geometry as
                    | import("geojson").LineString
                    | import("geojson").MultiLineString
                    | undefined;
                const parts: number[][][] =
                    lg?.type === "MultiLineString"
                        ? (lg.coordinates as number[][][])
                        : lg?.type === "LineString"
                          ? [lg.coordinates as number[][]]
                          : [];
                for (const coords of parts) {
                    if (coords.length < 2) continue;
                    try {
                        const d = pointToLineDistance(
                            seeker,
                            { type: "LineString", coordinates: coords } as never,
                            { units: "kilometers" },
                        );
                        if (d < best) best = d;
                    } catch {
                        /* skip a degenerate ring */
                    }
                }
            }
            return best;
        }
    } catch {
        return Infinity;
    }
    return Infinity;
}

/**
 * v984: the generalized measuring "closer than my nearest X" region, OFF the
 * main thread — the SAME buffer+union arcgis's `arcBufferToPoint` does (buffer
 * every reference by the seeker's distance to the NEAREST one, union), but with
 * turf so it can run in the worker for ANY geometry (points/lines/polygons), not
 * just points. This is what lets body-of-water — ponds + rivers + the sea AREA —
 * compute without freezing the app or choking arcgis (the v982/v983 "no overlay"
 * regression). `null` on a degenerate input (caller falls back to arcgis).
 */
/** Count the coordinate vertices of a geometry (any type). */
function geomVertexCount(g: Feature["geometry"] | undefined): number {
    if (!g || !("coordinates" in g)) return 0;
    let n = 0;
    const walk = (c: unknown): void => {
        if (!Array.isArray(c)) return;
        if (typeof c[0] === "number") {
            n++;
            return;
        }
        for (const x of c) walk(x);
    };
    walk((g as { coordinates: unknown }).coordinates);
    return n;
}

const isPolyFeat = (f: Feature): boolean =>
    f.geometry?.type === "Polygon" || f.geometry?.type === "MultiPolygon";
const isLineFeat = (f: Feature): boolean =>
    f.geometry?.type === "LineString" || f.geometry?.type === "MultiLineString";

/** Douglas-Peucker simplify that never throws — returns the input on failure or
 *  if the simplified result is degenerate. `tol` in degrees. */
function gentleSimplify<T extends Feature>(f: T, tol: number): T {
    try {
        const s = turfSimplify(f as never, {
            tolerance: tol,
            highQuality: false,
            mutate: false,
        }) as T | undefined;
        return s && s.geometry ? s : f;
    } catch {
        return f;
    }
}

/**
 * v1011: DISSOLVE a set of water polygons into their real bodies.
 *
 * The basemap-water capture returns TILE-CLIPPED pieces of the same bodies (the
 * East River split across many z-tiles), so the raw set is huge AND redundant —
 * 72 pieces / 32k verts for NYC. v1010 hit that by simplifying each piece to a
 * vertex budget, but the budget forced tolerances up to ~700 m, which COLLAPSED
 * narrow water (the lower East River / harbour channels) so their buffer
 * vanished and near-shore land wrongly read "further" (the reported bug). The
 * right move is to UNION the pieces FIRST: dissolving the shared tile-boundary
 * edges cuts the vertex count far more than simplify AND preserves every water
 * body's true shape. A gentle ~20 m river-safe pre-simplify only speeds the
 * union; the accumulator is re-simplified gently if it grows large so the
 * incremental union stays cheap. Per-part try/catch keeps the accumulator (the
 * sea, unioned first as the largest) if a later piece can't union.
 */
const UNION_ACC_SIMPLIFY_AT = 12000;
function unionPolygonsGently(
    polys: Feature[],
): Feature<Polygon | MultiPolygon> | null {
    const ps = polys.filter(isPolyFeat);
    if (ps.length === 0) return null;
    if (ps.length === 1) return ps[0] as Feature<Polygon | MultiPolygon>;
    // v1139: FAST PATH — union ALL polygons in ONE polygon-clipping sweep-line
    // call. turf.union over a whole FeatureCollection is O((n+k) log n); the
    // incremental fold below is O(N × accumulator) — each step re-unions the
    // GROWING sea with one more piece, which is what TIMED OUT the dissolve on a
    // weak mobile CPU for a dense metro's tile-clipped water (dozens–hundreds of
    // pieces). The inputs are already cleaned (truncate+simplify per poly), so
    // the single call usually succeeds; only on a throw (one self-intersecting
    // piece) do we fall back to the robust incremental union that skips the
    // offender. This is the biggest lever for "works on PC, not Android".
    try {
        const all = union(featureCollection(ps) as never) as Feature<
            Polygon | MultiPolygon
        > | null;
        if (all && all.geometry && area(all) > 0) {
            return geomVertexCount(all.geometry) > UNION_ACC_SIMPLIFY_AT
                ? (gentleSimplify(all, 0.0003) as Feature<
                      Polygon | MultiPolygon
                  >)
                : all;
        }
    } catch {
        /* fall back to the robust incremental union below */
    }
    // Union the largest first so the accumulator starts with the sea/major body.
    ps.sort((a, b) => {
        try {
            return area(b) - area(a);
        } catch {
            return 0;
        }
    });
    // v1012: union the RAW pieces (no per-piece pre-simplify — that could
    // self-intersect a narrow channel and make its union throw, silently
    // DROPPING that water so its shore read "further"). Only the accumulator is
    // gently simplified, and only once it grows large, to keep the incremental
    // union fast.
    let acc = ps[0] as Feature<Polygon | MultiPolygon>;
    for (let i = 1; i < ps.length; i++) {
        const p = ps[i];
        try {
            const u = union(featureCollection([acc, p]) as never) as Feature<
                Polygon | MultiPolygon
            > | null;
            if (u && u.geometry && area(u) > 0) acc = u;
        } catch {
            /* keep the accumulator, skip this piece */
        }
        if (geomVertexCount(acc.geometry) > UNION_ACC_SIMPLIFY_AT) {
            acc = gentleSimplify(acc, 0.0003) as Feature<Polygon | MultiPolygon>;
        }
    }
    return acc;
}

function bufferAndUnionImpl(
    p: BufferAndUnionPayload,
): Feature<Polygon | MultiPolygon> | null {
    const feats = (p.features ?? []).filter((f) => f && f.geometry);
    if (feats.length === 0) return null;
    // v987: a feature tagged `__waterArea` is ALREADY water (e.g. the coarse
    // ocean polygon) — it's unioned in AS-IS (never buffered) and excluded
    // from the buffer-radius min, so a coarse/imprecise sea shore can't shrink
    // the "closer than my nearest water" radius (which must match the
    // nearest-reference label). The buffered features (ponds / rivers /
    // coastline lines) still fill the near-shore band + narrow tidal channels.
    const waterAreas: Feature<Polygon | MultiPolygon>[] = [];
    const targets: Feature[] = [];
    for (const f of feats) {
        if ((f.properties as { __waterArea?: boolean })?.__waterArea === true) {
            if (
                f.geometry.type === "Polygon" ||
                f.geometry.type === "MultiPolygon"
            ) {
                waterAreas.push(f as Feature<Polygon | MultiPolygon>);
            }
        } else {
            targets.push(f);
        }
    }
    const seeker = turfPoint([p.seeker.lng, p.seeker.lat]);
    let minKm = Infinity;
    for (const f of targets) {
        const d = distanceToFeatureKm(seeker, f);
        if (Number.isFinite(d) && d < minKm) minKm = d;
    }
    // Assemble the union parts WATER-AREAS FIRST, then the buffered targets.
    // v994: this ordering is load-bearing — the union is INCREMENTAL and the
    // accumulator starts with the water areas (the sea), so even if a later
    // union step throws (e.g. an invalid buffered target) the sea is NEVER
    // dropped. The old all-at-once `union(...) ?? parts[0]` fell back to
    // `parts[0]` (the FIRST buffered target) on ANY throw, silently losing the
    // sea → open water wrongly read "further".
    const parts: Feature<Polygon | MultiPolygon>[] = [];
    for (const w of waterAreas) {
        try {
            if (area(w) > 0) parts.push(w);
        } catch {
            /* skip a degenerate water polygon */
        }
    }
    if (Number.isFinite(minKm)) {
        const r = Math.max(minKm, 0.01);
        // v1011: UNION the polygon targets FIRST (dissolving the redundant
        // tile-boundary vertices from the tile-clipped basemap-water capture),
        // then buffer the dissolved shape ONCE. This is both cheaper (one buffer
        // + a small dissolved input instead of N buffers unioned as big blobs)
        // AND shoreline-preserving — v1010's per-piece simplify-to-budget went as
        // coarse as ~700 m and collapsed narrow water so its buffer vanished.
        const polyTargets = targets.filter(isPolyFeat);
        const lineTargets = targets.filter(isLineFeat);
        const waterUnion = unionPolygonsGently(polyTargets);
        if (waterUnion) {
            let ok = false;
            try {
                // v1131/v1140: SIMPLIFY the unioned water before buffering, at a
                // tolerance SCALED to the buffer distance `r`. A dense coastal
                // metro's sea (NYC's Hudson + East River + harbour + ocean, tens
                // of thousands of vertices) makes `turf.buffer` choke → no
                // overlay. The simplify is invisible against the buffer it feeds
                // (we buffer by `r` km, so ~r/10 of detail is imperceptible), and
                // a coarser input keeps the buffer fast + reliable on a weak
                // mobile CPU (the "works on PC, not Android" case). Clamped to
                // [~55 m, ~550 m] so a near-water seeker (tiny r) stays crisp and
                // a far one (large r) simplifies hard. `gentleSimplify` never
                // throws (returns the input on a degenerate result).
                const tol = Math.min(0.005, Math.max(0.0005, r / 10 / 111));
                const buf = gentleSimplify(waterUnion, tol);
                const b = turfBuffer(buf as never, r, {
                    units: "kilometers",
                }) as Feature<Polygon | MultiPolygon> | undefined;
                if (b && b.geometry && area(b) > 0) {
                    parts.push(b);
                    ok = true;
                }
            } catch {
                /* fall back to buffering each piece below */
            }
            if (!ok) {
                for (const f of polyTargets) {
                    try {
                        const b = turfBuffer(gentleSimplify(f, 0.0004), r, {
                            units: "kilometers",
                        }) as Feature<Polygon | MultiPolygon> | undefined;
                        if (b && b.geometry && area(b) > 0) parts.push(b);
                    } catch {
                        /* skip a piece turf can't buffer */
                    }
                }
            }
        }
        // Line targets (rivers-as-centrelines / coastline lines in the cold OSM
        // fallback) can't be unioned as polygons — buffer each individually.
        for (const f of lineTargets) {
            try {
                const b = turfBuffer(gentleSimplify(f, 0.0003), r, {
                    units: "kilometers",
                }) as Feature<Polygon | MultiPolygon> | undefined;
                if (b && b.geometry && area(b) > 0) parts.push(b);
            } catch {
                /* skip a line turf can't buffer */
            }
        }
    }
    if (parts.length === 0) return null;
    if (parts.length === 1) return parts[0];
    // v1139: FAST PATH — one sweep-line union of ALL buffered parts (see
    // unionPolygonsGently). The incremental fold is the slow O(N × accumulator)
    // fallback for when a part is bad.
    try {
        const all = union(featureCollection(parts) as never) as Feature<
            Polygon | MultiPolygon
        > | null;
        if (all && all.geometry && area(all) > 0) return all;
    } catch {
        /* fall back to the incremental union below */
    }
    // Incremental union — union each part into the accumulator; on a per-part
    // failure keep the accumulator (which already holds the sea) and skip only
    // the offending part, instead of collapsing the whole result.
    let acc = parts[0];
    for (let i = 1; i < parts.length; i++) {
        try {
            const u = union(
                featureCollection([acc, parts[i]]) as never,
            ) as Feature<Polygon | MultiPolygon> | null;
            if (u && u.geometry && area(u) > 0) acc = u;
        } catch {
            /* keep the accumulator, skip this part */
        }
    }
    return acc;
}

/**
 * v1011: the seeker's LANDMASS from the basemap `water` layer — the SAME source
 * body-of-water buffers, so `same-landmass` and `body-of-water` agree on where
 * the water is (the user's ask: "why don't we use the same base calculation as
 * body of water?"). Land = the play-area frame MINUS the unioned basemap water;
 * the connected component CONTAINING the seeker is their landmass. Smooth
 * Protomaps water polygons replace the BLOCKY raster `seaFromCoastline` land.
 *
 * Returns the seeker's land polygon, or the NEAREST land part when the seeker's
 * point falls just on the water side (basemap-water imprecision — the v1001
 * "are you in a body of water?" error is fixed by never erroring here), or the
 * whole frame when there's no water (all land) / geometry fails. `null` only
 * when the frame is entirely water.
 */
function landFromWaterImpl(
    p: LandFromWaterPayload,
): Feature<Polygon> | null {
    const frame = bboxPolygon(p.bbox) as Feature<Polygon>;
    const water = (p.water ?? []).filter(isPolyFeat);
    if (water.length === 0) return frame; // no water → all land
    const waterUnion = unionPolygonsGently(water);
    if (!waterUnion) return frame;
    let land: Feature<Polygon | MultiPolygon> | null;
    try {
        land = difference(
            featureCollection([frame, waterUnion]) as never,
        ) as Feature<Polygon | MultiPolygon> | null;
    } catch {
        return frame;
    }
    if (!land || !land.geometry) return null; // frame entirely water
    const parts: Feature<Polygon>[] = [];
    if (land.geometry.type === "Polygon") {
        parts.push(land as Feature<Polygon>);
    } else {
        for (const ring of (land.geometry as MultiPolygon).coordinates) {
            try {
                parts.push(polygon(ring));
            } catch {
                /* skip a degenerate ring */
            }
        }
    }
    if (parts.length === 0) return frame;
    const pt = turfPoint([p.seeker.lng, p.seeker.lat]);
    for (const part of parts) {
        try {
            if (booleanPointInPolygon(pt, part)) return part;
        } catch {
            /* skip */
        }
    }
    // Seeker not strictly inside any land part (on the water side of an
    // imprecise shore) — return the NEAREST land part rather than erroring.
    let best: Feature<Polygon> | null = null;
    let bestD = Infinity;
    for (const part of parts) {
        try {
            const line = polygonToLine(part as never) as Feature;
            const d = pointToLineDistance(pt, line as never, {
                units: "kilometers",
            });
            if (d < bestD) {
                bestD = d;
                best = part;
            }
        } catch {
            /* skip */
        }
    }
    return best ?? parts[0] ?? frame;
}

self.onmessage = async (e: MessageEvent<InMessage>) => {
    const msg = e.data;
    const { id, type } = msg;
    try {
        if (type === "clip") {
            const [land, lake] = await Promise.all([getLand(), getLake()]);
            const result = clipPolygonToLandWith(msg.payload.polygon, land, lake);
            self.postMessage({ id, ok: true, result });
        } else if (type === "combine") {
            const result: FeatureCollection<MultiPolygon> =
                combineBoundaryGeometry(
                    msg.payload.addedFeatures,
                    msg.payload.subtractFeatures,
                    (phase) => self.postMessage({ id, phase }),
                );
            self.postMessage({ id, ok: true, result });
        } else if (type === "landFromCoast") {
            const result = landFromCoastImpl(msg.payload);
            self.postMessage({ id, ok: true, result });
        } else if (type === "seaFromCoast") {
            // v879: the SEA polygon from the OSM coastline (body-of-water /
            // coastline measuring elimination), off the main thread — the
            // same heavy node/polygonize/right-of-way-label/union as
            // landFromCoast, minus the world-frame difference. `null` on any
            // degeneracy (caller falls back to the coarse sea).
            const p = msg.payload;
            const result = seaFromCoastline(
                p.lines as never,
                p.bbox,
                { lng: p.seeker.lng, lat: p.seeker.lat },
                { useRaster: true },
            );
            self.postMessage({ id, ok: true, result });
        } else if (type === "holedMask") {
            const result = holedMaskImpl(msg.payload);
            self.postMessage({ id, ok: true, result });
        } else if (type === "bufferPoints") {
            const result = bufferPointsImpl(msg.payload);
            self.postMessage({ id, ok: true, result });
        } else if (type === "bufferAndUnion") {
            const result = bufferAndUnionImpl(msg.payload);
            self.postMessage({ id, ok: true, result });
        } else if (type === "landFromWater") {
            const result = landFromWaterImpl(msg.payload);
            self.postMessage({ id, ok: true, result });
        } else if (type === "dissolveWater") {
            // v1012: union the captured water pieces into their real bodies
            // (dissolving the redundant tile-boundary vertices) ONCE, so the
            // client can cache it per water-version and every buffer reuses a
            // small shape instead of re-unioning 100+ pieces (which piled up in
            // this single worker and timed out).
            const result = unionPolygonsGently(
                (msg.payload.features ?? []).filter((f) => f && f.geometry),
            );
            self.postMessage({ id, ok: true, result });
        } else {
            self.postMessage({
                id,
                ok: false,
                error: `unknown geometry op: ${String(type)}`,
            });
        }
    } catch (err) {
        self.postMessage({ id, ok: false, error: String(err) });
    }
};
