/**
 * MOTIS departure-board adapter — the near-universal fallback.
 *
 * Same MOTIS v2 API the trip planner's `transitous`/`motisSelfHosted`
 * adapters use, so it covers wherever the Mobility Database has a GTFS
 * feed. Two upstream calls against a MOTIS instance base URL:
 *
 *   1. `GET /api/v1/reverse-geocode?place=lat,lon` — resolve the tapped
 *      coordinate to the nearest STOP and its `stopId`.
 *   2. `GET /api/v1/stoptimes?stopId=…&time=…&n=…&arriveBy=false` — the
 *      next departures from that stop.
 *
 * `baseUrl` is the instance's `/api/v1` root (public Transitous or the
 * operator's self-hosted box). Keyless. Returns null on any failure so
 * the dispatcher degrades to "no live departures".
 *
 * ⚠️ The public Transitous instance carries the same non-commercial
 * flag noted in `travel/adapters/transitous.ts` — revisit before
 * monetising; a self-hosted MOTIS box is license-clean.
 *
 * Not live-testable from the sandbox — the response PARSER is
 * fixture-tested (`tests/departures.test.ts`); a wrong request shape
 * degrades to an empty board, never a crash.
 */

import type { Departure, TravelMode } from "../types";

const UPSTREAM_TIMEOUT_MS = 9_000;

/** Public Transitous MOTIS v2 API root. */
export const TRANSITOUS_BASE = "https://api.transitous.org/api/v1";

/** Universal — MOTIS routes wherever the Mobility Database has a feed;
 *  outside coverage it simply returns no stop / no departures. */
export function canServe(_lat: number, _lng: number): boolean {
    return true;
}

export async function fetchBoard(
    baseUrl: string,
    lat: number,
    lng: number,
    when: number,
    max: number,
    signal?: AbortSignal,
): Promise<{ stopName?: string; departures: Departure[] } | null> {
    const stop = await resolveStop(baseUrl, lat, lng, signal);
    if (!stop) return null;
    const json = await fetchStoptimes(baseUrl, stop.id, when, max, signal);
    if (json == null) return null;
    const departures = parseMotisStoptimes(json);
    return { stopName: stop.name, departures };
}

/* ─────────────────────── Upstream calls ─────────────────────── */

async function resolveStop(
    baseUrl: string,
    lat: number,
    lng: number,
    signal?: AbortSignal,
): Promise<{ id: string; name?: string } | null> {
    const url = new URL(`${baseUrl}/reverse-geocode`);
    url.searchParams.set("place", `${lat},${lng}`);
    const json = await getJson(url.toString(), signal);
    if (json == null) return null;
    return parseNearestStop(json);
}

async function fetchStoptimes(
    baseUrl: string,
    stopId: string,
    when: number,
    max: number,
    signal?: AbortSignal,
): Promise<unknown> {
    const url = new URL(`${baseUrl}/stoptimes`);
    url.searchParams.set("stopId", stopId);
    url.searchParams.set("time", new Date(when).toISOString());
    url.searchParams.set("n", String(max));
    url.searchParams.set("arriveBy", "false");
    return getJson(url.toString(), signal);
}

async function getJson(
    url: string,
    signal?: AbortSignal,
): Promise<unknown | null> {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
    let resp: Response;
    try {
        resp = await fetch(url, {
            signal: ctrl.signal,
            headers: { Accept: "application/json" },
        });
    } catch (e) {
        console.warn("MOTIS departures fetch failed:", e);
        return null;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
    }
    if (!resp.ok) {
        console.warn("MOTIS departures non-OK:", resp.status, resp.statusText);
        return null;
    }
    try {
        return await resp.json();
    } catch {
        return null;
    }
}

/* ─────────────────────── Pure parsers ─────────────────────── */

/**
 * Pull the nearest STOP from a MOTIS `reverse-geocode` response (an
 * array of matches, each `{ type, id, name, lat, lon, … }`). Keeps the
 * first `type === "STOP"` entry. Exported for fixture tests.
 */
export function parseNearestStop(
    json: unknown,
): { id: string; name?: string } | null {
    if (!Array.isArray(json)) return null;
    for (const m of json) {
        const match = m as { type?: string; id?: string; name?: string };
        if (match?.type === "STOP" && match.id) {
            return { id: match.id, name: match.name };
        }
    }
    return null;
}

interface MotisStopTimePlace {
    name?: string;
    stopId?: string;
    departure?: string;
    scheduledDeparture?: string;
    arrival?: string;
    scheduledArrival?: string;
}

/**
 * Normalise a MOTIS v2 `stoptimes` response (`{ stopTimes: [...] }`)
 * into our `Departure[]`, soonest first. Each stopTime is OTP-shaped:
 * `place.departure` (ISO, real-time), `place.scheduledDeparture`,
 * `mode`, `headsign`, `routeShortName`, `realTime`. Exported for fixture
 * tests.
 */
export function parseMotisStoptimes(json: unknown): Departure[] {
    const rows = (json as { stopTimes?: unknown[] })?.stopTimes;
    if (!Array.isArray(rows)) return [];
    const out: Departure[] = [];
    for (const r of rows) {
        const st = r as {
            place?: MotisStopTimePlace;
            mode?: string;
            realTime?: boolean;
            headsign?: string;
            routeShortName?: string;
            routeLongName?: string;
        };
        const place = st.place ?? {};
        // Prefer the (real-time) `departure`, fall back to scheduled.
        const rt = parseISO(place.departure);
        const sched = parseISO(place.scheduledDeparture);
        const time = rt ?? sched;
        if (time == null) continue;
        const d: Departure = { time, mode: classifyMode(st.mode) };
        if (st.realTime && rt != null) d.realtime = true;
        const line = st.routeShortName ?? st.routeLongName;
        if (line) d.line = line;
        if (st.headsign) d.headsign = st.headsign;
        out.push(d);
    }
    out.sort((a, b) => a.time - b.time);
    return out;
}

/** MOTIS/OTP `mode` → our mode enum. Same mapping as the plan parser. */
function classifyMode(mode?: string): TravelMode | "transit" {
    switch ((mode ?? "").toUpperCase()) {
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
