/**
 * Generic OpenTripPlanner (OTP) REST adapter factory.
 *
 * OTP is THE dominant free, coordinate-based journey-planner pattern:
 * dozens of transit authorities run a public OTP instance exposing the
 * standard `GET {base}/plan?fromPlace=lat,lon&toPlace=lat,lon` REST API
 * that returns `{ plan: { itineraries: [{ legs: [...] }] } }`. Rather
 * than write a near-identical adapter per agency, this module provides
 * one parser + one request function; each instance is then a tiny
 * config (id, base URL, bbox) registered in `router.ts`.
 *
 * All OTP instances we use are free + keyless (or free-key-no-billing).
 * The response shape is stable across OTP1/OTP2; the request date/time
 * format has minor version drift, so `planViaOtp` sends the broadly-
 * accepted `date=YYYY-MM-DD` + `time=HH:MM:SS`. Not live-testable from
 * here — the PARSER is fixture-tested and the walking backstop covers a
 * wrong request, so per-instance request tweaks are safe to do live.
 */

import type {
    Journey,
    JourneyLeg,
    PlanRequest,
    TravelMode,
    TravelPlace,
} from "../types";

const UPSTREAM_TIMEOUT_MS = 9_000;

/**
 * Issue an OTP REST `/plan` request against `baseUrl` (which should end
 * at the router root, e.g. `https://host/otp/routers/default`). Returns
 * null on any failure so the dispatcher falls through.
 */
export async function planViaOtp(
    baseUrl: string,
    req: PlanRequest,
    departAt: number,
    signal?: AbortSignal,
    /** Extra query params (e.g. an instance's `app_id`/`app_key`). */
    extraParams?: Record<string, string>,
): Promise<Journey | null> {
    const depart = new Date(departAt);
    const url = new URL(`${baseUrl.replace(/\/$/, "")}/plan`);
    url.searchParams.set("fromPlace", `${req.origin.lat},${req.origin.lng}`);
    url.searchParams.set(
        "toPlace",
        `${req.destination.lat},${req.destination.lng}`,
    );
    url.searchParams.set("date", ymd(depart));
    url.searchParams.set("time", hms(depart));
    url.searchParams.set("numItineraries", "1");
    url.searchParams.set("mode", "TRANSIT,WALK");
    if (extraParams) {
        for (const [k, v] of Object.entries(extraParams)) {
            url.searchParams.set(k, v);
        }
    }

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
        console.warn(`OTP fetch failed (${baseUrl}):`, e);
        return null;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
    }
    if (!resp.ok) {
        console.warn(`OTP non-OK (${baseUrl}):`, resp.status, resp.statusText);
        return null;
    }
    let json: unknown;
    try {
        json = await resp.json();
    } catch {
        return null;
    }
    return parseOtpPlan(json, req.destination);
}

/* ─────────────────────── Pure parser ─────────────────────── */

interface OtpPlace {
    name?: string;
    lat?: number;
    lon?: number;
}

/**
 * Normalise an OTP REST `/plan` response into our `Journey`.
 * `plan.itineraries[0].legs[]`; each leg has `mode`, epoch
 * `startTime`/`endTime`, `from`/`to` {name,lat,lon}, `distance`,
 * `routeShortName`/`route`, `headsign`.
 */
export function parseOtpPlan(
    json: unknown,
    destFallback: TravelPlace,
): Journey | null {
    const itineraries = (json as { plan?: { itineraries?: unknown[] } })?.plan
        ?.itineraries;
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
        startTime?: number;
        endTime?: number;
        distance?: number;
        from?: OtpPlace;
        to?: OtpPlace;
        route?: string;
        routeShortName?: string;
        routeLongName?: string;
        headsign?: string;
        tripHeadsign?: string;
    };
    const departAt = toMs(leg.startTime);
    const arriveAt = toMs(leg.endTime);
    if (departAt == null || arriveAt == null) return null;

    const mode = classifyMode(leg.mode);
    const isWalk = mode === "walk";
    const out: JourneyLeg = {
        mode,
        from: place(leg.from),
        to: place(leg.to, destFallback),
        departAt,
        arriveAt,
    };
    if (!isWalk) {
        const line = leg.routeShortName ?? leg.route ?? leg.routeLongName;
        if (line) out.line = String(line);
        const dir = leg.headsign ?? leg.tripHeadsign;
        if (dir) out.direction = dir;
    }
    if (typeof leg.distance === "number") {
        out.distanceMeters = Math.round(leg.distance);
    }
    return out;
}

function place(p: OtpPlace | undefined, fallback?: TravelPlace): TravelPlace {
    return {
        lat: typeof p?.lat === "number" ? p.lat : (fallback?.lat ?? 0),
        lng: typeof p?.lon === "number" ? p.lon : (fallback?.lng ?? 0),
        name: p?.name ?? fallback?.name,
    };
}

/** OTP `mode` enum → our mode. */
function classifyMode(mode?: string): "walk" | TravelMode | "transit" {
    switch ((mode ?? "").toUpperCase()) {
        case "WALK":
            return "walk";
        case "BUS":
        case "TROLLEYBUS":
        case "COACH":
            return "bus";
        case "TRAM":
        case "CABLE_CAR":
        case "GONDOLA":
        case "FUNICULAR":
            return "tram";
        case "SUBWAY":
        case "METRO":
            return "subway";
        case "RAIL":
        case "MONORAIL":
            return "train";
        case "FERRY":
            return "ferry";
        default:
            return "transit";
    }
}

/** OTP REST returns epoch ms; tolerate seconds defensively. */
function toMs(v: number | undefined): number | null {
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    return v < 1e12 ? v * 1000 : v;
}

function ymd(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function hms(d: Date): string {
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}
