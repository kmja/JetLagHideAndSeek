/**
 * Netherlands — NS (Nederlandse Spoorwegen) Reisinformatie Trips API.
 *
 * NS is the national RAILWAY operator; its Trips API accepts origin +
 * destination coordinates and returns door-to-door journeys, but it's
 * rail-CENTRIC: coordinate routing snaps to nearby stations and the
 * journey is train + walk-access legs (weaker for pure local bus/tram/
 * metro). Still the only official free coordinate-capable NL planner
 * (9292 is commercial; Plannerstack OTP is defunct).
 *
 * Endpoint: `GET https://gateway.apiportal.ns.nl/reisinformatie-api/api/v3/trips`
 * Coords: `originLat`/`originLng`/`destinationLat`/`destinationLng`.
 * Auth: free key (no billing) as `Ocp-Apim-Subscription-Key` header.
 * Response: `trips[].legs[]`; each leg has `origin`/`destination`
 * (`name`, `lat`, `lng`, `plannedDateTime`) and a `product`
 * (`categoryCode`, `displayName`, `number`); a WALKING leg has no
 * `product`.
 *
 * Keyed (`NS_API_KEY`). Not live-testable here; shape from the official
 * docs + aquatix/ns-api reference client, walking backstop covers a
 * wrong request.
 */

import type {
    Journey,
    JourneyLeg,
    PlanRequest,
    TravelMode,
    TravelPlace,
} from "../types";

const NS_TRIPS_URL =
    "https://gateway.apiportal.ns.nl/reisinformatie-api/api/v3/trips";
const UPSTREAM_TIMEOUT_MS = 9_000;

/** Netherlands bbox. */
const NL_BBOX = { minLat: 50.7, maxLat: 53.6, minLng: 3.3, maxLng: 7.25 };

export function canServe(lat: number, lng: number): boolean {
    return (
        lat >= NL_BBOX.minLat &&
        lat <= NL_BBOX.maxLat &&
        lng >= NL_BBOX.minLng &&
        lng <= NL_BBOX.maxLng
    );
}

export async function planJourney(
    req: PlanRequest,
    apiKey: string,
    departAt: number,
    signal?: AbortSignal,
): Promise<Journey | null> {
    const url = new URL(NS_TRIPS_URL);
    url.searchParams.set("originLat", req.origin.lat.toFixed(6));
    url.searchParams.set("originLng", req.origin.lng.toFixed(6));
    url.searchParams.set("destinationLat", req.destination.lat.toFixed(6));
    url.searchParams.set("destinationLng", req.destination.lng.toFixed(6));
    url.searchParams.set("dateTime", new Date(departAt).toISOString());

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
                "Ocp-Apim-Subscription-Key": apiKey,
            },
        });
    } catch (e) {
        console.warn("Netherlands (NS) fetch failed:", e);
        return null;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
    }
    if (!resp.ok) {
        console.warn("Netherlands non-OK:", resp.status, resp.statusText);
        return null;
    }
    let json: unknown;
    try {
        json = await resp.json();
    } catch {
        return null;
    }
    return parseNsTrip(json, req.destination);
}

/* ─────────────────────── Pure parser ─────────────────────── */

interface NsPlace {
    name?: string;
    lat?: number;
    lng?: number;
    plannedDateTime?: string;
    actualDateTime?: string;
}

export function parseNsTrip(
    json: unknown,
    destFallback: TravelPlace,
): Journey | null {
    const trips = (json as { trips?: unknown[] }).trips;
    if (!Array.isArray(trips) || trips.length === 0) return null;
    const rawLegs = (trips[0] as { legs?: unknown[] }).legs;
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

function parseLeg(raw: unknown, destFallback: TravelPlace): JourneyLeg | null {
    const leg = raw as {
        origin?: NsPlace;
        destination?: NsPlace;
        direction?: string;
        travelType?: string;
        product?: {
            displayName?: string;
            categoryCode?: string;
            shortCategoryName?: string;
            number?: string;
        };
    };
    const o = leg.origin;
    const d = leg.destination;
    if (!o || !d) return null;

    const departAt = parseISO(o.actualDateTime ?? o.plannedDateTime);
    const arriveAt = parseISO(d.actualDateTime ?? d.plannedDateTime);
    if (departAt == null || arriveAt == null) return null;

    // A walking leg has no product (or an explicit WALK travelType).
    const isWalk =
        !leg.product || (leg.travelType ?? "").toUpperCase() === "WALK";
    const out: JourneyLeg = {
        mode: isWalk ? "walk" : classifyMode(leg.product),
        from: place(o),
        to: place(d, destFallback),
        departAt,
        arriveAt,
    };
    if (!isWalk) {
        const p = leg.product;
        const line =
            p?.displayName ??
            [p?.shortCategoryName, p?.number].filter(Boolean).join(" ");
        if (line) out.line = line;
        if (leg.direction) out.direction = leg.direction;
    }
    return out;
}

function place(p: NsPlace, fallback?: TravelPlace): TravelPlace {
    return {
        lat: typeof p.lat === "number" ? p.lat : (fallback?.lat ?? 0),
        lng: typeof p.lng === "number" ? p.lng : (fallback?.lng ?? 0),
        name: p.name ?? fallback?.name,
    };
}

/** NS `product.categoryCode` / names → our mode. Mostly trains; NS
 *  door-to-door can also return bus/tram/metro access legs. */
function classifyMode(product?: {
    categoryCode?: string;
    shortCategoryName?: string;
    displayName?: string;
}): TravelMode | "transit" {
    const hay =
        `${product?.categoryCode ?? ""} ${product?.shortCategoryName ?? ""} ${product?.displayName ?? ""}`.toLowerCase();
    if (/metro/.test(hay)) return "subway";
    if (/tram/.test(hay)) return "tram";
    if (/bus/.test(hay)) return "bus";
    if (/ferry|boot|veer/.test(hay)) return "ferry";
    // IC, SPR, ST, intercity, sprinter, stoptrein, … → train.
    return "train";
}

function parseISO(s?: string): number | null {
    if (!s) return null;
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
}
