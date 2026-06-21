/**
 * Transitous — free, community-run, near-universal transit router.
 *
 * Transitous (https://transitous.org) is a free, donation-funded public
 * transport routing service built on the MOTIS engine, routing over the
 * GTFS feeds catalogued in the **Mobility Database**. It is **keyless**
 * and has **no billing** — no credit card, no per-request charge — which
 * is exactly why it replaces the paid Google/HERE universal providers
 * here. Coverage is global-ish and growing (heavy in Europe, expanding
 * across North America/Asia as feeds are added to the catalog).
 *
 * This is effectively the "self-hosted GTFS raptor over the Mobility
 * Database" idea (the deferred M5), except the community already hosts
 * it for free — so we just call it. As the universal free fallback it
 * sits after the free regional adapters + navitia, before walking.
 *
 * ⚠️ TODO / LICENSE CHECK (flagged by Kalle): the Transitous site states
 * it is "not intended for commercial or for-profit purposes; contact us
 * if unsure — decided case-by-case." This app is currently a free hobby
 * project, so it's plausibly fine, but BEFORE any commercial/monetised
 * use we must confirm with the Transitous maintainers (contact via
 * transitous.org). If they decline, drop this adapter — every other
 * provider here is unambiguously free-for-any-use, and the regional
 * adapters cover most populated areas anyway. Keeping it for now.
 *
 * API: MOTIS v2 `GET /api/v1/plan` (OTP-shaped). Be a polite citizen
 * with the shared free instance — the worker's edge+R2 cache already
 * dedupes by (origin, dest, 5-min bucket), so repeated lookups don't
 * re-hit it.
 *
 * Not live-testable from here (sandbox blocks egress); request shape
 * follows the MOTIS API and the response PARSER is fixture-tested. A
 * wrong request degrades to the walking estimate.
 */

import type {
    Journey,
    JourneyLeg,
    PlanRequest,
    TravelMode,
    TravelPlace,
} from "../types";

const TRANSITOUS_URL = "https://api.transitous.org/api/v1/plan";
const UPSTREAM_TIMEOUT_MS = 9_000;

/** Universal — Transitous routes wherever the Mobility Database has a
 *  feed. Outside its coverage it simply returns no itinerary and the
 *  dispatcher falls through to walking. */
export function canServe(_lat: number, _lng: number): boolean {
    return true;
}

export async function planJourney(
    req: PlanRequest,
    departAt: number,
    signal?: AbortSignal,
): Promise<Journey | null> {
    return planViaMotis(TRANSITOUS_URL, req, departAt, signal);
}

/**
 * Generic MOTIS v2 `/api/v1/plan` fetch against any MOTIS instance —
 * the public Transitous one OR a self-hosted box (see
 * `motisSelfHosted.ts`). `planUrl` is the full plan endpoint. Both use
 * the identical request + `parseMotisPlan` response shape.
 */
export async function planViaMotis(
    planUrl: string,
    req: PlanRequest,
    departAt: number,
    signal?: AbortSignal,
): Promise<Journey | null> {
    const url = new URL(planUrl);
    // MOTIS takes `fromPlace` / `toPlace` as "lat,lon".
    url.searchParams.set("fromPlace", `${req.origin.lat},${req.origin.lng}`);
    url.searchParams.set(
        "toPlace",
        `${req.destination.lat},${req.destination.lng}`,
    );
    url.searchParams.set("time", new Date(departAt).toISOString());
    url.searchParams.set("arriveBy", "false");

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
        console.warn("MOTIS fetch failed:", e);
        return null;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
    }
    if (!resp.ok) {
        console.warn("MOTIS non-OK:", resp.status, resp.statusText);
        return null;
    }
    let json: unknown;
    try {
        json = await resp.json();
    } catch {
        return null;
    }
    return parseMotisPlan(json, req.destination);
}

/* ─────────────────────── Pure parser ─────────────────────── */

interface MotisPlace {
    name?: string;
    lat?: number;
    lon?: number;
}

/**
 * Normalise a MOTIS v2 `/api/v1/plan` response (`{ itineraries: [{
 * legs: [...] }] }`) into our `Journey`. MOTIS legs are OTP-shaped:
 * `mode`, ISO `startTime`/`endTime`, `from`/`to` places, `distance`,
 * `routeShortName`, `headsign`.
 */
export function parseMotisPlan(
    json: unknown,
    destFallback: TravelPlace,
): Journey | null {
    const itineraries = (json as { itineraries?: unknown[] }).itineraries;
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
        startTime?: string;
        endTime?: string;
        distance?: number;
        from?: MotisPlace;
        to?: MotisPlace;
        routeShortName?: string;
        routeLongName?: string;
        headsign?: string;
    };
    const departAt = parseISO(leg.startTime);
    const arriveAt = parseISO(leg.endTime);
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
        const line = leg.routeShortName ?? leg.routeLongName;
        if (line) out.line = line;
        if (leg.headsign) out.direction = leg.headsign;
    }
    if (typeof leg.distance === "number") {
        out.distanceMeters = Math.round(leg.distance);
    }
    return out;
}

function place(p: MotisPlace | undefined, fallback?: TravelPlace): TravelPlace {
    return {
        lat: typeof p?.lat === "number" ? p.lat : (fallback?.lat ?? 0),
        lng: typeof p?.lon === "number" ? p.lon : (fallback?.lng ?? 0),
        name: p?.name ?? fallback?.name,
    };
}

/** MOTIS/OTP `mode` → our mode. */
function classifyMode(mode?: string): "walk" | TravelMode | "transit" {
    switch ((mode ?? "").toUpperCase()) {
        case "WALK":
            return "walk";
        case "BUS":
        case "COACH":
        case "TROLLEYBUS":
            return "bus";
        case "TRAM":
        case "CABLE_CAR":
        case "FUNICULAR":
            return "tram";
        case "SUBWAY":
        case "METRO":
            return "subway";
        case "RAIL":
        case "REGIONAL_RAIL":
        case "REGIONAL_FAST_RAIL":
        case "COMMUTER_RAIL":
        case "LONG_DISTANCE":
        case "HIGHSPEED_RAIL":
        case "NIGHT_RAIL":
            return "train";
        case "FERRY":
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
