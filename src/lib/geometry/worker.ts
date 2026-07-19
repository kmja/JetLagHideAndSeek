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
    const sea = seaFromCoastline(p.lines as never, p.bbox, {
        lng: p.seeker.lng,
        lat: p.seeker.lat,
    });
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
                try {
                    const d = pointToLineDistance(seeker, l as never, {
                        units: "kilometers",
                    });
                    if (d < best) best = d;
                } catch {
                    /* skip */
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
        for (const f of targets) {
            try {
                const b = turfBuffer(f as never, r, {
                    units: "kilometers",
                }) as Feature<Polygon | MultiPolygon> | undefined;
                if (b && b.geometry && area(b) > 0) parts.push(b);
            } catch {
                /* skip a feature turf can't buffer */
            }
        }
    }
    if (parts.length === 0) return null;
    if (parts.length === 1) return parts[0];
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
            const result = seaFromCoastline(p.lines as never, p.bbox, {
                lng: p.seeker.lng,
                lat: p.seeker.lat,
            });
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
