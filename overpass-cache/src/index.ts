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

import {
    appendDiscoveredCities,
    type CityEntry,
    getPopularCities,
    missingExtentRelations,
    repairBogusDiscoveredEntries,
    unresolvedCandidates,
    upsertDiscoveredCity,
} from "./cities";
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

/* ───────────────── Upstream load control ─────────────────
 *
 * The cache only fills if upstream fetches succeed — and they were
 * failing because the client fires a burst of distinct category
 * queries at game start, each of which had the worker race all three
 * public mirrors with no coordination. 14 queries × 3 mirrors = 42
 * near-simultaneous hits from the worker's single egress IP, which
 * the mirrors answer with an instant 429. Every query 502'd, nothing
 * got written to R2, and the next game repeated the cycle.
 *
 * Two module-level guards (state persists per isolate across
 * requests) tame that:
 *
 *   1. A counting semaphore caps how many upstream mirror-races run
 *      at once, converting the thundering herd into a polite trickle.
 *   2. An in-flight map coalesces concurrent requests for the SAME
 *      query (duplicate matching taps, React strict-mode double
 *      fires, two seekers on the same play area) onto a single
 *      upstream fetch + single R2 write.
 */

/** Max concurrent upstream mirror-races across the whole isolate.
 *  4 races × 3 mirrors = 12 concurrent connections — a big cut from
 *  the unbounded herd, low enough to stay under the mirrors' per-IP
 *  rate limit, high enough that the queue drains well inside the
 *  ~30 s Workers wall-clock budget. */
const MAX_CONCURRENT_UPSTREAM = 4;

/** A minimal fair counting semaphore. `run` acquires a slot, awaits
 *  `fn`, then hands the slot directly to the next waiter (no
 *  decrement-then-reincrement gap, so the active count can never
 *  overshoot `max`). */
class Semaphore {
    private active = 0;
    private readonly queue: Array<() => void> = [];
    constructor(private readonly max: number) {}
    async run<T>(fn: () => Promise<T>): Promise<T> {
        await this.acquire();
        try {
            return await fn();
        } finally {
            this.release();
        }
    }
    private async acquire(): Promise<void> {
        if (this.active < this.max) {
            this.active++;
            return;
        }
        await new Promise<void>((res) => this.queue.push(res));
        // A slot was handed to us by release(); `active` already
        // counts us, so we don't increment here.
    }
    private release(): void {
        const next = this.queue.shift();
        if (next) {
            // Transfer our slot straight to the next waiter; the
            // active count stays the same.
            next();
        } else {
            this.active--;
        }
    }
}

const upstreamSemaphore = new Semaphore(MAX_CONCURRENT_UPSTREAM);

/** Coalesce concurrent upstream fetches for the same R2 cache key.
 *  Keyed by cacheKey → in-flight Promise of the response body (or
 *  null on total failure). Cleared in the `finally` once the fetch
 *  and its R2 write-back finish. */
const inFlightUpstream = new Map<string, Promise<string | null>>();


export default {
    async fetch(
        request: Request,
        env: Env,
        ctx: ExecutionContext,
    ): Promise<Response> {
        const cors = corsHeaders(request, env);
        // Top-level guard: NOTHING below may produce a response without
        // CORS headers. A bare throw here would otherwise surface in the
        // browser as "CORS Missing Allow Origin" with whatever status
        // Cloudflare slaps on (often a 404/500 from the default error
        // page), masking the real failure and blocking the client from
        // even reading the error body. Catch everything and re-emit with
        // CORS so the frontend can fail over cleanly to a public mirror.
        try {
            return await handleRequest(request, env, ctx, cors);
        } catch (e) {
            console.error("[overpass-cache] unhandled error:", e);
            return new Response(
                JSON.stringify({
                    error: "Cache worker error",
                    detail: e instanceof Error ? e.message : String(e),
                }),
                {
                    status: 500,
                    headers: { ...cors, "Content-Type": "application/json" },
                },
            );
        }
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
        const batch = parseInt(env.PREWARM_BATCH_SIZE, 10) || 20;
        const ttlMs =
            (parseInt(env.CACHE_TTL_DAYS, 10) || 30) *
            24 *
            60 *
            60 *
            1000;
        // Discovery pass first: resolve up to 10 names from the
        // bundled candidate list against Photon (1 req/s = ~10s of
        // wall clock), append to R2. The bulk-city-names list grew
        // to ~1350 entries; hourly cron × 10/run drains the backlog
        // in ~6 days even from cold. The remaining ~20 s of the
        // scheduled budget goes to the prewarm pass below.
        try {
            const discovered = await discoverCandidates(env, 10);
            if (discovered.length > 0) {
                console.log(
                    `[discover] +${discovered.length}: ${discovered
                        .map((d) => d.name)
                        .join(", ")}`,
                );
            }
        } catch (e) {
            console.warn("Discovery pass failed:", e);
        }
        // Repair pass: a previous version of this cron called
        // `resolveNameViaPhoton(name)` to backfill extents on bare
        // names like "Stockholm". Photon's first relation match for
        // an ambiguous name is whichever it sorts first — for
        // "Stockholm" that's the village in Maine, not the city in
        // Sweden. So the discovered-cities R2 doc accumulated entries
        // with wrong relationIds and wrong extents, on TOP of the
        // perfectly-good HAND_CURATED entries. Wipe any discovered
        // entry whose name (case-insensitive, first-comma-trimmed)
        // collides with a HAND_CURATED or BULK_CITIES name but whose
        // relationId does NOT match the bundled canonical id. Safe to
        // run every tick — if there's nothing to repair, it's a no-op.
        try {
            const repaired = await repairBogusDiscoveredEntries(env);
            if (repaired > 0) {
                console.log(`[repair] removed ${repaired} bogus discovered entries`);
            }
        } catch (e) {
            console.warn("Repair pass failed:", e);
        }
        // Backfill pass: legacy entries are missing the `extent`
        // field, which makes the reference + HSR prewarms skip them.
        // We compute the extent directly from polygons.openstreetmap.fr
        // using the EXISTING relationId — no Photon involved, so
        // there's no name-ambiguity surface. ~3-5 relations per tick
        // (each takes ~500-1500 ms once polygons.osm.fr has the
        // polygon cached) keeps the wall budget free for the prewarm
        // pass below.
        try {
            const missing = await missingExtentRelations(env, 5);
            for (const entry of missing) {
                try {
                    const extent = await bboxFromRelation(entry.relationId);
                    if (extent) {
                        await upsertDiscoveredCity(env, {
                            name: entry.name,
                            relationId: entry.relationId,
                            extent,
                        });
                    }
                } catch (e) {
                    console.warn(
                        `Backfill failed for "${entry.name}" (r${entry.relationId}):`,
                        e,
                    );
                }
            }
            if (missing.length > 0) {
                console.log(
                    `[backfill] computed extents for ${missing.length} relation(s) via polygons.osm.fr`,
                );
            }
        } catch (e) {
            console.warn("Backfill pass failed:", e);
        }
        const cities = await getPopularCities(env);
        const shuffled = [...cities].sort(() => Math.random() - 0.5);
        const picked = shuffled.slice(0, batch);
        for (const city of picked) {
            try {
                // 1. Boundary polygon — the play-area outline. Always
                //    done; this is the original cron job.
                await prewarmCity(env, ctx, city, ttlMs);
                // 2. Per-city reference cache — museums / hospitals /
                //    airports / brand shops / train stations. ONE
                //    combined Overpass query keyed on the city's
                //    Photon bbox + 50 km pad; the result lands on the
                //    same R2 key the client's combined prefetch will
                //    request, so the client never touches Overpass for
                //    that city's references either. Silently skipped
                //    when the city entry is missing the extent field
                //    (legacy pre-v193 entries — the discovery pass
                //    backfills them in the same cron tick).
                if (city.extent) {
                    await prewarmReferencesForCity(env, city, ttlMs);
                    // 3. High-speed rail — `out geom` over a wider
                    //    bbox (sparse network). Same R2 key the client
                    //    HSR lookup hits.
                    await prewarmHsrForCity(env, city, ttlMs);
                }
            } catch (e) {
                console.warn(
                    `Prewarm failed for ${city.name} (${city.relationId}):`,
                    e,
                );
            }
        }
    },
};

/**
 * Core request handler. Extracted from the `fetch` export so the
 * thin wrapper above can guarantee CORS headers on every response —
 * including on an unexpected throw, which would otherwise reach the
 * browser as a CORS-less 4xx/5xx and read as "CORS Missing Allow
 * Origin".
 */
async function handleRequest(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
    cors: HeadersInit,
): Promise<Response> {
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
        if (url.pathname === "/admin/trigger-prewarm") {
            return handleAdminTriggerPrewarm(request, env, ctx, cors);
        }
        if (url.pathname === "/admin/discover") {
            return handleAdminDiscover(request, env, cors);
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
            // Stale — fall through to refresh (coalesced + rate-
            // limited), but hang onto the stale R2 hit for the "all
            // upstreams failed" branch.
            const upstreamBody = await fetchAndCacheUpstream(
                env,
                ctx,
                edgeCache,
                cacheApiKey,
                cacheKey,
                query,
            );
            if (upstreamBody !== null) {
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

        // Step 3 — full miss. Fetch upstream (coalesced + rate-
        // limited), persist, return.
        const upstreamBody = await fetchAndCacheUpstream(
            env,
            ctx,
            edgeCache,
            cacheApiKey,
            cacheKey,
            query,
        );
        if (upstreamBody === null) {
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
        return buildJSONResponse(upstreamBody, cors, "MISS");
}

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

    // Large play-area polygons push the encoded query well past the
    // typical 8 KB GET URI cap on public Overpass mirrors (414 Request
    // URI Too Long). POST the data field as form-urlencoded body
    // instead — every Overpass mirror accepts that shape — once the
    // encoded query crosses a comfortable threshold. Short queries
    // keep the GET shape so requests stay observable in mirror logs.
    const URL_POST_THRESHOLD = 4000;
    const usePost = encoded.length > URL_POST_THRESHOLD;

    const attempts = OVERPASS_MIRRORS.map((base, i) =>
        (usePost
            ? fetch(base, {
                  method: "POST",
                  headers: {
                      "Content-Type": "application/x-www-form-urlencoded",
                  },
                  body: `data=${encoded}`,
                  signal: controllers[i].signal,
              })
            : fetch(`${base}?data=${encoded}`, {
                  method: "GET",
                  signal: controllers[i].signal,
              })
        )
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

/** One retry pass over the mirror chain. The common failure mode is
 *  a rate-limit storm where every mirror 429s in ~150 ms — a brief
 *  backoff then a second try usually clears it. We only retry when
 *  the first pass failed *fast* (a slow timeout failure means the
 *  mirrors are genuinely hung, and retrying would just burn the
 *  remaining wall-clock budget). */
async function fetchFromMirrorChainWithRetry(
    query: string,
): Promise<Response | null> {
    const t0 = Date.now();
    const first = await fetchFromMirrorChain(query);
    if (first) return first;
    if (Date.now() - t0 > 6000) return null;
    await new Promise((r) => setTimeout(r, 1200));
    return await fetchFromMirrorChain(query);
}

/**
 * Fetch a query upstream and write the result back through both
 * cache tiers — coalesced so concurrent callers for the same query
 * share one upstream round trip and one R2 write, and rate-limited
 * by the upstream semaphore so a burst of distinct queries doesn't
 * trip the public mirrors.
 *
 * The R2 write is awaited (not fire-and-forget) so the cache
 * actually fills — that's this worker's entire reason to exist, and
 * the symptom that started this was an empty bucket. Returns the
 * response body, or null if every mirror failed.
 */
function fetchAndCacheUpstream(
    env: Env,
    ctx: ExecutionContext,
    edgeCache: Cache,
    cacheApiKey: Request,
    cacheKey: string,
    query: string,
): Promise<string | null> {
    const existing = inFlightUpstream.get(cacheKey);
    if (existing) return existing;
    const p = (async () => {
        try {
            const upstream = await upstreamSemaphore.run(() =>
                fetchFromMirrorChainWithRetry(query),
            );
            if (!upstream) return null;
            const body = await upstream.text();
            await writeBackThroughCaches(
                env,
                ctx,
                edgeCache,
                cacheApiKey,
                cacheKey,
                body,
            );
            return body;
        } finally {
            inFlightUpstream.delete(cacheKey);
        }
    })();
    inFlightUpstream.set(cacheKey, p);
    return p;
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
    // Through the shared semaphore so a cron batch can't starve (or
    // be starved by) live request traffic on the same mirrors.
    const upstream = await upstreamSemaphore.run(() =>
        fetchFromMirrorChainWithRetry(query),
    );
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

/* ─────────────────────── Reference prewarm ─────────────────────── */

/**
 * Reference families the cron prewarms per-city. MUST stay byte-
 * identical to the client's standard list in
 * `src/maps/api/playAreaPrefetch.ts` — same `nwr[…]` filter strings,
 * sorted in the same order — because the R2 cache key is the SHA-256
 * of the full query string. Any divergence and the cron's lovingly
 * pre-warmed entries silently miss the client's cache.
 *
 * Order is alphabetical by family key, matching the client's
 * `families.sort()` call before query construction.
 */
const REFERENCE_FAMILY_FILTERS: { family: string; filter: string }[] = [
    { family: "airport", filter: '["aeroway"="aerodrome"]["iata"]' },
    { family: "api:aquarium", filter: '["tourism"="aquarium"]' },
    { family: "api:cinema", filter: '["amenity"="cinema"]' },
    { family: "api:consulate", filter: '["diplomatic"="consulate"]' },
    { family: "api:golf_course", filter: '["leisure"="golf_course"]' },
    { family: "api:hospital", filter: '["amenity"="hospital"]' },
    { family: "api:library", filter: '["amenity"="library"]' },
    { family: "api:museum", filter: '["tourism"="museum"]' },
    { family: "api:park", filter: '["leisure"="park"]' },
    { family: "api:peak", filter: '["natural"="peak"]' },
    { family: "api:theme_park", filter: '["tourism"="theme_park"]' },
    { family: "api:zoo", filter: '["tourism"="zoo"]' },
    { family: "brand:Q259340", filter: '["brand:wikidata"="Q259340"]' },
    { family: "brand:Q38076", filter: '["brand:wikidata"="Q38076"]' },
    { family: "rail-station", filter: '["railway"="station"]' },
];
const PAD_KM = 50;
/** HSR uses a wider pad than the point references because the network
 *  is sparse. MUST match HSR_PAD_KM in src/maps/api/playAreaPrefetch.ts. */
const HSR_PAD_KM = 100;

/** Build the `[bbox:s,w,n,e]` filter from a Photon extent + pad,
 *  formatted EXACTLY as the client's `buildPaddedBboxFilter` does
 *  (3-decimal coordinates). The R2 cache key hashes the full query
 *  string, so any formatting drift diverges client and cron. */
function buildBboxFilter(
    extent: [number, number, number, number],
    padKm: number,
): string {
    // Photon extent: [maxLat, minLng, minLat, maxLng]
    const [maxLat, minLng, minLat, maxLng] = extent;
    const south = minLat;
    const west = minLng;
    const north = maxLat;
    const east = maxLng;
    const latPad = padKm / 111;
    const midLat = (south + north) / 2;
    const lngPad = padKm / (111 * Math.cos((midLat * Math.PI) / 180));
    const s = (south - latPad).toFixed(3);
    const w = (west - lngPad).toFixed(3);
    const n = (north + latPad).toFixed(3);
    const e = (east + lngPad).toFixed(3);
    return `[bbox:${s},${w},${n},${e}]`;
}

/**
 * Build the EXACT reference-prefetch query string the client emits.
 * Whitespace, ordering, and numeric formatting all matter — mirrors
 * `runBboxOverpassFetch` in src/maps/api/playAreaPrefetch.ts.
 */
function buildReferenceBboxQuery(
    extent: [number, number, number, number],
): string {
    const bboxFilter = buildBboxFilter(extent, PAD_KM);
    const body = REFERENCE_FAMILY_FILTERS.map(
        ({ filter }) => `nwr${filter};`,
    ).join("\n");
    return `
[out:json][timeout:120]${bboxFilter};
(
${body}
);
out center;
`;
}

/** HSR query — byte-identical to `buildHsrBboxQuery` in
 *  src/maps/api/playAreaPrefetch.ts. */
function buildHsrBboxQuery(
    extent: [number, number, number, number],
): string {
    const bboxFilter = buildBboxFilter(extent, HSR_PAD_KM);
    return `
[out:json][timeout:120]${bboxFilter};
way["railway"="rail"]["highspeed"="yes"];
out geom;
`;
}

/**
 * Prewarm an arbitrary Overpass query into R2, keyed on the same
 * SHA-256 hash of the query string the client computes. Skips the
 * upstream fetch when a fresh entry already exists. Shared by the
 * per-city reference prewarm and the HSR prewarm — the only thing
 * that differs between them is the query string and the metadata
 * `kind` tag.
 */
async function prewarmQuery(
    env: Env,
    query: string,
    city: CityEntry,
    ttlMs: number,
    kind: string,
): Promise<{ status: string; ageMs?: number; sizeBytes?: number }> {
    const cacheKey = await r2KeyForQuery(query);
    let r2Hit: R2ObjectBody | null = null;
    try {
        r2Hit = await env.CACHE.get(`overpass/${cacheKey}`);
    } catch (e) {
        console.warn(`R2 get failed during ${kind} prewarm:`, e);
    }
    if (r2Hit) {
        const cachedAt = parseInt(
            r2Hit.customMetadata?.cachedAt ?? "0",
            10,
        );
        const ageMs = Date.now() - cachedAt;
        if (cachedAt && ageMs < ttlMs) {
            return { status: "skipped-fresh", ageMs };
        }
    }
    const upstream = await upstreamSemaphore.run(() =>
        fetchFromMirrorChainWithRetry(query),
    );
    if (!upstream) return { status: "upstream-failed" };
    const body = await upstream.text();
    try {
        await env.CACHE.put(`overpass/${cacheKey}`, body, {
            customMetadata: {
                cachedAt: String(Date.now()),
                sizeBytes: String(body.length),
                sourceName: city.name,
                sourceRelationId: String(city.relationId),
                prewarmed: "true",
                kind,
            },
        });
    } catch (e) {
        console.warn(`R2 put failed during ${kind} prewarm:`, e);
    }
    return { status: "stored", sizeBytes: body.length };
}

/** Per-city reference cache — one combined query covering every
 *  standard reference family (museums / hospitals / airports / …). */
async function prewarmReferencesForCity(
    env: Env,
    city: CityEntry,
    ttlMs: number,
): Promise<{ status: string }> {
    if (!city.extent) return { status: "skipped-no-extent" };
    return prewarmQuery(
        env,
        buildReferenceBboxQuery(city.extent),
        city,
        ttlMs,
        "references",
    );
}

/** Per-city high-speed-rail cache — `out geom` over the city's
 *  HSR-padded bbox. */
async function prewarmHsrForCity(
    env: Env,
    city: CityEntry,
    ttlMs: number,
): Promise<{ status: string }> {
    if (!city.extent) return { status: "skipped-no-extent" };
    return prewarmQuery(
        env,
        buildHsrBboxQuery(city.extent),
        city,
        ttlMs,
        "hsr",
    );
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

/**
 * Manual "run the cron right now" trigger. Picks the same kind of
 * random batch from POPULAR_CITIES that scheduled() would, but on
 * demand — kicked off from curl, the browser console, Postman, or the
 * Cloudflare dashboard tester. Useful when you want to fast-fill the
 * cache without waiting for tomorrow's cron, or when the cron is
 * disabled in a preview environment.
 *
 * Body (all optional):
 *   { "batch": 20, "delayBetweenMs": 1000 }
 *
 * Returns the same { results: [...] } shape the bulk endpoint does, so
 * callers can pipe the response straight into a log.
 */
async function handleAdminTriggerPrewarm(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
    cors: HeadersInit,
): Promise<Response> {
    if (request.method !== "POST" && request.method !== "GET") {
        return new Response("Method not allowed", {
            status: 405,
            headers: cors,
        });
    }
    if (!checkAdminAuth(request, env)) {
        return new Response("Unauthorized", { status: 401, headers: cors });
    }
    // Accept config either as a JSON POST body OR as query params on a
    // GET, so the operator can trigger this from a browser URL bar /
    // the Cloudflare dashboard's HTTP tester without needing curl.
    //   ?batch=60&delayBetweenMs=1000
    let payload: { batch?: number; delayBetweenMs?: number } = {};
    try {
        if (request.method === "GET") {
            const u = new URL(request.url);
            const b = u.searchParams.get("batch");
            const d = u.searchParams.get("delayBetweenMs");
            if (b) payload.batch = parseInt(b, 10);
            if (d) payload.delayBetweenMs = parseInt(d, 10);
        } else {
            const text = await request.text();
            if (text.trim()) payload = JSON.parse(text);
        }
    } catch {
        return new Response("Invalid JSON body", {
            status: 400,
            headers: cors,
        });
    }
    const batch =
        typeof payload.batch === "number" && payload.batch > 0
            ? Math.min(Math.floor(payload.batch), 100)
            : parseInt(env.PREWARM_BATCH_SIZE, 10) || 20;
    const delay =
        typeof payload.delayBetweenMs === "number" &&
        payload.delayBetweenMs >= 0
            ? Math.min(payload.delayBetweenMs, 10_000)
            : 1000;
    const ttlMs =
        (parseInt(env.CACHE_TTL_DAYS, 10) || 30) *
        24 *
        60 *
        60 *
        1000;
    const cities = await getPopularCities(env);
    const shuffled = [...cities].sort(() => Math.random() - 0.5);
    const picked = shuffled.slice(0, batch);
    const results: Array<{
        relationId: number;
        name?: string;
        status: string;
        sizeBytes?: number;
        ageMs?: number;
        durationMs: number;
    }> = [];
    for (let i = 0; i < picked.length; i++) {
        const city = picked[i];
        const t0 = Date.now();
        try {
            const r = await prewarmRelation(
                env,
                ctx,
                city.relationId,
                ttlMs,
                city.name,
            );
            results.push({
                relationId: city.relationId,
                name: city.name,
                status: r.status,
                sizeBytes:
                    "sizeBytes" in r ? r.sizeBytes : undefined,
                ageMs: "ageMs" in r ? r.ageMs : undefined,
                durationMs: Date.now() - t0,
            });
        } catch (e) {
            results.push({
                relationId: city.relationId,
                name: city.name,
                status: "error",
                durationMs: Date.now() - t0,
            });
            console.warn(
                `Trigger-prewarm error for ${city.name} (${city.relationId}):`,
                e,
            );
        }
        if (i < picked.length - 1 && delay > 0) {
            await new Promise((r) => setTimeout(r, delay));
        }
    }
    return new Response(
        JSON.stringify(
            {
                picked: picked.length,
                totalCandidates: cities.length,
                results,
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

/* ─────────────────────── Discovery ─────────────────────── */

const PHOTON_API = "https://photon.komoot.io/api/";

/** polygons.openstreetmap.fr fetches the pre-computed polygon for an
 *  OSM relation. We use it for two backfill jobs: computing the
 *  authoritative bbox for a known relation (no name ambiguity), and
 *  triggering a build for relations not yet computed. */
const POLYGONS_OSM_FR_GET =
    "https://polygons.openstreetmap.fr/get_geojson.py";

/**
 * Compute the bounding box of an OSM relation directly from its
 * polygon geometry via polygons.openstreetmap.fr. Deterministic —
 * the same relationId always produces the same bbox — so this is
 * what the backfill uses to add `extent` fields to HAND_CURATED
 * entries whose names alone are ambiguous on Photon ("Stockholm"
 * the city in Sweden vs the town in Maine). Returns null on any
 * failure or the "None" sentinel (relation not yet built).
 */
async function bboxFromRelation(
    relationId: number,
    timeoutMs = 8000,
): Promise<[number, number, number, number] | null> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let text: string;
    try {
        const resp = await fetch(
            `${POLYGONS_OSM_FR_GET}?id=${relationId}&params=0`,
            { method: "GET", signal: ctrl.signal },
        );
        if (!resp.ok) return null;
        text = await resp.text();
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
    const trimmed = text.trim();
    if (!trimmed || trimmed === "None" || trimmed.startsWith("<")) {
        return null;
    }
    let parsed: any;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        return null;
    }
    // Walk every Position pair to find the min/max lat/lng.
    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLng = Infinity;
    let maxLng = -Infinity;
    const consumeCoord = (lng: number, lat: number) => {
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
    };
    const visit = (node: any) => {
        if (!node) return;
        if (Array.isArray(node)) {
            // Leaf [lng, lat] vs nested coord array — detect by
            // checking if first two elements are numbers AND length
            // is 2 (or 3 incl. altitude).
            if (
                node.length >= 2 &&
                typeof node[0] === "number" &&
                typeof node[1] === "number"
            ) {
                consumeCoord(node[0], node[1]);
                return;
            }
            for (const child of node) visit(child);
            return;
        }
        if (node.geometry) visit(node.geometry);
        if (node.coordinates) visit(node.coordinates);
        if (Array.isArray(node.features)) {
            for (const f of node.features) visit(f);
        }
    };
    visit(parsed);
    if (
        !Number.isFinite(minLat) ||
        !Number.isFinite(maxLat) ||
        !Number.isFinite(minLng) ||
        !Number.isFinite(maxLng)
    ) {
        return null;
    }
    // Photon shape: [maxLat, minLng, minLat, maxLng].
    return [maxLat, minLng, minLat, maxLng];
}

/**
 * Resolve a "City, Country" string to an OSM relation ID via Photon.
 * Picks the first feature with `osm_type === "R"` — that's the
 * relation-shaped result, which is what every play-area boundary
 * fetch needs. Returns null when no relation result is found.
 */
async function resolveNameViaPhoton(
    name: string,
    timeoutMs = 8_000,
): Promise<{
    relationId: number;
    extent?: [number, number, number, number];
} | null> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const resp = await fetch(
            `${PHOTON_API}?q=${encodeURIComponent(name)}&limit=5`,
            { signal: ctrl.signal },
        );
        if (!resp.ok) return null;
        const data = (await resp.json()) as {
            features?: Array<{
                properties?: {
                    osm_type?: string;
                    osm_id?: number;
                    extent?: number[];
                };
            }>;
        };
        for (const f of data.features ?? []) {
            if (
                f.properties?.osm_type === "R" &&
                typeof f.properties.osm_id === "number" &&
                f.properties.osm_id > 0
            ) {
                // Photon's raw `extent` is [minLng, maxLat, maxLng, minLat]
                // (lng-major, NW corner first). The client side normalises
                // this on receipt to lat-major [maxLat, minLng, minLat, maxLng]
                // in src/maps/api/geocode.ts; we mirror that normalisation
                // here so a CityEntry's `extent` is bit-identical to what
                // the client carries on `mapGeoLocation.properties.extent`.
                let extent:
                    | [number, number, number, number]
                    | undefined;
                const raw = f.properties.extent;
                if (Array.isArray(raw) && raw.length === 4) {
                    const [minLng, maxLat, maxLng, minLat] = raw;
                    if (
                        [minLng, maxLat, maxLng, minLat].every((v) =>
                            Number.isFinite(v),
                        )
                    ) {
                        extent = [maxLat, minLng, minLat, maxLng];
                    }
                }
                return { relationId: f.properties.osm_id, extent };
            }
        }
        return null;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Process up to `limit` unresolved candidate names, rate-limited at
 * ~1 req/s to keep within Photon's free-tier expectations. Successful
 * resolutions are appended to the R2-stored discovered list. Returns
 * the newly added entries so callers can log them.
 */
async function discoverCandidates(
    env: Env,
    limit: number,
): Promise<CityEntry[]> {
    if (limit <= 0) return [];
    const todo = (await unresolvedCandidates(env)).slice(0, limit);
    const fresh: CityEntry[] = [];
    for (let i = 0; i < todo.length; i++) {
        const name = todo[i];
        try {
            const r = await resolveNameViaPhoton(name);
            if (r) {
                fresh.push({
                    name,
                    relationId: r.relationId,
                    extent: r.extent,
                });
            }
        } catch (e) {
            console.warn(`Photon resolve failed for "${name}":`, e);
        }
        // Photon courtesy delay; skip after the last item.
        if (i < todo.length - 1) {
            await new Promise((r) => setTimeout(r, 1000));
        }
    }
    if (fresh.length > 0) {
        await appendDiscoveredCities(env, fresh);
    }
    return fresh;
}

/**
 * `POST /admin/discover` — manual discovery trigger.
 *
 * Body (all optional):
 *   { "batch": 20 }              — process up to N unresolved names.
 *   { "names": ["...","..."] }   — resolve these specific strings
 *                                   instead of pulling from the
 *                                   bundled candidate list.
 *
 * With no body, defaults to batch=20. Each Photon hit is 1 req/s so a
 * batch of 20 finishes in ~20 s — safely under the worker's 30 s
 * wall-clock budget. Repeat the call until the backlog drains, or
 * just let the daily cron auto-drain it 5 names at a time.
 */
async function handleAdminDiscover(
    request: Request,
    env: Env,
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
    let payload: { batch?: number; names?: string[] } = {};
    try {
        const text = await request.text();
        if (text.trim()) payload = JSON.parse(text);
    } catch {
        return new Response("Invalid JSON body", {
            status: 400,
            headers: cors,
        });
    }
    let names: string[];
    if (Array.isArray(payload.names) && payload.names.length > 0) {
        names = payload.names
            .filter((n): n is string => typeof n === "string" && n.length > 0)
            .slice(0, 25);
    } else {
        const batch =
            typeof payload.batch === "number" && payload.batch > 0
                ? Math.min(Math.floor(payload.batch), 25)
                : 20;
        names = (await unresolvedCandidates(env)).slice(0, batch);
    }
    const fresh: CityEntry[] = [];
    const skipped: string[] = [];
    for (let i = 0; i < names.length; i++) {
        const name = names[i];
        try {
            const r = await resolveNameViaPhoton(name);
            if (r) {
                fresh.push({ name, relationId: r.relationId });
            } else {
                skipped.push(name);
            }
        } catch (e) {
            skipped.push(name);
            console.warn(`Photon resolve failed for "${name}":`, e);
        }
        if (i < names.length - 1) {
            await new Promise((r) => setTimeout(r, 1000));
        }
    }
    if (fresh.length > 0) {
        await appendDiscoveredCities(env, fresh);
    }
    const remaining = await unresolvedCandidates(env);
    return new Response(
        JSON.stringify(
            {
                attempted: names.length,
                resolved: fresh,
                skipped,
                stillUnresolved: remaining.length,
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
    // Primary path: Authorization: Bearer <secret> header.
    const header = request.headers.get("Authorization");
    if (header && constantTimeEqual(header, `Bearer ${env.ADMIN_SECRET}`)) {
        return true;
    }
    // Convenience path: `?secret=<secret>` query param, so the admin
    // endpoints can be triggered from a plain browser URL bar / phone
    // (which can't set request headers). Less secure — the secret
    // lands in browser history and any intermediary logs — so it's
    // intended for the occasional manual prewarm nudge, not automated
    // use. URL-encode the secret if it contains reserved characters.
    try {
        const param = new URL(request.url).searchParams.get("secret");
        if (param && constantTimeEqual(param, env.ADMIN_SECRET)) {
            return true;
        }
    } catch {
        /* malformed URL — fall through to deny */
    }
    return false;
}

/** Length-checked constant-time string compare. */
function constantTimeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
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
