/**
 * Wire types for the trip-planning endpoints (`/api/travel/*`).
 *
 * Deliberately self-contained — the same convention the journey-
 * arrival proxy follows (`journey.ts` defines its own
 * `JourneyAnchor`/`JourneyStop`/`ArrivalResult` rather than reaching
 * into a shared `protocol/` module, which is reserved for the
 * multiplayer worker's WebSocket schema). The browser-side mirror of
 * these types lives in `src/lib/journey/plan.ts`; the two must agree
 * on the JSON shape but are intentionally NOT a shared TS import, so
 * neither worker root has to bundle code from across the repo.
 *
 * Difference from `/api/journey/arrivals`: that endpoint answers
 * "given an anchor and many stops, when does the hider arrive at
 * each?" and throws away everything but the final timestamp (it asks
 * ResRobot with `passlist=0`). This endpoint answers "give me the
 * whole journey from A to B" — the individual legs, lines, transfers
 * and walking segments — which both the seeker trip planner and the
 * hider's "plan a trip to my chosen zone" view need to render.
 */

/** Transit modes the planner may use. Walking is always implicitly
 *  allowed and never appears in this list — it's the universal
 *  backstop. Mirrors `TransitMode` in `src/lib/gameSetup.ts`. */
export type TravelMode = "bus" | "tram" | "train" | "subway" | "ferry";

/** A bare coordinate. */
export interface TravelPoint {
    lat: number;
    lng: number;
}

/** A named coordinate — origin/destination endpoints and leg
 *  boundaries. `name` is best-effort; walking-only fallbacks won't
 *  have station names. */
export interface TravelPlace extends TravelPoint {
    name?: string;
}

/** Request body for `POST /api/travel/plan`. */
export interface PlanRequest {
    origin: TravelPoint;
    destination: TravelPlace;
    /** Unix ms. The journey's earliest departure. Defaults to "now"
     *  on the server when omitted. */
    departAt?: number;
    /** Allowed transit modes. Threaded through to the cache key and
     *  (eventually) to upstream product filters. Omitted / empty is
     *  treated as "any mode". */
    modes?: TravelMode[];
}

/** One leg of a planned journey. A leg is either a walking segment
 *  or a single ride on one vehicle; transfers are the boundaries
 *  between consecutive transit legs. */
export interface JourneyLeg {
    /** `"walk"` for on-foot segments; a concrete mode when the
     *  adapter could classify the vehicle; `"transit"` when it's a
     *  ride but the mode couldn't be determined. */
    mode: "walk" | TravelMode | "transit";
    /** Human-readable line label, e.g. "Bus 4", "T14", "Tåg 43".
     *  Absent on walking legs. */
    line?: string;
    /** Direction headsign when the upstream supplies one. */
    direction?: string;
    from: TravelPlace;
    to: TravelPlace;
    /** Unix ms. */
    departAt: number;
    /** Unix ms. */
    arriveAt: number;
    /** Straight-line-ish distance in metres — populated for walking
     *  legs (where it's the headline number) and opportunistically
     *  for transit legs when the upstream reports it. */
    distanceMeters?: number;
    /** The leg's real shape as `[lng, lat]` points (GeoJSON order),
     *  decoded from the upstream `legGeometry` polyline when available
     *  (MOTIS/OTP). Lets the client draw the true walking-street /
     *  track path instead of a straight from→to segment. Absent when
     *  the adapter has no shape — the client falls back to the
     *  straight segment. */
    geometry?: [number, number][];
}

/** A fully planned door-to-door journey. Provider-agnostic: the
 *  Trafiklab/Entur/Digitransit/walking adapters all normalise into
 *  this one shape so the client renders a single card design. */
export interface Journey {
    /** Unix ms — departure of the first leg. */
    departAt: number;
    /** Unix ms — arrival of the last leg. */
    arriveAt: number;
    /** Whole-journey duration in minutes (rounded). */
    durationMin: number;
    /** Number of transit-to-transit transfers (≥ 0). */
    transfers: number;
    legs: JourneyLeg[];
}

/** Response body for `POST /api/travel/plan`. */
export interface PlanResponse {
    /** False only in pathological cases where not even the walking
     *  backstop could produce a journey (e.g. non-finite coords that
     *  slipped past validation). In practice this is essentially
     *  always true because walking is unconditional. */
    available: boolean;
    /** Id of the adapter that produced the journey: `"trafiklab"`,
     *  `"walking"`, etc. The client uses this to caveat the result —
     *  a `"walking"` source means "no live schedule here, on-foot
     *  estimate only". */
    source: string;
    journey: Journey | null;
}
