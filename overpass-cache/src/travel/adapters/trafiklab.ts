/**
 * Trafiklab ResRobot 2.1 trip adapter.
 *
 * Sibling of the arrival proxy in `../../journey.ts`, but where that
 * one asks ResRobot for `passlist=0` and keeps only the final arrival
 * timestamp, this one asks for `passlist=1` and reconstructs the full
 * leg list — origin/destination of each leg, the line label, walking
 * segments and transfers — so the client can render a real journey
 * card.
 *
 * Coverage: ResRobot is the Swedish national federated planner (SL,
 * SJ, Västtrafik, Skånetrafiken, …). `canServe` gates it to a
 * Sweden-centric bounding box so we don't burn an upstream call (and
 * the operator's free-tier quota) planning a Tokyo trip that would
 * just fail and fall through to walking anyway. When Norway (Entur)
 * and Finland (Digitransit) adapters land they sit ahead of this one
 * with tighter boxes and win inside their borders.
 *
 * The API key never leaves the server — it's the worker's
 * `TRAFIKLAB_API_KEY` secret, same as the arrival proxy.
 */

import type {
    Journey,
    JourneyLeg,
    PlanRequest,
    TravelMode,
    TravelPlace,
} from "../types";

const RESROBOT_TRIP_URL = "https://api.resrobot.se/v2.1/trip";
const UPSTREAM_TIMEOUT_MS = 8_000;

/** Sweden bbox, tightened to be disjoint from the Norway and Finland
 *  adapters' boxes:
 *    - West edge 11.0 excludes Oslo (10.75 E) so it lands on Entur.
 *    - East edge 24.5 excludes Helsinki (24.94 E) so it lands on
 *      Digitransit.
 *  The Finnish/Swedish border around Haparanda (23 E) and Sweden's
 *  whole interior are well inside the trimmed bbox. */
const SWEDEN_BBOX = { minLat: 55.0, maxLat: 69.1, minLng: 11.0, maxLng: 24.5 };

export function canServe(lat: number, lng: number): boolean {
    return (
        lat >= SWEDEN_BBOX.minLat &&
        lat <= SWEDEN_BBOX.maxLat &&
        lng >= SWEDEN_BBOX.minLng &&
        lng <= SWEDEN_BBOX.maxLng
    );
}

/**
 * Plan a journey via ResRobot. Returns null on any failure (no key,
 * network error, no trip found, unparseable response) so the
 * dispatcher falls through to the walking backstop — the caller is
 * guaranteed a journey either way.
 */
export async function planJourney(
    req: PlanRequest,
    apiKey: string,
    departAt: number,
    signal?: AbortSignal,
): Promise<Journey | null> {
    const depart = new Date(departAt);
    const url = new URL(RESROBOT_TRIP_URL);
    url.searchParams.set("accessId", apiKey);
    url.searchParams.set("format", "json");
    url.searchParams.set("originCoordLat", req.origin.lat.toFixed(6));
    url.searchParams.set("originCoordLong", req.origin.lng.toFixed(6));
    url.searchParams.set("destCoordLat", req.destination.lat.toFixed(6));
    url.searchParams.set("destCoordLong", req.destination.lng.toFixed(6));
    url.searchParams.set("date", dateYmd(depart));
    url.searchParams.set("time", timeHm(depart));
    url.searchParams.set("numF", "1");
    // passlist=1 is the whole point of this adapter — it makes
    // ResRobot return the per-leg stop list we normalise below.
    url.searchParams.set("passlist", "1");
    url.searchParams.set("rtMode", "OFF");

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
        console.warn("ResRobot trip fetch failed:", e);
        return null;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
    }
    if (!resp.ok) {
        console.warn("ResRobot trip non-OK:", resp.status, resp.statusText);
        return null;
    }
    let json: unknown;
    try {
        json = await resp.json();
    } catch {
        return null;
    }
    return parseResRobotTrip(json, req.destination);
}

/* ─────────────────────── Pure parser ─────────────────────── */

/**
 * Normalise a ResRobot 2.1 trip response into our provider-agnostic
 * `Journey`. Pure and defensive — every field access is optional so a
 * partial/odd upstream payload degrades to null rather than throwing.
 * Exported separately from the fetch so it can be unit-tested against
 * captured fixtures without a network round-trip.
 *
 * `destFallback` supplies a name/coords for the final leg endpoint
 * when the upstream leg omits them.
 */
export function parseResRobotTrip(
    json: unknown,
    destFallback: TravelPlace,
): Journey | null {
    const trips = (json as { Trip?: unknown[] })?.Trip;
    if (!Array.isArray(trips) || trips.length === 0) return null;
    const trip = trips[0] as {
        LegList?: { Leg?: unknown[] };
        transferCount?: number;
    };
    const rawLegs = trip.LegList?.Leg;
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
    const transfers =
        typeof trip.transferCount === "number"
            ? trip.transferCount
            : Math.max(0, transitLegs - 1);

    return {
        departAt,
        arriveAt,
        durationMin: Math.max(1, Math.round((arriveAt - departAt) / 60_000)),
        transfers,
        legs,
    };
}

interface RawEndpoint {
    name?: string;
    date?: string;
    time?: string;
    lat?: number | string;
    lon?: number | string;
}

function parseLeg(raw: unknown, destFallback: TravelPlace): JourneyLeg | null {
    const leg = raw as {
        type?: string;
        name?: string;
        direction?: string;
        dist?: number | string;
        Origin?: RawEndpoint;
        Destination?: RawEndpoint;
        Product?: unknown;
        Stops?: { Stop?: unknown };
    };
    const o = leg.Origin;
    const d = leg.Destination;
    if (!o || !d) return null;

    const departAt = parseLocalDateTime(o.date, o.time);
    const arriveAt = parseLocalDateTime(d.date, d.time);
    if (departAt == null || arriveAt == null) return null;

    const isWalk = (leg.type ?? "").toUpperCase() === "WALK";
    const line = isWalk ? undefined : legLineLabel(leg);
    const mode = isWalk ? "walk" : classifyMode(leg);

    const out: JourneyLeg = {
        mode,
        from: endpointPlace(o),
        to: endpointPlace(d, destFallback),
        departAt,
        arriveAt,
    };
    if (line) out.line = line;
    if (leg.direction) out.direction = String(leg.direction);
    const dist = toNum(leg.dist);
    if (dist != null) out.distanceMeters = Math.round(dist);
    // ResRobot passlist=1 gives each transit leg's intermediate stops —
    // stringing them into a polyline shapes the leg to the route (stop
    // to stop) instead of a straight Origin→Destination line. Walk legs
    // carry no stops, so they stay a straight segment.
    if (!isWalk) {
        const shape = stopsToGeometry(leg.Stops?.Stop);
        if (shape) out.geometry = shape;
    }
    return out;
}

/** Build a `[lng, lat][]` shape from a ResRobot leg's passlist stops. */
function stopsToGeometry(stops: unknown): [number, number][] | undefined {
    if (!Array.isArray(stops)) return undefined;
    const pts: [number, number][] = [];
    for (const s of stops) {
        const st = s as { lat?: number | string; lon?: number | string };
        const lat = toNum(st.lat);
        const lng = toNum(st.lon);
        if (lat == null || lng == null) continue;
        if (lat === 0 && lng === 0) continue;
        pts.push([lng, lat]);
    }
    return pts.length >= 2 ? pts : undefined;
}

function endpointPlace(e: RawEndpoint, fallback?: TravelPlace): TravelPlace {
    const lat = toNum(e.lat);
    const lng = toNum(e.lon);
    return {
        lat: lat ?? fallback?.lat ?? 0,
        lng: lng ?? fallback?.lng ?? 0,
        name: e.name ?? fallback?.name,
    };
}

/** ResRobot exposes the line under `Product` (object or array,
 *  version-dependent). Fall back to the leg's own `name`. */
function legLineLabel(leg: {
    name?: string;
    Product?: unknown;
}): string | undefined {
    const product = Array.isArray(leg.Product) ? leg.Product[0] : leg.Product;
    const p = product as { name?: string; line?: string } | undefined;
    return p?.name ?? p?.line ?? leg.name ?? undefined;
}

/** Best-effort mapping from ResRobot's category/product text to our
 *  mode enum. Swedish + English keywords; defaults to the generic
 *  `"transit"` when nothing matches so the leg still renders. */
function classifyMode(leg: {
    name?: string;
    Product?: unknown;
}): TravelMode | "transit" {
    const product = Array.isArray(leg.Product) ? leg.Product[0] : leg.Product;
    const p = product as
        | { catOut?: string; catOutL?: string; name?: string }
        | undefined;
    const hay =
        `${p?.catOut ?? ""} ${p?.catOutL ?? ""} ${p?.name ?? ""} ${leg.name ?? ""}`.toLowerCase();
    if (/tunnelbana|metro|subway|u-bahn/.test(hay)) return "subway";
    if (/spårväg|sparvag|tram|spårvagn|light rail/.test(hay)) return "tram";
    if (/buss|bus/.test(hay)) return "bus";
    if (/färja|farja|ferry|båt|boat/.test(hay)) return "ferry";
    if (/tåg|tag|train|järnväg|jarnvag|pendel|rail/.test(hay)) return "train";
    return "transit";
}

/* ─────────────────────── Helpers ─────────────────────── */

function toNum(v: number | string | undefined): number | null {
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    if (typeof v === "string" && v.trim() !== "") {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    }
    return null;
}

function dateYmd(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function timeHm(d: Date): string {
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Parse ResRobot's local `YYYY-MM-DD` + `HH:MM[:SS]` into Unix ms.
 *  Mirrors the helper in `journey.ts` exactly so this endpoint and
 *  the arrival proxy interpret upstream times identically. (Both
 *  build the Date in the runtime's local zone, which is UTC on
 *  Workers — a known shared simplification, not re-litigated here.) */
function parseLocalDateTime(date?: string, time?: string): number | null {
    if (!date || !time) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    const tm = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time);
    if (!m || !tm) return null;
    const t = new Date(
        Number(m[1]),
        Number(m[2]) - 1,
        Number(m[3]),
        Number(tm[1]),
        Number(tm[2]),
        Number(tm[3] ?? "0"),
    ).getTime();
    return Number.isFinite(t) ? t : null;
}
