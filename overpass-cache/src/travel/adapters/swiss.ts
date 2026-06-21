/**
 * Switzerland — transport.opendata.ch adapter.
 *
 * `transport.opendata.ch` is a community wrapper over the Swiss
 * Federal Railways (SBB) HAFAS, returning JSON. Completely keyless
 * (1000 req/day soft cap per IP, way above what a single player can
 * burn — and Workers' shared egress IP means we benefit from the
 * pooled allowance).
 *
 * Docs: https://transport.opendata.ch/docs.html
 * Endpoint: GET /v1/connections?from=X,Y&to=X,Y&date=YYYY-MM-DD&time=HH:MM
 *
 * Connections come back with `sections[]`; each section has either a
 * `journey` (a transit ride with `category` like "S", "IC", "T",
 * "Bus") or a `walk` (on-foot segment between two stops).
 */

import type {
    Journey,
    JourneyLeg,
    PlanRequest,
    TravelMode,
    TravelPlace,
} from "../types";

const SWISS_URL = "https://transport.opendata.ch/v1/connections";
const UPSTREAM_TIMEOUT_MS = 8_000;

/** Switzerland bbox. Coarse rectangle from the Genève corner up to
 *  St. Moritz / Lake Constance — the country is small enough that
 *  one box covers it without overlap risk against neighbours. */
const SWISS_BBOX = { minLat: 45.7, maxLat: 47.85, minLng: 5.9, maxLng: 10.5 };

export function canServe(lat: number, lng: number): boolean {
    return (
        lat >= SWISS_BBOX.minLat &&
        lat <= SWISS_BBOX.maxLat &&
        lng >= SWISS_BBOX.minLng &&
        lng <= SWISS_BBOX.maxLng
    );
}

export async function planJourney(
    req: PlanRequest,
    departAt: number,
    signal?: AbortSignal,
): Promise<Journey | null> {
    const depart = new Date(departAt);
    const url = new URL(SWISS_URL);
    url.searchParams.set(
        "from",
        `${req.origin.lat.toFixed(6)},${req.origin.lng.toFixed(6)}`,
    );
    url.searchParams.set(
        "to",
        `${req.destination.lat.toFixed(6)},${req.destination.lng.toFixed(6)}`,
    );
    url.searchParams.set("date", dateYmd(depart));
    url.searchParams.set("time", timeHm(depart));
    url.searchParams.set("limit", "1");
    // `fields[]=connections/sections` is the docs-recommended way to
    // request the leg detail; without it, sections come back trimmed.
    url.searchParams.append("fields[]", "connections/sections");
    url.searchParams.append("fields[]", "connections/from");
    url.searchParams.append("fields[]", "connections/to");
    url.searchParams.append("fields[]", "connections/duration");

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
        console.warn("Swiss fetch failed:", e);
        return null;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
    }
    if (!resp.ok) {
        console.warn("Swiss non-OK:", resp.status, resp.statusText);
        return null;
    }
    let json: unknown;
    try {
        json = await resp.json();
    } catch {
        return null;
    }
    return parseSwissConnections(json, req.destination);
}

/* ─────────────────────── Pure parser ─────────────────────── */

export function parseSwissConnections(
    json: unknown,
    destFallback: TravelPlace,
): Journey | null {
    const conns = (json as { connections?: unknown[] }).connections;
    if (!Array.isArray(conns) || conns.length === 0) return null;
    const conn = conns[0] as { sections?: unknown[] };
    const rawSections = conn.sections;
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

interface RawCheckpoint {
    station?: { name?: string; coordinate?: { x?: number; y?: number } };
    departure?: string;
    arrival?: string;
    departureTimestamp?: number;
    arrivalTimestamp?: number;
}

function parseSection(
    raw: unknown,
    destFallback: TravelPlace,
): JourneyLeg | null {
    const sec = raw as {
        journey?: {
            category?: string;
            number?: string;
            to?: string;
            name?: string;
        };
        walk?: { duration?: number };
        departure?: RawCheckpoint;
        arrival?: RawCheckpoint;
    };
    const dep = sec.departure;
    const arr = sec.arrival;
    if (!dep || !arr) return null;

    const departAt = tsFromCheckpoint(dep, "departure");
    const arriveAt = tsFromCheckpoint(arr, "arrival");
    if (departAt == null || arriveAt == null) return null;

    const isWalk = sec.walk != null && sec.journey == null;
    const mode = isWalk ? "walk" : classifyMode(sec.journey);

    const out: JourneyLeg = {
        mode,
        from: {
            lat: dep.station?.coordinate?.x ?? 0,
            lng: dep.station?.coordinate?.y ?? 0,
            name: dep.station?.name,
        },
        to: {
            lat: arr.station?.coordinate?.x ?? destFallback.lat,
            lng: arr.station?.coordinate?.y ?? destFallback.lng,
            name: arr.station?.name ?? destFallback.name,
        },
        departAt,
        arriveAt,
    };
    if (!isWalk && sec.journey) {
        const line =
            sec.journey.name ??
            [sec.journey.category, sec.journey.number]
                .filter(Boolean)
                .join(" ");
        if (line) out.line = line;
        if (sec.journey.to) out.direction = sec.journey.to;
    }
    return out;
}

/** transport.opendata.ch's `journey.category` follows HAFAS codes:
 *  ICE/IC/IR/RE/S/Bus/Tram/M (metro)/T (tram alt) etc. */
function classifyMode(j?: { category?: string }): TravelMode | "transit" {
    const c = (j?.category ?? "").toUpperCase();
    if (c === "M" || c === "U") return "subway";
    if (c === "T" || c === "TRAM") return "tram";
    if (c === "BUS" || c === "B" || c.startsWith("NFB")) return "bus";
    if (c === "SHIP" || c === "BAT" || c === "FÄHRE" || c === "BOAT")
        return "ferry";
    // Most everything else (S, IC, IR, RE, EC, EN, ICE, R) is rail.
    if (c) return "train";
    return "transit";
}

function tsFromCheckpoint(
    cp: RawCheckpoint,
    kind: "departure" | "arrival",
): number | null {
    // The API includes both an ISO string (`departure`) and a Unix
    // seconds timestamp (`departureTimestamp`) — prefer the
    // timestamp since it's unambiguous about timezone.
    const tsField =
        kind === "departure" ? cp.departureTimestamp : cp.arrivalTimestamp;
    if (typeof tsField === "number" && Number.isFinite(tsField)) {
        return tsField * 1000;
    }
    const iso = kind === "departure" ? cp.departure : cp.arrival;
    if (typeof iso === "string") {
        const t = Date.parse(iso);
        if (Number.isFinite(t)) return t;
    }
    return null;
}

function dateYmd(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function timeHm(d: Date): string {
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
