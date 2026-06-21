/**
 * Client-side trip-plan fetch + types — calls
 * `POST /api/travel/plan` on the overpass-cache worker.
 *
 * Wire shapes mirror `overpass-cache/src/travel/types.ts` exactly.
 * They're duplicated rather than imported across worker roots; the
 * convention matches the journey-arrival proxy (`resrobot.ts` ↔
 * `journey.ts`) — both sides agree on the JSON contract without
 * sharing a TS module.
 */

import type { TransitMode } from "@/lib/gameSetup";
import { JOURNEY_API } from "@/maps/api/constants";

/** Trip-plan endpoint URL, derived from the journey arrivals URL by
 *  swapping the route suffix — saves us another constant + override. */
export const TRAVEL_PLAN_API = JOURNEY_API.replace(
    /\/api\/journey\/arrivals\/?$/,
    "/api/travel/plan",
);

export type TravelMode = TransitMode;

export interface TravelPoint {
    lat: number;
    lng: number;
}

export interface TravelPlace extends TravelPoint {
    name?: string;
}

export interface PlanRequest {
    origin: TravelPoint;
    destination: TravelPlace;
    departAt?: number;
    modes?: TravelMode[];
}

export interface JourneyLeg {
    mode: "walk" | TravelMode | "transit";
    line?: string;
    direction?: string;
    from: TravelPlace;
    to: TravelPlace;
    departAt: number;
    arriveAt: number;
    distanceMeters?: number;
}

export interface Journey {
    departAt: number;
    arriveAt: number;
    durationMin: number;
    transfers: number;
    legs: JourneyLeg[];
}

export interface PlanResponse {
    available: boolean;
    /** Adapter id: `"trafiklab"`, `"walking"`, etc. The UI uses this
     *  to label walking-sourced plans as estimates. */
    source: string;
    journey: Journey | null;
}

/** Network + abort timeout matching the trafiklab adapter's
 *  per-upstream cap plus a slack budget for the round trip. */
const PROXY_TIMEOUT_MS = 20_000;

/**
 * Fetch a single planned journey. Returns null on any failure
 * (network, parse, non-200) — the caller surfaces "couldn't plan a
 * route" rather than throwing. The worker is built so it ALWAYS
 * succeeds with at least a walking fallback, so a null here means a
 * genuine transport-layer problem (offline, DNS) rather than
 * unsupported geography.
 */
export async function fetchTripPlan(
    req: PlanRequest,
    signal?: AbortSignal,
): Promise<PlanResponse | null> {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), PROXY_TIMEOUT_MS);

    let resp: Response;
    try {
        resp = await fetch(TRAVEL_PLAN_API, {
            method: "POST",
            signal: ctrl.signal,
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
            },
            body: JSON.stringify(req),
        });
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
    }
    if (!resp.ok) return null;
    try {
        return (await resp.json()) as PlanResponse;
    } catch {
        return null;
    }
}
