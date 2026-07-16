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
    difference,
    featureCollection,
    polygon,
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
type InMessage =
    | { id: number; type: "clip"; payload: ClipPayload }
    | { id: number; type: "combine"; payload: CombinePayload }
    | { id: number; type: "landFromCoast"; payload: LandFromCoastPayload }
    | { id: number; type: "seaFromCoast"; payload: SeaFromCoastPayload }
    | { id: number; type: "holedMask"; payload: HoledMaskPayload };

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
