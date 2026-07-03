/**
 * Germany / DACH `transport.rest` (FPTF) departure-board adapter.
 *
 * The `*.transport.rest` family (DB `v6.db.transport.rest`, ÖBB
 * `v6.oebb.transport.rest`, …) exposes a clean keyless stationboard:
 *
 *   1. `GET {base}/locations/nearby?latitude=&longitude=&results=1&stops=true`
 *      → nearest stop `{ type:"stop", id, name, location }`.
 *   2. `GET {base}/stops/{id}/departures?when=&duration=&results=`
 *      → `{ departures: [{ when, plannedWhen, delay, direction,
 *        line:{ name, product, mode } }] }`.
 *
 * Shared `fetchViaFptf` so Germany + Austria (ÖBB) reuse one code path,
 * mirroring the trip planner's `planViaFptf`. Same `canServe` boxes as
 * the planner adapters. Not live-testable from the sandbox — the PARSER
 * is fixture-tested and a wrong request degrades to an empty board.
 */

import { canServe as germanyCanServe } from "../../travel/adapters/germany";
import type { Departure, TravelMode } from "../types";

const UPSTREAM_TIMEOUT_MS = 4_500;

/** DB `v6.db.transport.rest` base. */
export const DB_BASE = "https://v6.db.transport.rest";

export const canServe = germanyCanServe;

export async function fetchBoard(
    baseUrl: string,
    lat: number,
    lng: number,
    when: number,
    max: number,
    signal?: AbortSignal,
): Promise<{ stopName?: string; departures: Departure[] } | null> {
    return fetchViaFptf(baseUrl, lat, lng, when, max, signal);
}

/** Generic transport.rest stationboard fetch (DB, ÖBB, …). */
export async function fetchViaFptf(
    baseUrl: string,
    lat: number,
    lng: number,
    when: number,
    max: number,
    signal?: AbortSignal,
): Promise<{ stopName?: string; departures: Departure[] } | null> {
    const base = baseUrl.replace(/\/$/, "");
    const stop = await fetchNearestStop(base, lat, lng, signal);
    if (!stop) return null;
    const boardUrl = new URL(
        `${base}/stops/${encodeURIComponent(stop.id)}/departures`,
    );
    boardUrl.searchParams.set("when", new Date(when).toISOString());
    boardUrl.searchParams.set("duration", "120");
    boardUrl.searchParams.set("results", String(max));
    const json = await getJson(boardUrl.toString(), signal);
    if (json == null) return null;
    return { stopName: stop.name, departures: parseFptfDepartures(json) };
}

async function fetchNearestStop(
    base: string,
    lat: number,
    lng: number,
    signal?: AbortSignal,
): Promise<{ id: string; name?: string } | null> {
    const url = new URL(`${base}/locations/nearby`);
    url.searchParams.set("latitude", lat.toFixed(6));
    url.searchParams.set("longitude", lng.toFixed(6));
    url.searchParams.set("results", "1");
    url.searchParams.set("stops", "true");
    url.searchParams.set("poi", "false");
    const json = await getJson(url.toString(), signal);
    if (json == null) return null;
    return parseNearestStop(json);
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
        console.warn("transport.rest departures fetch failed:", e);
        return null;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
    }
    if (!resp.ok) {
        console.warn(
            "transport.rest departures non-OK:",
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

/** `/locations/nearby` returns a bare array; keep the first `stop`.
 *  Exported for fixture tests. */
export function parseNearestStop(
    json: unknown,
): { id: string; name?: string } | null {
    if (!Array.isArray(json)) return null;
    for (const m of json) {
        const loc = m as { type?: string; id?: string; name?: string };
        if (loc?.type === "stop" && loc.id) {
            return { id: loc.id, name: loc.name };
        }
    }
    return null;
}

/**
 * Normalise an FPTF `{ departures: [...] }` stationboard into our
 * `Departure[]`, soonest first. Exported for fixture tests.
 */
export function parseFptfDepartures(json: unknown): Departure[] {
    const rows = (json as { departures?: unknown[] })?.departures;
    if (!Array.isArray(rows)) return [];
    const out: Departure[] = [];
    for (const r of rows) {
        const dep = r as {
            when?: string | null;
            plannedWhen?: string;
            delay?: number | null;
            direction?: string;
            line?: { name?: string; product?: string; mode?: string };
        };
        const rt = parseISO(dep.when ?? undefined);
        const time = rt ?? parseISO(dep.plannedWhen);
        if (time == null) continue;
        const d: Departure = { time, mode: classifyMode(dep.line) };
        if (rt != null && typeof dep.delay === "number") d.realtime = true;
        if (dep.line?.name) d.line = dep.line.name;
        if (dep.direction) d.headsign = dep.direction;
        out.push(d);
    }
    out.sort((a, b) => a.time - b.time);
    return out;
}

/** FPTF `line.product` (specific) preferred over `line.mode` (coarse).
 *  Same mapping as the trip planner's FPTF classifier. */
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
