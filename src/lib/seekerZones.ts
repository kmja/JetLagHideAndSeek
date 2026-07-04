import type { Units } from "@turf/turf";
import type {
    Feature,
    FeatureCollection,
    MultiPolygon,
    Polygon,
} from "geojson";

import { prepareZoneCircles, styleZoneStations } from "@/lib/zonePipeline";
import type { StationCircle, StationPlace } from "@/maps/api/types";

/**
 * Client-side handle to the seeker-zones worker
 * (`src/workers/seekerZones.worker.ts`).
 *
 * The seeker overlay's heavy geometry (512-step circles + remaining-area
 * intersect filter, and the union of every circle for the styled fill)
 * runs OFF the main thread so a dense metro's compute doesn't freeze the
 * app — the exact fix the hider overlay got in v652, applied to the
 * seeker's `ZoneSidebar` pipeline.
 *
 * One lazily-created, reused worker; requests are id-tagged. Where
 * Workers are unavailable (or the worker dies), calls FALL BACK to
 * running the same pure `zonePipeline` functions on the main thread —
 * identical results, just the old blocking behaviour.
 *
 * Errors from the pipeline (e.g. the remaining-area union failing) are
 * RE-THROWN to the caller, matching the old inline behaviour where
 * `ZoneSidebar`'s catch → toast path owns them.
 */

interface Pending {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
}

let worker: Worker | null = null;
let workerBroken = false;
let nextId = 1;
const pending = new Map<number, Pending>();

function getWorker(): Worker | null {
    if (workerBroken) return null;
    if (typeof window === "undefined" || typeof Worker === "undefined") {
        return null;
    }
    if (!worker) {
        try {
            worker = new Worker(
                new URL("../workers/seekerZones.worker.ts", import.meta.url),
                { type: "module" },
            );
            worker.onmessage = (
                e: MessageEvent<{
                    id: number;
                    ok: boolean;
                    result?: unknown;
                    error?: string;
                }>,
            ) => {
                const p = pending.get(e.data.id);
                if (!p) return;
                pending.delete(e.data.id);
                if (e.data.ok) p.resolve(e.data.result);
                else p.reject(new Error(e.data.error ?? "zone worker error"));
            };
            worker.onerror = () => {
                // The worker died — reject everything in flight (callers
                // toast like any pipeline failure) and stop using it this
                // session; later calls take the main-thread fallback.
                workerBroken = true;
                for (const p of pending.values())
                    p.reject(new Error("zone worker crashed"));
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

function callWorker(msg: Record<string, unknown>): Promise<unknown> | null {
    const w = getWorker();
    if (!w) return null;
    const id = nextId++;
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try {
            w.postMessage({ ...msg, id });
        } catch (e) {
            pending.delete(id);
            reject(e instanceof Error ? e : new Error(String(e)));
        }
    });
}

/** `prepareZoneCircles`, off-thread when possible. */
export async function prepareZoneCirclesAsync(
    places: StationPlace[],
    radius: number,
    units: Units,
    area: FeatureCollection<Polygon | MultiPolygon>,
): Promise<StationCircle[]> {
    const viaWorker = callWorker({ op: "prepare", places, radius, units, area });
    if (viaWorker) return (await viaWorker) as StationCircle[];
    return prepareZoneCircles(places, radius, units, area);
}

/** `styleZoneStations`, off-thread when possible. The cheap styles
 *  ("zones" / "no-display" — no union) run inline: a worker round-trip
 *  would just add clone latency for zero main-thread relief. */
export async function styleZoneStationsAsync(
    circles: StationCircle[],
    style: string,
): Promise<FeatureCollection | Feature> {
    if (style !== "stations" && style !== "no-overlap") {
        return styleZoneStations(circles, style);
    }
    const viaWorker = callWorker({ op: "style", circles, style });
    if (viaWorker) return (await viaWorker) as FeatureCollection | Feature;
    return styleZoneStations(circles, style);
}
