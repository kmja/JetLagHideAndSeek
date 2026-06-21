/**
 * South Korea — ODsay public-transit routing (nationwide).
 *
 * ODsay is the de-facto standard KR transit routing API (Seoul, Busan,
 * Incheon, …). Free tier: 1,000 calls/day, no credit card (key only).
 *
 * Endpoint: `GET https://api.odsay.com/v1/api/searchPubTransPathT`
 * Coords: `SX`/`SY` = origin lng/lat, `EX`/`EY` = dest lng/lat.
 * Response: `result.path[].subPath[]` — each subPath is a leg with
 * `trafficType` (1 subway, 2 bus, 3 walk), `sectionTime` (minutes),
 * `distance` (m), `startName`/`endName`, `startX/Y`/`endX/Y`, and
 * `lane[0].name`/`lane[0].busNo` for the line. ODsay gives per-leg
 * DURATIONS (no absolute clock), so timestamps accumulate from
 * `departAt`.
 *
 * Keyed (`ODSAY_API_KEY`). Not live-testable here; shape from research,
 * walking backstop covers a wrong request.
 */

import type {
    Journey,
    JourneyLeg,
    PlanRequest,
    TravelMode,
    TravelPlace,
} from "../types";

const ODSAY_URL = "https://api.odsay.com/v1/api/searchPubTransPathT";
const UPSTREAM_TIMEOUT_MS = 9_000;

/** South Korea bbox (mainland + Jeju). */
const KOREA_BBOX = { minLat: 33.0, maxLat: 38.7, minLng: 124.5, maxLng: 131.0 };

export function canServe(lat: number, lng: number): boolean {
    return (
        lat >= KOREA_BBOX.minLat &&
        lat <= KOREA_BBOX.maxLat &&
        lng >= KOREA_BBOX.minLng &&
        lng <= KOREA_BBOX.maxLng
    );
}

export async function planJourney(
    req: PlanRequest,
    apiKey: string,
    departAt: number,
    signal?: AbortSignal,
): Promise<Journey | null> {
    const url = new URL(ODSAY_URL);
    url.searchParams.set("SX", String(req.origin.lng));
    url.searchParams.set("SY", String(req.origin.lat));
    url.searchParams.set("EX", String(req.destination.lng));
    url.searchParams.set("EY", String(req.destination.lat));
    url.searchParams.set("apiKey", apiKey);

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
        console.warn("Korea (ODsay) fetch failed:", e);
        return null;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
    }
    if (!resp.ok) {
        console.warn("Korea non-OK:", resp.status, resp.statusText);
        return null;
    }
    let json: unknown;
    try {
        json = await resp.json();
    } catch {
        return null;
    }
    return parseOdsayPath(json, departAt, req.destination);
}

/* ─────────────────────── Pure parser ─────────────────────── */

interface OdsaySubPath {
    trafficType?: number; // 1 subway, 2 bus, 3 walk
    distance?: number;
    sectionTime?: number; // minutes
    startName?: string;
    endName?: string;
    startX?: number; // lng
    startY?: number; // lat
    endX?: number;
    endY?: number;
    lane?: Array<{ name?: string; busNo?: string; subwayCode?: number }>;
}

export function parseOdsayPath(
    json: unknown,
    departAt: number,
    destFallback: TravelPlace,
): Journey | null {
    const paths = (json as { result?: { path?: unknown[] } })?.result?.path;
    if (!Array.isArray(paths) || paths.length === 0) return null;
    const subPaths = (paths[0] as { subPath?: unknown[] }).subPath;
    if (!Array.isArray(subPaths) || subPaths.length === 0) return null;

    let cursor = departAt;
    const legs: JourneyLeg[] = [];
    for (const raw of subPaths) {
        const sp = raw as OdsaySubPath;
        const durMs = Math.max(0, (sp.sectionTime ?? 0) * 60_000);
        const departLeg = cursor;
        const arriveLeg = cursor + durMs;
        cursor = arriveLeg;

        const isWalk = sp.trafficType === 3;
        const out: JourneyLeg = {
            mode: classifyMode(sp.trafficType),
            from: {
                lat: typeof sp.startY === "number" ? sp.startY : 0,
                lng: typeof sp.startX === "number" ? sp.startX : 0,
                name: sp.startName,
            },
            to: {
                lat: typeof sp.endY === "number" ? sp.endY : destFallback.lat,
                lng: typeof sp.endX === "number" ? sp.endX : destFallback.lng,
                name: sp.endName ?? destFallback.name,
            },
            departAt: departLeg,
            arriveAt: arriveLeg,
        };
        if (!isWalk) {
            const lane = sp.lane?.[0];
            const line = lane?.name ?? lane?.busNo;
            if (line) out.line = line;
        }
        if (typeof sp.distance === "number") {
            out.distanceMeters = Math.round(sp.distance);
        }
        legs.push(out);
    }
    if (legs.length === 0) return null;

    const departAtFinal = legs[0].departAt;
    const arriveAt = legs[legs.length - 1].arriveAt;
    const transitLegs = legs.filter((l) => l.mode !== "walk").length;
    return {
        departAt: departAtFinal,
        arriveAt,
        durationMin: Math.max(
            1,
            Math.round((arriveAt - departAtFinal) / 60_000),
        ),
        transfers: Math.max(0, transitLegs - 1),
        legs,
    };
}

/** ODsay `trafficType`: 1 subway, 2 bus, 3 walk. */
function classifyMode(t?: number): "walk" | TravelMode | "transit" {
    switch (t) {
        case 1:
            return "subway";
        case 2:
            return "bus";
        case 3:
            return "walk";
        default:
            return "transit";
    }
}
