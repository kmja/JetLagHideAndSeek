/// <reference lib="webworker" />
import type {
    Feature,
    FeatureCollection,
    MultiPolygon,
    Polygon,
} from "geojson";

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
type InMessage =
    | { id: number; type: "clip"; payload: ClipPayload }
    | { id: number; type: "combine"; payload: CombinePayload };

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
