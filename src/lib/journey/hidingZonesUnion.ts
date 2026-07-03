import type { Units } from "@turf/turf";
import type { Feature } from "geojson";

/**
 * Client-side handle to the hiding-zones union worker
 * (`src/workers/hidingZonesUnion.worker.ts`).
 *
 * The heavy `turf.union` of every candidate zone's hiding-radius circle
 * runs OFF the main thread so the overlay can paint its dots instantly
 * and drop the fill in when it's ready — no app-wide hitch while a dense
 * metro's hundreds of circles are merged.
 *
 * One lazily-created, reused worker; requests are id-tagged so a stale
 * response (the hider moved / toggled off before this one finished) is
 * ignored via the AbortSignal. Degrades gracefully to `null` (dots-only,
 * no fill) where Workers aren't available.
 */

let worker: Worker | null = null;
let workerBroken = false;
let nextId = 1;
const pending = new Map<number, (u: Feature | null) => void>();

function getWorker(): Worker | null {
    if (workerBroken) return null;
    if (typeof window === "undefined" || typeof Worker === "undefined") {
        return null;
    }
    if (!worker) {
        try {
            worker = new Worker(
                new URL(
                    "../../workers/hidingZonesUnion.worker.ts",
                    import.meta.url,
                ),
                { type: "module" },
            );
            worker.onmessage = (
                e: MessageEvent<{ id: number; union: Feature | null }>,
            ) => {
                const cb = pending.get(e.data.id);
                if (cb) {
                    pending.delete(e.data.id);
                    cb(e.data.union);
                }
            };
            worker.onerror = () => {
                // The worker died — resolve everything waiting to null
                // (dots-only) and stop trying to use it this session.
                workerBroken = true;
                for (const cb of pending.values()) cb(null);
                pending.clear();
                worker = null;
            };
        } catch {
            workerBroken = true;
            worker = null;
        }
    }
    return worker;
}

/**
 * Compute the unioned hiding-radius extent polygon for a set of stations,
 * off the main thread. Resolves with the union `Feature`, or `null` when
 * there's no fill to draw / no worker support / the request was aborted.
 */
export function computeHidingUnion(
    stations: { lng: number; lat: number }[],
    radius: number,
    units: Units,
    signal?: AbortSignal,
): Promise<Feature | null> {
    const w = getWorker();
    if (!w) return Promise.resolve(null);
    if (signal?.aborted) return Promise.resolve(null);
    const id = nextId++;
    return new Promise((resolve) => {
        pending.set(id, resolve);
        signal?.addEventListener(
            "abort",
            () => {
                if (pending.has(id)) {
                    pending.delete(id);
                    resolve(null);
                }
            },
            { once: true },
        );
        try {
            w.postMessage({ id, stations, radius, units });
        } catch {
            pending.delete(id);
            resolve(null);
        }
    });
}
