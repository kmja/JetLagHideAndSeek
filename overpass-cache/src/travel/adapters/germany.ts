/**
 * Germany — `transport.rest` (Deutsche Bahn HAFAS) adapter.
 *
 * `v6.db.transport.rest` is a community-run, **keyless** REST wrapper
 * over DB's HAFAS endpoint, returning FPTF (Friendly Public Transport
 * Format) JSON. It covers the whole country — DB long-distance plus
 * regional/local networks in Berlin (VBB), Hamburg (HVV), Munich
 * (MVV), Cologne, Frankfurt, etc.
 *
 * Docs: https://v6.db.transport.rest/api.html (the `/journeys`
 * operation). Coordinate origins/destinations are passed as
 * `from.latitude`/`from.longitude` (+ a display `from.address`).
 *
 * NOTE: the exact query-param requirements aren't live-testable from
 * here (sandbox blocks egress), so the request shape below follows
 * the documented API but may need a small tweak once deployed. The
 * dispatcher's walking backstop means a wrong request just yields a
 * walking estimate rather than an error — safe to ship and tune live.
 * The response PARSER is fixture-tested in tests/travelPlan.test.ts.
 */

import type {
    Journey,
    JourneyLeg,
    PlanRequest,
    TravelMode,
    TravelPlace,
} from "../types";

const DBREST_URL = "https://v6.db.transport.rest/journeys";
const UPSTREAM_TIMEOUT_MS = 8_000;

/** Germany bbox. Northern lat split at 47.7 keeps it disjoint from the
 *  Switzerland adapter (whose box tops out at 47.7); covers Munich
 *  (48.1) up to Flensburg (54.8). The lng span (5.8–15.1) bleeds into
 *  bits of eastern France / western Austria / the Czech border, where
 *  DB HAFAS still plans cross-border journeys — acceptable until those
 *  countries get their own (tighter, earlier-ordered) adapters. */
const GERMANY_BBOX = { minLat: 47.7, maxLat: 55.1, minLng: 5.8, maxLng: 15.1 };

export function canServe(lat: number, lng: number): boolean {
    return (
        lat >= GERMANY_BBOX.minLat &&
        lat <= GERMANY_BBOX.maxLat &&
        lng >= GERMANY_BBOX.minLng &&
        lng <= GERMANY_BBOX.maxLng
    );
}

export async function planJourney(
    req: PlanRequest,
    departAt: number,
    signal?: AbortSignal,
): Promise<Journey | null> {
    const url = new URL(DBREST_URL);
    url.searchParams.set("from.latitude", req.origin.lat.toFixed(6));
    url.searchParams.set("from.longitude", req.origin.lng.toFixed(6));
    url.searchParams.set("from.address", "origin");
    url.searchParams.set("to.latitude", req.destination.lat.toFixed(6));
    url.searchParams.set("to.longitude", req.destination.lng.toFixed(6));
    url.searchParams.set("to.address", req.destination.name ?? "destination");
    url.searchParams.set("departure", new Date(departAt).toISOString());
    url.searchParams.set("results", "1");
    url.searchParams.set("stopovers", "false");

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
        console.warn("Germany (db.transport.rest) fetch failed:", e);
        return null;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
    }
    if (!resp.ok) {
        console.warn("Germany non-OK:", resp.status, resp.statusText);
        return null;
    }
    let json: unknown;
    try {
        json = await resp.json();
    } catch {
        return null;
    }
    return parseFptfJourneys(json, req.destination);
}

/* ─────────────────────── Pure parser ─────────────────────── */

/**
 * Parse an FPTF `{ journeys: [{ legs: [...] }] }` response into our
 * normalised `Journey`. FPTF is shared by the whole transport.rest
 * family (DB, VBB, BVG, …), so this parser is reusable if more of
 * them get added later.
 */
export function parseFptfJourneys(
    json: unknown,
    destFallback: TravelPlace,
): Journey | null {
    const journeys = (json as { journeys?: unknown[] }).journeys;
    if (!Array.isArray(journeys) || journeys.length === 0) return null;
    const j = journeys[0] as { legs?: unknown[] };
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

interface FptfPlace {
    name?: string;
    location?: { latitude?: number; longitude?: number };
}

function parseLeg(raw: unknown, destFallback: TravelPlace): JourneyLeg | null {
    const leg = raw as {
        origin?: FptfPlace;
        destination?: FptfPlace;
        departure?: string;
        plannedDeparture?: string;
        arrival?: string;
        plannedArrival?: string;
        walking?: boolean;
        distance?: number;
        direction?: string;
        line?: { name?: string; mode?: string; product?: string };
    };
    const o = leg.origin;
    const d = leg.destination;
    if (!o || !d) return null;

    const departAt = parseISO(leg.departure ?? leg.plannedDeparture);
    const arriveAt = parseISO(leg.arrival ?? leg.plannedArrival);
    if (departAt == null || arriveAt == null) return null;

    const isWalk = leg.walking === true || !leg.line;
    const out: JourneyLeg = {
        mode: isWalk ? "walk" : classifyMode(leg.line),
        from: place(o),
        to: place(d, destFallback),
        departAt,
        arriveAt,
    };
    if (!isWalk && leg.line?.name) out.line = leg.line.name;
    if (leg.direction) out.direction = leg.direction;
    if (typeof leg.distance === "number")
        out.distanceMeters = Math.round(leg.distance);
    return out;
}

function place(p: FptfPlace, fallback?: TravelPlace): TravelPlace {
    return {
        lat: p.location?.latitude ?? fallback?.lat ?? 0,
        lng: p.location?.longitude ?? fallback?.lng ?? 0,
        name: p.name ?? fallback?.name,
    };
}

/** FPTF `line.product` is the specific category; `line.mode` is the
 *  coarse one. Prefer product. DB products: nationalExpress, national,
 *  regionalExpress, regional, suburban, subway, tram, bus, ferry,
 *  taxi. */
function classifyMode(line?: {
    mode?: string;
    product?: string;
}): TravelMode | "transit" {
    const product = (line?.product ?? "").toLowerCase();
    if (product === "subway" || product === "u-bahn") return "subway";
    if (product === "tram") return "tram";
    if (product === "bus") return "bus";
    if (product === "ferry") return "ferry";
    if (
        product === "suburban" ||
        product === "regional" ||
        product === "regionalexpress" ||
        product === "national" ||
        product === "nationalexpress"
    ) {
        return "train";
    }
    // Fall back to the coarse FPTF mode.
    const mode = (line?.mode ?? "").toLowerCase();
    if (mode === "train") return "train";
    if (mode === "bus") return "bus";
    if (mode === "watercraft") return "ferry";
    return "transit";
}

function parseISO(s?: string): number | null {
    if (!s) return null;
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
}
