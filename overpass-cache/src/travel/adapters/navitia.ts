/**
 * navitia.io — broad multi-region journey planner (fallback tier).
 *
 * Unlike the national adapters (each one country), navitia is a single
 * coordinate-based planner covering many regions from one endpoint —
 * most valuably **France (incl. Paris/Île-de-France)**, plus partial
 * coverage across the Benelux, Iberia, Italy and others. It sits LAST
 * among the regional adapters (just before the walking backstop), so
 * the country-specific planners still win inside their borders; navitia
 * only gets tried where they all decline.
 *
 * Docs: https://doc.navitia.io/ — `GET /v1/journeys`.
 * Auth: free API key, sent as the `Authorization` header. When the
 * worker operator hasn't set `NAVITIA_API_KEY`, this adapter defers
 * (returns null) and the dispatcher falls through to walking — same
 * pattern as Trafiklab/Digitransit.
 *
 * Coordinates are passed as `lng;lat` (longitude first — a navitia
 * quirk). Datetimes use navitia's basic ISO form `YYYYMMDDTHHMMSS`.
 */

import type {
    Journey,
    JourneyLeg,
    PlanRequest,
    TravelMode,
    TravelPlace,
} from "../types";

const NAVITIA_URL = "https://api.navitia.io/v1/journeys";
const UPSTREAM_TIMEOUT_MS = 8_000;

/** Broad continental-Europe bbox. Deliberately wide — navitia is the
 *  pre-walking fallback, and it's ordered after every country-specific
 *  adapter, so overlap with their boxes is harmless (they're tried
 *  first). Outside Europe navitia coverage is too patchy to claim, so
 *  non-European origins skip straight to walking. */
const EUROPE_BBOX = { minLat: 35.0, maxLat: 71.5, minLng: -11.0, maxLng: 32.0 };

export function canServe(lat: number, lng: number): boolean {
    return (
        lat >= EUROPE_BBOX.minLat &&
        lat <= EUROPE_BBOX.maxLat &&
        lng >= EUROPE_BBOX.minLng &&
        lng <= EUROPE_BBOX.maxLng
    );
}

export async function planJourney(
    req: PlanRequest,
    apiKey: string,
    departAt: number,
    signal?: AbortSignal,
): Promise<Journey | null> {
    // navitia.io takes the key in the `Authorization` header.
    return planViaNavitia(
        NAVITIA_URL,
        { Authorization: apiKey },
        req,
        departAt,
        signal,
    );
}

/**
 * Generic Navitia v2 `/journeys` fetch + parse, shared by every
 * Navitia-shaped instance (navitia.io, IDFM PRIM, SNCF, …). `authHeaders`
 * carries the per-instance auth (navitia.io uses `Authorization: <key>`;
 * PRIM uses `apikey: <key>`). The request + response contract is
 * identical across instances, so `parseNavitiaJourneys` is reused as-is.
 */
export async function planViaNavitia(
    journeysUrl: string,
    authHeaders: Record<string, string>,
    req: PlanRequest,
    departAt: number,
    signal?: AbortSignal,
): Promise<Journey | null> {
    const url = new URL(journeysUrl);
    // Note the lng;lat ordering.
    url.searchParams.set("from", `${req.origin.lng};${req.origin.lat}`);
    url.searchParams.set("to", `${req.destination.lng};${req.destination.lat}`);
    url.searchParams.set("datetime", basicIso(new Date(departAt)));
    url.searchParams.set("datetime_represents", "departure");
    url.searchParams.set("count", "1");

    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);

    let resp: Response;
    try {
        resp = await fetch(url.toString(), {
            signal: ctrl.signal,
            headers: { Accept: "application/json", ...authHeaders },
        });
    } catch (e) {
        console.warn("navitia fetch failed:", e);
        return null;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
    }
    if (!resp.ok) {
        console.warn("navitia non-OK:", resp.status, resp.statusText);
        return null;
    }
    let json: unknown;
    try {
        json = await resp.json();
    } catch {
        return null;
    }
    return parseNavitiaJourneys(json, req.destination);
}

/* ─────────────────────── Pure parser ─────────────────────── */

export function parseNavitiaJourneys(
    json: unknown,
    destFallback: TravelPlace,
): Journey | null {
    const journeys = (json as { journeys?: unknown[] }).journeys;
    if (!Array.isArray(journeys) || journeys.length === 0) return null;
    const j = journeys[0] as { sections?: unknown[] };
    const rawSections = j.sections;
    if (!Array.isArray(rawSections) || rawSections.length === 0) return null;

    const legs: JourneyLeg[] = [];
    for (const raw of rawSections) {
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

interface NavitiaEndpoint {
    name?: string;
    stop_point?: {
        name?: string;
        coord?: { lat?: string | number; lon?: string | number };
    };
    address?: {
        name?: string;
        coord?: { lat?: string | number; lon?: string | number };
    };
    coord?: { lat?: string | number; lon?: string | number };
}

function parseSection(
    raw: unknown,
    destFallback: TravelPlace,
): JourneyLeg | null {
    const sec = raw as {
        type?: string;
        mode?: string;
        departure_date_time?: string;
        arrival_date_time?: string;
        from?: NavitiaEndpoint;
        to?: NavitiaEndpoint;
        display_informations?: {
            physical_mode?: string;
            commercial_mode?: string;
            label?: string;
            code?: string;
            direction?: string;
        };
    };
    const type = sec.type ?? "";
    // Waiting sections are idle time between legs, not a movement leg.
    if (type === "waiting") return null;

    const departAt = parseBasicIso(sec.departure_date_time);
    const arriveAt = parseBasicIso(sec.arrival_date_time);
    if (departAt == null || arriveAt == null) return null;

    const isTransit = type === "public_transport";
    const out: JourneyLeg = {
        mode: isTransit ? classifyMode(sec.display_informations) : "walk",
        from: place(sec.from, destFallback),
        to: place(sec.to, destFallback),
        departAt,
        arriveAt,
    };
    if (isTransit) {
        const di = sec.display_informations;
        const line = di?.code ?? di?.label;
        if (line) out.line = line;
        if (di?.direction) out.direction = di.direction;
    }
    return out;
}

function place(
    e: NavitiaEndpoint | undefined,
    fallback: TravelPlace,
): TravelPlace {
    const coord =
        e?.stop_point?.coord ?? e?.address?.coord ?? e?.coord ?? undefined;
    const name = e?.stop_point?.name ?? e?.address?.name ?? e?.name;
    return {
        lat: toNum(coord?.lat) ?? fallback.lat,
        lng: toNum(coord?.lon) ?? fallback.lng,
        name: name ?? fallback.name,
    };
}

/** navitia `display_informations.physical_mode` is reliable English:
 *  "Metro", "Tramway", "Bus", "Train", "RapidTransit" (RER), "Ferry",
 *  "Funicular", etc. */
function classifyMode(di?: {
    physical_mode?: string;
    commercial_mode?: string;
}): TravelMode | "transit" {
    const hay =
        `${di?.physical_mode ?? ""} ${di?.commercial_mode ?? ""}`.toLowerCase();
    if (/metro|subway|métro/.test(hay)) return "subway";
    if (/tram/.test(hay)) return "tram";
    if (/bus|coach/.test(hay)) return "bus";
    if (/ferry|boat|ship/.test(hay)) return "ferry";
    if (/train|rail|rer|rapidtransit|ter|intercit/.test(hay)) return "train";
    return "transit";
}

function toNum(v: string | number | undefined): number | null {
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    if (typeof v === "string" && v.trim() !== "") {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    }
    return null;
}

/** navitia basic-ISO output, e.g. "20260621T120000" (local time). */
function parseBasicIso(s?: string): number | null {
    if (!s) return null;
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(s);
    if (!m) {
        // Tolerate a full ISO string too, just in case.
        const t = Date.parse(s);
        return Number.isFinite(t) ? t : null;
    }
    const t = new Date(
        Number(m[1]),
        Number(m[2]) - 1,
        Number(m[3]),
        Number(m[4]),
        Number(m[5]),
        Number(m[6]),
    ).getTime();
    return Number.isFinite(t) ? t : null;
}

function basicIso(d: Date): string {
    return (
        `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}` +
        `T${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}`
    );
}
