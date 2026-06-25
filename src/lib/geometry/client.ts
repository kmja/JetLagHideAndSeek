import type {
    Feature,
    FeatureCollection,
    MultiPolygon,
    Polygon,
} from "geojson";

import { clipPolygonToLand as clipOnMainThread } from "@/lib/landClip";

import { combineBoundaryGeometry } from "./combineCore";

/**
 * Main-thread client for the geometry Web Worker. Delegates the two
 * CPU-heavy turf pipelines (clip-to-land, boundary-combine) to the
 * worker so they never block the UI — with a transparent MAIN-THREAD
 * FALLBACK if the worker is unavailable (no `Worker`, construction
 * failed, runtime error, or a per-call timeout). Correctness is never
 * at the mercy of the worker existing; only smoothness is.
 */

type Pending = {
    resolve: (value: any) => void;
    reject: (err: Error) => void;
    onPhase?: (phase: string) => void;
    timer: ReturnType<typeof setTimeout>;
};

let worker: Worker | null = null;
let workerDead = false;
let nextId = 1;
const pending = new Map<number, Pending>();

/** A single combine/clip on a huge boundary can legitimately take a
 *  few seconds in the worker; this only guards a wedged worker. */
const CALL_TIMEOUT_MS = 30_000;

function failAllPending(err: Error) {
    for (const [, p] of pending) {
        clearTimeout(p.timer);
        p.reject(err);
    }
    pending.clear();
}

function getWorker(): Worker | null {
    if (workerDead) return null;
    if (worker) return worker;
    if (typeof Worker === "undefined") {
        workerDead = true;
        return null;
    }
    try {
        worker = new Worker(new URL("./worker.ts", import.meta.url), {
            type: "module",
        });
        worker.onmessage = (
            e: MessageEvent<{
                id: number;
                ok?: boolean;
                result?: unknown;
                error?: string;
                phase?: string;
            }>,
        ) => {
            const { id, ok, result, error, phase } = e.data;
            const entry = pending.get(id);
            if (!entry) return;
            if (phase !== undefined) {
                entry.onPhase?.(phase);
                return;
            }
            pending.delete(id);
            clearTimeout(entry.timer);
            if (ok) entry.resolve(result);
            else entry.reject(new Error(error ?? "geometry worker error"));
        };
        worker.onerror = (ev) => {
            // The worker crashed. Tear it down, fail everything in
            // flight (callers fall back to the main thread), and never
            // try to use it again this session.
            console.warn("[geometry] worker error; using main thread", ev);
            workerDead = true;
            worker = null;
            failAllPending(new Error("geometry worker crashed"));
        };
        return worker;
    } catch (e) {
        console.warn("[geometry] worker construction failed", e);
        workerDead = true;
        worker = null;
        return null;
    }
}

function call<T>(
    type: "clip" | "combine",
    payload: unknown,
    onPhase?: (phase: string) => void,
): Promise<T> {
    const w = getWorker();
    if (!w) return Promise.reject(new Error("geometry worker unavailable"));
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`geometry worker '${type}' timed out`));
        }, CALL_TIMEOUT_MS);
        pending.set(id, { resolve, reject, onPhase, timer });
        try {
            w.postMessage({ id, type, payload });
        } catch (e) {
            clearTimeout(timer);
            pending.delete(id);
            reject(e instanceof Error ? e : new Error(String(e)));
        }
    });
}

/**
 * Clip a play-area polygon to land, off the main thread. Falls back to
 * the synchronous main-thread `clipPolygonToLand` if the worker can't
 * do it. Returns `null` when the clip should be discarded (caller keeps
 * the raw polygon) — identical contract to `landClip.clipPolygonToLand`.
 */
export async function clipPolygonToLand(
    polygon: Feature<Polygon | MultiPolygon>,
): Promise<Feature<Polygon | MultiPolygon> | null> {
    try {
        return await call<Feature<Polygon | MultiPolygon> | null>("clip", {
            polygon,
        });
    } catch (e) {
        console.warn(
            "[geometry] clip via worker failed; main-thread fallback",
            e,
        );
        return clipOnMainThread(polygon);
    }
}

/**
 * Combine fetched boundary pieces into the final play-area geometry,
 * off the main thread. `onPhase` receives the worker's progress labels
 * ("Subtracting excluded areas…", "Simplifying geometry…") so the
 * loading overlay stays live. Falls back to the synchronous core on the
 * main thread if the worker can't do it.
 */
export async function combineBoundary(
    addedFeatures: Feature<Polygon | MultiPolygon>[],
    subtractFeatures: Feature<Polygon | MultiPolygon>[],
    onPhase?: (phase: string) => void,
): Promise<FeatureCollection<MultiPolygon>> {
    try {
        return await call<FeatureCollection<MultiPolygon>>(
            "combine",
            { addedFeatures, subtractFeatures },
            onPhase,
        );
    } catch (e) {
        console.warn(
            "[geometry] combine via worker failed; main-thread fallback",
            e,
        );
        return combineBoundaryGeometry(addedFeatures, subtractFeatures, onPhase);
    }
}
