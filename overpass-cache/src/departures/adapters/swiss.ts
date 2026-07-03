/**
 * Switzerland (transport.opendata.ch) departure-board adapter.
 *
 * Keyless SBB HAFAS wrapper. Two calls:
 *
 *   1. `GET /v1/locations?x={lat}&y={lng}&type=station` → nearest
 *      `{ stations: [{ id, name }] }`.
 *   2. `GET /v1/stationboard?id={id}&limit={n}` → `{ station,
 *      stationboard: [{ stop:{ departure, departureTimestamp },
 *      category, number, name, to }] }`.
 *
 * Same `canServe` box as the trip planner's `swiss.ts`. (The API's
 * coordinate convention is `x` = latitude, `y` = longitude — see the
 * planner adapter's `coordinate.x`/`.y` usage.) Not live-testable from
 * the sandbox — the PARSER is fixture-tested.
 */

import { canServe as swissCanServe } from "../../travel/adapters/swiss";
import type { Departure, TravelMode } from "../types";

const LOCATIONS_URL = "https://transport.opendata.ch/v1/locations";
const BOARD_URL = "https://transport.opendata.ch/v1/stationboard";
const UPSTREAM_TIMEOUT_MS = 8_000;

export const canServe = swissCanServe;

export async function fetchBoard(
    lat: number,
    lng: number,
    _when: number,
    max: number,
    signal?: AbortSignal,
): Promise<{ stopName?: string; departures: Departure[] } | null> {
    const stop = await fetchNearestStation(lat, lng, signal);
    if (!stop) return null;
    const url = new URL(BOARD_URL);
    url.searchParams.set("id", stop.id);
    url.searchParams.set("limit", String(max));
    const json = await getJson(url.toString(), signal);
    if (json == null) return null;
    return { stopName: stop.name, departures: parseSwissBoard(json) };
}

async function fetchNearestStation(
    lat: number,
    lng: number,
    signal?: AbortSignal,
): Promise<{ id: string; name?: string } | null> {
    const url = new URL(LOCATIONS_URL);
    // x = latitude, y = longitude in this API's convention.
    url.searchParams.set("x", lat.toFixed(6));
    url.searchParams.set("y", lng.toFixed(6));
    url.searchParams.set("type", "station");
    const json = await getJson(url.toString(), signal);
    if (json == null) return null;
    return parseNearestStation(json);
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
        console.warn("Swiss departures fetch failed:", e);
        return null;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
    }
    if (!resp.ok) {
        console.warn("Swiss departures non-OK:", resp.status, resp.statusText);
        return null;
    }
    try {
        return await resp.json();
    } catch {
        return null;
    }
}

/* ─────────────────────── Pure parsers ─────────────────────── */

/** Keep the first station from a `/v1/locations` response. Exported for
 *  fixture tests. */
export function parseNearestStation(
    json: unknown,
): { id: string; name?: string } | null {
    const stations = (json as { stations?: unknown[] })?.stations;
    if (!Array.isArray(stations)) return null;
    for (const s of stations) {
        const st = s as { id?: string; name?: string };
        if (st?.id) return { id: st.id, name: st.name };
    }
    return null;
}

/**
 * Normalise a `/v1/stationboard` response into our `Departure[]`,
 * soonest first. Exported for fixture tests.
 */
export function parseSwissBoard(json: unknown): Departure[] {
    const rows = (json as { stationboard?: unknown[] })?.stationboard;
    if (!Array.isArray(rows)) return [];
    const out: Departure[] = [];
    for (const r of rows) {
        const row = r as {
            category?: string;
            number?: string;
            name?: string;
            to?: string;
            stop?: {
                departure?: string;
                departureTimestamp?: number;
            };
        };
        const stop = row.stop ?? {};
        const time =
            typeof stop.departureTimestamp === "number" &&
            Number.isFinite(stop.departureTimestamp)
                ? stop.departureTimestamp * 1000
                : parseISO(stop.departure);
        if (time == null) continue;
        const d: Departure = { time, mode: classifyMode(row.category) };
        const line =
            row.name ??
            [row.category, row.number].filter(Boolean).join(" ") ??
            undefined;
        if (line) d.line = line;
        if (row.to) d.headsign = row.to;
        out.push(d);
    }
    out.sort((a, b) => a.time - b.time);
    return out;
}

/** transport.opendata.ch HAFAS `category` codes → our mode. Same
 *  mapping as the trip planner's `swiss.ts`. */
function classifyMode(category?: string): TravelMode | "transit" {
    const c = (category ?? "").toUpperCase();
    if (c === "M" || c === "U") return "subway";
    if (c === "T" || c === "TRAM") return "tram";
    if (c === "BUS" || c === "B" || c.startsWith("NFB")) return "bus";
    if (c === "SHIP" || c === "BAT" || c === "FÄHRE" || c === "BOAT")
        return "ferry";
    if (c) return "train";
    return "transit";
}

function parseISO(s?: string): number | null {
    if (!s) return null;
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
}
