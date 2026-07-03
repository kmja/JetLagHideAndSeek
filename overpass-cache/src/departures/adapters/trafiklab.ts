/**
 * Trafiklab ResRobot 2.1 departure-board adapter (Sweden).
 *
 * Two upstream calls, both keyed by the worker's `TRAFIKLAB_API_KEY`
 * secret (same key as the arrival proxy + trip planner):
 *
 *   1. `location.nearbystops` — coordinate → nearest stop area id.
 *   2. `departureBoard` — that stop's next departures.
 *
 * Coverage is Sweden (SL, SJ, Västtrafik, Skånetrafiken, …); `canServe`
 * reuses the trip planner's Sweden bbox so departures come from the same
 * source that would plan a trip there. Real-time when ResRobot supplies
 * it (`rtTime`/`rtDate`), scheduled otherwise. Returns null on any
 * failure so the dispatcher falls through to the MOTIS fallback.
 */

import { canServe as trafiklabCanServe } from "../../travel/adapters/trafiklab";
import type { Departure, DepartureBoardRequest, TravelMode } from "../types";

const NEARBY_URL = "https://api.resrobot.se/v2.1/location.nearbystops";
const BOARD_URL = "https://api.resrobot.se/v2.1/departureBoard";
const UPSTREAM_TIMEOUT_MS = 8_000;

/** Same Sweden bbox the trip-planner adapter uses. */
export const canServe = trafiklabCanServe;

export async function fetchBoard(
    req: DepartureBoardRequest,
    apiKey: string,
    when: number,
    max: number,
    signal?: AbortSignal,
): Promise<{ stopName?: string; departures: Departure[] } | null> {
    const stop = await fetchNearestStop(req.lat, req.lng, apiKey, signal);
    if (!stop) return null;
    const json = await fetchDepartureJson(stop.id, when, max, apiKey, signal);
    if (json == null) return null;
    const departures = parseResRobotBoard(json);
    return { stopName: stop.name, departures };
}

/* ─────────────────────── Upstream calls ─────────────────────── */

async function fetchNearestStop(
    lat: number,
    lng: number,
    apiKey: string,
    signal?: AbortSignal,
): Promise<{ id: string; name?: string } | null> {
    const url = new URL(NEARBY_URL);
    url.searchParams.set("accessId", apiKey);
    url.searchParams.set("format", "json");
    url.searchParams.set("originCoordLat", lat.toFixed(6));
    url.searchParams.set("originCoordLong", lng.toFixed(6));
    url.searchParams.set("maxNo", "1");
    url.searchParams.set("r", "1000");
    const json = await getJson(url.toString(), signal);
    if (json == null) return null;
    return parseNearestStop(json);
}

async function fetchDepartureJson(
    stopId: string,
    when: number,
    max: number,
    apiKey: string,
    signal?: AbortSignal,
): Promise<unknown> {
    const d = new Date(when);
    const url = new URL(BOARD_URL);
    url.searchParams.set("accessId", apiKey);
    url.searchParams.set("format", "json");
    url.searchParams.set("id", stopId);
    url.searchParams.set("date", dateYmd(d));
    url.searchParams.set("time", timeHm(d));
    url.searchParams.set("maxJourneys", String(max));
    url.searchParams.set("duration", "120");
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
        console.warn("ResRobot departures fetch failed:", e);
        return null;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
    }
    if (!resp.ok) {
        console.warn(
            "ResRobot departures non-OK:",
            resp.status,
            resp.statusText,
        );
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
 * Pull the first stop id from a `location.nearbystops` response.
 * Exported for fixture tests.
 */
export function parseNearestStop(
    json: unknown,
): { id: string; name?: string } | null {
    const list = (json as { stopLocationOrCoordLocation?: unknown[] })
        ?.stopLocationOrCoordLocation;
    if (!Array.isArray(list) || list.length === 0) return null;
    for (const entry of list) {
        const sl = (entry as { StopLocation?: unknown })?.StopLocation as
            | { id?: string; extId?: string; name?: string }
            | undefined;
        if (!sl) continue;
        const id = sl.id ?? sl.extId;
        if (id) return { id, name: sl.name };
    }
    return null;
}

/**
 * Normalise a ResRobot 2.1 `departureBoard` response into our
 * `Departure[]`, soonest first. Pure + defensive: a partial payload
 * degrades to the departures it can parse rather than throwing.
 * Exported for fixture tests.
 */
export function parseResRobotBoard(json: unknown): Departure[] {
    const raw = (json as { Departure?: unknown[] })?.Departure;
    if (!Array.isArray(raw)) return [];
    const out: Departure[] = [];
    for (const r of raw) {
        const dep = r as {
            name?: string;
            direction?: string;
            time?: string;
            date?: string;
            rtTime?: string;
            rtDate?: string;
            Product?: unknown;
        };
        // Prefer the real-time timestamp when present.
        const realtime = Boolean(dep.rtTime && dep.rtDate);
        const time = realtime
            ? parseLocalDateTime(dep.rtDate, dep.rtTime)
            : parseLocalDateTime(dep.date, dep.time);
        if (time == null) continue;
        const d: Departure = {
            time,
            mode: classifyMode(dep),
        };
        if (realtime) d.realtime = true;
        const line = lineLabel(dep);
        if (line) d.line = line;
        if (dep.direction) d.headsign = String(dep.direction);
        out.push(d);
    }
    out.sort((a, b) => a.time - b.time);
    return out;
}

function lineLabel(dep: {
    name?: string;
    Product?: unknown;
}): string | undefined {
    const product = firstProduct(dep.Product);
    return product?.name ?? dep.name ?? undefined;
}

function classifyMode(dep: {
    name?: string;
    Product?: unknown;
}): TravelMode | "transit" {
    const product = firstProduct(dep.Product);
    const hay =
        `${product?.catOut ?? ""} ${product?.catOutL ?? ""} ${product?.name ?? ""} ${dep.name ?? ""}`.toLowerCase();
    if (/tunnelbana|metro|subway|u-bahn/.test(hay)) return "subway";
    if (/spårväg|sparvag|tram|spårvagn|light rail/.test(hay)) return "tram";
    if (/buss|bus/.test(hay)) return "bus";
    if (/färja|farja|ferry|båt|boat/.test(hay)) return "ferry";
    if (/tåg|tag|train|järnväg|jarnvag|pendel|rail/.test(hay)) return "train";
    return "transit";
}

function firstProduct(
    product: unknown,
): { name?: string; catOut?: string; catOutL?: string } | undefined {
    const p = Array.isArray(product) ? product[0] : product;
    return p as { name?: string; catOut?: string; catOutL?: string } | undefined;
}

/* ─────────────────────── Helpers ─────────────────────── */

function dateYmd(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function timeHm(d: Date): string {
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Parse ResRobot's local `YYYY-MM-DD` + `HH:MM[:SS]` into Unix ms.
 *  Same helper as the trip planner + arrival proxy (local zone = UTC on
 *  Workers — the known shared simplification). */
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
