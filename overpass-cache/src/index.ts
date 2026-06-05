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
import type { Env } from "./envTypes";
import { handleJourneyArrivals } from "./journey";

const OVERPASS_MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
];

/** Per-attempt client-side timeout. Was 45 s (matching the
 *  browser-side default), but the Workers Free plan caps a
 *  single request at ~30 s wall clock, and we now race all
 *  three mirrors in parallel — so each individual attempt
 *  doesn't need a generous timeout. 20 s gets the fastest
 *  mirror's headers in well under the worker cap. */
const UPSTREAM_TIMEOUT_MS = 20_000;

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

        if (url.pathname === "/admin/prewarm") {
            return handleAdminPrewarm(request, env, ctx, cors);
        }
        if (url.pathname === "/admin/status") {
            return handleAdminStatus(request, env, cors);
        }
        if (url.pathname === "/api/journey/arrivals") {
            return handleJourneyArrivals(request, env, ctx, cors);
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
        // as a stream which we can re-emit directly. Wrapped in
        // try/catch: if the bucket binding errors (e.g. the bucket
        // doesn't exist yet on first-deploy accounts), don't bring
        // down the whole request — just treat as a cache miss and
        // fall through to upstream.
        let r2Hit: R2ObjectBody | null = null;
        try {
            r2Hit = await env.CACHE.get(`overpass/${cacheKey}`);
        } catch (e) {
            console.warn(
                "R2 get failed (bucket missing? falling through to upstream):",
                e,
            );
        }
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

/** Race all upstream mirrors in parallel. First mirror to
 *  return a 200 wins; all others get aborted so we don't waste
 *  upstream resources finishing their downloads. Falls back to
 *  null if every mirror errors or times out.
 *
 *  Why race instead of serial? The Workers Free plan caps each
 *  request at ~30 s wall clock. Serial (3 × 20 s = 60 s worst
 *  case) blows past that. Parallel resolves in max(per-mirror
 *  RTT) — typically 2–10 s when at least one mirror is healthy. */
async function fetchFromMirrorChain(query: string): Promise<Response | null> {
    const encoded = encodeURIComponent(query);
    const controllers = OVERPASS_MIRRORS.map(() => new AbortController());
    const timers: ReturnType<typeof setTimeout>[] = controllers.map((c) =>
        setTimeout(() => c.abort(), UPSTREAM_TIMEOUT_MS),
    );

    const attempts = OVERPASS_MIRRORS.map((base, i) =>
        fetch(`${base}?data=${encoded}`, {
            method: "GET",
            signal: controllers[i].signal,
        })
            .then((resp) => ({ idx: i, base, resp }))
            .catch((e) => {
                console.warn(`Upstream ${base} threw:`, e);
                return null as null;
            }),
    );

    return new Promise<Response | null>((resolve) => {
        let pending = attempts.length;
        let resolved = false;
        const finishWith = (winnerIdx: number | null, winner: Response | null) => {
            if (resolved) return;
            resolved = true;
            // Abort the LOSERS so they stop streaming, but leave
            // the winner's controller alone — we still need to
            // read its body downstream.
            for (let i = 0; i < controllers.length; i++) {
                if (i !== winnerIdx) controllers[i].abort();
            }
            for (let i = 0; i < timers.length; i++) {
                clearTimeout(timers[i]);
            }
            resolve(winner);
        };
        for (const a of attempts) {
            a.then((r) => {
                if (resolved) return;
                if (r && r.resp.ok) {
                    finishWith(r.idx, r.resp);
                } else {
                    if (r) {
                        console.warn(
                            `Upstream ${r.base} returned ${r.resp.status} ${r.resp.statusText}`,
                        );
                    }
                    if (--pending === 0) finishWith(null, null);
                }
            });
        }
    });
}

async function prewarmCity(
    env: Env,
    ctx: ExecutionContext,
    city: CityEntry,
    ttlMs: number,
): Promise<void> {
    await prewarmRelation(env, ctx, city.relationId, ttlMs, city.name);
}

/** Generic prewarm by raw OSM relation id. Used by both the
 *  weekly cron (via `prewarmCity`) and the admin bulk endpoint. */
async function prewarmRelation(
    env: Env,
    _ctx: ExecutionContext,
    relationId: number,
    ttlMs: number,
    sourceName?: string,
): Promise<
    | { status: "skipped-fresh"; ageMs: number }
    | { status: "stored"; sizeBytes: number }
    | { status: "upstream-failed" }
> {
    const query = `[out:json][timeout:120];relation(${relationId});out geom;`;
    const cacheKey = await r2KeyForQuery(query);
    let r2Hit: R2ObjectBody | null = null;
    try {
        r2Hit = await env.CACHE.get(`overpass/${cacheKey}`);
    } catch (e) {
        console.warn("R2 get failed during prewarm:", e);
    }
    if (r2Hit) {
        const cachedAt = parseInt(r2Hit.customMetadata?.cachedAt ?? "0", 10);
        const ageMs = Date.now() - cachedAt;
        if (cachedAt && ageMs < ttlMs) {
            return { status: "skipped-fresh", ageMs };
        }
    }
    const upstream = await fetchFromMirrorChain(query);
    if (!upstream) {
        return { status: "upstream-failed" };
    }
    const body = await upstream.text();
    try {
        await env.CACHE.put(`overpass/${cacheKey}`, body, {
            customMetadata: {
                cachedAt: String(Date.now()),
                sizeBytes: String(body.length),
                ...(sourceName ? { sourceName } : {}),
                sourceRelationId: String(relationId),
                prewarmed: "true",
            },
        });
    } catch (e) {
        console.warn("R2 put failed during prewarm:", e);
    }
    return { status: "stored", sizeBytes: body.length };
}

/* ─────────────────────── Admin endpoints ─────────────────────── */

interface AdminPrewarmRequest {
    /** OSM relation ids to fetch + store. Anything already fresh
     *  in R2 (< CACHE_TTL_DAYS old) is skipped, not refetched. */
    relationIds: number[];
    /** Optional parallel names, indexed the same as relationIds.
     *  Saved into R2 metadata for later auditing. */
    names?: string[];
    /** Per-id polite delay in ms. Defaults to 1500 (≈ 0.7 req/s)
     *  to stay well under Overpass's rate-limit guidance. */
    delayBetweenMs?: number;
}

async function handleAdminPrewarm(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
    cors: HeadersInit,
): Promise<Response> {
    if (request.method !== "POST") {
        return new Response("Method not allowed", {
            status: 405,
            headers: cors,
        });
    }
    if (!checkAdminAuth(request, env)) {
        return new Response("Unauthorized", { status: 401, headers: cors });
    }
    let payload: AdminPrewarmRequest;
    try {
        payload = (await request.json()) as AdminPrewarmRequest;
    } catch {
        return new Response("Invalid JSON body", {
            status: 400,
            headers: cors,
        });
    }
    if (
        !payload ||
        !Array.isArray(payload.relationIds) ||
        payload.relationIds.length === 0
    ) {
        return new Response("relationIds (non-empty array) is required", {
            status: 400,
            headers: cors,
        });
    }
    const ttlMs =
        (parseInt(env.CACHE_TTL_DAYS, 10) || 30) *
        24 *
        60 *
        60 *
        1000;
    const delay =
        typeof payload.delayBetweenMs === "number" &&
        payload.delayBetweenMs >= 0
            ? Math.min(payload.delayBetweenMs, 10_000)
            : 1500;
    const results: Array<{
        relationId: number;
        name?: string;
        status: string;
        sizeBytes?: number;
        ageMs?: number;
        durationMs: number;
    }> = [];
    for (let i = 0; i < payload.relationIds.length; i++) {
        const id = payload.relationIds[i];
        const name = payload.names?.[i];
        const t0 = Date.now();
        try {
            const result = await prewarmRelation(env, ctx, id, ttlMs, name);
            results.push({
                relationId: id,
                name,
                status: result.status,
                sizeBytes:
                    "sizeBytes" in result ? result.sizeBytes : undefined,
                ageMs: "ageMs" in result ? result.ageMs : undefined,
                durationMs: Date.now() - t0,
            });
        } catch (e) {
            results.push({
                relationId: id,
                name,
                status: "error",
                durationMs: Date.now() - t0,
            });
            console.warn(`Bulk prewarm error for ${id}:`, e);
        }
        if (i < payload.relationIds.length - 1 && delay > 0) {
            await new Promise((r) => setTimeout(r, delay));
        }
    }
    return new Response(JSON.stringify({ results }, null, 2), {
        status: 200,
        headers: { ...cors, "Content-Type": "application/json" },
    });
}

async function handleAdminStatus(
    request: Request,
    env: Env,
    cors: HeadersInit,
): Promise<Response> {
    if (!checkAdminAuth(request, env)) {
        return new Response("Unauthorized", { status: 401, headers: cors });
    }
    // R2 doesn't surface a cheap "count + total size" without
    // listing every key. Page through up to ~10k entries — fine
    // for our scale, and aborts early on bigger ones.
    let cursor: string | undefined = undefined;
    let count = 0;
    let totalBytes = 0;
    let prewarmedCount = 0;
    do {
        let page: R2Objects;
        try {
            page = await env.CACHE.list({
                prefix: "overpass/",
                cursor,
                limit: 1000,
                include: ["customMetadata"],
            });
        } catch (e) {
            return new Response(
                JSON.stringify(
                    {
                        error: "R2 list failed — bucket may not exist yet.",
                        details: e instanceof Error ? e.message : String(e),
                    },
                    null,
                    2,
                ),
                {
                    status: 503,
                    headers: { ...cors, "Content-Type": "application/json" },
                },
            );
        }
        for (const obj of page.objects) {
            count++;
            const sb = parseInt(
                obj.customMetadata?.sizeBytes ?? String(obj.size),
                10,
            );
            if (!isNaN(sb)) totalBytes += sb;
            if (obj.customMetadata?.prewarmed === "true") prewarmedCount++;
        }
        cursor = page.truncated ? page.cursor : undefined;
        if (count >= 10_000) break;
    } while (cursor);
    return new Response(
        JSON.stringify(
            {
                cachedEntries: count,
                totalBytes,
                prewarmedEntries: prewarmedCount,
                tooManyToCountExactly: count >= 10_000,
            },
            null,
            2,
        ),
        {
            status: 200,
            headers: { ...cors, "Content-Type": "application/json" },
        },
    );
}

function checkAdminAuth(request: Request, env: Env): boolean {
    if (!env.ADMIN_SECRET) return false;
    const got = request.headers.get("Authorization") || "";
    const expected = `Bearer ${env.ADMIN_SECRET}`;
    // Constant-time compare to avoid timing attacks on the secret.
    if (got.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < got.length; i++) {
        diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
    }
    return diff === 0;
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

/** Match an Origin against the ALLOWED_ORIGINS list. Same
 *  glob semantics as the multiplayer worker — entries with `*`
 *  are converted to a regex (`*` → `[^/]*`) so a single
 *  pattern can cover both the production hostname and
 *  Cloudflare's per-branch preview URLs. */
function originMatches(origin: string, patterns: string[]): boolean {
    for (const p of patterns) {
        if (p === "*") return true;
        if (!p.includes("*")) {
            if (p === origin) return true;
            continue;
        }
        const re =
            "^" +
            p
                .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
                .replace(/\*/g, "[^/]*") +
            "$";
        if (new RegExp(re).test(origin)) return true;
    }
    return false;
}

function corsHeaders(request: Request, env: Env): HeadersInit {
    const origin = request.headers.get("Origin");
    const allowed = (env.ALLOWED_ORIGINS || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    const allow =
        origin && originMatches(origin, allowed)
            ? origin
            : allowed[0] ?? "*";
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
