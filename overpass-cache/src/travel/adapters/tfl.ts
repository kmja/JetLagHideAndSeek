/**
 * Transport for London (TfL) Unified API trip adapter.
 *
 * London-only — TfL's `/Journey/JourneyResults/{from}/to/{to}`
 * endpoint covers Tube, Overground, DLR, Elizabeth Line, National
 * Rail, buses, river services. Free, instant, no key needed for low
 * volume; with a free `app_key` the rate limit lifts but the
 * adapter accepts either.
 *
 * Docs: https://api.tfl.gov.uk/swagger/ui/index.html (Journey →
 *       JourneyResults).
 *
 * The endpoint accepts `lat,lng` coordinate pairs directly in the
 * path — no separate geocode step.
 */

import type {
    Journey,
    JourneyLeg,
    PlanRequest,
    TravelMode,
    TravelPlace,
} from "../types";

const TFL_BASE = "https://api.tfl.gov.uk/Journey/JourneyResults";
const UPSTREAM_TIMEOUT_MS = 8_000;

/** London bbox, comfortably wider than the M25 so suburban
 *  origins still match. Latitude/Longitude in WGS84. */
const LONDON_BBOX = { minLat: 51.25, maxLat: 51.72, minLng: -0.55, maxLng: 0.35 };

export function canServe(lat: number, lng: number): boolean {
    return (
        lat >= LONDON_BBOX.minLat &&
        lat <= LONDON_BBOX.maxLat &&
        lng >= LONDON_BBOX.minLng &&
        lng <= LONDON_BBOX.maxLng
    );
}

export async function planJourney(
    req: PlanRequest,
    appKey: string | undefined,
    departAt: number,
    signal?: AbortSignal,
): Promise<Journey | null> {
    const depart = new Date(departAt);
    const from = `${req.origin.lat.toFixed(6)},${req.origin.lng.toFixed(6)}`;
    const to = `${req.destination.lat.toFixed(6)},${req.destination.lng.toFixed(6)}`;
    const url = new URL(`${TFL_BASE}/${from}/to/${to}`);
    url.searchParams.set("date", dateYmd(depart));
    url.searchParams.set("time", timeHm(depart));
    url.searchParams.set("timeIs", "Departing");
    if (appKey) url.searchParams.set("app_key", appKey);

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
        console.warn("TfL fetch failed:", e);
        return null;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
    }
    if (!resp.ok) {
        console.warn("TfL non-OK:", resp.status, resp.statusText);
        return null;
    }
    let json: unknown;
    try {
        json = await resp.json();
    } catch {
        return null;
    }
    return parseTflJourney(json, req.destination);
}

/* ─────────────────────── Pure parser ─────────────────────── */

export function parseTflJourney(
    json: unknown,
    destFallback: TravelPlace,
): Journey | null {
    const journeys = (json as { journeys?: unknown[] }).journeys;
    if (!Array.isArray(journeys) || journeys.length === 0) return null;
    const j = journeys[0] as {
        startDateTime?: string;
        arrivalDateTime?: string;
        legs?: unknown[];
    };
    const rawLegs = j.legs;
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
        mode?: { id?: string; name?: string };
        departureTime?: string;
        arrivalTime?: string;
        departurePoint?: { commonName?: string; lat?: number; lon?: number };
        arrivalPoint?: { commonName?: string; lat?: number; lon?: number };
        routeOptions?: Array<{ name?: string; directions?: string[] }>;
        distance?: number;
        instruction?: { summary?: string };
    };
    const departAt = parseISO(leg.departureTime);
    const arriveAt = parseISO(leg.arrivalTime);
    if (departAt == null || arriveAt == null) return null;

    const mode = classifyMode(leg.mode?.id ?? leg.mode?.name);
    const out: JourneyLeg = {
        mode,
        from: {
            lat: leg.departurePoint?.lat ?? 0,
            lng: leg.departurePoint?.lon ?? 0,
            name: leg.departurePoint?.commonName,
        },
        to: {
            lat: leg.arrivalPoint?.lat ?? destFallback.lat,
            lng: leg.arrivalPoint?.lon ?? destFallback.lng,
            name: leg.arrivalPoint?.commonName ?? destFallback.name,
        },
        departAt,
        arriveAt,
    };
    const route = leg.routeOptions?.[0];
    if (route?.name) out.line = route.name;
    if (route?.directions?.[0]) out.direction = route.directions[0];
    if (typeof leg.distance === "number") {
        out.distanceMeters = Math.round(leg.distance);
    }
    return out;
}

/** TfL mode ids include: `walking`, `bus`, `tube`, `overground`,
 *  `dlr`, `elizabeth-line`, `tram`, `national-rail`, `river-bus`,
 *  `river-tour`, `coach`, `cycle`. Map to our normalised modes. */
function classifyMode(id?: string): "walk" | TravelMode | "transit" {
    switch ((id ?? "").toLowerCase()) {
        case "walking":
            return "walk";
        case "bus":
        case "coach":
            return "bus";
        case "tube":
        case "dlr":
        case "elizabeth-line":
            return "subway";
        case "tram":
            return "tram";
        case "overground":
        case "national-rail":
        case "tflrail":
            return "train";
        case "river-bus":
        case "river-tour":
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

function dateYmd(d: Date): string {
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

function timeHm(d: Date): string {
    return `${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
}
