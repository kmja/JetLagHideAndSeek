/**
 * Trip-planning adapter dispatcher.
 *
 * One uniform interface, many region-specific backends. Adapters are
 * declared in specificity order (city/national planners first, the
 * walking backstop last). For a given origin we keep the adapters
 * whose `canServe` accepts the coordinate, preserving declaration
 * order, and try them in turn until one returns a journey. Walking
 * accepts everywhere, so the list is never empty and a journey is
 * always produced.
 *
 * Adding a country = adding one adapter file + one entry in
 * `ADAPTERS`. The dispatcher, the cache layer (`plan.ts`) and the
 * entire client are untouched. That's the whole point of the
 * indirection: coverage grows without the call sites knowing.
 */

import type { Env } from "../envTypes";
import * as denmark from "./adapters/denmark";
import * as digitransit from "./adapters/digitransit";
import * as entur from "./adapters/entur";
import * as germany from "./adapters/germany";
import * as navitia from "./adapters/navitia";
import * as nsw from "./adapters/nsw";
import * as swiss from "./adapters/swiss";
import * as tfl from "./adapters/tfl";
import * as trafiklab from "./adapters/trafiklab";
import * as transitous from "./adapters/transitous";
import { walkingJourney } from "./adapters/walking";
import type { Journey, PlanRequest } from "./types";

export interface TravelAdapter {
    /** Stable id, surfaced to the client as `PlanResponse.source` and
     *  used in logs. */
    id: string;
    /** True if this adapter can plan journeys originating at the given
     *  coordinate. Pure + synchronous so dispatch ordering is cheap
     *  and unit-testable. */
    canServe(lat: number, lng: number): boolean;
    /** Plan a journey, or return null to defer to the next adapter.
     *  Implementations must NOT throw — a thrown error is caught by
     *  the dispatcher and treated as a null (defer). */
    plan(
        req: PlanRequest,
        departAt: number,
        env: Env,
        signal?: AbortSignal,
    ): Promise<Journey | null>;
}

/** The Trafiklab adapter, wrapped to fit the uniform interface. Reads
 *  the API key from env at call time; returns null (defer) when the
 *  key is unset so an unconfigured operator simply gets walking. */
const TRAFIKLAB: TravelAdapter = {
    id: "trafiklab",
    canServe: trafiklab.canServe,
    async plan(req, departAt, env, signal) {
        if (!env.TRAFIKLAB_API_KEY) return null;
        return trafiklab.planJourney(
            req,
            env.TRAFIKLAB_API_KEY,
            departAt,
            signal,
        );
    },
};

/** Denmark (Rejseplanen HAFAS) — keyless. Ordered ahead of Trafiklab
 *  so the Øresund overlap routes Copenhagen to Rejseplanen. */
const DENMARK: TravelAdapter = {
    id: "denmark",
    canServe: denmark.canServe,
    async plan(req, departAt, _env, signal) {
        return denmark.planJourney(req, departAt, signal);
    },
};

/** Entur (Norway) — keyless GraphQL endpoint, always available so
 *  no env-key gate. */
const ENTUR: TravelAdapter = {
    id: "entur",
    canServe: entur.canServe,
    async plan(req, departAt, _env, signal) {
        return entur.planJourney(req, departAt, signal);
    },
};

/** Transport for NSW (Sydney/Australia) — keyed EFA; defers without
 *  the key. Geographically isolated, no bbox overlap. */
const NSW: TravelAdapter = {
    id: "nsw",
    canServe: nsw.canServe,
    async plan(req, departAt, env, signal) {
        if (!env.TFNSW_API_KEY) return null;
        return nsw.planJourney(req, env.TFNSW_API_KEY, departAt, signal);
    },
};

/** Digitransit (Finland) — subscription-keyed; defers without the
 *  key, same pattern as Trafiklab. */
const DIGITRANSIT: TravelAdapter = {
    id: "digitransit",
    canServe: digitransit.canServe,
    async plan(req, departAt, env, signal) {
        if (!env.DIGITRANSIT_API_KEY) return null;
        return digitransit.planJourney(
            req,
            env.DIGITRANSIT_API_KEY,
            departAt,
            signal,
        );
    },
};

/** TfL (London) — works keyless at a lower rate limit, optional key
 *  for higher quota. Never defers on key absence. */
const TFL: TravelAdapter = {
    id: "tfl",
    canServe: tfl.canServe,
    async plan(req, departAt, env, signal) {
        return tfl.planJourney(req, env.TFL_API_KEY, departAt, signal);
    },
};

/** Switzerland (SBB via transport.opendata.ch) — keyless, never
 *  defers on env. */
const SWISS: TravelAdapter = {
    id: "swiss",
    canServe: swiss.canServe,
    async plan(req, departAt, _env, signal) {
        return swiss.planJourney(req, departAt, signal);
    },
};

/** Germany (DB HAFAS via v6.db.transport.rest) — keyless, never
 *  defers on env. */
const GERMANY: TravelAdapter = {
    id: "germany",
    canServe: germany.canServe,
    async plan(req, departAt, _env, signal) {
        return germany.planJourney(req, departAt, signal);
    },
};

/** navitia (broad European fallback) — keyed; defers without the key.
 *  Ordered last among the regional adapters so country-specific
 *  planners win first; navitia only runs where they all decline. */
const NAVITIA: TravelAdapter = {
    id: "navitia",
    canServe: navitia.canServe,
    async plan(req, departAt, env, signal) {
        if (!env.NAVITIA_API_KEY) return null;
        return navitia.planJourney(req, env.NAVITIA_API_KEY, departAt, signal);
    },
};

/** Transitous (MOTIS over the Mobility Database) — the near-universal
 *  fallback. FREE and KEYLESS (community-run), so it's always
 *  available; outside its coverage it returns no itinerary and we fall
 *  through to walking. */
const TRANSITOUS: TravelAdapter = {
    id: "transitous",
    canServe: transitous.canServe,
    async plan(req, departAt, _env, signal) {
        return transitous.planJourney(req, departAt, signal);
    },
};

/** The unconditional backstop. `canServe` is always true, so it's
 *  always last and always answers. */
const WALKING: TravelAdapter = {
    id: "walking",
    canServe: () => true,
    async plan(req, departAt) {
        return walkingJourney(req.origin, req.destination, departAt);
    },
};

/** Dispatch order. Three tiers, ALL FREE (no billing / no credit card):
 *  1. Free country/region adapters (Denmark, Trafiklab SE, Entur NO,
 *     Digitransit FI, TfL London, Swiss CH, Germany DE, NSW Sydney) —
 *     mostly disjoint bboxes; where two overlap (DK/SE) the more
 *     specific is first and `dispatchPlan` falls through on null.
 *  2. Broad fallbacks: `navitia` (Europe, free key), then `transitous`
 *     (free + keyless, MOTIS over the Mobility Database — near-universal
 *     and growing).
 *  3. `walking` — the unconditional final backstop.
 *  Each tier only runs where the tier above it declines/has no key.
 *  (Paid providers like Google Directions / HERE were deliberately NOT
 *  used — they require billing and bill per request.) */
export const ADAPTERS: TravelAdapter[] = [
    DENMARK,
    TRAFIKLAB,
    ENTUR,
    DIGITRANSIT,
    TFL,
    SWISS,
    GERMANY,
    NSW,
    NAVITIA,
    TRANSITOUS,
    WALKING,
];

/**
 * The ordered subset of adapters that will be tried for an origin at
 * (lat, lng). Pure — no I/O — so the dispatch decision can be tested
 * directly. Walking is guaranteed to be present (and last).
 */
export function selectAdapters(
    lat: number,
    lng: number,
    adapters: TravelAdapter[] = ADAPTERS,
): TravelAdapter[] {
    return adapters.filter((a) => a.canServe(lat, lng));
}

/** What `dispatchPlan` resolves to: the journey plus the id of the
 *  adapter that produced it. */
export interface DispatchResult {
    source: string;
    journey: Journey | null;
}

/**
 * Run the selected adapters in order until one yields a journey.
 * Because walking always serves and always succeeds, this resolves to
 * a non-null journey for any finite origin/destination.
 */
export async function dispatchPlan(
    req: PlanRequest,
    departAt: number,
    env: Env,
    signal?: AbortSignal,
): Promise<DispatchResult> {
    const candidates = selectAdapters(req.origin.lat, req.origin.lng);
    for (const adapter of candidates) {
        let journey: Journey | null = null;
        try {
            journey = await adapter.plan(req, departAt, env, signal);
        } catch (e) {
            console.warn(`travel adapter ${adapter.id} threw:`, e);
            journey = null;
        }
        if (journey) return { source: adapter.id, journey };
    }
    // Unreachable in practice (walking is always a candidate), but
    // keep the type honest.
    return { source: "none", journey: null };
}
