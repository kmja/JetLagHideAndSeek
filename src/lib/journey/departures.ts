/**
 * Client-side departure-board fetch + types — calls
 * `POST /api/journey/departures` on the overpass-cache worker.
 *
 * Wire shapes mirror `overpass-cache/src/departures/types.ts` exactly
 * (duplicated per side, same convention as `plan.ts` ↔
 * `travel/types.ts`). The board is a live stationboard the hider reads
 * to adapt on the fly — "what leaves this stop next?".
 */

import type { TransitMode } from "@/lib/gameSetup";
import { JOURNEY_API } from "@/maps/api/constants";

/** Departures endpoint URL, derived from the arrivals URL by swapping
 *  the suffix (both live under `/api/journey/`). */
export const DEPARTURES_API = JOURNEY_API.replace(
    /\/arrivals\/?$/,
    "/departures",
);

export interface Departure {
    /** Unix ms — real-time when available, else scheduled. */
    time: number;
    realtime?: boolean;
    line?: string;
    headsign?: string;
    mode: TransitMode | "transit";
}

export interface DepartureBoard {
    available: boolean;
    /** Adapter id that produced the board, or `"none"`. */
    source: string;
    stopName?: string;
    departures: Departure[];
}

const TIMEOUT_MS = 12_000;

/**
 * Fetch the next departures from a stop. Returns null on any failure
 * (network, parse, non-200) — the caller shows a quiet "no live
 * departures" state rather than throwing. An empty `departures` array
 * with `available: true` means the stop resolved but nothing's leaving
 * soon.
 */
export async function fetchDepartures(
    stop: { lat: number; lng: number; name?: string },
    modes: TransitMode[],
    signal?: AbortSignal,
): Promise<DepartureBoard | null> {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

    let resp: Response;
    try {
        resp = await fetch(DEPARTURES_API, {
            method: "POST",
            signal: ctrl.signal,
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
            },
            body: JSON.stringify({
                lat: stop.lat,
                lng: stop.lng,
                name: stop.name,
                modes,
            }),
        });
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
    }
    if (!resp.ok) return null;
    try {
        return (await resp.json()) as DepartureBoard;
    } catch {
        return null;
    }
}
