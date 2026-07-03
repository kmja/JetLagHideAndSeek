/**
 * Departure-board endpoint — `POST /api/journey/departures`.
 *
 *   Body: {
 *     lat, lng: number,        // the stop to read
 *     name?:   string,         // best-effort tapped-feature name
 *     when?:   number,         // Unix ms, defaults to now
 *     modes?:  TravelMode[],   // filter to the game's allowed modes
 *   }
 *   200 → DepartureBoardResponse { available, source, stopName, departures }
 *
 * Same trust + CORS + cache model as the arrival proxy / trip planner
 * next door. The adapter dispatcher fans out to whichever regional
 * board serves the stop (Trafiklab SE today), with MOTIS as the
 * universal fallback. Upstream keys stay server-side secrets.
 *
 * Cache: keyed by (lat, lng, 2-minute `when` bucket, sorted modes).
 * Departures are time-sensitive, so the bucket + TTLs are much SHORTER
 * than the trip planner's — a board is only good for a couple of
 * minutes. Cloudflare edge cache first (per-colo), R2 second.
 */

import type { Env } from "../envTypes";
import { dispatchBoard } from "./dispatcher";
import type {
    DepartureBoardRequest,
    DepartureBoardResponse,
    TravelMode,
} from "./types";

/** 2-minute departure-anchor bucket — coarse enough for cache hits when
 *  the hider re-taps the same stop, fine enough that a cached board is
 *  never badly stale. */
const WHEN_BUCKET_MS = 2 * 60 * 1000;
/** R2 durability window — a board older than this is treated as missing. */
const R2_TTL_MS = 5 * 60 * 1000;
/** Edge cache lifetime (seconds). */
const EDGE_CACHE_TTL_SECS = 2 * 60;
/** How many departures to return. */
const MAX_DEPARTURES = 8;

const ALL_MODES: TravelMode[] = ["bus", "tram", "train", "subway", "ferry"];

export async function handleDepartures(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
    cors: HeadersInit,
): Promise<Response> {
    if (request.method !== "POST") {
        return jsonResponse({ error: "POST required" }, 405, cors);
    }

    let body: DepartureBoardRequest;
    try {
        body = (await request.json()) as DepartureBoardRequest;
    } catch {
        return jsonResponse({ error: "invalid JSON body" }, 400, cors);
    }
    if (
        typeof body.lat !== "number" ||
        typeof body.lng !== "number" ||
        !Number.isFinite(body.lat) ||
        !Number.isFinite(body.lng)
    ) {
        return jsonResponse(
            { error: "finite lat/lng required" },
            400,
            cors,
        );
    }

    const when =
        typeof body.when === "number" && Number.isFinite(body.when)
            ? body.when
            : Date.now();
    const modes = normaliseModes(body.modes);
    const req: DepartureBoardRequest = {
        lat: body.lat,
        lng: body.lng,
        name: body.name,
        when,
        modes,
    };

    const whenBucket = Math.floor(when / WHEN_BUCKET_MS) * WHEN_BUCKET_MS;
    const edgeCache = caches.default;
    const key = await cacheKeyFor(req, whenBucket);

    // Phase 1: cache probe.
    const cached = await readCached(env, edgeCache, key);
    if (cached) {
        return jsonResponse(cached, 200, cors, "HIT");
    }

    // Phase 2: dispatch, anchored at the bucket so cache hits don't drift.
    const { source, stopName, departures } = await dispatchBoard(
        req,
        env,
        whenBucket,
        MAX_DEPARTURES,
    );
    const payload: DepartureBoardResponse = {
        available: source !== "none",
        source,
        stopName,
        departures,
    };

    // Only persist a resolved board — a "none" (no stop / upstream miss)
    // is cheap to retry and caching it would pin an empty board through a
    // transient upstream hiccup.
    if (source !== "none") {
        ctx.waitUntil(writeCached(env, edgeCache, key, payload));
    }

    return jsonResponse(payload, 200, cors, "MISS");
}

/* ─────────────────────── Cache layers ─────────────────────── */

async function readCached(
    env: Env,
    edgeCache: Cache,
    key: string,
): Promise<DepartureBoardResponse | null> {
    const edgeHit = await edgeCache.match(syntheticReq(key));
    if (edgeHit) {
        try {
            return (await edgeHit.json()) as DepartureBoardResponse;
        } catch {
            /* corrupt — fall through */
        }
    }
    try {
        const obj = await env.CACHE.get(`departures/${key}`);
        if (obj) {
            const cachedAt = parseInt(obj.customMetadata?.cachedAt ?? "0", 10);
            if (Date.now() - cachedAt < R2_TTL_MS) {
                return JSON.parse(await obj.text()) as DepartureBoardResponse;
            }
        }
    } catch (e) {
        console.warn("Departures R2 get failed:", e);
    }
    return null;
}

async function writeCached(
    env: Env,
    edgeCache: Cache,
    key: string,
    payload: DepartureBoardResponse,
): Promise<void> {
    const body = JSON.stringify(payload);
    try {
        await env.CACHE.put(`departures/${key}`, body, {
            customMetadata: {
                cachedAt: String(Date.now()),
                kind: "departure-board",
            },
        });
    } catch (e) {
        console.warn("Departures R2 put failed:", e);
    }
    try {
        const edgeResp = new Response(body, {
            headers: {
                "Content-Type": "application/json",
                "Cache-Control": `public, max-age=${EDGE_CACHE_TTL_SECS}`,
            },
        });
        await edgeCache.put(syntheticReq(key), edgeResp);
    } catch (e) {
        console.warn("Departures edge put failed:", e);
    }
}

async function cacheKeyFor(
    req: DepartureBoardRequest,
    whenBucket: number,
): Promise<string> {
    const s = [
        req.lat.toFixed(5),
        req.lng.toFixed(5),
        String(whenBucket),
        (req.modes ?? []).slice().sort().join(","),
    ].join("|");
    const bytes = new TextEncoder().encode(s);
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(hash))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

function syntheticReq(key: string): Request {
    return new Request(`https://_departures-cache/${key}`, { method: "GET" });
}

/* ─────────────────────── Helpers ─────────────────────── */

function normaliseModes(modes: TravelMode[] | undefined): TravelMode[] {
    if (!Array.isArray(modes) || modes.length === 0) return ALL_MODES;
    return modes.filter((m) => ALL_MODES.includes(m));
}

function jsonResponse(
    body: unknown,
    status: number,
    cors: HeadersInit,
    cacheStatus?: string,
): Response {
    const headers: Record<string, string> = {
        ...corsAsObject(cors),
        "Content-Type": "application/json",
    };
    if (cacheStatus) headers["X-Cache"] = cacheStatus;
    return new Response(JSON.stringify(body), { status, headers });
}

function corsAsObject(h: HeadersInit): Record<string, string> {
    if (h instanceof Headers) {
        const o: Record<string, string> = {};
        h.forEach((v, k) => (o[k] = v));
        return o;
    }
    if (Array.isArray(h)) return Object.fromEntries(h);
    return { ...h } as Record<string, string>;
}
