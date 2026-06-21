/**
 * Australia (NSW) — Transport for NSW Trip Planner adapter.
 *
 * TfNSW's Open Data Trip Planner API (EFA, `rapidJSON` output) covers
 * Greater Sydney + NSW: trains, Sydney Metro, light rail, buses,
 * ferries. Coordinate-based; free API key from the TfNSW Open Data
 * Hub, sent as `Authorization: apikey <KEY>`.
 *
 * Docs: https://opendata.transport.nsw.gov.au/ → "Trip Planner APIs".
 *
 * Geographically isolated, so the bbox doesn't overlap any other
 * adapter. Keyed: defers without `TFNSW_API_KEY` → walking. As with
 * the other non-live-testable adapters, the request shape follows the
 * docs and the response PARSER is fixture-tested; a wrong request just
 * degrades to a walking estimate.
 */

import type {
    Journey,
    JourneyLeg,
    PlanRequest,
    TravelMode,
    TravelPlace,
} from "../types";

const TFNSW_URL = "https://api.transport.nsw.gov.au/v1/tp/trip";
const UPSTREAM_TIMEOUT_MS = 8_000;

/** NSW + ACT-ish bbox (Sydney, Newcastle, Wollongong, Canberra). Well
 *  clear of every other adapter's region. */
const NSW_BBOX = { minLat: -37.6, maxLat: -28.0, minLng: 140.9, maxLng: 153.7 };

export function canServe(lat: number, lng: number): boolean {
    return (
        lat >= NSW_BBOX.minLat &&
        lat <= NSW_BBOX.maxLat &&
        lng >= NSW_BBOX.minLng &&
        lng <= NSW_BBOX.maxLng
    );
}

export async function planJourney(
    req: PlanRequest,
    apiKey: string,
    departAt: number,
    signal?: AbortSignal,
): Promise<Journey | null> {
    const depart = new Date(departAt);
    const url = new URL(TFNSW_URL);
    url.searchParams.set("outputFormat", "rapidJSON");
    url.searchParams.set("coordOutputFormat", "EPSG:4326");
    url.searchParams.set("depArrMacro", "dep");
    url.searchParams.set("itdDate", ymd(depart));
    url.searchParams.set("itdTime", hm(depart));
    url.searchParams.set("type_origin", "coord");
    // EFA coord input is lng:lat:EPSG:4326.
    url.searchParams.set(
        "name_origin",
        `${req.origin.lng}:${req.origin.lat}:EPSG:4326`,
    );
    url.searchParams.set("type_destination", "coord");
    url.searchParams.set(
        "name_destination",
        `${req.destination.lng}:${req.destination.lat}:EPSG:4326`,
    );
    url.searchParams.set("calcNumberOfTrips", "1");
    url.searchParams.set("TfNSWTR", "true");
    url.searchParams.set("version", "10.2.1.42");

    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);

    let resp: Response;
    try {
        resp = await fetch(url.toString(), {
            signal: ctrl.signal,
            headers: {
                Accept: "application/json",
                Authorization: `apikey ${apiKey}`,
            },
        });
    } catch (e) {
        console.warn("NSW (TfNSW) fetch failed:", e);
        return null;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
    }
    if (!resp.ok) {
        console.warn("NSW non-OK:", resp.status, resp.statusText);
        return null;
    }
    let json: unknown;
    try {
        json = await resp.json();
    } catch {
        return null;
    }
    return parseEfaTrip(json, req.destination);
}

/* ─────────────────────── Pure parser ─────────────────────── */

export function parseEfaTrip(
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

interface EfaPoint {
    name?: string;
    disassembledName?: string;
    coord?: number[]; // [lat, lng] in rapidJSON
    departureTimeEstimated?: string;
    departureTimePlanned?: string;
    arrivalTimeEstimated?: string;
    arrivalTimePlanned?: string;
}

function parseLeg(raw: unknown, destFallback: TravelPlace): JourneyLeg | null {
    const leg = raw as {
        origin?: EfaPoint;
        destination?: EfaPoint;
        distance?: number;
        transportation?: {
            product?: { class?: number; name?: string };
            disassembledName?: string;
            number?: string;
            destination?: { name?: string };
        };
    };
    const o = leg.origin;
    const d = leg.destination;
    if (!o || !d) return null;

    const departAt = parseISO(
        o.departureTimeEstimated ?? o.departureTimePlanned,
    );
    const arriveAt = parseISO(d.arrivalTimeEstimated ?? d.arrivalTimePlanned);
    if (departAt == null || arriveAt == null) return null;

    const cls = leg.transportation?.product?.class;
    const mode = classifyMode(cls);
    const isWalk = mode === "walk";
    const out: JourneyLeg = {
        mode,
        from: point(o, destFallback),
        to: point(d, destFallback),
        departAt,
        arriveAt,
    };
    if (!isWalk) {
        const t = leg.transportation;
        const line = t?.disassembledName ?? t?.number ?? t?.product?.name;
        if (line) out.line = line;
        if (t?.destination?.name) out.direction = t.destination.name;
    }
    if (typeof leg.distance === "number")
        out.distanceMeters = Math.round(leg.distance);
    return out;
}

function point(p: EfaPoint, fallback: TravelPlace): TravelPlace {
    const coord = Array.isArray(p.coord) ? p.coord : undefined;
    return {
        // rapidJSON coord is [lat, lng].
        lat: typeof coord?.[0] === "number" ? coord[0] : fallback.lat,
        lng: typeof coord?.[1] === "number" ? coord[1] : fallback.lng,
        name: p.disassembledName ?? p.name ?? fallback.name,
    };
}

/** EFA `product.class`: 1 train, 2 metro, 4 light rail, 5/7/11 bus,
 *  9 ferry, 99/100 walking. */
function classifyMode(cls?: number): "walk" | TravelMode | "transit" {
    switch (cls) {
        case 1:
            return "train";
        case 2:
            return "subway";
        case 4:
            return "tram";
        case 5:
        case 7:
        case 11:
            return "bus";
        case 9:
            return "ferry";
        case 99:
        case 100:
        case undefined:
            return "walk";
        default:
            return "transit";
    }
}

function parseISO(s?: string): number | null {
    if (!s) return null;
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
}

function ymd(d: Date): string {
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

function hm(d: Date): string {
    return `${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
}
