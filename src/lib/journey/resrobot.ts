/**
 * Trafiklab ResRobot 2.1 adapter — Swedish public + national transit
 * (SL, SJ, Västtrafik, Skånetrafiken, MTR Express, etc., all in one
 * federated journey planner).
 *
 * Docs: https://www.trafiklab.se/api/our-apis/resrobot-v21/
 *
 * The provider exposes a one-to-one trip endpoint, not a many-to-one
 * batch — so for N stops we make N requests. That's fine for casual
 * play with the cache layer in front (typical refresh: 20-60 stops
 * after the cache warms once per game), but a play area with hundreds
 * of visible stops would burn through the 10k/month free tier
 * quickly. Concurrency-limited and rate-paced to be polite.
 */

import type {
    JourneyAnchor,
    JourneyProvider,
    JourneyResult,
    JourneyStop,
} from "./types";

const TRIP_ENDPOINT = "https://api.resrobot.se/v2.1/trip";

/** Per-request hard cap. Trip planning shouldn't take this long even
 *  cold — if it does, the api or network is sad and the user is
 *  better off seeing "no time" than a stuck spinner. */
const REQUEST_TIMEOUT_MS = 8_000;

/** Concurrency cap. ResRobot's free tier doesn't publish a hard
 *  per-second rate, but 4 in flight is polite and keeps the burst
 *  under typical service tier thresholds. */
const PARALLEL = 4;

/** YYYY-MM-DD in the user's local time. ResRobot uses local civil
 *  time so we don't need to do anything UTC-clever here. */
function dateParam(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** HH:MM in the user's local time. */
function timeParam(d: Date): string {
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Parse ResRobot's "YYYY-MM-DD" + "HH:MM:SS" string pair into a
 *  Unix ms timestamp in the user's local zone. ResRobot returns
 *  local civil time without a TZ offset; the seeker app is by
 *  definition in the same zone, so we treat the strings as local
 *  and let Date do the heavy lifting. */
function parseArrival(date: string, time: string): number | null {
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

async function fetchOneArrival(
    anchor: JourneyAnchor,
    stop: JourneyStop,
    apiKey: string,
    signal: AbortSignal,
): Promise<number | null> {
    const depart = new Date(anchor.departAt);
    const url = new URL(TRIP_ENDPOINT);
    url.searchParams.set("accessId", apiKey);
    url.searchParams.set("format", "json");
    url.searchParams.set("originCoordLat", String(anchor.lat));
    url.searchParams.set("originCoordLong", String(anchor.lng));
    url.searchParams.set("destCoordLat", String(stop.lat));
    url.searchParams.set("destCoordLong", String(stop.lng));
    url.searchParams.set("date", dateParam(depart));
    url.searchParams.set("time", timeParam(depart));
    url.searchParams.set("numF", "1");
    url.searchParams.set("passlist", "0");
    url.searchParams.set("rtMode", "OFF");

    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    let resp: Response;
    try {
        resp = await fetch(url.toString(), {
            signal: ctrl.signal,
            headers: { Accept: "application/json" },
        });
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
    }
    if (!resp.ok) return null;
    let json: unknown;
    try {
        json = await resp.json();
    } catch {
        return null;
    }
    // Response shape (abbreviated):
    //   { Trip: [{ LegList: { Leg: [{ Origin: {...}, Destination: { date, time, ... } }, ...] }, ... }] }
    // We want the last Leg's Destination time of the FIRST trip.
    const trips = (json as { Trip?: unknown[] }).Trip;
    if (!Array.isArray(trips) || trips.length === 0) return null;
    const first = trips[0] as {
        LegList?: { Leg?: Array<{ Destination?: { date?: string; time?: string } }> };
    };
    const legs = first.LegList?.Leg;
    if (!Array.isArray(legs) || legs.length === 0) return null;
    const lastDest = legs[legs.length - 1].Destination;
    if (!lastDest?.date || !lastDest?.time) return null;
    return parseArrival(lastDest.date, lastDest.time);
}

/** Concurrency-limited fan-out. Aborts in-flight requests if the
 *  caller-provided signal is aborted. */
async function withConcurrency<T, R>(
    items: T[],
    limit: number,
    worker: (item: T, index: number) => Promise<R>,
    signal: AbortSignal,
): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (true) {
            if (signal.aborted) return;
            const i = next++;
            if (i >= items.length) return;
            results[i] = await worker(items[i], i);
        }
    });
    await Promise.all(runners);
    return results;
}

export function createResRobotProvider(getApiKey: () => string): JourneyProvider {
    return {
        id: "resrobot",
        displayName: "ResRobot (Sweden — SL, SJ, Västtrafik …)",
        apiKeyUrl: "https://www.trafiklab.se/api/our-apis/resrobot-v21/",
        isAvailable() {
            return getApiKey().trim().length > 0;
        },
        async fetchArrivals(
            anchor,
            stops,
            signal = new AbortController().signal,
        ): Promise<JourneyResult[]> {
            const key = getApiKey().trim();
            if (!key) {
                // No key — empty arrivals so the caller can still
                // distribute results 1:1 with the stops list.
                return stops.map((s) => ({ stopId: s.id, arrivalAt: null }));
            }
            const arrivals = await withConcurrency(
                stops,
                PARALLEL,
                (s) => fetchOneArrival(anchor, s, key, signal),
                signal,
            );
            return stops.map((s, i) => ({
                stopId: s.id,
                arrivalAt: arrivals[i] ?? null,
            }));
        },
    };
}
