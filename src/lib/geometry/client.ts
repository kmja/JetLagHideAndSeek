import type {
    Feature,
    FeatureCollection,
    MultiPolygon,
    Polygon,
} from "geojson";

import { clipPolygonToLand as clipOnMainThread } from "@/lib/landClip";
import { holedMask as holedMaskOnMainThread } from "@/maps/geo-utils/operators";

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

// v1013: a POOL of geometry workers, not one. The configure dialog fires a
// water dissolve + buffer while the seeker map behind it runs `holedMask`, and
// version-bump re-computes queue more — all in a SINGLE serial worker they
// piled up and hit the 30 s timeout (→ dissolve fell back to raw polys → buffer
// timed out → arcgis on the main thread → the ~30 s freeze the user saw). A
// small pool runs them in parallel so no op waits behind an unrelated one. Ids
// are globally unique, so one shared `pending` map dispatches across all
// workers; each result carries its id back to the right caller regardless of
// which worker produced it.
let workers: Worker[] = [];
let poolInit = false;
let poolDead = false;
let rrIndex = 0;
let nextId = 1;
const pending = new Map<number, Pending>();

/** A single combine/clip on a huge boundary can legitimately take a
 *  few seconds in the worker; this only guards a wedged worker. */
const CALL_TIMEOUT_MS = 30_000;

function poolSize(): number {
    const cores =
        typeof navigator !== "undefined" &&
        typeof navigator.hardwareConcurrency === "number"
            ? navigator.hardwareConcurrency
            : 4;
    // 2–4 workers: enough to overlap dissolve + buffer + holedMask without
    // spawning a worker per core (each loads the full worker bundle).
    return Math.max(2, Math.min(4, cores - 2));
}

function failAllPending(err: Error) {
    for (const [, p] of pending) {
        clearTimeout(p.timer);
        p.reject(err);
    }
    pending.clear();
}

function makeWorker(): Worker {
    const w = new Worker(new URL("./worker.ts", import.meta.url), {
        type: "module",
    });
    w.onmessage = (
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
    w.onerror = (ev) => {
        // A worker crashed. Tear the whole pool down, fail everything in
        // flight (callers fall back to the main thread), and never try the
        // pool again this session.
        console.warn("[geometry] worker error; using main thread", ev);
        poolDead = true;
        for (const worker of workers) {
            try {
                worker.terminate();
            } catch {
                /* ignore */
            }
        }
        workers = [];
        failAllPending(new Error("geometry worker crashed"));
    };
    return w;
}

/** Pick the next pool worker round-robin (lazily constructing the pool). */
function getWorker(): Worker | null {
    if (poolDead) return null;
    if (typeof Worker === "undefined") {
        poolDead = true;
        return null;
    }
    if (!poolInit) {
        poolInit = true;
        try {
            const n = poolSize();
            for (let i = 0; i < n; i++) workers.push(makeWorker());
            // eslint-disable-next-line no-console
            console.log(`[geometry] worker pool created: ${n} workers`);
        } catch (e) {
            console.warn("[geometry] worker construction failed", e);
            poolDead = true;
            workers = [];
            return null;
        }
    }
    if (workers.length === 0) return null;
    const w = workers[rrIndex % workers.length];
    rrIndex++;
    return w;
}

function call<T>(
    type:
        | "clip"
        | "combine"
        | "landFromCoast"
        | "seaFromCoast"
        | "holedMask"
        | "bufferPoints"
        | "bufferAndUnion"
        | "landFromWater"
        | "dissolveWater",
    payload: unknown,
    onPhase?: (phase: string) => void,
): Promise<T> {
    const w = getWorker();
    if (!w) return Promise.reject(new Error("geometry worker unavailable"));
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            pending.delete(id);
            // eslint-disable-next-line no-console
            console.warn(`[geometry] '${type}' TIMED OUT after ${CALL_TIMEOUT_MS}ms`);
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
 * Per-city LAND polygons from the OSM coastline, OFF the main thread (v875).
 * The heavy `seaFromCoastline` + world-frame `difference` runs in the worker
 * so a dense coastal metro's same-landmass question / configure preview no
 * longer freezes the UI. REJECTS if the worker is unavailable — the caller
 * (`coast.ts fetchAreaLandPolygons`) keeps its own main-thread fallback, so
 * this never touches correctness, only smoothness.
 */
export async function landFromCoast(
    lines: Feature[],
    bbox: [number, number, number, number],
    seeker: { lat: number; lng: number },
): Promise<Feature<Polygon | MultiPolygon> | null> {
    return call<Feature<Polygon | MultiPolygon> | null>("landFromCoast", {
        lines,
        bbox,
        seeker,
    });
}

/**
 * The SEA polygon from the OSM coastline, OFF the main thread (v879) — the
 * body-of-water / coastline measuring elimination's heaviest step
 * (`seaFromCoastline`). REJECTS if the worker is unavailable, so the caller
 * (`measuring.ts`) keeps its synchronous main-thread `seaFromCoastline` +
 * coarse-sea fallback — correctness never depends on the worker existing,
 * only smoothness. `null` = no valid sea (caller falls back).
 */
export async function seaFromCoast(
    lines: Feature[],
    bbox: [number, number, number, number],
    seeker: { lat: number; lng: number },
): Promise<Feature<Polygon | MultiPolygon> | null> {
    return call<Feature<Polygon | MultiPolygon> | null>("seaFromCoast", {
        lines,
        bbox,
        seeker,
    });
}

/**
 * The "closer than my nearest X" region for a POINT-reference measuring
 * question, OFF the main thread (v978) — the union of a disk (radius = the
 * seeker's distance to the nearest reference) around EVERY reference. arcgis's
 * geodesic buffer did this in ONE synchronous WASM call over hundreds of
 * point-circles and froze the app on a dense metro (NYC parks / stations /
 * peaks). Pure turf here. REJECTS if the worker is unavailable so the caller
 * (`measuring.ts bufferedDeterminer`) keeps its arcgis fallback — the hider
 * grades by DISTANCE, so the turf-vs-arcgis cut differs only sub-metre and
 * never changes an answer. `null` on a degenerate input.
 */
export async function bufferPointsUnion(
    points: [number, number][],
    lat: number,
    lng: number,
): Promise<Feature<Polygon | MultiPolygon> | null> {
    return call<Feature<Polygon | MultiPolygon> | null>("bufferPoints", {
        points,
        seeker: { lat, lng },
    });
}

/**
 * v984: the generalized measuring "closer than my nearest X" region for ANY
 * geometry (points/lines/polygons), OFF the main thread — the turf equivalent
 * of arcgis's `arcBufferToPoint` (buffer every feature by the seeker's distance
 * to the nearest, union). Lets body-of-water (ponds + rivers + sea AREA) compute
 * without freezing / choking arcgis. REJECTS if the worker is unavailable so the
 * caller keeps its arcgis fallback. `null` on a degenerate input.
 */
export async function bufferAndUnion(
    features: Feature[],
    lat: number,
    lng: number,
): Promise<Feature<Polygon | MultiPolygon> | null> {
    return call<Feature<Polygon | MultiPolygon> | null>("bufferAndUnion", {
        features,
        seeker: { lat, lng },
    });
}

/**
 * v1011: the seeker's LANDMASS from basemap water polygons (frame − unioned
 * water, the component containing the seeker), OFF the main thread — the
 * `same-landmass` counterpart to `bufferAndUnion`, sharing the SAME basemap
 * water source as body-of-water so the two agree. Returns the seeker's land
 * polygon (nearest part if the seeker falls on an imprecise shore), the whole
 * frame when there's no water, or `null` when the frame is all water. REJECTS
 * if the worker is unavailable so the caller keeps its OSM-coast fallback.
 */
export async function landFromWater(
    water: Feature[],
    bbox: [number, number, number, number],
    lat: number,
    lng: number,
): Promise<Feature<Polygon> | null> {
    return call<Feature<Polygon> | null>("landFromWater", {
        water,
        bbox,
        seeker: { lat, lng },
    });
}

/**
 * v1012: union captured water pieces into their real bodies (dissolving the
 * redundant tile-boundary vertices) OFF the main thread. Position-independent,
 * so the client caches it per water-version and every downstream buffer reuses
 * the small dissolved shape. REJECTS if the worker is unavailable. `null` on an
 * empty/degenerate input.
 */
export async function dissolveWater(
    features: Feature[],
): Promise<Feature<Polygon | MultiPolygon> | null> {
    return call<Feature<Polygon | MultiPolygon> | null>("dissolveWater", {
        features,
    });
}

/**
 * The dimming MASK (world rectangle minus the play area), OFF the main
 * thread (v899). The world-scale `turf.difference` froze the tab for a beat
 * on a dense boundary every time an answer shrank the remaining area. Falls
 * back to the synchronous main-thread `holedMask` if the worker is
 * unavailable — identical `Feature | null` contract, so correctness never
 * depends on the worker existing.
 */
export async function holedMaskViaWorker(
    input:
        | Feature<Polygon | MultiPolygon>
        | FeatureCollection<Polygon | MultiPolygon>,
): Promise<Feature | null> {
    try {
        return await call<Feature | null>("holedMask", { input });
    } catch (e) {
        console.warn(
            "[geometry] holedMask via worker failed; main-thread fallback",
            e,
        );
        return holedMaskOnMainThread(input) as Feature | null;
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
