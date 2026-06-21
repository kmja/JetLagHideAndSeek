/**
 * HERE Public Transit — second near-universal journey planner.
 *
 * HERE's Transit Routing API (v8) covers public transport across most
 * of the world. It's the alternative universal provider to Google: same
 * "works almost everywhere" role, different data + pricing, so an
 * operator can pick whichever key they have. Ordered as a universal
 * fallback just before Google (which is itself just before walking).
 *
 * Keyed (free HERE developer tier), sent as the `apiKey` query param.
 * Defers without `HERE_API_KEY`.
 *
 * Response shape is clean: `routes[0].sections[]`, each a `pedestrian`
 * or `transit` section with absolute ISO `departure.time` /
 * `arrival.time` and a `transport.mode`.
 */

import type {
    Journey,
    JourneyLeg,
    PlanRequest,
    TravelMode,
    TravelPlace,
} from "../types";

const HERE_TRANSIT_URL = "https://transit.router.hereapi.com/v8/routes";
const UPSTREAM_TIMEOUT_MS = 8_000;

/** Universal — HERE has broad worldwide transit coverage. */
export function canServe(_lat: number, _lng: number): boolean {
    return true;
}

export async function planJourney(
    req: PlanRequest,
    apiKey: string,
    departAt: number,
    signal?: AbortSignal,
): Promise<Journey | null> {
    const url = new URL(HERE_TRANSIT_URL);
    url.searchParams.set("origin", `${req.origin.lat},${req.origin.lng}`);
    url.searchParams.set(
        "destination",
        `${req.destination.lat},${req.destination.lng}`,
    );
    url.searchParams.set("departureTime", new Date(departAt).toISOString());
    url.searchParams.set("return", "intermediate");
    url.searchParams.set("alternatives", "0");
    url.searchParams.set("apiKey", apiKey);

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
        console.warn("HERE transit fetch failed:", e);
        return null;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
    }
    if (!resp.ok) {
        console.warn("HERE transit non-OK:", resp.status, resp.statusText);
        return null;
    }
    let json: unknown;
    try {
        json = await resp.json();
    } catch {
        return null;
    }
    return parseHereTransit(json, req.destination);
}

/* ─────────────────────── Pure parser ─────────────────────── */

interface HerePlace {
    name?: string;
    location?: { lat?: number; lng?: number };
}

export function parseHereTransit(
    json: unknown,
    destFallback: TravelPlace,
): Journey | null {
    const routes = (json as { routes?: unknown[] }).routes;
    if (!Array.isArray(routes) || routes.length === 0) return null;
    const sections = (routes[0] as { sections?: unknown[] }).sections;
    if (!Array.isArray(sections) || sections.length === 0) return null;

    const legs: JourneyLeg[] = [];
    for (const raw of sections) {
        const leg = parseSection(raw, destFallback);
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

function parseSection(
    raw: unknown,
    destFallback: TravelPlace,
): JourneyLeg | null {
    const sec = raw as {
        type?: string;
        departure?: { time?: string; place?: HerePlace };
        arrival?: { time?: string; place?: HerePlace };
        transport?: { mode?: string; name?: string; headsign?: string };
    };
    const departAt = parseISO(sec.departure?.time);
    const arriveAt = parseISO(sec.arrival?.time);
    if (departAt == null || arriveAt == null) return null;

    const isPedestrian = (sec.type ?? "") === "pedestrian";
    const out: JourneyLeg = {
        mode: isPedestrian ? "walk" : classifyMode(sec.transport?.mode),
        from: herePlace(sec.departure?.place, destFallback),
        to: herePlace(sec.arrival?.place, destFallback),
        departAt,
        arriveAt,
    };
    if (!isPedestrian) {
        if (sec.transport?.name) out.line = sec.transport.name;
        if (sec.transport?.headsign) out.direction = sec.transport.headsign;
    }
    return out;
}

function herePlace(
    p: HerePlace | undefined,
    fallback: TravelPlace,
): TravelPlace {
    return {
        lat:
            typeof p?.location?.lat === "number"
                ? p.location.lat
                : fallback.lat,
        lng:
            typeof p?.location?.lng === "number"
                ? p.location.lng
                : fallback.lng,
        name: p?.name ?? fallback.name,
    };
}

/** HERE `transport.mode` → our mode. */
function classifyMode(mode?: string): TravelMode | "transit" {
    switch ((mode ?? "").toLowerCase()) {
        case "buspublic":
        case "busprivate":
        case "bus":
            return "bus";
        case "subway":
            return "subway";
        case "lightrail":
        case "tram":
        case "monorail":
            return "tram";
        case "regionaltrain":
        case "citytrain":
        case "intercitytrain":
        case "highspeedtrain":
        case "train":
            return "train";
        case "ferry":
        case "privateferry":
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
