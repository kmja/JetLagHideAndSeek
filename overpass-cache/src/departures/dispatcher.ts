/**
 * Departure-board adapter dispatcher.
 *
 * The stationboard sibling of `travel/router.ts` — same regional-first
 * → MOTIS-fallback model, and it reuses the trip planner's `canServe`
 * boxes so a stop's departures come from the SAME backend that would
 * plan a trip there. Adapters are tried in declaration order; the first
 * one whose `canServe` accepts the coordinate AND returns a board wins.
 * MOTIS (self-hosted, then public Transitous) is the universal backstop.
 *
 * Not every trip-planner backend exposes a stationboard, so this list
 * is a SUBSET of `travel/router.ts`'s adapters — it grows one
 * `fetchBoard` at a time exactly like the trip planner grew one `plan`
 * at a time. Where a region has no dedicated board adapter yet, the
 * coordinate falls through to MOTIS (which covers it via GTFS).
 */

import type { Env } from "../envTypes";
import { canServe as motisSelfHostedCanServe } from "../travel/adapters/motisSelfHosted";
import * as trafiklab from "./adapters/trafiklab";
import * as transitous from "./adapters/transitous";
import type {
    Departure,
    DepartureBoardRequest,
    TravelMode,
} from "./types";

interface DepartureAdapter {
    id: string;
    canServe(lat: number, lng: number): boolean;
    /** Fetch a board, or null to defer to the next adapter. Must NOT
     *  throw — a throw is caught and treated as a defer. */
    fetchBoard(
        req: DepartureBoardRequest,
        env: Env,
        when: number,
        max: number,
        signal?: AbortSignal,
    ): Promise<{ stopName?: string; departures: Departure[] } | null>;
}

/** Trafiklab ResRobot (Sweden) — keyed; defers without the key. */
const TRAFIKLAB: DepartureAdapter = {
    id: "trafiklab",
    canServe: trafiklab.canServe,
    async fetchBoard(req, env, when, max, signal) {
        if (!env.TRAFIKLAB_API_KEY) return null;
        return trafiklab.fetchBoard(
            req,
            env.TRAFIKLAB_API_KEY,
            when,
            max,
            signal,
        );
    },
};

/** Self-hosted MOTIS — license-clean universal fallback, ordered ahead
 *  of public Transitous. Defers unless `MOTIS_SELF_HOSTED_URL` is set. */
const MOTIS_SELF_HOSTED: DepartureAdapter = {
    id: "motis-self-hosted",
    canServe: motisSelfHostedCanServe,
    async fetchBoard(req, env, when, max, signal) {
        if (!env.MOTIS_SELF_HOSTED_URL) return null;
        // The env URL is the instance's plan endpoint; derive the /api/v1
        // root it shares with the other MOTIS endpoints.
        const base = env.MOTIS_SELF_HOSTED_URL.replace(/\/plan\/?$/, "").replace(
            /\/$/,
            "",
        );
        return transitous.fetchBoard(
            base,
            req.lat,
            req.lng,
            when,
            max,
            signal,
        );
    },
};

/** Public Transitous MOTIS — near-universal keyless backstop. */
const TRANSITOUS: DepartureAdapter = {
    id: "transitous",
    canServe: transitous.canServe,
    async fetchBoard(req, _env, when, max, signal) {
        return transitous.fetchBoard(
            transitous.TRANSITOUS_BASE,
            req.lat,
            req.lng,
            when,
            max,
            signal,
        );
    },
};

/** Dispatch order: regional (Trafiklab SE) → MOTIS (self-hosted, then
 *  public Transitous). More regional board adapters slot in above MOTIS
 *  as they're written. */
export const DEPARTURE_ADAPTERS: DepartureAdapter[] = [
    TRAFIKLAB,
    MOTIS_SELF_HOSTED,
    TRANSITOUS,
];

export interface DispatchBoardResult {
    source: string;
    stopName?: string;
    departures: Departure[];
}

/**
 * Run the candidate adapters in order until one returns a board. A
 * board with zero departures still "wins" (the stop was resolved but
 * nothing's leaving soon) — that's a valid answer, not a defer; only a
 * null (couldn't resolve a stop / upstream failure) falls through.
 * Returns `{ source: "none", departures: [] }` when nothing served.
 */
export async function dispatchBoard(
    req: DepartureBoardRequest,
    env: Env,
    when: number,
    max: number,
    signal?: AbortSignal,
): Promise<DispatchBoardResult> {
    const allowed = normaliseModes(req.modes);
    const candidates = DEPARTURE_ADAPTERS.filter((a) =>
        a.canServe(req.lat, req.lng),
    );
    for (const adapter of candidates) {
        let board: { stopName?: string; departures: Departure[] } | null = null;
        try {
            board = await adapter.fetchBoard(req, env, when, max, signal);
        } catch (e) {
            console.warn(`departure adapter ${adapter.id} threw:`, e);
            board = null;
        }
        if (board) {
            const departures = filterModes(board.departures, allowed).slice(
                0,
                max,
            );
            return { source: adapter.id, stopName: board.stopName, departures };
        }
    }
    return { source: "none", departures: [] };
}

const ALL_MODES: TravelMode[] = ["bus", "tram", "train", "subway", "ferry"];

function normaliseModes(modes: TravelMode[] | undefined): Set<TravelMode> {
    const list =
        Array.isArray(modes) && modes.length > 0 ? modes : ALL_MODES;
    return new Set(list);
}

/** Drop departures on a concrete mode the game bans. A `"transit"`
 *  departure (mode unknown) is kept — we can't prove it violates the
 *  constraint, same policy as the trip planner. */
function filterModes(
    departures: Departure[],
    allowed: Set<TravelMode>,
): Departure[] {
    return departures.filter(
        (d) => d.mode === "transit" || allowed.has(d.mode),
    );
}
