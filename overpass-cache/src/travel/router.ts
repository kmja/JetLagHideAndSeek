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
import * as australia from "./adapters/australia";
import * as austria from "./adapters/austria";
import * as barcelona from "./adapters/barcelona";
import * as denmark from "./adapters/denmark";
import * as digitransit from "./adapters/digitransit";
import * as entur from "./adapters/entur";
import * as estonia from "./adapters/estonia";
import * as france from "./adapters/france";
import * as germany from "./adapters/germany";
import * as hungary from "./adapters/hungary";
import * as ireland from "./adapters/ireland";
import * as korea from "./adapters/korea";
import * as motisSelfHosted from "./adapters/motisSelfHosted";
import * as navitia from "./adapters/navitia";
import * as netherlands from "./adapters/netherlands";
import * as nsw from "./adapters/nsw";
import * as swiss from "./adapters/swiss";
import * as tfl from "./adapters/tfl";
import * as trafiklab from "./adapters/trafiklab";
import * as transitous from "./adapters/transitous";
import { walkingJourney, walkingSeconds } from "./adapters/walking";
import type { Journey, PlanRequest, TravelMode } from "./types";

/**
 * Clamp an implausibly-long ACCESS (first) or EGRESS (last) walk leg to the
 * straight-line walking estimate. A transit planner (MOTIS) routes the access
 * walk to its GTFS stop coordinate — often a few hundred metres off the nearest
 * entrance, or a far end of a long station — so a 200 m straight-line gap can
 * come back as a 10-min walk, which is jarring next to the direct-station card's
 * honest 3-min estimate. Only the first/last walk legs are touched (a mid-trip
 * transfer walk is constrained by both stops' schedules); a scheduled transit
 * leg's clock is FIXED, so clamping the access walk means "leave later" (move
 * its departAt) and clamping the egress walk means "arrive earlier" (move its
 * arriveAt) — the transit legs never move. Only shortens (never lengthens), and
 * only when the routed walk exceeds 2.2× the estimate AND 4 min, so normal
 * walks are untouched.
 */
export function clampAccessEgressWalks(journey: Journey): Journey {
    const legs = journey.legs;
    if (!legs || legs.length < 2) return journey; // walk-only trip: leave it
    const hasTransit = legs.some((l) => l.mode !== "walk");
    if (!hasTransit) return journey;
    const CLAMP_MIN_SEC = 240;
    const CLAMP_FACTOR = 2.2;
    const out = legs.map((l) => ({ ...l }));
    const first = out[0];
    if (first.mode === "walk") {
        const est = walkingSeconds(first.from, first.to);
        const actual = (first.arriveAt - first.departAt) / 1000;
        if (est > 0 && actual > Math.max(est * CLAMP_FACTOR, CLAMP_MIN_SEC)) {
            first.departAt = first.arriveAt - Math.round(est * 1000);
        }
    }
    const last = out[out.length - 1];
    if (last.mode === "walk") {
        const est = walkingSeconds(last.from, last.to);
        const actual = (last.arriveAt - last.departAt) / 1000;
        if (est > 0 && actual > Math.max(est * CLAMP_FACTOR, CLAMP_MIN_SEC)) {
            last.arriveAt = last.departAt + Math.round(est * 1000);
        }
    }
    const departAt = out[0].departAt;
    const arriveAt = out[out.length - 1].arriveAt;
    return {
        ...journey,
        legs: out,
        departAt,
        arriveAt,
        durationMin: Math.max(1, Math.round((arriveAt - departAt) / 60000)),
    };
}

/**
 * True if every transit leg in `journey` uses a mode the request allows.
 *
 * Walking is always allowed; a generic `"transit"` leg (mode couldn't be
 * determined upstream) is allowed too — we can't prove it violates the
 * constraint, and dropping otherwise-fine multimodal journeys on an
 * unknown leg would be over-eager. Only a CONCRETE disallowed mode
 * (bus / tram / train / subway / ferry absent from the allow-set) makes a
 * journey infeasible.
 *
 * `modes` is always populated by `normaliseModes` (it defaults to the
 * full set when the client sends none), so an unconstrained request
 * contains every mode and this returns true for any journey — a no-op.
 * Only when the player has actually banned a mode does it bite.
 */
export function journeyModesAllowed(
    journey: Journey,
    modes: TravelMode[] | undefined,
): boolean {
    if (!modes || modes.length === 0) return true;
    const allowed = new Set<string>(modes);
    for (const leg of journey.legs) {
        if (leg.mode === "walk" || leg.mode === "transit") continue;
        if (!allowed.has(leg.mode)) return false;
    }
    return true;
}

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
    async plan(req, departAt, env, signal) {
        // Rejseplanen open API 1.0 was shut down; API 2.0 needs a key.
        // Defer to Transitous until a key (and an API-2.0 request shape)
        // is wired — see envTypes.REJSEPLANEN_API_KEY + denmark.ts.
        if (!env.REJSEPLANEN_API_KEY) return null;
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

/** Austria (ÖBB via v6.oebb.transport.rest) — keyless FPTF, reuses the
 *  Germany transport.rest helper. Ordered after Germany so DACH-overlap
 *  German cities still hit DB first (both HAFAS cover the region). */
const AUSTRIA: TravelAdapter = {
    id: "austria",
    canServe: austria.canServe,
    async plan(req, departAt, _env, signal) {
        return austria.planJourney(req, departAt, signal);
    },
};

/** Estonia (peatus.ee) — keyless OTP REST, reuses planViaOtp. */
const ESTONIA: TravelAdapter = {
    id: "estonia",
    canServe: estonia.canServe,
    async plan(req, departAt, _env, signal) {
        return estonia.planJourney(req, departAt, signal);
    },
};

/** Ireland (TFI/NTA EFA) — keyless, reuses the NSW EFA parser. */
const IRELAND: TravelAdapter = {
    id: "ireland",
    canServe: ireland.canServe,
    async plan(req, departAt, _env, signal) {
        return ireland.planJourney(req, departAt, signal);
    },
};

/** Barcelona (TMB OTP) — keyed (app_id + app_key), reuses planViaOtp.
 *  Defers unless both TMB keys are set. */
const BARCELONA: TravelAdapter = {
    id: "barcelona",
    canServe: barcelona.canServe,
    async plan(req, departAt, env, signal) {
        if (!env.TMB_APP_ID || !env.TMB_APP_KEY) return null;
        return barcelona.planJourney(
            req,
            env.TMB_APP_ID,
            env.TMB_APP_KEY,
            departAt,
            signal,
        );
    },
};

/** Netherlands (NS Trips) — keyed, rail-centric coordinate planner. */
const NETHERLANDS: TravelAdapter = {
    id: "netherlands",
    canServe: netherlands.canServe,
    async plan(req, departAt, env, signal) {
        if (!env.NS_API_KEY) return null;
        return netherlands.planJourney(req, env.NS_API_KEY, departAt, signal);
    },
};

/** South Korea (ODsay) — keyed; nationwide subway/bus routing. */
const KOREA: TravelAdapter = {
    id: "korea",
    canServe: korea.canServe,
    async plan(req, departAt, env, signal) {
        if (!env.ODSAY_API_KEY) return null;
        return korea.planJourney(req, env.ODSAY_API_KEY, departAt, signal);
    },
};

/** BKK FUTÁR (Budapest) — keyed OTP. Free key from opendata.bkk.hu;
 *  defers when unset. Slotted before navitia so Hungarian origins hit
 *  the regional planner first when a key is available. */
const HUNGARY: TravelAdapter = {
    id: "hungary",
    canServe: hungary.canServe,
    async plan(req, departAt, env, signal) {
        if (!env.BKK_FUTAR_KEY) return null;
        return hungary.planJourney(req, env.BKK_FUTAR_KEY, departAt, signal);
    },
};

/** La Trobe University public OTP — KEYLESS, covers AU non-NSW (VIC /
 *  QLD / SA / WA / TAS / NT / ACT). Academic-hosted, no SLA, so it's
 *  ordered AFTER the official NSW EFA and BEFORE Transitous — a null
 *  here cleanly falls through. Inside the adapter the per-state router
 *  id is picked by bbox; coords outside the per-state hints simply
 *  return null. */
const AUSTRALIA: TravelAdapter = {
    id: "australia",
    canServe: australia.canServe,
    async plan(req, departAt, _env, signal) {
        return australia.planJourney(req, departAt, signal);
    },
};

/** IDFM PRIM (Paris / Île-de-France) — keyed Navitia instance, free
 *  20k/day quota pool. Defers without the key. Ordered ahead of the
 *  broad navitia.io fallback so Paris-region origins use the
 *  authoritative IdF source + its separate quota; the rest of France
 *  still falls through to navitia. */
const FRANCE: TravelAdapter = {
    id: "france",
    canServe: france.canServe,
    async plan(req, departAt, env, signal) {
        if (!env.PRIM_API_KEY) return null;
        return france.planJourney(req, env.PRIM_API_KEY, departAt, signal);
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

/** Self-hosted MOTIS — the LICENSE-CLEAN universal fallback. Same MOTIS
 *  API as Transitous but pointed at the operator's own box (env URL),
 *  so it has no non-commercial restriction. Ordered AHEAD of the public
 *  Transitous instance: when `MOTIS_SELF_HOSTED_URL` is set, your box
 *  wins; otherwise it defers. */
const MOTIS_SELF_HOSTED: TravelAdapter = {
    id: "motis-self-hosted",
    canServe: motisSelfHosted.canServe,
    async plan(req, departAt, env, signal) {
        if (!env.MOTIS_SELF_HOSTED_URL) return null;
        return motisSelfHosted.planJourney(
            env.MOTIS_SELF_HOSTED_URL,
            req,
            departAt,
            signal,
        );
    },
};

/** Transitous (public MOTIS over the Mobility Database) — near-universal
 *  fallback. FREE + KEYLESS, but ⚠️ flagged "non-commercial" (see
 *  transitous.ts). Kept as a backstop after self-hosted MOTIS; revisit
 *  if the app is ever monetised. */
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

/** Dispatch order. Tiers, ALL FREE (no billing / no credit card):
 *  1. Free country/region adapters — Denmark, Trafiklab SE, Entur NO,
 *     Digitransit FI, Estonia, TfL London, Swiss CH, Germany DE,
 *     Austria, Ireland, Barcelona, NSW Sydney. Mostly disjoint bboxes;
 *     overlaps (DK/SE Øresund, DACH borders) are handled by order +
 *     `dispatchPlan` null-fallthrough since the regional HAFAS/OTP
 *     instances cover their neighbours too.
 *  2. Broad fallbacks: `navitia` (Europe, free key) → `motis-self-hosted`
 *     (operator's own MOTIS box, license-clean, env URL) → `transitous`
 *     (public MOTIS, free+keyless but ⚠️ non-commercial — backstop only).
 *  3. `walking` — the unconditional final backstop.
 *  Each tier only runs where the tier above declines/has no key.
 *  (Paid providers — Google Directions, HERE — are deliberately NOT
 *  used: they require billing. See CLAUDE.md.) */
export const ADAPTERS: TravelAdapter[] = [
    DENMARK,
    TRAFIKLAB,
    ENTUR,
    DIGITRANSIT,
    ESTONIA,
    TFL,
    SWISS,
    GERMANY,
    AUSTRIA,
    IRELAND,
    HUNGARY,
    BARCELONA,
    NETHERLANDS,
    NSW,
    AUSTRALIA,
    KOREA,
    FRANCE,
    NAVITIA,
    MOTIS_SELF_HOSTED,
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
        // Reject a journey that rides a mode the player has banned and
        // fall through to the next adapter. Most regional planners can't
        // be told to avoid a mode, so we filter their output instead; the
        // unconditional walking backstop always satisfies the constraint,
        // so this can only downgrade an illegal transit route to walking,
        // never blank the plan. Without this the planner happily suggested
        // e.g. a bus even when bus wasn't an allowed transit mode.
        if (journey && !journeyModesAllowed(journey, req.modes)) {
            journey = null;
        }
        if (journey)
            return {
                source: adapter.id,
                journey: clampAccessEgressWalks(journey),
            };
    }
    // Unreachable in practice (walking is always a candidate), but
    // keep the type honest.
    return { source: "none", journey: null };
}
