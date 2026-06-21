/**
 * Entur (Norway) trip adapter.
 *
 * Entur is Norway's national journey-planner cooperative. Free,
 * keyless GraphQL endpoint, generous quotas. Covers the whole
 * country — Oslo, Bergen, Trondheim, Stavanger, every operator —
 * via a single endpoint, which makes the adapter shape clean.
 *
 * Docs: https://developer.entur.org/pages-journeyplanner-journeyplanner-v3
 * Endpoint: https://api.entur.io/journey-planner/v3/graphql
 *
 * GraphQL `trip(...)` returns tripPatterns; each has legs with
 * `mode`, `line.publicCode`, `fromPlace.name`, etc. — exactly the
 * shape our normaliser wants.
 */

import type {
    Journey,
    JourneyLeg,
    PlanRequest,
    TravelMode,
    TravelPlace,
} from "../types";

const ENTUR_GRAPHQL_URL = "https://api.entur.io/journey-planner/v3/graphql";
const UPSTREAM_TIMEOUT_MS = 8_000;

/** Norway bbox — two regions joined to stay disjoint from Sweden and
 *  Finland while still covering Finnmark:
 *    - Main: south of lat 65, west of lng 12 (covers Oslo, Bergen,
 *      Trondheim, Stavanger and the whole south of the country).
 *    - North: lat 65–71.5, west of lng 31 (covers Bodø, Tromsø,
 *      Hammerfest, Kirkenes).
 *  Past these two strips, Sweden's bbox owns the southeast and
 *  Finland's owns the east — overlap would let the dispatcher try
 *  ResRobot for an Oslo journey (and waste an upstream call). */
const NORWAY_SOUTH_MAX_LAT = 65;
const NORWAY_SOUTH_MAX_LNG = 12;
const NORWAY_NORTH_MIN_LAT = 65;
const NORWAY_NORTH_MAX_LAT = 71.5;
const NORWAY_NORTH_MAX_LNG = 31;
const NORWAY_MIN_LAT = 57.5;
const NORWAY_MIN_LNG = 4.0;

/** Entur's `User-Agent` policy — they ask integrators to identify
 *  themselves with a contact/app handle. The header is technically
 *  forbidden in browser fetch, but Workers' fetch can set it freely. */
const USER_AGENT =
    "jetlag-hide-and-seek/v1 (https://jetlaghideandseek.karl-mj-andersson.workers.dev)";

export function canServe(lat: number, lng: number): boolean {
    if (lng < NORWAY_MIN_LNG) return false;
    if (
        lat >= NORWAY_MIN_LAT &&
        lat < NORWAY_SOUTH_MAX_LAT &&
        lng <= NORWAY_SOUTH_MAX_LNG
    ) {
        return true;
    }
    if (
        lat >= NORWAY_NORTH_MIN_LAT &&
        lat <= NORWAY_NORTH_MAX_LAT &&
        lng <= NORWAY_NORTH_MAX_LNG
    ) {
        return true;
    }
    return false;
}

const TRIP_QUERY = `
query Trip($from: Location!, $to: Location!, $dateTime: DateTime!) {
  trip(
    from: $from
    to: $to
    dateTime: $dateTime
    numTripPatterns: 1
  ) {
    tripPatterns {
      expectedStartTime
      expectedEndTime
      duration
      legs {
        mode
        distance
        expectedStartTime
        expectedEndTime
        fromPlace { name latitude longitude }
        toPlace { name latitude longitude }
        line { publicCode name }
        fromEstimatedCall { destinationDisplay { frontText } }
      }
    }
  }
}
`;

export async function planJourney(
    req: PlanRequest,
    departAt: number,
    signal?: AbortSignal,
): Promise<Journey | null> {
    const variables = {
        from: {
            coordinates: {
                latitude: req.origin.lat,
                longitude: req.origin.lng,
            },
        },
        to: {
            coordinates: {
                latitude: req.destination.lat,
                longitude: req.destination.lng,
            },
        },
        dateTime: new Date(departAt).toISOString(),
    };

    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);

    let resp: Response;
    try {
        resp = await fetch(ENTUR_GRAPHQL_URL, {
            method: "POST",
            signal: ctrl.signal,
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
                "ET-Client-Name": USER_AGENT,
            },
            body: JSON.stringify({ query: TRIP_QUERY, variables }),
        });
    } catch (e) {
        console.warn("Entur fetch failed:", e);
        return null;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
    }
    if (!resp.ok) {
        console.warn("Entur non-OK:", resp.status, resp.statusText);
        return null;
    }
    let json: unknown;
    try {
        json = await resp.json();
    } catch {
        return null;
    }
    return parseEnturTrip(json, req.destination);
}

/* ─────────────────────── Pure parser ─────────────────────── */

export function parseEnturTrip(
    json: unknown,
    destFallback: TravelPlace,
): Journey | null {
    const trip = (
        json as {
            data?: { trip?: { tripPatterns?: unknown[] } };
        }
    )?.data?.trip;
    const patterns = trip?.tripPatterns;
    if (!Array.isArray(patterns) || patterns.length === 0) return null;
    const tp = patterns[0] as {
        expectedStartTime?: string;
        expectedEndTime?: string;
        legs?: unknown[];
    };
    const rawLegs = tp.legs;
    if (!Array.isArray(rawLegs) || rawLegs.length === 0) return null;

    const legs: JourneyLeg[] = [];
    for (const raw of rawLegs) {
        const leg = parseLeg(raw, destFallback);
        if (leg) legs.push(leg);
    }
    if (legs.length === 0) return null;

    const departAt = legs[0].departAt;
    const arriveAt = legs[legs.length - 1].arriveAt;
    if (!Number.isFinite(departAt) || !Number.isFinite(arriveAt)) return null;

    const transitLegs = legs.filter((l) => l.mode !== "walk").length;
    return {
        departAt,
        arriveAt,
        durationMin: Math.max(1, Math.round((arriveAt - departAt) / 60_000)),
        transfers: Math.max(0, transitLegs - 1),
        legs,
    };
}

function parseLeg(raw: unknown, destFallback: TravelPlace): JourneyLeg | null {
    const leg = raw as {
        mode?: string;
        distance?: number;
        expectedStartTime?: string;
        expectedEndTime?: string;
        fromPlace?: { name?: string; latitude?: number; longitude?: number };
        toPlace?: { name?: string; latitude?: number; longitude?: number };
        line?: { publicCode?: string; name?: string };
        fromEstimatedCall?: { destinationDisplay?: { frontText?: string } };
    };
    const departAt = parseISO(leg.expectedStartTime);
    const arriveAt = parseISO(leg.expectedEndTime);
    if (departAt == null || arriveAt == null) return null;

    const mode = classifyMode(leg.mode);
    const out: JourneyLeg = {
        mode,
        from: {
            lat: leg.fromPlace?.latitude ?? 0,
            lng: leg.fromPlace?.longitude ?? 0,
            name: leg.fromPlace?.name,
        },
        to: {
            lat: leg.toPlace?.latitude ?? destFallback.lat,
            lng: leg.toPlace?.longitude ?? destFallback.lng,
            name: leg.toPlace?.name ?? destFallback.name,
        },
        departAt,
        arriveAt,
    };
    const line = leg.line?.publicCode ?? leg.line?.name;
    if (line) out.line = line;
    const dir = leg.fromEstimatedCall?.destinationDisplay?.frontText;
    if (dir) out.direction = dir;
    if (typeof leg.distance === "number") {
        out.distanceMeters = Math.round(leg.distance);
    }
    return out;
}

/** Map Entur's mode enum to our normalised mode. Entur values:
 *  `foot`, `bus`, `tram`, `metro`, `rail`, `water`, `air`, `cableway`. */
function classifyMode(mode?: string): "walk" | TravelMode | "transit" {
    switch ((mode ?? "").toLowerCase()) {
        case "foot":
            return "walk";
        case "bus":
            return "bus";
        case "tram":
            return "tram";
        case "metro":
            return "subway";
        case "rail":
            return "train";
        case "water":
            return "ferry";
        default:
            return "transit";
    }
}

function parseISO(s?: string): number | null {
    if (!s) return null;
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
}
