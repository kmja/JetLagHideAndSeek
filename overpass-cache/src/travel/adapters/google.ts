/**
 * Google Directions (transit) — near-universal journey planner.
 *
 * Google's Directions API with `mode=transit` plans public-transport
 * journeys in virtually every city on Earth that has transit data —
 * North America, Asia, Australia, Africa, South America, the lot. One
 * adapter, hundreds of cities. That makes it the single biggest
 * coverage win, so it sits as a universal fallback: ordered after the
 * free regional adapters and after navitia, and just before walking.
 *
 * Keyed (Google Maps Platform key, generous free tier). Sent as the
 * `key` query param. Defers (returns null) without `GOOGLE_MAPS_API_KEY`,
 * so the dispatcher falls through to walking — same pattern as the
 * other keyed adapters.
 *
 * Shape note: a Google `route.legs[0]` is the whole origin→destination;
 * the per-segment walk/ride breakdown lives in `legs[0].steps[]`, which
 * is what we map to our `JourneyLeg[]`. Walking steps carry only a
 * duration (no absolute clock), so we accumulate timestamps forward
 * from the leg's `departure_time`, snapping to transit steps' absolute
 * times when present.
 */

import type {
    Journey,
    JourneyLeg,
    PlanRequest,
    TravelMode,
    TravelPlace,
} from "../types";

const DIRECTIONS_URL = "https://maps.googleapis.com/maps/api/directions/json";
const UPSTREAM_TIMEOUT_MS = 8_000;

/** Universal — Google has transit coverage essentially everywhere. */
export function canServe(_lat: number, _lng: number): boolean {
    return true;
}

export async function planJourney(
    req: PlanRequest,
    apiKey: string,
    departAt: number,
    signal?: AbortSignal,
): Promise<Journey | null> {
    const url = new URL(DIRECTIONS_URL);
    url.searchParams.set("origin", `${req.origin.lat},${req.origin.lng}`);
    url.searchParams.set(
        "destination",
        `${req.destination.lat},${req.destination.lng}`,
    );
    url.searchParams.set("mode", "transit");
    url.searchParams.set("departure_time", String(Math.floor(departAt / 1000)));
    url.searchParams.set("key", apiKey);

    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);

    let resp: Response;
    try {
        resp = await fetch(url.toString(), {
            signal: ctrl.signal,
            headers: { Accept: "application/json" },
        });
    } catch (e) {
        console.warn("Google Directions fetch failed:", e);
        return null;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
    }
    if (!resp.ok) {
        console.warn("Google Directions non-OK:", resp.status, resp.statusText);
        return null;
    }
    let json: unknown;
    try {
        json = await resp.json();
    } catch {
        return null;
    }
    return parseGoogleDirections(json, req.origin, req.destination);
}

/* ─────────────────────── Pure parser ─────────────────────── */

interface GLatLng {
    lat?: number;
    lng?: number;
}
interface GStep {
    travel_mode?: string;
    duration?: { value?: number };
    distance?: { value?: number };
    start_location?: GLatLng;
    end_location?: GLatLng;
    html_instructions?: string;
    transit_details?: {
        departure_time?: { value?: number };
        arrival_time?: { value?: number };
        departure_stop?: { name?: string; location?: GLatLng };
        arrival_stop?: { name?: string; location?: GLatLng };
        headsign?: string;
        line?: {
            short_name?: string;
            name?: string;
            vehicle?: { type?: string };
        };
    };
}

export function parseGoogleDirections(
    json: unknown,
    origin: { lat: number; lng: number },
    destFallback: TravelPlace,
): Journey | null {
    const status = (json as { status?: string }).status;
    if (status && status !== "OK") return null;
    const routes = (json as { routes?: unknown[] }).routes;
    if (!Array.isArray(routes) || routes.length === 0) return null;
    const leg = (routes[0] as { legs?: unknown[] }).legs?.[0] as
        | { steps?: unknown[]; departure_time?: { value?: number } }
        | undefined;
    const steps = leg?.steps;
    if (!Array.isArray(steps) || steps.length === 0) return null;

    // Forward time cursor. Prefer the leg's absolute departure_time; fall
    // back to "now" so a transit-less walking route still produces sane
    // monotonic timestamps.
    let cursor =
        typeof leg?.departure_time?.value === "number"
            ? leg.departure_time.value * 1000
            : Date.now();

    const legs: JourneyLeg[] = [];
    for (const raw of steps) {
        const step = raw as GStep;
        const isTransit = (step.travel_mode ?? "").toUpperCase() === "TRANSIT";
        const td = step.transit_details;

        let departAt: number;
        let arriveAt: number;
        if (isTransit && typeof td?.departure_time?.value === "number") {
            departAt = td.departure_time.value * 1000;
            arriveAt =
                typeof td.arrival_time?.value === "number"
                    ? td.arrival_time.value * 1000
                    : departAt + durationMs(step);
        } else {
            departAt = cursor;
            arriveAt = cursor + durationMs(step);
        }
        cursor = arriveAt;

        const from: TravelPlace = isTransit
            ? gPlace(td?.departure_stop?.location, td?.departure_stop?.name)
            : gPlace(step.start_location, undefined, origin);
        const to: TravelPlace = isTransit
            ? gPlace(td?.arrival_stop?.location, td?.arrival_stop?.name)
            : gPlace(step.end_location, undefined, destFallback);

        const out: JourneyLeg = {
            mode: isTransit ? classifyMode(td?.line?.vehicle?.type) : "walk",
            from,
            to,
            departAt,
            arriveAt,
        };
        if (isTransit) {
            const line = td?.line?.short_name ?? td?.line?.name;
            if (line) out.line = line;
            if (td?.headsign) out.direction = td.headsign;
        }
        const dist = step.distance?.value;
        if (typeof dist === "number") out.distanceMeters = Math.round(dist);
        legs.push(out);
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

function durationMs(step: GStep): number {
    const s = step.duration?.value;
    return typeof s === "number" ? s * 1000 : 0;
}

function gPlace(
    loc: GLatLng | undefined,
    name: string | undefined,
    fallback?: TravelPlace | { lat: number; lng: number },
): TravelPlace {
    return {
        lat: typeof loc?.lat === "number" ? loc.lat : (fallback?.lat ?? 0),
        lng: typeof loc?.lng === "number" ? loc.lng : (fallback?.lng ?? 0),
        name: name ?? (fallback as TravelPlace | undefined)?.name,
    };
}

/** Google `transit_details.line.vehicle.type` → our mode. */
function classifyMode(type?: string): TravelMode | "transit" {
    switch ((type ?? "").toUpperCase()) {
        case "BUS":
        case "INTERCITY_BUS":
        case "TROLLEYBUS":
            return "bus";
        case "SUBWAY":
        case "METRO_RAIL":
        case "MONORAIL":
            return "subway";
        case "TRAM":
        case "LIGHT_RAIL":
        case "CABLE_CAR":
            return "tram";
        case "HEAVY_RAIL":
        case "COMMUTER_TRAIN":
        case "HIGH_SPEED_TRAIN":
        case "LONG_DISTANCE_TRAIN":
        case "RAIL":
            return "train";
        case "FERRY":
            return "ferry";
        default:
            return "transit";
    }
}
