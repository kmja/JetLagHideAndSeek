/**
 * Trip-plan endpoint — `POST /api/travel/plan`.
 *
 *   Body: {
 *     origin:      { lat, lng },
 *     destination: { lat, lng, name? },
 *     departAt?:   number,        // Unix ms, defaults to now
 *     modes?:      TravelMode[],  // walking always implicitly allowed
 *   }
 *   200 → PlanResponse { available, source, journey }
 *
 * Same trust + CORS + cache model as the journey-arrival proxy next
 * door (`journey.ts`): the adapter dispatcher fans out to whichever
 * regional planner serves the origin (Trafiklab today, more later),
 * with a walking backstop that guarantees a journey. The upstream API
 * key stays a server-side secret.
 *
 * Cache: keyed by (origin, destination, 5-minute departure bucket,
 * sorted modes). Cloudflare edge cache first (per-colo, sub-ms), R2
 * second (durable across colos + deploys); misses fall through to the
 * dispatcher. Bucketed departures keep the hit ratio high while the
 * hider repeatedly re-checks the route to their chosen zone.
 */

import type { Env } from "../envTypes";
import { dispatchPlan } from "./router";
import type { PlanRequest, PlanResponse, TravelMode } from "./types";

const DEPART_BUCKET_MS = 5 * 60 * 1000;
const R2_TTL_MS = 24 * 60 * 60 * 1000;
const EDGE_CACHE_TTL_SECS = 60 * 60; // 1h

const ALL_MODES: TravelMode[] = ["bus", "tram", "train", "subway", "ferry"];

export async function handleTravelPlan(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
    cors: HeadersInit,
): Promise<Response> {
    if (request.method !== "POST") {
        return jsonResponse({ error: "POST required" }, 405, cors);
    }

    let body: PlanRequest;
    try {
        body = (await request.json()) as PlanRequest;
    } catch {
        return jsonResponse({ error: "invalid JSON body" }, 400, cors);
    }

    const origin = body.origin;
    const destination = body.destination;
    if (
        !origin ||
        !isFiniteCoord(origin.lat, origin.lng) ||
        !destination ||
        !isFiniteCoord(destination.lat, destination.lng)
    ) {
        return jsonResponse(
            { error: "origin and destination with finite lat/lng required" },
            400,
            cors,
        );
    }

    const departAt =
        typeof body.departAt === "number" && Number.isFinite(body.departAt)
            ? body.departAt
            : Date.now();
    const modes = normaliseModes(body.modes);
    const req: PlanRequest = { origin, destination, departAt, modes };

    const departBucket =
        Math.floor(departAt / DEPART_BUCKET_MS) * DEPART_BUCKET_MS;
    const edgeCache = caches.default;
    const key = await cacheKeyFor(req, departBucket);

    // Phase 1: cache probe.
    const cached = await readCached(env, edgeCache, key);
    if (cached) {
        return jsonResponse(cached, 200, cors, "HIT");
    }

    // Phase 2: dispatch. Re-anchor the journey to the bucket so cache
    // hits don't drift the displayed departure around within the
    // 5-minute window.
    const { source, journey } = await dispatchPlan(req, departBucket, env);
    const payload: PlanResponse = {
        available: journey != null,
        source,
        journey,
    };

    // Write back through both layers, best-effort + non-blocking.
    ctx.waitUntil(writeCached(env, edgeCache, key, payload));

    return jsonResponse(payload, 200, cors, "MISS");
}

/* ─────────────────────── Cache layers ─────────────────────── */

async function readCached(
    env: Env,
    edgeCache: Cache,
    key: string,
): Promise<PlanResponse | null> {
    const edgeHit = await edgeCache.match(syntheticReq(key));
    if (edgeHit) {
        try {
            return (await edgeHit.json()) as PlanResponse;
        } catch {
            /* corrupt entry — fall through */
        }
    }
    try {
        const obj = await env.CACHE.get(`travel/${key}`);
        if (obj) {
            const cachedAt = parseInt(obj.customMetadata?.cachedAt ?? "0", 10);
            if (Date.now() - cachedAt < R2_TTL_MS) {
                return JSON.parse(await obj.text()) as PlanResponse;
            }
        }
    } catch (e) {
        console.warn("Travel R2 get failed:", e);
    }
    return null;
}

async function writeCached(
    env: Env,
    edgeCache: Cache,
    key: string,
    payload: PlanResponse,
): Promise<void> {
    const body = JSON.stringify(payload);
    try {
        await env.CACHE.put(`travel/${key}`, body, {
            customMetadata: {
                cachedAt: String(Date.now()),
                kind: "travel-plan",
            },
        });
    } catch (e) {
        console.warn("Travel R2 put failed:", e);
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
        console.warn("Travel edge put failed:", e);
    }
}

async function cacheKeyFor(
    req: PlanRequest,
    departBucket: number,
): Promise<string> {
    const s = [
        req.origin.lat.toFixed(5),
        req.origin.lng.toFixed(5),
        req.destination.lat.toFixed(5),
        req.destination.lng.toFixed(5),
        String(departBucket),
        (req.modes ?? []).join(","),
    ].join("|");
    const bytes = new TextEncoder().encode(s);
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(hash))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

function syntheticReq(key: string): Request {
    return new Request(`https://_travel-cache/${key}`, { method: "GET" });
}

/* ─────────────────────── Helpers ─────────────────────── */

function isFiniteCoord(lat: unknown, lng: unknown): boolean {
    return (
        typeof lat === "number" &&
        Number.isFinite(lat) &&
        Math.abs(lat) <= 90 &&
        typeof lng === "number" &&
        Number.isFinite(lng) &&
        Math.abs(lng) <= 180
    );
}

/** Keep only recognised modes, de-duped and in canonical order so the
 *  cache key is stable regardless of client ordering. Empty / absent
 *  → all modes (the planner is unconstrained). */
function normaliseModes(modes: TravelMode[] | undefined): TravelMode[] {
    if (!Array.isArray(modes) || modes.length === 0) return [...ALL_MODES];
    const set = new Set(modes.filter((m) => ALL_MODES.includes(m)));
    return ALL_MODES.filter((m) => set.has(m));
}

function jsonResponse(
    body: unknown,
    status: number,
    cors: HeadersInit,
    cacheState?: string,
): Response {
    const headers: Record<string, string> = {
        ...corsAsObject(cors),
        "Content-Type": "application/json",
    };
    if (cacheState) headers["X-Cache"] = cacheState;
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
