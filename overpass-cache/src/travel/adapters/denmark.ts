/**
 * Denmark — Rejseplanen (HAFAS) adapter.
 *
 * Rejseplanen is the Danish national journey planner. Its classic open
 * REST endpoint (`xmlopen.rejseplanen.dk/bin/rest.exe`) is keyless and
 * coordinate-based, returning HAFAS JSON — the same `Trip → Leg` shape
 * family as Sweden's ResRobot, just with Danish formatting quirks
 * (microdegree coords, `dd.MM.yy` dates).
 *
 * Covers all of Denmark — Copenhagen (DSB/Metro/S-tog/Movia), Aarhus
 * (letbane), Odense, Aalborg, the regional + intercity rail.
 *
 * ⚠️ STATUS (confirmed live, 2026): the open API 1.0 endpoint below is
 * SHUT DOWN — `xmlopen.rejseplanen.dk` now returns only an HTTP 299
 * deprecation page ("API 1.0 has been shut down, replaced by API 2.0").
 * The router therefore GATES this adapter behind `REJSEPLANEN_API_KEY`
 * and it defers to Transitous until a key is configured. The parser
 * (`parseRejseplanenTrip`) stays fixture-tested and should largely
 * carry over to API 2.0 (still HAFAS-shaped); when wiring a key, update
 * `REJSEPLANEN_URL` + the request params to the API 2.0 contract
 * (labs.rejseplanen.dk/hc/en-us/articles/21554723926557).
 */

import type {
    Journey,
    JourneyLeg,
    PlanRequest,
    TravelMode,
    TravelPlace,
} from "../types";

// ⚠️ DEAD: API 1.0 shut down (HTTP 299 deprecation page). Only reached
// when REJSEPLANEN_API_KEY is set (router gate) — migrate to API 2.0
// before relying on it. Left here so the request/parse scaffolding is
// ready to repoint.
const REJSEPLANEN_URL = "https://xmlopen.rejseplanen.dk/bin/rest.exe/trip";
const UPSTREAM_TIMEOUT_MS = 8_000;

/** Denmark bbox — Jutland + Funen + Zealand incl. Copenhagen. East
 *  edge 12.7 stays just west of Malmö (13.0, Swedish) but does still
 *  overlap the Gothenburg longitude band; the dispatcher's
 *  try-in-order + null-fallthrough handles that (a Swedish city makes
 *  Rejseplanen return null → Trafiklab serves it). Bornholm (15°E) is
 *  intentionally out of box. */
const DENMARK_BBOX = { minLat: 54.5, maxLat: 57.8, minLng: 8.0, maxLng: 12.7 };

export function canServe(lat: number, lng: number): boolean {
    return (
        lat >= DENMARK_BBOX.minLat &&
        lat <= DENMARK_BBOX.maxLat &&
        lng >= DENMARK_BBOX.minLng &&
        lng <= DENMARK_BBOX.maxLng
    );
}

/** HAFAS wants coordinates as integer microdegrees (value × 1e6). */
function microdeg(v: number): string {
    return String(Math.round(v * 1_000_000));
}

export async function planJourney(
    req: PlanRequest,
    departAt: number,
    signal?: AbortSignal,
): Promise<Journey | null> {
    const depart = new Date(departAt);
    const url = new URL(REJSEPLANEN_URL);
    url.searchParams.set("originCoordX", microdeg(req.origin.lng));
    url.searchParams.set("originCoordY", microdeg(req.origin.lat));
    url.searchParams.set("originCoordName", "origin");
    url.searchParams.set("destCoordX", microdeg(req.destination.lng));
    url.searchParams.set("destCoordY", microdeg(req.destination.lat));
    url.searchParams.set(
        "destCoordName",
        req.destination.name ?? "destination",
    );
    url.searchParams.set("date", danishDate(depart));
    url.searchParams.set("time", timeHm(depart));
    url.searchParams.set("format", "json");

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
        console.warn("Denmark (Rejseplanen) fetch failed:", e);
        return null;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
    }
    if (!resp.ok) {
        console.warn("Denmark non-OK:", resp.status, resp.statusText);
        return null;
    }
    let json: unknown;
    try {
        json = await resp.json();
    } catch {
        return null;
    }
    return parseRejseplanenTrip(json, req.destination);
}

/* ─────────────────────── Pure parser ─────────────────────── */

export function parseRejseplanenTrip(
    json: unknown,
    destFallback: TravelPlace,
): Journey | null {
    const tripList = (json as { TripList?: { Trip?: unknown } }).TripList;
    if (!tripList) return null;
    // Trip can be an array or (rarely) a single object.
    const trips = asArray(tripList.Trip);
    if (trips.length === 0) return null;
    const trip = trips[0] as { Leg?: unknown };
    // Leg, likewise, is object-or-array (the classic HAFAS quirk).
    const rawLegs = asArray(trip.Leg);
    if (rawLegs.length === 0) return null;

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

interface RjEndpoint {
    name?: string;
    time?: string;
    date?: string;
    x?: string | number;
    y?: string | number;
}

function parseLeg(raw: unknown, destFallback: TravelPlace): JourneyLeg | null {
    const leg = raw as {
        name?: string;
        type?: string;
        direction?: string;
        Origin?: RjEndpoint;
        Destination?: RjEndpoint;
    };
    const o = leg.Origin;
    const d = leg.Destination;
    if (!o || !d) return null;

    const departAt = parseDanishDateTime(o.date, o.time);
    const arriveAt = parseDanishDateTime(d.date, d.time);
    if (departAt == null || arriveAt == null) return null;

    const isWalk = (leg.type ?? "").toUpperCase() === "WALK";
    const out: JourneyLeg = {
        mode: isWalk ? "walk" : classifyMode(leg.type, leg.name),
        from: endpoint(o),
        to: endpoint(d, destFallback),
        departAt,
        arriveAt,
    };
    if (!isWalk && leg.name) out.line = leg.name;
    if (leg.direction) out.direction = leg.direction;
    return out;
}

function endpoint(e: RjEndpoint, fallback?: TravelPlace): TravelPlace {
    const lng = toNum(e.x);
    const lat = toNum(e.y);
    return {
        // HAFAS X/Y are microdegrees when present.
        lat: lat != null ? lat / 1_000_000 : (fallback?.lat ?? 0),
        lng: lng != null ? lng / 1_000_000 : (fallback?.lng ?? 0),
        name: e.name ?? fallback?.name,
    };
}

/** Rejseplanen `type` / product codes: WALK, IC, ICL, RE, Re, Tog, S
 *  (S-tog), M/Metro, Bus/EBus/Bybus/NBus/Letbane, F (Færge). */
function classifyMode(type?: string, name?: string): TravelMode | "transit" {
    const hay = `${type ?? ""} ${name ?? ""}`.toLowerCase();
    if (/\bm\b|metro/.test(hay)) return "subway";
    if (/letbane|tram/.test(hay)) return "tram";
    if (/bus/.test(hay)) return "bus";
    if (/færge|faerge|ferry|\bf\b/.test(hay)) return "ferry";
    if (/\bs\b|s-tog|stog|tog|ic|icl|\bre\b|reg|lyn|train|rail/.test(hay))
        return "train";
    return "transit";
}

/* ─────────────────────── Helpers ─────────────────────── */

function asArray(v: unknown): unknown[] {
    if (Array.isArray(v)) return v;
    if (v == null) return [];
    return [v];
}

function toNum(v: string | number | undefined): number | null {
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    if (typeof v === "string" && v.trim() !== "") {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    }
    return null;
}

function danishDate(d: Date): string {
    return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getFullYear()).slice(2)}`;
}

function timeHm(d: Date): string {
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Parse Rejseplanen's date (`dd.MM.yy`, occasionally `yyyy-MM-dd`) +
 *  `HH:MM` into Unix ms. Builds the Date in runtime-local time (UTC on
 *  Workers) — the same simplification the other HAFAS adapters use. */
function parseDanishDateTime(date?: string, time?: string): number | null {
    if (!date || !time) return null;
    const tm = /^(\d{2}):(\d{2})/.exec(time);
    if (!tm) return null;
    let y: number, mo: number, da: number;
    const dk = /^(\d{2})\.(\d{2})\.(\d{2})$/.exec(date);
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (dk) {
        da = Number(dk[1]);
        mo = Number(dk[2]);
        y = 2000 + Number(dk[3]);
    } else if (iso) {
        y = Number(iso[1]);
        mo = Number(iso[2]);
        da = Number(iso[3]);
    } else {
        return null;
    }
    const t = new Date(y, mo - 1, da, Number(tm[1]), Number(tm[2])).getTime();
    return Number.isFinite(t) ? t : null;
}
