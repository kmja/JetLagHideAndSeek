/**
 * Overpass-boundary R2 cache worker.
 *
 * Request path: GET /api/interpreter?data=<URL-encoded Overpass QL>
 * — the exact same shape as `overpass-api.de/api/interpreter`, so
 * the seeker app can swap this URL into its mirror chain without
 * changing query construction.
 *
 * Lookup order on a request:
 *   1. Cloudflare edge cache (Cache API) — free, ephemeral, fast.
 *   2. R2 bucket keyed by SHA-256 of the query string — durable,
 *      warm even after the edge cache evicts.
 *   3. Upstream fetch via the same 3-mirror chain the seeker app
 *      used to use directly (overpass-api.de → private.coffee →
 *      kumi.systems). First mirror with a 200 response wins.
 *
 * On a fresh upstream fetch we write the body back into R2 (with
 * `cachedAt` metadata) and seed the edge cache so subsequent
 * identical requests skip the upstream entirely. Stale-while-error:
 * if every upstream mirror fails, we serve the most recent R2 copy
 * — even past the configured TTL — rather than 502ing the client.
 *
 * The scheduled cron iterates a curated list of major-city
 * relation ids (see cities.ts), processes `PREWARM_BATCH_SIZE` of
 * them per run, skips anything that's still fresh in R2, and
 * refreshes the rest. Over the course of a few weeks the whole
 * list cycles, so a real user picking any of those as a play area
 * hits warm cache on day one.
 */

import { POPULAR_CITIES, type CityEntry } from "./cities";

export interface Env {
    CACHE: R2Bucket;
    ALLOWED_ORIGINS: string;
    CACHE_TTL_DAYS: string;
    PREWARM_BATCH_SIZE: string;
}

const OVERPASS_MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
];

/** Per-attempt client-side timeout. Matches the in-browser
 *  default; keeps a hung mirror from pinning the whole chain. */
const UPSTREAM_TIMEOUT_MS = 45_000;

const CACHE_API_TTL_SECS = 24 * 60 * 60; // 24 h at the edge

export default {
    async fetch(
        request: Request,
        env: Env,
        ctx: ExecutionContext,
    ): Promise<Response> {
        const cors = corsHeaders(request, env);

        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: cors });
        }
        if (request.method !== "GET" && request.method !== "POST") {
            return new Response("Method not allowed", {
                status: 405,
                headers: cors,
            });
        }

        const url = new URL(request.url);

        // Health check / readiness probe — handy for Cloudflare
        // build verification and uptime monitoring.
        if (url.pathname === "/health") {
            return new Response("ok", {
                status: 200,
                headers: { ...cors, "Content-Type": "text/plain" },
            });
        }

        if (url.pathname !== "/api/interpreter") {
            return new Response("Not found", { status: 404, headers: cors });
        }

        // Overpass accepts the query either as `?data=…` (GET)
        // or as a urlencoded body (POST). Normalize to the GET
        // form so the R2 key is stable.
        let query: string | null = null;
        if (request.method === "GET") {
            query = url.searchParams.get("data");
        } else {
            const body = await request.text();
            const params = new URLSearchParams(body);
            query = params.get("data");
        }
        if (!query) {
            return new Response("Missing 'data' parameter", {
                status: 400,
                headers: cors,
            });
        }

        const cacheKey = await r2KeyForQuery(query);
        const ttlMs =
            (parseInt(env.CACHE_TTL_DAYS, 10) || 30) *
            24 *
            60 *
            60 *
            1000;

        // Step 1 — edge cache (Cloudflare's per-colo Cache API). A
        // hit here is ~1 ms; a miss costs nothing. We use a
        // normalized GET URL as the cache key so different query
        // encodings still match.
        const cacheApiKey = new Request(
            `${url.origin}/api/interpreter?data=${encodeURIComponent(query)}`,
            { method: "GET" },
        );
        const edgeCache = caches.default;
        const edgeHit = await edgeCache.match(cacheApiKey);
        if (edgeHit) {
            return appendCacheStatus(edgeHit, cors, "EDGE_HIT");
        }

        // Step 2 — R2. Read metadata first so we can decide fresh
        // vs stale without buffering the body. R2 returns the body
        // as a stream which we can re-emit directly.
        const r2Hit = await env.CACHE.get(`overpass/${cacheKey}`);
        if (r2Hit) {
            const cachedAt = parseInt(
                r2Hit.customMetadata?.cachedAt ?? "0",
                10,
            );
            const age = Date.now() - cachedAt;
            if (cachedAt && age < ttlMs) {
                const fresh = buildResponse(r2Hit.body, cors, "R2_HIT", age);
                ctx.waitUntil(edgeCache.put(cacheApiKey, fresh.clone()));
                return fresh;
            }
            // Stale — fall through to refresh, but hang onto the
            // stale R2 hit for the "all upstreams failed" branch.
            const upstream = await fetchFromMirrorChain(query);
            if (upstream) {
                const upstreamBody = await upstream.text();
                ctx.waitUntil(
                    writeBackThroughCaches(
                        env,
                        ctx,
                        edgeCache,
                        cacheApiKey,
                        cacheKey,
                        upstreamBody,
                    ),
                );
                return buildJSONResponse(upstreamBody, cors, "MISS_REFRESH");
            }
            // Stale-while-error: every mirror was sad, serve the
            // expired copy. Client gets data back; logs flag this
            // as STALE so monitoring can pick it up.
            const stale = buildResponse(
                r2Hit.body,
                cors,
                "R2_STALE_FALLBACK",
                age,
            );
            return stale;
        }

        // Step 3 — full miss. Fetch upstream, persist, return.
        const upstream = await fetchFromMirrorChain(query);
        if (!upstream) {
            return new Response(
                JSON.stringify({
                    error: "All Overpass mirrors are currently unavailable.",
                }),
                {
                    status: 502,
                    headers: {
                        ...cors,
                        "Content-Type": "application/json",
                    },
                },
            );
        }
        const upstreamBody = await upstream.text();
        ctx.waitUntil(
            writeBackThroughCaches(
                env,
                ctx,
                edgeCache,
                cacheApiKey,
                cacheKey,
                upstreamBody,
            ),
        );
        return buildJSONResponse(upstreamBody, cors, "MISS");
    },

    /**
     * Weekly cron — pre-warm the curated cities list. Cycles
     * through `POPULAR_CITIES` PREWARM_BATCH_SIZE at a time so
     * each city gets refreshed roughly once every
     * `cities.length / batch` weeks. Random shuffle each run so
     * no city is permanently last in line.
     */
    async scheduled(
        _event: ScheduledEvent,
        env: Env,
        ctx: ExecutionContext,
    ): Promise<void> {
        const batch = parseInt(env.PREWARM_BATCH_SIZE, 10) || 5;
        const ttlMs =
            (parseInt(env.CACHE_TTL_DAYS, 10) || 30) *
            24 *
            60 *
            60 *
            1000;
        const shuffled = [...POPULAR_CITIES].sort(() => Math.random() - 0.5);
        const picked = shuffled.slice(0, batch);
        for (const city of picked) {
            try {
                await prewarmCity(env, ctx, city, ttlMs);
            } catch (e) {
                console.warn(
                    `Prewarm failed for ${city.name} (${city.relationId}):`,
                    e,
                );
            }
        }
    },
};

/* ─────────────────────── Fetch helpers ─────────────────────── */

async function fetchFromMirrorChain(query: string): Promise<Response | null> {
    const encoded = encodeURIComponent(query);
    for (const base of OVERPASS_MIRRORS) {
        const url = `${base}?data=${encoded}`;
        try {
            const controller = new AbortController();
            const timer = setTimeout(
                () => controller.abort(),
                UPSTREAM_TIMEOUT_MS,
            );
            const resp = await fetch(url, {
                method: "GET",
                signal: controller.signal,
                // No `cf.cacheTtl` here — we manage caching
                // ourselves via R2 / Cache API so the client gets
                // consistent X-Cache headers regardless of edge
                // pop state.
            });
            clearTimeout(timer);
            if (resp.ok) return resp;
            console.warn(
                `Upstream ${base} returned ${resp.status} ${resp.statusText}`,
            );
        } catch (e) {
            console.warn(`Upstream ${base} threw:`, e);
        }
    }
    return null;
}

async function prewarmCity(
    env: Env,
    ctx: ExecutionContext,
    city: CityEntry,
    ttlMs: number,
): Promise<void> {
    const query = `[out:json][timeout:120];relation(${city.relationId});out geom;`;
    const cacheKey = await r2KeyForQuery(query);
    const r2Hit = await env.CACHE.get(`overpass/${cacheKey}`);
    if (r2Hit) {
        const cachedAt = parseInt(r2Hit.customMetadata?.cachedAt ?? "0", 10);
        if (cachedAt && Date.now() - cachedAt < ttlMs) {
            // Already fresh — nothing to do.
            return;
        }
    }
    const upstream = await fetchFromMirrorChain(query);
    if (!upstream) {
        console.warn(`Prewarm: every mirror failed for ${city.name}`);
        return;
    }
    const body = await upstream.text();
    await env.CACHE.put(`overpass/${cacheKey}`, body, {
        customMetadata: {
            cachedAt: String(Date.now()),
            sizeBytes: String(body.length),
            sourceName: city.name,
            sourceRelationId: String(city.relationId),
            prewarmed: "true",
        },
    });
    console.log(
        `Prewarmed ${city.name} (${city.relationId}) — ${body.length} bytes`,
    );
}

async function writeBackThroughCaches(
    env: Env,
    _ctx: ExecutionContext,
    edgeCache: Cache,
    cacheApiKey: Request,
    cacheKey: string,
    body: string,
): Promise<void> {
    try {
        await env.CACHE.put(`overpass/${cacheKey}`, body, {
            customMetadata: {
                cachedAt: String(Date.now()),
                sizeBytes: String(body.length),
            },
        });
    } catch (e) {
        console.warn("R2 put failed:", e);
    }
    try {
        const edgeResp = new Response(body, {
            headers: {
                "Content-Type": "application/json",
                "Cache-Control": `public, max-age=${CACHE_API_TTL_SECS}`,
            },
        });
        await edgeCache.put(cacheApiKey, edgeResp);
    } catch (e) {
        console.warn("Edge cache put failed:", e);
    }
}

/* ─────────────────────── Response builders ─────────────────────── */

function buildJSONResponse(
    body: string,
    cors: HeadersInit,
    status: string,
): Response {
    return new Response(body, {
        status: 200,
        headers: {
            ...corsHeadersAsObject(cors),
            "Content-Type": "application/json",
            "Cache-Control": `public, max-age=${CACHE_API_TTL_SECS}`,
            "X-Cache": status,
        },
    });
}

function buildResponse(
    body: ReadableStream<Uint8Array> | null,
    cors: HeadersInit,
    status: string,
    ageMs: number,
): Response {
    return new Response(body, {
        status: 200,
        headers: {
            ...corsHeadersAsObject(cors),
            "Content-Type": "application/json",
            "Cache-Control": `public, max-age=${CACHE_API_TTL_SECS}`,
            "X-Cache": status,
            "X-Cache-Age-Ms": String(ageMs),
        },
    });
}

function appendCacheStatus(
    resp: Response,
    cors: HeadersInit,
    status: string,
): Response {
    const headers = new Headers(resp.headers);
    for (const [k, v] of Object.entries(corsHeadersAsObject(cors))) {
        headers.set(k, v);
    }
    headers.set("X-Cache", status);
    return new Response(resp.body, {
        status: resp.status,
        statusText: resp.statusText,
        headers,
    });
}

/* ─────────────────────── CORS ─────────────────────── */

function corsHeaders(request: Request, env: Env): HeadersInit {
    const origin = request.headers.get("Origin");
    const allowed = (env.ALLOWED_ORIGINS || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    const allow =
        origin && allowed.includes(origin) ? origin : allowed[0] ?? "*";
    return {
        "Access-Control-Allow-Origin": allow,
        "Vary": "Origin",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
    };
}

function corsHeadersAsObject(h: HeadersInit): Record<string, string> {
    if (h instanceof Headers) {
        const o: Record<string, string> = {};
        h.forEach((v, k) => (o[k] = v));
        return o;
    }
    if (Array.isArray(h)) return Object.fromEntries(h);
    return { ...h } as Record<string, string>;
}

/* ─────────────────────── Cache keys ─────────────────────── */

/** Stable R2 key for an Overpass query. SHA-256 over the raw
 *  query string so identical queries always hash identically.
 *  We do NOT normalize whitespace — Overpass treats it as
 *  significant in some directives. */
async function r2KeyForQuery(query: string): Promise<string> {
    const bytes = new TextEncoder().encode(query);
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(hash))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}
