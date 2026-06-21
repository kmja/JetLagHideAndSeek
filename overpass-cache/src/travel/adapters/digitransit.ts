/**
 * Digitransit (Finland) trip adapter.
 *
 * Digitransit is the Finnish national journey-planning service,
 * built on OpenTripPlanner. National GraphQL endpoint via HSL's
 * routing-data subscription path covers HSL (Helsinki), Tampere,
 * Turku, Oulu, and the whole `finland` region.
 *
 * Docs: https://digitransit.fi/en/developers/apis/1-routing-api/
 * Endpoint: https://api.digitransit.fi/routing/v1/routers/finland/index/graphql
 *
 * The API used to be keyless but now requires a free subscription
 * key (`digitransit-subscription-key`). When the worker operator
 * hasn't set `DIGITRANSIT_API_KEY`, this adapter returns null
 * (defer) so the dispatcher falls through — same behaviour the
 * Trafiklab adapter has without its key.
 */

import type {
    Journey,
    JourneyLeg,
    PlanRequest,
    TravelMode,
    TravelPlace,
} from "../types";

const DIGITRANSIT_URL =
    "https://api.digitransit.fi/routing/v1/routers/finland/index/graphql";
const UPSTREAM_TIMEOUT_MS = 8_000;

/** Finland bbox, tightened so it's disjoint from the Sweden adapter's
 *  box (whose east edge is 24.5). 20.5 E excludes the Stockholm
 *  archipelago and falls just east of the Åland line, putting all
 *  Finnish coastal cities (Helsinki 24.9, Turku 22.3, Tampere 23.8,
 *  Oulu 25.5) firmly in this adapter's region. */
const FINLAND_BBOX = { minLat: 59.5, maxLat: 70.5, minLng: 20.5, maxLng: 32.0 };

export function canServe(lat: number, lng: number): boolean {
    return (
        lat >= FINLAND_BBOX.minLat &&
        lat <= FINLAND_BBOX.maxLat &&
        lng >= FINLAND_BBOX.minLng &&
        lng <= FINLAND_BBOX.maxLng
    );
}

const PLAN_QUERY = `
query Plan($from: InputCoordinates!, $to: InputCoordinates!, $date: String!, $time: String!) {
  plan(
    from: $from
    to: $to
    date: $date
    time: $time
    numItineraries: 1
  ) {
    itineraries {
      startTime
      endTime
      duration
      legs {
        mode
        distance
        startTime
        endTime
        from { name lat lon }
        to { name lat lon }
        route { shortName longName }
        headsign
      }
    }
  }
}
`;

export async function planJourney(
    req: PlanRequest,
    apiKey: string,
    departAt: number,
    signal?: AbortSignal,
): Promise<Journey | null> {
    const depart = new Date(departAt);
    const variables = {
        from: { lat: req.origin.lat, lon: req.origin.lng },
        to: { lat: req.destination.lat, lon: req.destination.lng },
        date: dateYmd(depart),
        time: timeHm(depart),
    };

    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);

    let resp: Response;
    try {
        resp = await fetch(DIGITRANSIT_URL, {
            method: "POST",
            signal: ctrl.signal,
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
                "digitransit-subscription-key": apiKey,
            },
            body: JSON.stringify({ query: PLAN_QUERY, variables }),
        });
    } catch (e) {
        console.warn("Digitransit fetch failed:", e);
        return null;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
    }
    if (!resp.ok) {
        console.warn("Digitransit non-OK:", resp.status, resp.statusText);
        return null;
    }
    let json: unknown;
    try {
        json = await resp.json();
    } catch {
        return null;
    }
    return parseDigitransitPlan(json, req.destination);
}

/* ─────────────────────── Pure parser ─────────────────────── */

export function parseDigitransitPlan(
    json: unknown,
    destFallback: TravelPlace,
): Journey | null {
    const itineraries = (json as {
        data?: { plan?: { itineraries?: unknown[] } };
    })?.data?.plan?.itineraries;
    if (!Array.isArray(itineraries) || itineraries.length === 0) return null;
    const it = itineraries[0] as { legs?: unknown[] };
    const rawLegs = it.legs;
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
        startTime?: number;
        endTime?: number;
        from?: { name?: string; lat?: number; lon?: number };
        to?: { name?: string; lat?: number; lon?: number };
        route?: { shortName?: string; longName?: string };
        headsign?: string;
    };
    const departAt = toMs(leg.startTime);
    const arriveAt = toMs(leg.endTime);
    if (departAt == null || arriveAt == null) return null;

    const mode = classifyMode(leg.mode);
    const out: JourneyLeg = {
        mode,
        from: {
            lat: leg.from?.lat ?? 0,
            lng: leg.from?.lon ?? 0,
            name: leg.from?.name,
        },
        to: {
            lat: leg.to?.lat ?? destFallback.lat,
            lng: leg.to?.lon ?? destFallback.lng,
            name: leg.to?.name ?? destFallback.name,
        },
        departAt,
        arriveAt,
    };
    const line = leg.route?.shortName ?? leg.route?.longName;
    if (line) out.line = line;
    if (leg.headsign) out.direction = leg.headsign;
    if (typeof leg.distance === "number") {
        out.distanceMeters = Math.round(leg.distance);
    }
    return out;
}

/** Map Digitransit's mode enum to our normalised mode. Values:
 *  `WALK`, `BUS`, `TRAM`, `SUBWAY`, `RAIL`, `FERRY`, `CABLE_CAR`,
 *  `GONDOLA`, `FUNICULAR`, `AIRPLANE`. */
function classifyMode(mode?: string): "walk" | TravelMode | "transit" {
    switch ((mode ?? "").toUpperCase()) {
        case "WALK":
            return "walk";
        case "BUS":
            return "bus";
        case "TRAM":
            return "tram";
        case "SUBWAY":
            return "subway";
        case "RAIL":
            return "train";
        case "FERRY":
            return "ferry";
        default:
            return "transit";
    }
}

/** Digitransit returns epoch ms (numbers). Defensive against string
 *  millis or seconds — some OTP versions echo seconds. */
function toMs(v: number | undefined): number | null {
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    // Heuristic: any timestamp before year 2200 in seconds is < 7.3e9;
    // in ms it's > 1e12. Anything below 1e12 is treated as seconds.
    return v < 1e12 ? v * 1000 : v;
}

function dateYmd(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function timeHm(d: Date): string {
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
