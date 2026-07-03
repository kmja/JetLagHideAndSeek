/**
 * Wire types for the departure-board endpoint (`/api/journey/departures`).
 *
 * Self-contained, same convention as `travel/types.ts` and `journey.ts`
 * — the browser mirror lives in `src/lib/journey/departures.ts` and the
 * two agree on the JSON shape without a shared TS import.
 *
 * This endpoint answers a DIFFERENT question from the other two transit
 * endpoints:
 *   - `/api/journey/arrivals`  → "when do I arrive at each of these
 *     stops from an anchor?" (kept only the final timestamp).
 *   - `/api/travel/plan`       → "give me the whole A→B journey."
 *   - `/api/journey/departures`→ "what leaves THIS stop next?" — a live
 *     stationboard the hider reads to adapt on the fly.
 *
 * It reuses the trip planner's regional-first → MOTIS-fallback dispatch
 * (see `dispatcher.ts`): the SAME `canServe` boxes decide which backend
 * serves a coordinate, so a departure board comes from the same source
 * that would plan a trip there.
 */

/** Transit modes — mirrors `TravelMode` in `travel/types.ts`. */
export type TravelMode = "bus" | "tram" | "train" | "subway" | "ferry";

/** Request body for `POST /api/journey/departures`. */
export interface DepartureBoardRequest {
    /** The stop/station to read departures from. */
    lat: number;
    lng: number;
    /** Best-effort stop name (from the tapped map feature) — used only
     *  to disambiguate when a backend returns several nearby stops. */
    name?: string;
    /** Unix ms — the board's start time. Defaults to "now" server-side. */
    when?: number;
    /** Allowed transit modes; omitted/empty means any mode. Filters the
     *  returned departures to the game's allowed set. */
    modes?: TravelMode[];
}

/** A single upcoming departure. */
export interface Departure {
    /** Unix ms — the (real-time if available, else scheduled) departure. */
    time: number;
    /** True when `time` reflects a real-time/predicted value. */
    realtime?: boolean;
    /** Line label, e.g. "Bus 4", "T14", "Tåg 43". */
    line?: string;
    /** Destination headsign / direction. */
    headsign?: string;
    /** Concrete mode when the backend classified it, else `"transit"`. */
    mode: TravelMode | "transit";
}

/** Response body for `POST /api/journey/departures`. */
export interface DepartureBoardResponse {
    /** False when no backend could resolve a stop / board here (the
     *  client shows a quiet "no live departures" state). */
    available: boolean;
    /** Id of the adapter that produced the board (`"trafiklab"`,
     *  `"transitous"`, …), or `"none"` when nothing served. */
    source: string;
    /** The resolved stop's display name, when the backend supplied one. */
    stopName?: string;
    /** Upcoming departures, soonest first. Empty when none were found. */
    departures: Departure[];
}
