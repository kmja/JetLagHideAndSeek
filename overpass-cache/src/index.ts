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
    parkNames,
    recordFailedResolves,
    removeDiscoveredByRelationId,
    repairBogusDiscoveredEntries,
    unresolvedCandidates,
    upsertDiscoveredCity,
} from "./cities";
import type { Env } from "./envTypes";
import { handleJourneyArrivals } from "./journey";

/**
 * Public Overpass mirrors we race for non-boundary queries.
 *
 * Down to ONE: overpass-api.de. v200's /admin/diagnose run revealed
 * that `overpass.private.coffee` and `overpass.kumi.systems` both
 * hang past our 15-20 s timeout — not "rate-limited," "hung." So
 * they were eating a race slot AND the timeout budget for nothing.
 * The remaining mirror returns 200 OK in 1-2 s when not throttled.
 *
 * If either of the dropped mirrors comes back online (or someone
 * else's mirror enters wide use), re-add it here — the race code
 * scales to any number of entries.
 */
const OVERPASS_MIRRORS = [
    "https://overpass-api.de/api/interpreter",
];

/** Per-attempt client-side timeout. Bumped 20 s → 60 s in v205
 *  because the batched reference + HSR queries hit 20 s server-side
 *  budget on the v204 test run and got killed by the worker before
 *  Overpass could finish. 60 s comfortably covers a 5-city × 11-
 *  family unioned query (the worst case we send) while still
 *  bounding any one stuck mirror to a minute. The query string
 *  itself asks for [timeout:180] server-side, so this is just our
 *  patience on top of that. Boundary queries respond in 1-5 s and
 *  never get near this. */
const UPSTREAM_TIMEOUT_MS = 60_000;

const CACHE_API_TTL_SECS = 24 * 60 * 60; // 24 h at the edge

/**
 * User-Agent we send on every upstream fetch from this worker. OSM
 * ecosystem services (Overpass mirrors, polygons.osm.fr, Photon)
 * explicitly ask for a meaningful UA identifying the application —
 * their usage policies cite anonymous / default UAs as grounds for
 * rate-limiting or outright blocking. The Workers runtime's default
 * UA looked like "Mozilla/5.0 ... Cloudflare-Workers" which is the
 * sort of thing rate-limiters love to add to their drop list.
 *
 * Including a contact URL gives an operator a place to complain (or
 * grant us a higher quota) before reaching for the block button.
 */
const USER_AGENT =
    "jetlaghideandseek-cache/1.0 (https://github.com/kmja/jetlaghideandseek)";

/** Convenience: outbound fetch with our identifying User-Agent
 *  merged into the headers. Use everywhere we hit a public service
 *  from this worker — single chokepoint so a future UA tweak
 *  doesn't have to thread through a dozen call sites. */
function ufetch(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (!headers.has("User-Agent")) headers.set("User-Agent", USER_AGENT);
    return fetch(url, { ...init, headers });
}

/* ─────────────────── Overpass slot coordination ─────────────────── *
 *
 * overpass-api.de gives each client IP a small pool of concurrent
 * execution slots. When they're all busy, your next query returns 429
 * — and bursting through the 429 just keeps the slots pinned. The
 * server's `/api/status` endpoint reports both how many slots are free
 * right now AND when each in-flight slot will free up, so we can
 * sleep exactly long enough to land on a free slot every time.
 *
 * Used by the cron only — live request paths can't afford to wait
 * 25 s and need to fail fast so the seeker app falls back to its
 * stale-R2 / error UI. Direct port of the same logic the laptop
 * prewarmer uses (scripts/laptop-prewarm.mjs).
 *
 * Response shape (plain text):
 *   Connected as: 1234567890
 *   Rate limit: 6
 *   2 slots available now.
 *   Slot available after: …, in 10 seconds.
 *   Slot available after: …, in 25 seconds.
 */

const OVERPASS_STATUS_URL = "https://overpass-api.de/api/status";

/** If the next free slot is more than this many milliseconds away,
 *  bail out of the wait and skip this batch — the cron tick will
 *  catch the work next hour. Keeps a busy/wedged Overpass from
 *  burning the entire cron wall budget on a single sleep. */
const SLOT_WAIT_MAX_MS = 30_000;

async function fetchOverpassStatus(): Promise<string | null> {
    try {
        const resp = await ufetch(OVERPASS_STATUS_URL, { method: "GET" });
        if (!resp.ok) return null;
        return await resp.text();
    } catch {
        return null;
    }
}

/** Block until overpass-api.de reports at least one free execution
 *  slot, or give up (return false) if the wait would be too long.
 *  Returns true when a slot is available and we should proceed with
 *  the upstream call. */
async function waitForOverpassSlot(label: string): Promise<boolean> {
    for (let attempt = 0; attempt < 6; attempt++) {
        const status = await fetchOverpassStatus();
        if (!status) {
            // /api/status itself unreachable. Could be a transient
            // blip or genuine downtime — sleep briefly and try once
            // more; if still down, just let the caller proceed (they
            // can race the upstream call and fail fast on their own).
            if (attempt >= 1) {
                console.warn(
                    `[slot] ${label}: /api/status unreachable twice, proceeding blind`,
                );
                return true;
            }
            await new Promise((r) => setTimeout(r, 3000));
            continue;
        }
        const m = status.match(/(\d+)\s+slots available now/i);
        const available = m ? parseInt(m[1], 10) : 0;
        if (available > 0) {
            if (attempt > 0) {
                console.log(`[slot] ${label}: slot free, proceeding`);
            }
            return true;
        }
        const waits = [...status.matchAll(/in\s+(\d+)\s+seconds?/gi)].map(
            (m) => parseInt(m[1], 10),
        );
        const nextFreeSec = waits.length > 0 ? Math.min(...waits) : 15;
        const waitMs = (nextFreeSec + 1) * 1000;
        if (waitMs > SLOT_WAIT_MAX_MS) {
            console.warn(
                `[slot] ${label}: next slot ${nextFreeSec}s away (> ${SLOT_WAIT_MAX_MS / 1000}s cap), skipping`,
            );
            return false;
        }
        console.log(`[slot] ${label}: 0 free, waiting ${nextFreeSec + 1}s`);
        await new Promise((r) => setTimeout(r, waitMs));
    }
    console.warn(`[slot] ${label}: gave up after 6 attempts`);
    return false;
}

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
/** Max concurrent upstream fetches across the whole isolate.
 *  Dropped from 4 to 2 in v198 — the primary upstream is now
 *  polygons.openstreetmap.fr, a community service with much
 *  stricter per-IP throttling than the public Overpass mirrors I
 *  originally sized this for. With 2 concurrent, a batch of 60
 *  paces at roughly 1 req/s, which polygons.osm.fr tolerates
 *  steadily across an hour. 4 was bursting them into 429s. */
const MAX_CONCURRENT_UPSTREAM = 2;

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
     *
     * Pacing: previously a blind 4 s sleep between batches plus a
     * 6 s pause between phases. v213 replaces that with slot
     * coordination via overpass-api.de's /api/status — each batch
     * waits exactly long enough to land on a free execution slot
     * (often zero, occasionally 10-25 s). Faster when the server's
     * idle, gentler when it's busy, never 429'd.
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

        // Phase 1: BOUNDARIES, batched.
        // The old per-city loop fired one Overpass query per city,
        // so 10 cities = 10 hits on overpass-api.de in quick
        // succession — exactly the burst that trips their per-IP
        // rate limit. v202 collapses each group of
        // BOUNDARY_BATCH_SIZE cities into ONE unioned
        // `relation(N1);relation(N2);…;out geom;` query and splits
        // the response back into per-relation R2 entries. Same
        // boundary coverage at 1/Nth the request count.
        const boundaryChunks: CityEntry[][] = [];
        for (let i = 0; i < picked.length; i += BOUNDARY_BATCH_SIZE) {
            boundaryChunks.push(picked.slice(i, i + BOUNDARY_BATCH_SIZE));
        }
        for (let i = 0; i < boundaryChunks.length; i++) {
            const slotOk = await waitForOverpassSlot(
                `boundary ${i + 1}/${boundaryChunks.length}`,
            );
            if (!slotOk) {
                console.warn(
                    `[prewarm] boundary batch ${i + 1} skipped — slot wait exceeded cap`,
                );
                continue;
            }
            try {
                const r = await prewarmBoundariesBatch(
                    env,
                    boundaryChunks[i],
                    ttlMs,
                );
                if (r.stored.length > 0) {
                    console.log(
                        `[prewarm] batch ${i + 1}/${boundaryChunks.length}: stored ${r.stored.length} boundaries`,
                    );
                }
                if (r.notInResponse.length > 0) {
                    console.warn(
                        `[prewarm] batch ${i + 1}: ${r.notInResponse.length} relations missing from upstream response`,
                    );
                }
            } catch (e) {
                console.warn(`[prewarm] batch ${i + 1} threw:`, e);
            }
        }

        // Phase 2: REFERENCES, batched.
        // v203: each batched query unions one nwr sub-statement per
        // (city × family) tuple. Response gets split by bbox-
        // containment at write time so each city's R2 entry matches
        // exactly what a single-city query would return. 10 cities
        // per batch matches the boundary batch size.
        const refCities = picked.filter((c) => c.extent);
        const refChunks: CityEntry[][] = [];
        for (let i = 0; i < refCities.length; i += REFERENCE_BATCH_SIZE) {
            refChunks.push(refCities.slice(i, i + REFERENCE_BATCH_SIZE));
        }
        for (let i = 0; i < refChunks.length; i++) {
            const slotOk = await waitForOverpassSlot(
                `refs ${i + 1}/${refChunks.length}`,
            );
            if (!slotOk) {
                console.warn(
                    `[prewarm] refs batch ${i + 1} skipped — slot wait exceeded cap`,
                );
                continue;
            }
            try {
                const r = await prewarmReferencesBatch(
                    env,
                    refChunks[i],
                    ttlMs,
                );
                if (r.stored > 0) {
                    console.log(
                        `[prewarm] refs batch ${i + 1}/${refChunks.length}: stored ${r.stored} city ref-sets`,
                    );
                }
            } catch (e) {
                console.warn(`[prewarm] refs batch ${i + 1} threw:`, e);
            }
        }

        // Phase 3: HSR, per-COUNTRY (v214). HSR is an inter-city
        // network, so one `area["ISO3166-1"=XX]` query per country is
        // complete and gap-free where per-city bboxes overlapped and
        // left gaps. There are only ~25 HSR countries total and they
        // change slowly, so we refresh a small rotating slice each
        // tick rather than all of them — the continuously-running
        // laptop prewarmer covers the full set far faster anyway.
        const hsrSlice = [...HSR_COUNTRIES]
            .sort(() => Math.random() - 0.5)
            .slice(0, HSR_COUNTRIES_PER_TICK);
        for (let i = 0; i < hsrSlice.length; i++) {
            const iso = hsrSlice[i];
            const slotOk = await waitForOverpassSlot(
                `HSR ${iso} (${i + 1}/${hsrSlice.length})`,
            );
            if (!slotOk) {
                console.warn(
                    `[prewarm] HSR ${iso} skipped — slot wait exceeded cap`,
                );
                continue;
            }
            try {
                const r = await prewarmHsrCountry(env, iso, ttlMs);
                if (r.status === "stored") {
                    console.log(
                        `[prewarm] HSR ${iso}: stored (${r.sizeBytes} B)`,
                    );
                }
            } catch (e) {
                console.warn(`[prewarm] HSR ${iso} threw:`, e);
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
        if (url.pathname === "/admin/diagnose") {
            return handleAdminDiagnose(request, env, cors);
        }
        if (url.pathname === "/admin/list-cities") {
            return handleAdminListCities(request, env, cors);
        }
        if (url.pathname === "/admin/store-prewarmed") {
            return handleAdminStorePrewarmed(request, env, cors);
        }
        if (url.pathname === "/admin/check-fresh") {
            return handleAdminCheckFresh(request, env, cors);
        }
        if (url.pathname === "/admin/evict-discovered") {
            return handleAdminEvictDiscovered(request, env, cors);
        }
        if (url.pathname.startsWith("/tiles/")) {
            return handleTiles(request, env, cors);
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
/**
 * Pull the relation id out of the canonical
 * `[out:json][timeout:NNN];relation(ID);out geom;` boundary
 * query shape that the cron emits. Returns null when the query is
 * anything more elaborate (multi-relation, area-based POI fetches,
 * bbox prefetches) — those go straight to Overpass.
 *
 * Mirrors `extractBoundaryRelationId` in src/maps/api/polygonsOsmFr.ts.
 */
function extractBoundaryRelationId(query: string): number | null {
    const m =
        /^\s*\[out:json\][^;]*;\s*relation\((\d+)\)\s*;\s*out\s+geom\s*;\s*$/i.exec(
            query,
        );
    if (!m) return null;
    const n = parseInt(m[1], 10);
    return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Fetch the polygon for a known relation via polygons.openstreetmap.fr
 * and wrap it in an Overpass-shaped `{ elements: [...] }` response so
 * the downstream code path doesn't care which upstream won.
 *
 * Why this exists: the public Overpass mirrors have been fast-failing
 * on boundary queries from this worker's IP (every single prewarm in
 * the user's 100-relation test came back `upstream-failed` in ~1.3 s
 * — all three mirrors 429'd in unison). The client side already
 * mitigates the same condition by racing polygons.osm.fr in tier 1;
 * we now mirror that on the server. polygons.osm.fr returns
 * pre-computed polygons in 1-5 s without per-IP rate limits, so most
 * boundary prewarms now skip Overpass entirely.
 *
 * Returns null on any failure, the "None" sentinel (relation not yet
 * built — caller can `triggerPolygonsOsmFrBuild`), or unparseable
 * GeoJSON.
 */
/**
 * Outcome of a `fetchBoundaryFromPolygonsOsmFr` call:
 *   - "ok"    — body is the wrapped Overpass-shaped response.
 *   - "none"  — service returned the "polygon not yet built"
 *               sentinel. Caller SHOULD fire a build-trigger ping
 *               so the next attempt has it ready.
 *   - "error" — anything else (5xx, 429, network, parse). Caller
 *               MUST NOT fire a build trigger — doing so amplifies
 *               load on an already-stressed server and turns a
 *               single rate-limit failure into two.
 */
type PolyResult =
    | { kind: "ok"; response: Response }
    | { kind: "none" }
    | { kind: "error" };

async function fetchBoundaryFromPolygonsOsmFr(
    relationId: number,
): Promise<PolyResult> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    let resp: Response;
    try {
        resp = await ufetch(
            `${POLYGONS_OSM_FR_GET}?id=${relationId}&params=0`,
            { method: "GET", signal: ctrl.signal },
        );
    } catch {
        return { kind: "error" };
    } finally {
        clearTimeout(timer);
    }
    // 429 / 5xx — server is telling us to back off. Returning "none"
    // here would trigger a build ping that piles on; "error" makes
    // the caller skip the trigger.
    if (!resp.ok) return { kind: "error" };
    let text: string;
    try {
        text = await resp.text();
    } catch {
        return { kind: "error" };
    }
    const trimmed = text.trim();
    // Genuine "polygon not yet computed" — the build trigger IS the
    // right remedy for this one.
    if (trimmed === "None") return { kind: "none" };
    // HTML error page or empty body — server's confused, don't pile
    // on with a build trigger.
    if (!trimmed || trimmed.startsWith("<") || trimmed.startsWith("!")) {
        return { kind: "error" };
    }
    let geom: any;
    try {
        geom = JSON.parse(trimmed);
    } catch {
        return { kind: "error" };
    }
    const normalized = normalizeToPolyGeometry(geom);
    if (!normalized) return { kind: "error" };
    const wrapped = {
        elements: [
            {
                type: "relation",
                id: relationId,
                tags: { type: "boundary", boundary: "administrative" },
                members: synthesisMembersFromGeometry(normalized, relationId),
            },
        ],
    };
    return {
        kind: "ok",
        response: new Response(JSON.stringify(wrapped), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        }),
    };
}

function normalizeToPolyGeometry(raw: any): any | null {
    if (!raw || typeof raw !== "object") return null;
    if (raw.type === "Polygon" || raw.type === "MultiPolygon") return raw;
    if (raw.type === "Feature" && raw.geometry) {
        const t = raw.geometry.type;
        if (t === "Polygon" || t === "MultiPolygon") return raw.geometry;
    }
    if (raw.type === "FeatureCollection" && Array.isArray(raw.features)) {
        for (const f of raw.features) {
            const t = f?.geometry?.type;
            if (t === "Polygon" || t === "MultiPolygon") return f.geometry;
        }
    }
    return null;
}

function synthesisMembersFromGeometry(geom: any, relationId: number) {
    const polygons =
        geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
    const out: Array<{
        type: "way";
        ref: number;
        role: "outer" | "inner";
        geometry: Array<{ lat: number; lon: number }>;
    }> = [];
    let synthRef = relationId * 100;
    for (const poly of polygons) {
        poly.forEach((ring: number[][], idx: number) => {
            out.push({
                type: "way",
                ref: synthRef++,
                role: idx === 0 ? "outer" : "inner",
                geometry: ring.map((p) => ({ lat: p[1], lon: p[0] })),
            });
        });
    }
    return out;
}

async function fetchFromMirrorChain(query: string): Promise<Response | null> {
    // Boundary queries (relation(N);out geom;) RACE the three
    // Overpass mirrors against polygons.openstreetmap.fr as tier-1
    // co-equals — first success wins. Previous design (v196) put
    // polygons.osm.fr in front of the mirrors, but it's a much
    // smaller community service with stricter per-IP throttling than
    // the public Overpass mirrors. Crucially, our worker's outbound
    // IP is a shared Cloudflare edge IP — so polygons.osm.fr sees us
    // as one of many noisy neighbours and rate-limits hard, while
    // the bigger mirrors barely register the same shared-IP traffic.
    //
    // The race gets us the BEST of both: polygons.osm.fr wins on
    // cached relations (the common case for pre-built popular
    // cities), and the mirrors take over when polygons.osm.fr is
    // throttled or returns the "None" sentinel — the throughput
    // user-quoted ~10K/day per IP that I was originally reasoning
    // about. Non-boundary queries skip polygons.osm.fr entirely
    // since it can't serve them.
    const boundaryRelationId = extractBoundaryRelationId(query);
    const racers: Array<() => Promise<Response | null>> = [];
    let polyFiredNone = false;
    if (boundaryRelationId !== null) {
        racers.push(async () => {
            const r = await fetchBoundaryFromPolygonsOsmFr(boundaryRelationId);
            if (r.kind === "ok") return r.response;
            if (r.kind === "none") polyFiredNone = true;
            return null;
        });
    }
    racers.push(() => fetchFromOverpassMirrors(query));

    // First non-null wins. If both racers ultimately fail, we get null
    // here and the outer retry kicks in.
    const winner = await raceFirstSuccess(racers);
    // Only fire the build-trigger ping when polygons.osm.fr returned
    // the genuine "None" sentinel AND the mirrors also failed — in
    // that case the polygon doesn't exist yet, so kicking a build is
    // useful for the next cron tick. Skip on every other failure mode
    // to avoid amplifying load on an already-throttled server.
    if (!winner && polyFiredNone && boundaryRelationId !== null) {
        try {
            void ufetch(
                `https://polygons.openstreetmap.fr/?id=${boundaryRelationId}`,
                { method: "GET" },
            );
        } catch {
            /* noop */
        }
    }
    return winner;
}

/** First-success-wins race over N racers. Each runs in parallel; the
 *  first to resolve a non-null Response wins. Returns null only when
 *  every racer resolved to null. */
async function raceFirstSuccess(
    racers: Array<() => Promise<Response | null>>,
): Promise<Response | null> {
    if (racers.length === 0) return null;
    return new Promise((resolve) => {
        let pending = racers.length;
        let resolved = false;
        for (const run of racers) {
            run().then(
                (r) => {
                    if (resolved) return;
                    if (r) {
                        resolved = true;
                        resolve(r);
                        return;
                    }
                    if (--pending === 0) resolve(null);
                },
                () => {
                    if (resolved) return;
                    if (--pending === 0) resolve(null);
                },
            );
        }
    });
}

/** Race the three public Overpass mirrors. First 200-OK wins; if all
 *  three fail or timeout, returns null. Carved out of the old
 *  `fetchFromMirrorChain` so the boundary path can race it as one of
 *  several tier-1 racers. */
async function fetchFromOverpassMirrors(
    query: string,
): Promise<Response | null> {
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
            ? ufetch(base, {
                  method: "POST",
                  headers: {
                      "Content-Type": "application/x-www-form-urlencoded",
                  },
                  body: `data=${encoded}`,
                  signal: controllers[i].signal,
              })
            : ufetch(`${base}?data=${encoded}`, {
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

/**
 * How many cities we union into a single Overpass query for each
 * prewarm type. Tuned in v203 against the actual constraints:
 *
 *   - Each batched query counts ONCE against overpass-api.de's
 *     per-request rate limit, so bigger batches = fewer requests
 *     = less throttling pressure.
 *   - Bigger batches also mean a slow/broken relation in the batch
 *     drags more siblings down with it, so we don't go unbounded.
 *   - Response size matters too: a city boundary is ~0.5-2 MB of
 *     `out geom` data; references are ~100-500 KB per city's bbox;
 *     HSR is much smaller (most cities have no high-speed rail).
 *
 * Boundaries at 10 → ~5-20 MB response, comfortable for the worker.
 * References + HSR at 10 → response is dominated by reference count,
 * still well inside budgets. v202 stopped at 5/boundary out of pure
 * caution; v203 doubles it and adds the same batching to refs+HSR.
 */
const BOUNDARY_BATCH_SIZE = 10;
/**
 * References don't batch usefully. The v204→v205→v206 test runs all
 * timed out at the server's compute budget once a reference query
 * unioned more than one city's per-family bbox sub-statements. Reason:
 * Overpass's server-side bbox-filtered amenity finds are near-linear
 * in statement count — 33 sub-statements (3 cities × 11 families)
 * already exceeded the 60 s window. The batching savings we got for
 * boundaries (one relation lookup is light) don't generalise.
 *
 * Setting this to 1 means "each city's reference query goes as a
 * single per-city Overpass request" — same shape as the original
 * client query, no splitting, no risk of partial timeout. We accept
 * more per-IP request volume in exchange for actually getting
 * results stored. The 4 s per-batch pacing + 6 s phase pause keeps
 * the rate-limit pressure manageable.
 *
 * HSR stays at 5 — it uses one filter per city (vs 11), so a 5-city
 * batch is only 5 statements and resolves comfortably.
 */
const REFERENCE_BATCH_SIZE = 1;
/** Pause between cron phases (boundaries → references → HSR). The
 *  v205 test showed HSR fast-failing 9 s after references hit a 60 s
 *  timeout — the timeout left overpass-api.de's rate-limit window
 *  hot from the still-running server-side compute, and HSR walked
 *  straight into a 429. A short cooldown between phases gives the
 *  per-IP throttle room to recover. */
const PHASE_PAUSE_MS = 6000;

/**
 * Result of a batched boundary prewarm. `stored` is the list of
 * relation IDs we successfully cached; `notInResponse` is the list
 * Overpass omitted (relation doesn't exist, or the query timed out
 * before reaching it); `upstreamFailed` is true if the whole batch
 * call failed and the caller should re-queue all of them.
 */
interface BatchPrewarmResult {
    stored: number[];
    notInResponse: number[];
    upstreamFailed: boolean;
}

/**
 * Prewarm boundaries for many cities in ONE Overpass query, then
 * split the response and cache each relation under its single-
 * relation R2 key. Same key the client (and `prewarmRelation`) hits
 * for a single relation, so the batching is transparent: the client
 * never knows we cheated.
 *
 * Why this exists: prewarmRelation issues one Overpass request per
 * city, so a 10-city cron tick is 10 hits on overpass-api.de —
 * exactly the burst pattern that trips their rate limit. v202's
 * batched form makes that 2 hits (10 cities / 5 per batch) for the
 * same coverage, well inside the "be polite" budget.
 */
async function prewarmBoundariesBatch(
    env: Env,
    cities: CityEntry[],
    ttlMs: number,
): Promise<BatchPrewarmResult> {
    const result: BatchPrewarmResult = {
        stored: [],
        notInResponse: [],
        upstreamFailed: false,
    };
    if (cities.length === 0) return result;

    // Skip anything already fresh in R2 so we don't re-pay an
    // upstream request for cities we already have.
    const stale: CityEntry[] = [];
    for (const city of cities) {
        const singleQuery = singleRelationQuery(city.relationId);
        const cacheKey = await r2KeyForQuery(singleQuery);
        let r2Hit: R2ObjectBody | null = null;
        try {
            r2Hit = await env.CACHE.get(`overpass/${cacheKey}`);
        } catch {
            /* treat as miss */
        }
        if (r2Hit) {
            const cachedAt = parseInt(
                r2Hit.customMetadata?.cachedAt ?? "0",
                10,
            );
            const ageMs = Date.now() - cachedAt;
            if (cachedAt && ageMs < ttlMs) continue; // fresh, skip
        }
        stale.push(city);
    }
    if (stale.length === 0) return result;

    // Build the batched query. Sorted for a stable key — not
    // strictly necessary (we don't cache the batched response, only
    // its split parts), but makes log grepping nicer.
    const ids = stale.map((c) => c.relationId).sort((a, b) => a - b);
    const stmts = ids.map((id) => `  relation(${id});`).join("\n");
    const batchQuery = `[out:json][timeout:180];\n(\n${stmts}\n);\nout geom;\n`;
    const upstream = await upstreamSemaphore.run(() =>
        fetchFromMirrorChainWithRetry(batchQuery),
    );
    if (!upstream) {
        result.upstreamFailed = true;
        return result;
    }
    let json: any;
    try {
        json = await upstream.json();
    } catch {
        result.upstreamFailed = true;
        return result;
    }
    const elements = Array.isArray(json?.elements) ? json.elements : [];
    // Bucket the response by relation id; preserve only the
    // metadata stub Overpass needs for shape parity with the single-
    // relation response (osm3s + version, then one elements entry).
    const byId = new Map<number, any>();
    for (const el of elements) {
        if (el?.type === "relation" && typeof el.id === "number") {
            byId.set(el.id, el);
        }
    }
    const cityById = new Map<number, CityEntry>(
        stale.map((c) => [c.relationId, c]),
    );
    for (const id of ids) {
        const el = byId.get(id);
        if (!el) {
            result.notInResponse.push(id);
            continue;
        }
        // Wrap as a single-relation response, byte-shaped like
        // prewarmRelation's single-call body so the client gets the
        // exact same JSON regardless of which path warmed it.
        const wrapped = {
            version: json.version ?? 0.6,
            generator: json.generator ?? "jlhs-overpass-cache (batched)",
            osm3s: json.osm3s,
            elements: [el],
        };
        const body = JSON.stringify(wrapped);
        const singleQuery = singleRelationQuery(id);
        const cacheKey = await r2KeyForQuery(singleQuery);
        const city = cityById.get(id);
        try {
            await env.CACHE.put(`overpass/${cacheKey}`, body, {
                customMetadata: {
                    cachedAt: String(Date.now()),
                    sizeBytes: String(body.length),
                    ...(city?.name ? { sourceName: city.name } : {}),
                    sourceRelationId: String(id),
                    prewarmed: "true",
                    batched: "true",
                },
            });
            result.stored.push(id);
        } catch (e) {
            console.warn(`R2 put failed during batched prewarm of ${id}:`, e);
        }
    }
    return result;
}

/** The canonical single-relation boundary query. Same shape both
 *  the client and `prewarmRelation` emit, so its SHA-256 hash is the
 *  R2 cache key the client will hit. */
function singleRelationQuery(relationId: number): string {
    return `[out:json][timeout:120];relation(${relationId});out geom;`;
}

/**
 * Compute the [south, west, north, east] tuple for a city's bbox
 * with a given pad. Same arithmetic as `buildBboxFilter`, just
 * returning the numeric corners instead of an Overpass filter
 * string. Used by the batched ref/HSR splitter to test whether a
 * returned element belongs to a given city.
 */
function paddedBboxCorners(
    extent: [number, number, number, number],
    padKm: number,
): { south: number; west: number; north: number; east: number } {
    const [maxLat, minLng, minLat, maxLng] = extent;
    const latPad = padKm / 111;
    const midLat = (minLat + maxLat) / 2;
    const lngPad = padKm / (111 * Math.cos((midLat * Math.PI) / 180));
    return {
        south: parseFloat((minLat - latPad).toFixed(3)),
        west: parseFloat((minLng - lngPad).toFixed(3)),
        north: parseFloat((maxLat + latPad).toFixed(3)),
        east: parseFloat((maxLng + lngPad).toFixed(3)),
    };
}

/** Is (lat, lon) inside [south, west, north, east]? Closed interval
 *  on every edge — Overpass's `(bbox)` filter is inclusive too. */
function pointInBbox(
    lat: number,
    lon: number,
    bbox: { south: number; west: number; north: number; east: number },
): boolean {
    return (
        lat >= bbox.south &&
        lat <= bbox.north &&
        lon >= bbox.west &&
        lon <= bbox.east
    );
}

/** Pick a representative (lat, lon) for an Overpass element so the
 *  bbox-containment check can decide which city it belongs to.
 *  Nodes carry lat/lon directly; ways/relations from `out center`
 *  carry a `center` block; ways from `out geom` carry an array of
 *  points where we use the first as a proxy. Returns null if none
 *  match — element gets dropped from the per-city splits. */
function elementRepresentativePoint(
    el: any,
): { lat: number; lon: number } | null {
    if (typeof el?.lat === "number" && typeof el?.lon === "number") {
        return { lat: el.lat, lon: el.lon };
    }
    if (
        typeof el?.center?.lat === "number" &&
        typeof el?.center?.lon === "number"
    ) {
        return { lat: el.center.lat, lon: el.center.lon };
    }
    if (Array.isArray(el?.geometry) && el.geometry.length > 0) {
        const p = el.geometry[0];
        if (typeof p?.lat === "number" && typeof p?.lon === "number") {
            return { lat: p.lat, lon: p.lon };
        }
    }
    return null;
}

/**
 * Prewarm references for many cities in ONE unioned Overpass query,
 * then split the response by per-city bbox and store each slice
 * under that city's individual reference cache key.
 *
 * The split logic is straightforward: each amenity has a center
 * coord (from `out center`); test it against every input city's
 * padded bbox; bucket it into every city whose bbox contains it.
 * Overlapping bboxes (which happen because of the 50 km pad) cause
 * a single amenity to land in multiple per-city caches — that's
 * correct: each city's cache should match exactly what a
 * single-city query for that city would have returned.
 */
async function prewarmReferencesBatch(
    env: Env,
    cities: CityEntry[],
    ttlMs: number,
): Promise<{ stored: number; upstreamFailed: boolean }> {
    const out = { stored: 0, upstreamFailed: false };
    if (cities.length === 0) return out;

    // Skip already-fresh cities to avoid wasted upstream work.
    const stale: CityEntry[] = [];
    const perCityKey = new Map<number, string>();
    for (const city of cities) {
        if (!city.extent) continue;
        const singleQuery = buildReferenceBboxQuery(city.extent);
        const cacheKey = await r2KeyForQuery(singleQuery);
        let r2Hit: R2ObjectBody | null = null;
        try {
            r2Hit = await env.CACHE.get(`overpass/${cacheKey}`);
        } catch {
            /* miss */
        }
        if (r2Hit) {
            const cachedAt = parseInt(
                r2Hit.customMetadata?.cachedAt ?? "0",
                10,
            );
            if (cachedAt && Date.now() - cachedAt < ttlMs) continue;
        }
        stale.push(city);
        perCityKey.set(city.relationId, cacheKey);
    }
    if (stale.length === 0) return out;

    // Build the unioned batch query. One sub-block per city × per
    // family — the same shape the client query has for a single
    // city, just repeated.
    const subBlocks: string[] = [];
    for (const city of stale) {
        const bbox = paddedBboxCorners(city.extent!, PAD_KM);
        const bboxStr = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
        for (const { filter } of REFERENCE_FAMILY_FILTERS) {
            subBlocks.push(`  nwr${filter}(${bboxStr});`);
        }
    }
    const batchQuery = `
[out:json][timeout:180];
(
${subBlocks.join("\n")}
);
out center;
`;
    const upstream = await upstreamSemaphore.run(() =>
        fetchFromMirrorChainWithRetry(batchQuery),
    );
    if (!upstream) {
        out.upstreamFailed = true;
        return out;
    }
    let json: any;
    try {
        json = await upstream.json();
    } catch {
        out.upstreamFailed = true;
        return out;
    }
    const elements = Array.isArray(json?.elements) ? json.elements : [];

    // Compute each city's bbox once, then bucket every returned
    // element into every city whose bbox contains its representative
    // point. A single amenity can land in multiple caches; that's
    // intended (overlapping bboxes from the 50 km pad).
    const cityBboxes = stale.map((city) => ({
        city,
        bbox: paddedBboxCorners(city.extent!, PAD_KM),
        bucket: [] as any[],
    }));
    for (const el of elements) {
        const pt = elementRepresentativePoint(el);
        if (!pt) continue;
        for (const cb of cityBboxes) {
            if (pointInBbox(pt.lat, pt.lon, cb.bbox)) cb.bucket.push(el);
        }
    }

    for (const cb of cityBboxes) {
        const cacheKey = perCityKey.get(cb.city.relationId);
        if (!cacheKey) continue;
        const wrapped = {
            version: json.version ?? 0.6,
            generator: json.generator ?? "jlhs-overpass-cache (batched)",
            osm3s: json.osm3s,
            elements: cb.bucket,
        };
        const body = JSON.stringify(wrapped);
        try {
            await env.CACHE.put(`overpass/${cacheKey}`, body, {
                customMetadata: {
                    cachedAt: String(Date.now()),
                    sizeBytes: String(body.length),
                    sourceName: cb.city.name,
                    sourceRelationId: String(cb.city.relationId),
                    prewarmed: "true",
                    batched: "true",
                    kind: "references",
                },
            });
            out.stored++;
        } catch (e) {
            console.warn(
                `R2 put failed during batched ref prewarm of ${cb.city.name}:`,
                e,
            );
        }
    }
    return out;
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
 *  is sparse. Legacy: only the diagnose endpoint still reports it;
 *  the live HSR prewarm is per-country (see HSR_COUNTRIES). */
const HSR_PAD_KM = 100;

/** Countries whose national HSR network is prewarmed as a single
 *  `area["ISO3166-1"="XX"]` query. MUST stay byte-identical (same
 *  set, same uppercase alpha-2 codes) to `HSR_COUNTRIES` in
 *  src/maps/api/playAreaPrefetch.ts and scripts/laptop-prewarm.mjs. */
const HSR_COUNTRIES = [
    "JP",
    "CN",
    "FR",
    "DE",
    "ES",
    "IT",
    "GB",
    "BE",
    "NL",
    "CH",
    "AT",
    "KR",
    "TW",
    "TR",
    "SA",
    "MA",
    "SE",
    // US deliberately omitted: `area["ISO3166-1"="US"]` is a
    // continent-scale area construction that times out at the 180 s
    // Overpass ceiling on every run (the overnight log aborted US
    // 4/4 times at 180 010 ms). US "high speed" rail is just the
    // Acela corridor and is mostly not tagged highspeed=yes anyway;
    // the client's radius-walk fallback still resolves any nearby
    // tagged track. RU is also continent-scale but completes (~148 s),
    // so it stays.
    "RU",
    "PL",
    "DK",
    "PT",
    "UZ",
    "NO",
    "FI",
];

/** How many HSR countries to refresh per hourly cron tick. The full
 *  set changes slowly and the continuous laptop prewarmer covers it
 *  quickly, so the cron only needs to keep a rotating slice warm. */
const HSR_COUNTRIES_PER_TICK = 4;

/** Per-country HSR query. MUST stay byte-identical to
 *  `buildHsrCountryQuery` in src/maps/api/playAreaPrefetch.ts and
 *  scripts/laptop-prewarm.mjs — the R2 key hashes this exact string. */
function buildHsrCountryQuery(iso: string): string {
    return `
[out:json][timeout:180];
area["ISO3166-1"="${iso}"]["admin_level"="2"]->.hsrArea;
way["railway"="rail"]["highspeed"="yes"](area.hsrArea);
out geom;
`;
}

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

/**
 * Prewarm one country's HSR network into R2. Skips when a fresh
 * entry already exists. Stored under the same key the client's
 * `buildHsrQuery` → `buildHsrCountryQuery(iso)` computes, so a
 * seeker playing in that country gets an instant cache hit.
 */
async function prewarmHsrCountry(
    env: Env,
    iso: string,
    ttlMs: number,
): Promise<{ status: string; ageMs?: number; sizeBytes?: number }> {
    const query = buildHsrCountryQuery(iso);
    const cacheKey = await r2KeyForQuery(query);
    let r2Hit: R2ObjectBody | null = null;
    try {
        r2Hit = await env.CACHE.get(`overpass/${cacheKey}`);
    } catch (e) {
        console.warn(`R2 get failed during HSR prewarm of ${iso}:`, e);
    }
    if (r2Hit) {
        const cachedAt = parseInt(r2Hit.customMetadata?.cachedAt ?? "0", 10);
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
                sourceName: iso,
                prewarmed: "true",
                kind: "hsr",
            },
        });
    } catch (e) {
        console.warn(`R2 put failed during HSR prewarm of ${iso}:`, e);
        return { status: "r2-put-failed" };
    }
    return { status: "stored", sizeBytes: body.length };
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

    // v203: this endpoint now drives the SAME batched code path the
    // scheduled cron uses, so a manual trigger actually exercises
    // what runs nightly. Three phases:
    //   1. Boundaries — `relation(N1);relation(N2);…;out geom;`,
    //      BOUNDARY_BATCH_SIZE per query.
    //   2. References — unioned `nwr<filter>(bbox)` over every
    //      (city × family) tuple, response split by bbox.
    //   3. HSR — same shape but `out geom` for line geometry.
    // Each phase's batches are spaced `delay` ms apart so a
    // big manual trigger doesn't blow through overpass-api.de's
    // per-IP burst limit.

    const phaseResults: Array<{
        phase: string;
        batch: number;
        outOf: number;
        stored: number;
        notInResponse?: number[];
        upstreamFailed: boolean;
        durationMs: number;
    }> = [];

    const runPhase = async <T>(
        label: string,
        chunkSize: number,
        cityList: CityEntry[],
        runChunk: (
            chunk: CityEntry[],
        ) => Promise<T & { upstreamFailed: boolean }>,
        extract: (r: T) => {
            stored: number;
            notInResponse?: number[];
        },
    ) => {
        const chunks: CityEntry[][] = [];
        for (let i = 0; i < cityList.length; i += chunkSize) {
            chunks.push(cityList.slice(i, i + chunkSize));
        }
        for (let i = 0; i < chunks.length; i++) {
            const t0 = Date.now();
            try {
                const r = await runChunk(chunks[i]);
                const e = extract(r as T);
                phaseResults.push({
                    phase: label,
                    batch: i + 1,
                    outOf: chunks.length,
                    stored: e.stored,
                    notInResponse: e.notInResponse,
                    upstreamFailed: r.upstreamFailed,
                    durationMs: Date.now() - t0,
                });
            } catch (err) {
                phaseResults.push({
                    phase: label,
                    batch: i + 1,
                    outOf: chunks.length,
                    stored: 0,
                    upstreamFailed: true,
                    durationMs: Date.now() - t0,
                });
                console.warn(`[trigger] ${label} batch ${i + 1} threw:`, err);
            }
            if (i < chunks.length - 1 && delay > 0) {
                await new Promise((r) => setTimeout(r, delay));
            }
        }
    };

    await runPhase(
        "boundaries",
        BOUNDARY_BATCH_SIZE,
        picked,
        (chunk) => prewarmBoundariesBatch(env, chunk, ttlMs),
        (r) => ({
            stored: r.stored.length,
            notInResponse: r.notInResponse.length > 0 ? r.notInResponse : undefined,
        }),
    );

    await new Promise((r) => setTimeout(r, PHASE_PAUSE_MS));

    const withExtent = picked.filter((c) => c.extent);
    await runPhase(
        "references",
        REFERENCE_BATCH_SIZE,
        withExtent,
        (chunk) => prewarmReferencesBatch(env, chunk, ttlMs),
        (r) => ({ stored: r.stored }),
    );

    await new Promise((r) => setTimeout(r, PHASE_PAUSE_MS));

    // HSR is per-country (v214), not per-city: iterate the full
    // HSR_COUNTRIES list so a manual trigger warms every national
    // network, spaced by `delay` to stay polite.
    for (let i = 0; i < HSR_COUNTRIES.length; i++) {
        const iso = HSR_COUNTRIES[i];
        const t0 = Date.now();
        try {
            const r = await prewarmHsrCountry(env, iso, ttlMs);
            phaseResults.push({
                phase: "hsr",
                batch: i + 1,
                outOf: HSR_COUNTRIES.length,
                stored: r.status === "stored" ? 1 : 0,
                upstreamFailed: r.status === "upstream-failed",
                durationMs: Date.now() - t0,
            });
        } catch (err) {
            phaseResults.push({
                phase: "hsr",
                batch: i + 1,
                outOf: HSR_COUNTRIES.length,
                stored: 0,
                upstreamFailed: true,
                durationMs: Date.now() - t0,
            });
            console.warn(`[trigger] hsr ${iso} threw:`, err);
        }
        if (i < HSR_COUNTRIES.length - 1 && delay > 0) {
            await new Promise((r) => setTimeout(r, delay));
        }
    }

    const totalStored = phaseResults.reduce(
        (acc, p) => acc + p.stored,
        0,
    );
    const upstreamFailures = phaseResults.filter(
        (p) => p.upstreamFailed,
    ).length;
    return new Response(
        JSON.stringify(
            {
                picked: picked.length,
                totalCandidates: cities.length,
                totalStored,
                upstreamFailedBatches: upstreamFailures,
                phases: phaseResults,
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
        const resp = await ufetch(
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
        const resp = await ufetch(
            `${PHOTON_API}?q=${encodeURIComponent(name)}&limit=5`,
            { signal: ctrl.signal },
        );
        if (!resp.ok) return null;
        const data = (await resp.json()) as {
            features?: Array<{
                properties?: {
                    osm_type?: string;
                    osm_id?: number;
                    osm_key?: string;
                    extent?: number[];
                };
            }>;
        };
        for (const f of data.features ?? []) {
            if (
                f.properties?.osm_type === "R" &&
                typeof f.properties.osm_id === "number" &&
                f.properties.osm_id > 0 &&
                // Only accept place / boundary relations — a bare
                // first-R-result picks up route relations, building
                // complexes, etc. whose `relation(N);out geom;` comes
                // back with no usable boundary geometry. The overnight
                // log showed ~23 discovered cities (Aarhus, Adelaide,
                // Bergen…) stored with such ids, then failing their
                // boundary fetch as "empty / unparseable" every run.
                // This mirrors the client-side geocode.ts filter
                // (osm_key === "place" || "boundary").
                (f.properties.osm_key === "place" ||
                    f.properties.osm_key === "boundary")
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
    const knownRelationIds = new Set(
        (await getPopularCities(env)).map((c) => c.relationId),
    );
    const fresh: CityEntry[] = [];
    const failed: string[] = [];
    const duplicates: string[] = [];
    for (let i = 0; i < todo.length; i++) {
        const name = todo[i];
        try {
            const r = await resolveNameViaPhoton(name);
            if (r) {
                if (knownRelationIds.has(r.relationId)) {
                    // Resolved to a relation we already have under
                    // another name — can't store (dedup), so park it
                    // to keep the queue from re-serving it forever.
                    duplicates.push(name);
                } else {
                    fresh.push({
                        name,
                        relationId: r.relationId,
                        extent: r.extent,
                    });
                    knownRelationIds.add(r.relationId);
                }
            } else {
                failed.push(name);
            }
        } catch (e) {
            failed.push(name);
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
    if (failed.length > 0) {
        await recordFailedResolves(env, failed);
    }
    if (duplicates.length > 0) {
        await parkNames(env, duplicates);
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
    // Relation ids already claimed by a stored city. A candidate that
    // Photon resolves to one of these can't be stored (dedup by
    // relation id) and would loop forever, so we park it instead.
    const knownRelationIds = new Set(
        (await getPopularCities(env)).map((c) => c.relationId),
    );
    const fresh: CityEntry[] = [];
    const skipped: string[] = [];
    const duplicates: string[] = [];
    for (let i = 0; i < names.length; i++) {
        const name = names[i];
        try {
            const r = await resolveNameViaPhoton(name);
            if (r) {
                if (knownRelationIds.has(r.relationId)) {
                    duplicates.push(name);
                } else {
                    fresh.push({ name, relationId: r.relationId });
                    knownRelationIds.add(r.relationId);
                }
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
    if (skipped.length > 0) {
        // Park names Photon couldn't resolve so they stop blocking the
        // front of the queue on subsequent calls (see
        // DISCOVER_ATTEMPTS_R2_KEY). Explicit `names`-array calls also
        // count — a name fed directly that still won't resolve is just
        // as dead as one pulled from the candidate list.
        await recordFailedResolves(env, skipped);
    }
    if (duplicates.length > 0) {
        // Resolved, but to a relation id we already have under another
        // name — park immediately so the queue advances (otherwise
        // these re-resolve every call and never leave).
        await parkNames(env, duplicates);
    }
    const remaining = await unresolvedCandidates(env);
    return new Response(
        JSON.stringify(
            {
                attempted: names.length,
                resolved: fresh,
                skipped,
                duplicates,
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

/**
 * GET /tiles/<key>
 *
 * Range-request proxy for the Protomaps vector basemap PMTiles file
 * stored in R2 (env.TILES). PMTiles is a single binary file format —
 * its header at offset 0 indexes a directory of (z,x,y) → byte range
 * lookups, so the maplibre pmtiles:// protocol issues HTTP byte-range
 * reads to walk the directory and then pull just the visible tile
 * bytes. The Worker only needs to translate that into an R2 ranged
 * read, with caching and CORS.
 *
 * Why this lives in the existing overpass-cache Worker instead of a
 * second project: same R2 account, same Workers Builds wiring, same
 * deploy command. One worker, one deployment story, one set of
 * secrets — and PMTiles serving is read-only so the failure modes
 * don't cross over into the overpass cache code.
 *
 * Until a .pmtiles file is uploaded under env.TILES the route 404s
 * and the client (src/lib/protomapsStyle.ts) silently falls back to
 * Protomaps' public demo bucket — see PROTOMAPS_PMTILES_URL there.
 */
async function handleTiles(
    request: Request,
    env: Env,
    cors: HeadersInit,
): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method not allowed", {
            status: 405,
            headers: { ...cors, Allow: "GET, HEAD" },
        });
    }
    // Key is the part after `/tiles/`. e.g. /tiles/basemap.pmtiles →
    // "basemap.pmtiles". Reject anything that tries to escape the
    // bucket prefix via .. or absolute paths.
    const url = new URL(request.url);
    const key = url.pathname.slice("/tiles/".length);
    if (!key || key.includes("..") || key.startsWith("/")) {
        return new Response("Bad key", { status: 400, headers: cors });
    }

    // Parse the Range header (single range only — PMTiles never
    // requests multi-range). Format: "bytes=START-END" or
    // "bytes=START-" (open-ended). Missing header → return the whole
    // object. Malformed header → 416.
    const rangeHeader = request.headers.get("Range");
    let range: R2Range | undefined;
    let isPartial = false;
    if (rangeHeader) {
        const m = /^bytes=(\d+)-(\d+)?$/.exec(rangeHeader.trim());
        if (!m) {
            return new Response("Malformed Range", {
                status: 416,
                headers: { ...cors, "Accept-Ranges": "bytes" },
            });
        }
        const offset = parseInt(m[1], 10);
        const end = m[2] !== undefined ? parseInt(m[2], 10) : undefined;
        const length = end !== undefined ? end - offset + 1 : undefined;
        if (!Number.isFinite(offset) || offset < 0) {
            return new Response("Bad Range", { status: 416, headers: cors });
        }
        range = length !== undefined ? { offset, length } : { offset };
        isPartial = true;
    }

    let obj: R2ObjectBody | null;
    try {
        obj = await env.TILES.get(key, range ? { range } : undefined);
    } catch (e) {
        console.warn(`TILES get failed for ${key}:`, e);
        return new Response("R2 unreachable", {
            status: 503,
            headers: cors,
        });
    }
    if (!obj) {
        return new Response("Not found", {
            status: 404,
            headers: cors,
        });
    }

    // For partial responses we need to know the total size so we can
    // emit a Content-Range header maplibre/pmtiles understands. R2
    // returns total `size` on the metadata regardless of whether the
    // body is partial.
    const totalSize = obj.size;
    const respHeaders: HeadersInit = {
        ...cors,
        "Content-Type": "application/octet-stream",
        "Accept-Ranges": "bytes",
        // R2 vector tiles are immutable for a given filename — we
        // version by changing the filename rather than mutating in
        // place — so we can cache aggressively.
        "Cache-Control": "public, max-age=31536000, immutable",
        ETag: obj.httpEtag,
    };

    if (isPartial) {
        // We only ever construct {offset} or {offset,length} above,
        // never the suffix-form — narrow accordingly so TS lets us
        // read .offset off the union.
        const r = range as { offset: number; length?: number };
        const offset = r.offset;
        // R2 may return fewer bytes than requested at EOF; trust the
        // requested length when known, otherwise fall back to size.
        const returned = r.length ?? totalSize - offset;
        const endByte = offset + returned - 1;
        (respHeaders as Record<string, string>)["Content-Length"] =
            String(returned);
        (respHeaders as Record<string, string>)["Content-Range"] =
            `bytes ${offset}-${endByte}/${totalSize}`;
        return new Response(request.method === "HEAD" ? null : obj.body, {
            status: 206,
            headers: respHeaders,
        });
    }

    (respHeaders as Record<string, string>)["Content-Length"] = String(
        totalSize,
    );
    return new Response(request.method === "HEAD" ? null : obj.body, {
        status: 200,
        headers: respHeaders,
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

/** Local lightweight jsonResponse — journey.ts has a similar helper
 *  but lives in a different module; not worth a cross-file import
 *  for one diagnostic endpoint. */
function jsonResponse(
    body: unknown,
    status: number,
    cors: HeadersInit,
): Response {
    const headers = new Headers(cors);
    headers.set("Content-Type", "application/json");
    return new Response(JSON.stringify(body, null, 2), { status, headers });
}

/**
 * `GET /admin/diagnose?id=<relationId>&secret=<…>` — probe each
 * upstream individually and report exactly what it returned.
 *
 * Built after a 100-relation prewarm run came back 97/100
 * `upstream-failed` with identical ~1.3 s durations — that pattern
 * was suspicious enough that "treat null as null" stopped being
 * good enough. This endpoint runs ONE relation against:
 *   - polygons.openstreetmap.fr/get_geojson.py?id=<rel>
 *   - overpass-api.de/api/interpreter (with the cron's boundary
 *     query shape)
 *   - overpass.private.coffee/api/interpreter
 *   - overpass.kumi.systems/api/interpreter
 * Reports the HTTP status, response time, response headers, and a
 * short body preview for each. Lets the operator see whether
 * failures are 429, 403, 5xx, network-level, or something else.
 *
 * Defaults to relation 175905 (NYC) if no id is given.
 */
async function handleAdminDiagnose(
    request: Request,
    env: Env,
    cors: HeadersInit,
): Promise<Response> {
    if (!checkAdminAuth(request, env)) {
        return new Response("Unauthorized", { status: 401, headers: cors });
    }
    const u = new URL(request.url);
    const id = parseInt(u.searchParams.get("id") ?? "175905", 10);
    if (!Number.isFinite(id) || id <= 0) {
        return jsonResponse({ error: "bad id" }, 400, cors);
    }
    const overpassQuery = `[out:json][timeout:120];relation(${id});out geom;`;
    const targets = [
        {
            label: "polygons.osm.fr",
            url: `${POLYGONS_OSM_FR_GET}?id=${id}&params=0`,
            init: { method: "GET" as const },
        },
        ...OVERPASS_MIRRORS.map((base) => ({
            label: base.replace(/^https?:\/\//, "").split("/")[0],
            url: `${base}?data=${encodeURIComponent(overpassQuery)}`,
            init: { method: "GET" as const },
        })),
    ];
    const results = await Promise.all(
        targets.map(async (t) => {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 15000);
            const t0 = Date.now();
            try {
                const resp = await ufetch(t.url, {
                    ...t.init,
                    signal: ctrl.signal,
                });
                const elapsedMs = Date.now() - t0;
                const headers: Record<string, string> = {};
                resp.headers.forEach((v, k) => {
                    headers[k] = v;
                });
                let bodyPreview = "";
                try {
                    const text = await resp.text();
                    bodyPreview = text.slice(0, 500);
                } catch {
                    /* read failed */
                }
                return {
                    label: t.label,
                    status: resp.status,
                    statusText: resp.statusText,
                    elapsedMs,
                    headers,
                    bodyPreview,
                };
            } catch (e) {
                return {
                    label: t.label,
                    error: e instanceof Error ? e.message : String(e),
                    name: e instanceof Error ? e.name : undefined,
                    elapsedMs: Date.now() - t0,
                };
            } finally {
                clearTimeout(timer);
            }
        }),
    );
    return jsonResponse(
        {
            relationId: id,
            userAgent: USER_AGENT,
            results,
        },
        200,
        cors,
    );
}

/**
 * `GET /admin/list-cities?secret=<…>` — returns the merged
 * (HAND_CURATED + BULK_CITIES + discovered) city list as JSON. The
 * laptop-prewarm script reads this so it doesn't have to maintain
 * its own copy of the city table. Each entry is `{name, relationId,
 * extent?}` — same shape as `CityEntry`.
 */
async function handleAdminListCities(
    request: Request,
    env: Env,
    cors: HeadersInit,
): Promise<Response> {
    if (!checkAdminAuth(request, env)) {
        return new Response("Unauthorized", { status: 401, headers: cors });
    }
    const cities = await getPopularCities(env);
    return jsonResponse(
        {
            count: cities.length,
            cities,
            queryBuilders: {
                boundary: "[out:json][timeout:120];relation(${relationId});out geom;",
                referencePad: PAD_KM,
                hsrPad: HSR_PAD_KM,
                referenceFamilies: REFERENCE_FAMILY_FILTERS,
            },
        },
        200,
        cors,
    );
}

/**
 * `POST /admin/store-prewarmed` — accept a pre-fetched Overpass
 * response from an external runner and store it under the R2 cache
 * key the worker (and any client) would compute from the query.
 *
 * Why this endpoint exists: overpass-api.de aggressively per-IP
 * rate-limits the worker's Cloudflare-edge IP (shared with countless
 * other Workers), so the cron's effective throughput is far below
 * what a residential / VPS IP gets. Offloading the upstream fetch to
 * a home machine and uploading the result here lets us bypass the
 * shared-IP ceiling entirely — same R2 cache, same byte-shape, same
 * key, just a different machine doing the work.
 *
 * Body: JSON
 *   {
 *     "query":  "<exact Overpass QL string>",
 *     "body":   <Overpass JSON response object, as-is>,
 *     "kind":   "boundary" | "references" | "hsr"  (metadata only)
 *     "sourceName":       "City, Country"           (optional)
 *     "sourceRelationId": "123456"                  (optional)
 *   }
 *
 * The worker SHA-256-hashes `query` (same algorithm the request
 * handler uses) and stores `body` under `overpass/<hash>` so a
 * subsequent client request hashing the same query string gets a
 * cache hit. Overwrites any existing entry.
 */
async function handleAdminStorePrewarmed(
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
    let payload: {
        query?: string;
        body?: unknown;
        kind?: string;
        sourceName?: string;
        sourceRelationId?: string;
    };
    try {
        payload = await request.json();
    } catch {
        return jsonResponse({ error: "invalid JSON" }, 400, cors);
    }
    if (!payload?.query || typeof payload.query !== "string") {
        return jsonResponse(
            { error: "missing or non-string 'query'" },
            400,
            cors,
        );
    }
    if (payload.body === undefined || payload.body === null) {
        return jsonResponse({ error: "missing 'body'" }, 400, cors);
    }
    const cacheKey = await r2KeyForQuery(payload.query);
    const bodyStr =
        typeof payload.body === "string"
            ? payload.body
            : JSON.stringify(payload.body);
    try {
        await env.CACHE.put(`overpass/${cacheKey}`, bodyStr, {
            customMetadata: {
                cachedAt: String(Date.now()),
                sizeBytes: String(bodyStr.length),
                prewarmed: "true",
                source: "external-runner",
                ...(payload.kind ? { kind: payload.kind } : {}),
                ...(payload.sourceName
                    ? { sourceName: payload.sourceName }
                    : {}),
                ...(payload.sourceRelationId
                    ? { sourceRelationId: payload.sourceRelationId }
                    : {}),
            },
        });
    } catch (e) {
        return jsonResponse(
            {
                error: "R2 put failed",
                detail: e instanceof Error ? e.message : String(e),
            },
            500,
            cors,
        );
    }
    return jsonResponse(
        {
            status: "stored",
            cacheKey,
            sizeBytes: bodyStr.length,
            kind: payload.kind,
        },
        200,
        cors,
    );
}

/**
 * `POST /admin/check-fresh` — cheap "is this query already cached
 * and fresh?" probe for the laptop prewarmer. Lets the script skip
 * cities that the cron (or a previous laptop run) already populated,
 * rather than re-fetching the same boundary/refs/HSR every run.
 *
 * Body: `{ "query": "<exact Overpass QL string>" }`
 *
 * Same SHA-256 hash + TTL math the public `/api/interpreter`
 * handler uses, but we hit R2's `head()` instead of `get()` so we
 * don't transfer the cached body just to ask whether it exists.
 *
 * Response:
 *   { "fresh": true,  "ageMs": 12345678, "ttlMs": ... }   // good, skip
 *   { "fresh": false, "ageMs": 99999999, "ttlMs": ... }   // stale
 *   { "fresh": false, "exists": false }                    // never cached
 */
async function handleAdminCheckFresh(
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
    let payload: { query?: string };
    try {
        payload = await request.json();
    } catch {
        return jsonResponse({ error: "invalid JSON" }, 400, cors);
    }
    if (!payload?.query || typeof payload.query !== "string") {
        return jsonResponse(
            { error: "missing or non-string 'query'" },
            400,
            cors,
        );
    }
    const ttlMs =
        (parseInt(env.CACHE_TTL_DAYS, 10) || 30) * 24 * 60 * 60 * 1000;
    const cacheKey = await r2KeyForQuery(payload.query);
    let head: R2Object | null = null;
    try {
        head = await env.CACHE.head(`overpass/${cacheKey}`);
    } catch (e) {
        return jsonResponse(
            {
                error: "R2 head failed",
                detail: e instanceof Error ? e.message : String(e),
            },
            500,
            cors,
        );
    }
    if (!head) {
        return jsonResponse(
            { fresh: false, exists: false, ttlMs, cacheKey },
            200,
            cors,
        );
    }
    const cachedAt = parseInt(head.customMetadata?.cachedAt ?? "0", 10);
    const ageMs = cachedAt ? Date.now() - cachedAt : Infinity;
    const fresh = cachedAt > 0 && ageMs < ttlMs;
    return jsonResponse(
        { fresh, exists: true, ageMs, ttlMs, cacheKey },
        200,
        cors,
    );
}

/**
 * `POST /admin/evict-discovered` — remove a discovered city by
 * relation id. The external prewarmer calls this when a discovered
 * entry's boundary fetch returns empty (a sign Photon resolved the
 * name to a non-boundary relation). Eviction returns the name to the
 * unresolved queue so the boundary-filtered resolver can re-resolve
 * it correctly on the next discover pass.
 *
 * Body: `{ "relationId": 123456 }`
 */
async function handleAdminEvictDiscovered(
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
    let payload: { relationId?: number };
    try {
        payload = await request.json();
    } catch {
        return jsonResponse({ error: "invalid JSON" }, 400, cors);
    }
    const relationId = Number(payload?.relationId);
    if (!Number.isFinite(relationId) || relationId <= 0) {
        return jsonResponse(
            { error: "missing or invalid 'relationId'" },
            400,
            cors,
        );
    }
    let removed = false;
    try {
        removed = await removeDiscoveredByRelationId(env, relationId);
    } catch (e) {
        return jsonResponse(
            {
                error: "evict failed",
                detail: e instanceof Error ? e.message : String(e),
            },
            500,
            cors,
        );
    }
    return jsonResponse({ status: "ok", relationId, removed }, 200, cors);
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
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS, HEAD",
        // v233: added Range so the browser sends it (preflighted as a
        // CORS-safelist header in some specs but stricter in others —
        // make it explicit). Authorization stays for /admin/* routes.
        "Access-Control-Allow-Headers": "Content-Type, Authorization, Range",
        // Expose the bits the maplibre pmtiles:// protocol reads off
        // the response to walk the directory + verify partial reads.
        // Without these the browser hides them from JS.
        "Access-Control-Expose-Headers":
            "Content-Length, Content-Range, ETag, Accept-Ranges",
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
