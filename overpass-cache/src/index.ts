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
    SEED_CITIES,
    loadDiscoveredCities,
    missingExtentRelations,
    parkNames,
    recordFailedResolves,
    removeDiscoveredByRelationId,
    repairBogusDiscoveredEntries,
    setDiscoveredCities,
    unresolvedCandidates,
    upsertDiscoveredCity,
} from "./cities";
import { COUNTRY_SHARDS, type CountryShard } from "./countryShards";
import type { Env } from "./envTypes";
import { handleDepartures } from "./departures/board";
import { handleJourneyArrivals } from "./journey";
import { handleTravelPlan } from "./travel/plan";
import {
    countryRefsKey,
    extractBbox,
    findContainingShard,
    type OverpassResponse,
    sliceResponseByBbox,
    sliceTransitByBbox,
    templateFingerprint,
    transitShardKey,
    type TransitReducedResponse,
} from "./querySlicing";

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
// v351: lowered from 60 s. A single hung public mirror was holding the
// request open for 84 s (observed in a HAR), well past the point where
// Cloudflare kills the isolate (CORS-less 1101) and the seeker's
// browser/fetch has given up anyway. 25 s is plenty for a healthy
// boundary/reference fetch and lets the worker return a clean CORS'd
// 502 promptly when the mirrors are genuinely down, so the client can
// fall back (radius walk) instead of seeing an unreadable error.
const UPSTREAM_TIMEOUT_MS = 25_000;
// v696: a SHORTER per-attempt timeout for the USER-facing live path only.
// The user path is `waitForOverpassSlot(USER_SLOT_WAIT_MS) + mirror race`,
// and Cloudflare kills the isolate with a CORS-LESS 500 (which hard-blocks
// the browser, masking the graceful fail-over) past ~30 s wall-clock. With
// the old 8 s slot + 25 s race = 33 s, a game-start during an Overpass
// outage reliably tripped that. Slot 3 s + race 20 s = 23 s keeps the worker
// safely under the wall-clock so it returns its own CORS'd 502 and the
// client falls over cleanly. The cron keeps the full 25 s (no wall-clock
// pressure) for heavy prewarm queries.
const USER_UPSTREAM_TIMEOUT_MS = 20_000;

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

/** Slot-wait budget for LIVE (user-facing) requests. We STILL pace
 *  through the slot gate — skipping it would hammer overpass-api.de's
 *  429s and worsen the throttling — but a live request can't sit for the
 *  cron's full 30 s. This budget lets it do ~1-2 quick status checks and
 *  land on a free slot when one's near, then proceed to race the mirror
 *  (itself abort-bounded) if the slot is far off. v367: chosen so the
 *  request always resolves well inside Cloudflare's hang threshold. */
const USER_SLOT_WAIT_MS = 3_000;

/** v684: inter-fetch pacing floor for the CRON upstream path. A run of
 *  quick warms (many skip-if-stale HEADs punctuated by the occasional real
 *  fetch) could otherwise fire back-to-back the instant slots free and
 *  burst the mirror. Enforcing a minimum gap since the last cron upstream
 *  proceed mirrors the laptop prewarmer's `DELAY_MS` floor. Module-scoped
 *  state persists across the isolate; the live path never calls this. */
const CRON_UPSTREAM_MIN_GAP_MS = 500;
let lastCronUpstreamAt = 0;
async function paceCronUpstream(): Promise<void> {
    const gap = Date.now() - lastCronUpstreamAt;
    if (gap < CRON_UPSTREAM_MIN_GAP_MS) {
        await new Promise((r) =>
            setTimeout(r, CRON_UPSTREAM_MIN_GAP_MS - gap),
        );
    }
    lastCronUpstreamAt = Date.now();
}

async function fetchOverpassStatus(): Promise<string | null> {
    // v367: hard timeout. Without a signal, this fetch hangs forever
    // when overpass-api.de's /api/status wedges (accepts the connection
    // but never responds — its current 521 state), and since the live
    // request path awaits this, the WHOLE worker request hangs until
    // Cloudflare kills it with a CORS-less 500 ("Worker hung and would
    // never generate a response" — the Bordeaux crash).
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    try {
        const resp = await ufetch(OVERPASS_STATUS_URL, {
            method: "GET",
            signal: ctrl.signal,
        });
        if (!resp.ok) return null;
        return await resp.text();
    } catch {
        return null;
    } finally {
        clearTimeout(t);
    }
}

/** Block until overpass-api.de reports at least one free execution
 *  slot, or give up (return false) if the wait would be too long.
 *  Returns true when a slot is available and we should proceed with
 *  the upstream call. */
async function waitForOverpassSlot(
    label: string,
    maxTotalMs: number = SLOT_WAIT_MAX_MS,
    // v684: what to do when the slot state is UNCERTAIN — the budget ran
    // out or /api/status is itself unreachable. A LIVE request passes
    // `true` (proceed blind, race the mirror, fail fast — there's a user
    // waiting). The CRON leaves it `false` (default): decline the fetch and
    // catch the work next tick, NEVER hammer Overpass on a status wobble.
    // This is the core of why the cron used to earn 429s where the serial
    // laptop prewarmer doesn't — the laptop always waits for a real slot;
    // the cron used to "proceed blind" here and burst.
    proceedWhenUncertain: boolean = false,
): Promise<boolean> {
    // v367: bound the TOTAL time spent here. The cron can afford the full
    // 30 s; a LIVE request (fetchUpstreamStreaming) passes a small budget
    // so it does at most a quick status check and then proceeds to race
    // the mirror + fail fast — the old unbounded loop could sleep up to
    // ~150 s (6 × 26 s) which Cloudflare kills as a hang.
    const start = Date.now();
    const remaining = () => maxTotalMs - (Date.now() - start);
    for (let attempt = 0; attempt < 6; attempt++) {
        if (remaining() <= 0) return proceedWhenUncertain; // budget gone
        const status = await fetchOverpassStatus();
        if (!status) {
            // /api/status itself unreachable. Could be a transient
            // blip or genuine downtime — sleep briefly and try once
            // more; if still down, the LIVE path proceeds (races + fails
            // fast) while the CRON declines (skips this tick).
            if (attempt >= 1) {
                console.warn(
                    `[slot] ${label}: /api/status unreachable twice, ${proceedWhenUncertain ? "proceeding blind" : "skipping"}`,
                );
                return proceedWhenUncertain;
            }
            if (remaining() < 3000) return proceedWhenUncertain;
            await new Promise((r) => setTimeout(r, 3000));
            continue;
        }
        const m = status.match(/(\d+)\s+slots available now/i);
        const available = m ? parseInt(m[1], 10) : 0;
        if (available > 0) {
            if (attempt > 0) {
                console.log(`[slot] ${label}: slot free, proceeding`);
            }
            // v684: pacing floor for the cron path — even with a slot free,
            // don't fire back-to-back. Mirrors the laptop's inter-fetch
            // delay so a run of quick warms can't burst the mirror. The
            // live path (proceedWhenUncertain) skips the floor: a user is
            // waiting and it's already serialized by USER_SLOT_WAIT_MS.
            if (!proceedWhenUncertain) await paceCronUpstream();
            return true;
        }
        const waits = [...status.matchAll(/in\s+(\d+)\s+seconds?/gi)].map(
            (m) => parseInt(m[1], 10),
        );
        const nextFreeSec = waits.length > 0 ? Math.min(...waits) : 15;
        const waitMs = (nextFreeSec + 1) * 1000;
        if (waitMs > SLOT_WAIT_MAX_MS || waitMs > remaining()) {
            console.warn(
                `[slot] ${label}: next slot ${nextFreeSec}s away (> budget), skipping`,
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

// In-flight upstream-dedup map was removed when the on-demand path
// switched to streaming (a stream can't be re-tee'd across multiple
// Response objects, so coalescing isn't expressible). Concurrent
// requests on the same query are rare for our traffic shape; the
// worst case is two upstream fetches and an idempotent R2
// last-write-wins.

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
        // v680: the speculative name-discovery pass is OFF by default now.
        // The prewarm list is the world-cities.json seed (biggest cities)
        // PLUS organic player-driven growth (POST /api/register-area) — no
        // more resolving a bundled candidate-name backlog against Photon.
        // The code + `/admin/discover` stay for manual use; opt back in with
        // NAME_DISCOVERY_ENABLED="true".
        if (env.NAME_DISCOVERY_ENABLED === "true") {
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

        // Phase 2b: HIDING-ZONE STATIONS, per-city (v668). The hider's
        // "Hiding zones" overlay + the zone-containment lookups read
        // `/api/area-stations/<id>`; without this prewarm the FIRST load
        // in any play area went live to Overpass — and the bus-stop-heavy
        // query soft-timed-out in dense metros (the Chicago
        // "loaded-but-empty" report). Isolated per-city (NOT batched with
        // references) because the bus clause makes it too heavy to bundle
        // — the same reason body-of-water is fetched alone (v632).
        // skip-if-fresh keeps repeat ticks cheap; opt-out via
        // AREA_STATIONS_PREWARM_ENABLED="false".
        if (env.AREA_STATIONS_PREWARM_ENABLED !== "false") {
            for (const city of refCities) {
                const slotOk = await waitForOverpassSlot(
                    `stations ${city.name}`,
                );
                if (!slotOk) {
                    console.warn(
                        `[prewarm] stations ${city.name} skipped — slot wait exceeded cap`,
                    );
                    continue;
                }
                try {
                    const r = await prewarmAreaStationsForCity(
                        env,
                        city,
                        ttlMs,
                    );
                    if (r.status === "stored") {
                        console.log(
                            `[prewarm] stations ${city.name}: stored`,
                        );
                    }
                } catch (e) {
                    console.warn(`[prewarm] stations ${city.name} threw:`, e);
                }
            }
        }

        // Phase 2c: NAMED-WATER geometry, per-city (v687). The measuring
        // body-of-water elimination reads `/api/water/<id>`; without this
        // prewarm the FIRST body-of-water question in any play area went
        // live to Overpass — and the heavy `out geom` water scan
        // soft-timed-out in dense metros (the same class as the Chicago
        // bus-stop failure). Isolated per-city (NOT batched with
        // references) because the `natural=water` geometry is the heaviest
        // reference family — the reason it was pulled from the combined
        // refs query (v632). skip-if-fresh keeps repeat ticks cheap;
        // opt-out via WATER_PREWARM_ENABLED="false".
        if (env.WATER_PREWARM_ENABLED !== "false") {
            for (const city of refCities) {
                const slotOk = await waitForOverpassSlot(`water ${city.name}`);
                if (!slotOk) {
                    console.warn(
                        `[prewarm] water ${city.name} skipped — slot wait exceeded cap`,
                    );
                    continue;
                }
                try {
                    const r = await prewarmWaterForCity(env, city, ttlMs);
                    if (r.status === "stored") {
                        console.log(`[prewarm] water ${city.name}: stored`);
                    }
                } catch (e) {
                    console.warn(`[prewarm] water ${city.name} threw:`, e);
                }
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

        // Phase 4: ADJACENT-SEARCH (v268, extended v440). The wizard's
        // "extend play area to nearby municipalities" picker fires up to
        // five Overpass queries — topological adjacency (the primary
        // pass), admin-level lookup, adjacent admin relations, transit
        // stations, and (megacities only) sub-units — that are keyed
        // differently from the boundary R2 entries, so they'd otherwise
        // hit live mirrors for every curated city. Prewarming them here
        // makes the wizard's extend step near-instant for any city the
        // cron has covered.
        // v684: bound the COLD heavy adjacent curation per tick. Only the
        // first N picked cities may fully-curate their ~14 neighbours
        // (boundary+refs+stations) this tick; the rest still warm the cheap
        // adjacency queries + neighbour boundaries but defer the heavy
        // refs+stations to a later tick. Combined with the slot gate's
        // skip-on-uncertain + pacing floor, this stops a single tick from
        // queuing hundreds of cold Overpass fetches. Already-warm neighbours
        // are cheap R2 HEADs regardless, so a fully-warmed world (post
        // laptop-prewarm) isn't throttled by this. Tunable via env.
        let heavyCityBudget = parseInt(
            env.ADJACENT_HEAVY_CITIES_PER_TICK ?? "4",
            10,
        );
        if (!Number.isFinite(heavyCityBudget) || heavyCityBudget < 0) {
            heavyCityBudget = 4;
        }
        for (const city of picked) {
            if (!city.extent) continue;
            const slotOk = await waitForOverpassSlot(
                `adjacent ${city.name}`,
            );
            if (!slotOk) {
                console.warn(
                    `[prewarm] adjacent ${city.name} skipped — slot wait exceeded cap`,
                );
                continue;
            }
            const allowHeavy = heavyCityBudget > 0;
            if (allowHeavy) heavyCityBudget--;
            try {
                const r = await prewarmAdjacentSearchForCity(
                    env,
                    city,
                    ttlMs,
                    allowHeavy,
                );
                if (r.stored > 0) {
                    console.log(
                        `[prewarm] adjacent ${city.name}: stored ${r.stored}`,
                    );
                }
                // v676/v679: stamp the curation markers. `adjacentsCuratedAt`
                // = every adjacent area fully cached (boundary+refs+stations).
                // `fullyCuratedAt` = THAT plus the PRIMARY itself fully cached
                // — the single "ready to play, nothing hits Overpass" marker
                // the in-app star reflects (a star means "fully cached,
                // including adjacent areas"). We only WRITE on a state change
                // to avoid an R2 write every tick.
                if (env.ADJACENT_CURATION_ENABLED !== "false") {
                    try {
                        const v = await verifyAndStampCity(env, city, ttlMs);
                        if (v.stamped) {
                            console.log(
                                `[prewarm] ${city.name}: curation ${
                                    v.fullyCurated ? "COMPLETE (starred)" : "partial"
                                } — primary=${v.primaryCached} adjacents=${v.adjacentsCurated} (${v.neighboursTotal} neighbours)`,
                            );
                        }
                    } catch (e) {
                        console.warn(
                            `[prewarm] adjacent ${city.name} stamp check threw:`,
                            e,
                        );
                    }
                }
            } catch (e) {
                console.warn(`[prewarm] adjacent ${city.name} threw:`, e);
            }
        }

        // Phase 5: COUNTRY-SHARD REFERENCES (global prewarm). Behind
        // a feature flag — when COUNTRY_REFS_PREWARM_ENABLED isn't
        // "true" this whole pass is skipped and the per-city
        // references prewarm (Phase 2) stays the source of truth.
        //
        // Each tick warms a small rotating slice of the 214 country
        // shards. With skip-if-fresh, picking an already-warm shard is
        // a single cheap R2 read, so we OVERSAMPLE the shuffle and
        // count only shards that actually triggered an upstream fetch
        // toward the per-tick budget. Over a few days of ticks the
        // whole world warms; thereafter ticks are nearly free until
        // entries age past the (longer) country TTL.
        if (env.COUNTRY_REFS_PREWARM_ENABLED === "true") {
            // Country shards are large + slow to refetch, so they get
            // double the standard TTL — we'd rather serve slightly
            // staler national reference data than burn cron budget
            // re-warming 214 big queries every month.
            const countryTtlMs = ttlMs * 2;
            const shuffled = [...COUNTRY_SHARDS].sort(
                () => Math.random() - 0.5,
            );
            let warmed = 0;
            let checked = 0;
            for (const shard of shuffled) {
                if (warmed >= COUNTRY_REFS_PER_TICK) break;
                if (checked >= COUNTRY_REFS_MAX_CHECKS_PER_TICK) break;
                checked++;
                try {
                    const r = await prewarmCountryReferences(
                        env,
                        shard,
                        countryTtlMs,
                    );
                    if (r.status === "stored") {
                        warmed++;
                        console.log(
                            `[prewarm] country-refs ${shard.iso}: stored (${r.sizeBytes} B)`,
                        );
                    } else if (r.status === "slot-timeout") {
                        // Mirror is busy — stop this tick's country
                        // pass rather than hammering a throttled server.
                        console.warn(
                            `[prewarm] country-refs ${shard.iso}: slot timeout, ending pass`,
                        );
                        break;
                    }
                } catch (e) {
                    console.warn(
                        `[prewarm] country-refs ${shard.iso} threw:`,
                        e,
                    );
                }
            }
        }

        // Phase 6: TRANSIT ROUTES — split by sparsity (v329).
        //
        //   6a. SUBWAY/FERRY/TRAIN/TRAM/BUS per-country-shard. One
        //       shard-scope `out skel geom` fetch covers every play area
        //       in that shard via the runtime slicer (Step 2.6). Rotating
        //       slice across the ~214 shards × TRANSIT_SHARD_MODES; warm
        //       (and known-oversize, v584) shards skip cheaply. Bus joined
        //       here in v584: sparse/medium countries warm fine, dense
        //       ones (US/DE/JP) oversize-skip with a marker and fall to 6b.
        //   6b. BUS per-city. The fallback for dense countries whose
        //       country-scope bus is oversize at shard scope; the slicer's
        //       MAX_SLICE_PARSE_BYTES cap and the worker's resource budget
        //       can't take a national bus body for those. Exact-key match;
        //       cities already covered by a fresh bus shard are skipped.
        //
        // Both halves are opt-out via TRANSIT_PREWARM_ENABLED (the
        // request-time read paths use the same flag). Heavy phase, so
        // it runs LAST (never starves boundaries / references) over
        // small per-tick slices; oversized bus bodies are size-capped
        // and left to the laptop prewarmer.
        if (env.TRANSIT_PREWARM_ENABLED !== "false") {
            // 6a — transit shards.
            const shardShuffle = [...COUNTRY_SHARDS].sort(
                () => Math.random() - 0.5,
            );
            const shardSlice = shardShuffle.slice(0, TRANSIT_SHARDS_PER_TICK);
            for (const shard of shardSlice) {
                for (const routeType of TRANSIT_SHARD_MODES) {
                    try {
                        const r = await prewarmTransitForShard(
                            env,
                            shard,
                            routeType,
                            ttlMs,
                        );
                        if (
                            r.status === "stored" ||
                            r.status === "oversize-skipped"
                        ) {
                            console.log(
                                `[prewarm] transit-shard ${shard.iso} ${routeType}: ${r.status}${r.sizeBytes ? ` (${r.sizeBytes} B)` : ""}`,
                            );
                        } else if (r.status === "slot-timeout") {
                            // Mirror is busy — stop the shard pass for
                            // this tick rather than thrashing on a
                            // throttled server.
                            console.warn(
                                `[prewarm] transit-shard ${shard.iso} ${routeType}: slot timeout, ending shard pass`,
                            );
                            break;
                        }
                    } catch (e) {
                        console.warn(
                            `[prewarm] transit-shard ${shard.iso} ${routeType} threw:`,
                            e,
                        );
                    }
                }
            }

            // 6b — per-city bus.
            const transitCities = picked.filter((c) => c.extent);
            const transitSlice = [...transitCities]
                .sort(() => Math.random() - 0.5)
                .slice(0, TRANSIT_CITIES_PER_TICK);
            for (const city of transitSlice) {
                try {
                    const r = await prewarmTransitForCity(env, city, ttlMs);
                    if (r.stored > 0 || r.skippedBig > 0) {
                        console.log(
                            `[prewarm] transit-city ${city.name}: stored ${r.stored}, fresh ${r.skippedFresh}, oversized ${r.skippedBig}`,
                        );
                    }
                } catch (e) {
                    console.warn(
                        `[prewarm] transit-city ${city.name} threw:`,
                        e,
                    );
                }
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
        // HEAD allowed (v238) so the /tiles PMTiles route can answer
        // HEAD probes (the upload-verify curl, and range pre-flights).
        if (
            request.method !== "GET" &&
            request.method !== "POST" &&
            request.method !== "HEAD"
        ) {
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

        // Public, no-secret prewarm progress page. Returns aggregate
        // cache counts + a breakdown by `kind` (boundary, references,
        // adjacent-*, …) so you can watch the prewarm fill from a
        // browser. Only non-sensitive aggregates — no secrets, keys, or
        // per-query data. Memoised ~60 s so it can't be hammered into a
        // pile of R2 list calls.
        if (url.pathname === "/status" || url.pathname === "/prewarm-status") {
            return handlePublicStatus(env, cors);
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
        if (url.pathname === "/admin/prewarmed-cities") {
            return handleAdminPrewarmedCities(request, env, cors);
        }
        if (url.pathname === "/admin/adjacent-curation-status") {
            return handleAdminAdjacentCurationStatus(request, env, cors);
        }
        if (url.pathname === "/admin/verify-city") {
            return handleAdminVerifyCity(request, env, cors);
        }
        if (url.pathname === "/admin/city-neighbours") {
            return handleAdminCityNeighbours(request, env, cors);
        }
        if (url.pathname === "/admin/inspect-refs") {
            return handleAdminInspectRefs(request, env, cors);
        }
        if (url.pathname === "/admin/rediscover") {
            return handleAdminRediscover(request, env, cors);
        }
        if (url.pathname === "/admin/store-prewarmed") {
            return handleAdminStorePrewarmed(request, env, cors);
        }
        if (url.pathname === "/admin/check-fresh") {
            return handleAdminCheckFresh(request, env, cors);
        }
        if (url.pathname === "/admin/country-refs-status") {
            return handleAdminCountryRefsStatus(request, env, cors);
        }
        if (url.pathname === "/admin/prewarm-country-ref") {
            return handleAdminPrewarmCountryRef(request, env, cors);
        }
        if (url.pathname === "/admin/evict-discovered") {
            return handleAdminEvictDiscovered(request, env, cors);
        }
        if (url.pathname === "/admin/evict-query") {
            return handleAdminEvictQuery(request, env, cors);
        }
        if (url.pathname.startsWith("/tiles/")) {
            return handleTiles(request, env, cors);
        }
        if (url.pathname === "/admin/store-tile-pack") {
            return handleAdminStoreTilePack(request, env, cors);
        }
        if (url.pathname === "/admin/store-city-extent") {
            return handleAdminStoreCityExtent(request, env, cors);
        }
        if (url.pathname === "/admin/list-tile-packs") {
            return handleAdminListTilePacks(request, env, cors);
        }
        if (url.pathname === "/api/photon/forward") {
            return handlePhoton(request, env, ctx, cors, "forward");
        }
        if (url.pathname === "/api/photon/reverse") {
            return handlePhoton(request, env, ctx, cors, "reverse");
        }
        if (url.pathname === "/api/journey/arrivals") {
            return handleJourneyArrivals(request, env, ctx, cors);
        }
        if (url.pathname === "/api/travel/plan") {
            return handleTravelPlan(request, env, ctx, cors);
        }
        if (url.pathname === "/api/journey/departures") {
            return handleDepartures(request, env, ctx, cors);
        }
        if (url.pathname.startsWith("/api/refs/")) {
            const relId = parseInt(
                url.pathname.slice("/api/refs/".length),
                10,
            );
            if (!Number.isFinite(relId) || relId <= 0) {
                return new Response("bad relation id", {
                    status: 400,
                    headers: cors,
                });
            }
            // ?warm=1 → background warm of this relation's references
            // (boundary + refs) under the canonical read key. Used by the
            // client's warm-on-add and the laptop one-ring. Returns
            // immediately; the warm runs in waitUntil.
            if (url.searchParams.get("warm") === "1") {
                ctx.waitUntil(
                    warmRelationReferences(env, relId).catch((e) =>
                        console.warn(`warm r${relId} threw:`, e),
                    ),
                );
                return jsonResponse(
                    { status: "warming", relationId: relId },
                    202,
                    cors,
                );
            }
            return handleReferencesByRelation(request, env, ctx, cors, relId);
        }
        if (url.pathname.startsWith("/api/area-stations/")) {
            // /api/area-stations/<relationId>[?warm=1] (v668) — the
            // prewarmed hiding-zone STATION field, mirroring /api/refs.
            const relId = parseInt(
                url.pathname.slice("/api/area-stations/".length),
                10,
            );
            if (!Number.isFinite(relId) || relId <= 0) {
                return new Response("bad relation id", {
                    status: 400,
                    headers: cors,
                });
            }
            if (url.searchParams.get("warm") === "1") {
                ctx.waitUntil(
                    warmRelationAreaStations(env, relId).catch((e) =>
                        console.warn(`warm stations r${relId} threw:`, e),
                    ),
                );
                return jsonResponse(
                    { status: "warming", relationId: relId },
                    202,
                    cors,
                );
            }
            return handleAreaStationsByRelation(request, env, cors, relId);
        }
        if (url.pathname.startsWith("/api/water/")) {
            // /api/water/<relationId>[?warm=1] (v687) — the prewarmed
            // named-water-body geometry (`out geom` lakes/reservoirs +
            // named river/canal centrelines) for a play area, mirroring
            // /api/area-stations. The measuring body-of-water ELIMINATION
            // (heavy `out geom` water scan) reads this so a warm city
            // never runs it live — the same class of soft-timeout that
            // motivated isolating body-of-water from the combined refs
            // query (v632).
            const relId = parseInt(
                url.pathname.slice("/api/water/".length),
                10,
            );
            if (!Number.isFinite(relId) || relId <= 0) {
                return new Response("bad relation id", {
                    status: 400,
                    headers: cors,
                });
            }
            if (url.searchParams.get("warm") === "1") {
                ctx.waitUntil(
                    warmRelationWater(env, relId).catch((e) =>
                        console.warn(`warm water r${relId} threw:`, e),
                    ),
                );
                return jsonResponse(
                    { status: "warming", relationId: relId },
                    202,
                    cors,
                );
            }
            return handleWaterByRelation(request, env, cors, relId);
        }
        if (url.pathname.startsWith("/api/relation-extent/")) {
            const relId = parseInt(
                url.pathname.slice("/api/relation-extent/".length),
                10,
            );
            if (!Number.isFinite(relId) || relId <= 0) {
                return new Response("bad relation id", {
                    status: 400,
                    headers: cors,
                });
            }
            return handleRelationExtent(env, cors, relId);
        }
        if (url.pathname === "/api/warm-cities") {
            return handleWarmCities(env, cors);
        }
        if (url.pathname === "/api/seed-cities") {
            return handleSeedCities(cors);
        }
        if (url.pathname === "/api/register-area") {
            return handleRegisterArea(request, env, cors);
        }
        if (url.pathname.startsWith("/api/transit/")) {
            // /api/transit/<relationId>/<mode>[?warm=1] (v386)
            const parts = url.pathname
                .slice("/api/transit/".length)
                .split("/")
                .filter(Boolean);
            if (parts.length !== 2) {
                return new Response("bad path", { status: 400, headers: cors });
            }
            const [relStr, mode] = parts;
            const relId = parseInt(relStr, 10);
            if (!Number.isFinite(relId) || relId <= 0) {
                return new Response("bad relation id", {
                    status: 400,
                    headers: cors,
                });
            }
            // Whitelist modes so the path can't be coerced into building
            // arbitrary Overpass queries.
            if (!TRANSIT_MODES.has(mode)) {
                return new Response("bad mode", { status: 400, headers: cors });
            }
            if (url.searchParams.get("warm") === "1") {
                ctx.waitUntil(
                    warmRelationTransit(env, relId, mode).catch((e) =>
                        console.warn(`warm transit r${relId} ${mode} threw:`, e),
                    ),
                );
                return jsonResponse(
                    { status: "warming", relationId: relId, mode },
                    202,
                    cors,
                );
            }
            return handleTransitByRelation(
                request,
                env,
                ctx,
                cors,
                relId,
                mode,
            );
        }
        if (url.pathname.startsWith("/api/elevation/")) {
            return handleElevationTile(request, env, ctx, cors);
        }
        if (url.pathname.startsWith("/api/mapasset/")) {
            return handleMapAsset(request, env, ctx, cors);
        }
        if (url.pathname.startsWith("/api/railtile/")) {
            return handleRailTile(request, env, ctx, cors);
        }
        if (url.pathname.startsWith("/api/sattile/")) {
            return handleSatTile(request, env, ctx, cors);
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

        // v640: cache-only mode (`?cacheOnly=1`). Return an edge/R2 hit if
        // present (fresh OR stale — a cached boundary is fine), else a fast
        // empty `{elements:[]}` MISS — NEVER go upstream. The client's
        // worker-first boundary fetch (`fetchPolygonViaCacheWorker`) uses
        // this so a PREWARMED city's boundaries serve from R2 (zero
        // external), while an un-prewarmed area misses instantly and the
        // client falls to polygons.osm.fr — instead of the worker firing a
        // live Overpass query per neighbour (the Madrid boundary storm:
        // ~14 `relation(N);out geom;` calls hitting overpass-api.de →
        // 504/500). `cacheOnly` is a separate url param, so it doesn't
        // change the `data`-keyed R2 lookup.
        const cacheOnly = url.searchParams.get("cacheOnly") === "1";

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
        // v667 read-path self-heal: a pre-fix build may have cached an
        // Overpass soft-failure body (abort remark + empty elements)
        // under this key — Chicago's hiding-zones query sat poisoned
        // exactly like that. Small objects (a poisoned body is <1 KB
        // compressed) get decompressed + sniffed; on poison the entry
        // is deleted and the request proceeds as a full miss. The sniff
        // consumes the one-shot R2 body, so a clean small body is
        // re-served from the decoded text instead of the stream.
        let r2HitText: string | null = null;
        if (r2Hit && r2Hit.size <= ABORT_SNIFF_MAX_GZ_BYTES) {
            try {
                const text = await readR2BodyText(r2Hit);
                if (isAbortedOverpassText(text)) {
                    console.warn(
                        "[interpreter] poisoned cache entry (abort remark) — deleting + treating as miss",
                    );
                    ctx.waitUntil(
                        env.CACHE.delete(`overpass/${cacheKey}`).catch(
                            () => {},
                        ),
                    );
                    r2Hit = null;
                } else {
                    r2HitText = text;
                }
            } catch (e) {
                // Body stream already consumed — can't serve it anymore;
                // treat as a miss.
                console.warn(
                    "[interpreter] R2 abort sniff failed — treating as miss:",
                    e,
                );
                r2Hit = null;
            }
        }
        if (r2Hit) {
            const hit = r2Hit;
            const cachedAt = parseInt(
                hit.customMetadata?.cachedAt ?? "0",
                10,
            );
            const age = Date.now() - cachedAt;
            // Serve the hit — from the sniff's decoded text when the
            // body stream was consumed, else streamed straight through.
            const serveR2 = (xStatus: string): Response =>
                r2HitText !== null
                    ? new Response(r2HitText, {
                          status: 200,
                          headers: {
                              ...corsHeadersAsObject(cors),
                              "Content-Type": "application/json",
                              "Cache-Control": `public, max-age=${CACHE_API_TTL_SECS}`,
                              "X-Cache": xStatus,
                              "X-Cache-Age-Ms": String(age),
                          },
                      })
                    : buildR2Response(hit, cors, xStatus, age);
            if (cachedAt && age < ttlMs) {
                // Pass R2's body stream straight to the client,
                // honouring its encoding metadata so a gzip-stored
                // entry serves with `Content-Encoding: gzip`. The
                // edge cache write was historically here, but for the
                // streaming path we skip it: edge cache requires a
                // re-readable body and `R2ObjectBody` is one-shot.
                // R2 reads within Cloudflare are single-digit ms, so
                // the win was modest anyway.
                return serveR2("R2_HIT");
            }
            // Stale. In cache-only mode serve the stale hit as-is (a
            // slightly-old boundary is fine, and we must not go upstream);
            // otherwise refresh upstream.
            if (cacheOnly) {
                return serveR2("R2_STALE_CACHEONLY");
            }
            // Stale — refresh upstream and stream gzip → tee → [R2,
            // client]. Falls back to the stale R2 hit if every mirror
            // is sad.
            const refreshResp = await fetchUpstreamStreaming(
                env,
                ctx,
                cacheKey,
                query,
                cors,
                "MISS_REFRESH",
            );
            if (refreshResp) return refreshResp;
            return serveR2("R2_STALE_FALLBACK");
        }

        // v640: cache-only miss — nothing cached and we must not go
        // upstream. Return an empty `{elements:[]}` 200 (same shape a real
        // empty result has) so the caller cleanly detects "not cached" and
        // falls back to its own source. WITH cors, so it's never a
        // CORS-less error.
        if (cacheOnly) {
            return new Response(
                JSON.stringify({ elements: [], cache: "miss" }),
                {
                    status: 200,
                    headers: {
                        ...corsHeadersAsObject(cors),
                        "Content-Type": "application/json",
                        "X-Cache": "MISS_CACHEONLY",
                    },
                },
            );
        }

        // Step 2.5 — country-shard slicing. No exact cache entry, but
        // if this is the combined-references query and its bbox sits
        // inside a prewarmed country shard, derive the answer by
        // filtering the shard's cached response instead of going
        // upstream. Behind the same flag as the prewarm cron so we
        // never read shards that aren't being warmed. Any failure is a
        // clean fall-through to Step 3.
        if (env.COUNTRY_REFS_PREWARM_ENABLED === "true") {
            let sliced: SlicedResult | null = null;
            try {
                sliced = await trySliceFromCountryShard(query, env);
            } catch (e) {
                console.warn("country-refs slice threw, falling through:", e);
            }
            if (sliced) {
                const resp = new Response(JSON.stringify(sliced.body), {
                    status: 200,
                    headers: {
                        ...corsHeadersAsObject(cors),
                        "Content-Type": "application/json",
                        "Cache-Control": `public, max-age=${CACHE_API_TTL_SECS}`,
                        "X-Cache": "SLICED",
                        "X-Cache-Shard": sliced.shardIso,
                    },
                });
                // Seed the edge cache so a re-ask of the same play-area
                // bbox skips the shard fetch + parse entirely.
                ctx.waitUntil(edgeCache.put(cacheApiKey, resp.clone()));
                return resp;
            }
        }

        // Step 2.6 — transit-route shard slicing (v329). Same shape as
        // 2.5, different shard space: queries for any TRANSIT_SHARD_MODES
        // route (subway/ferry/train/tram, and bus since v584) get sliced
        // out of `transit-routes/v1/<iso>/<routeType>/all`. A bus query in
        // a DENSE country has no shard entry (it oversize-skipped at warm
        // time) so it cleanly falls through to the per-city exact-key path
        // (Step 2) / live miss (Step 3). Same opt-out flag as the per-city
        // bus prewarm (`TRANSIT_PREWARM_ENABLED`) so the runtime read path
        // stays consistent with the cron writes.
        if (env.TRANSIT_PREWARM_ENABLED !== "false") {
            let sliced: SlicedResult | null = null;
            try {
                sliced = await trySliceFromTransitShard(query, env);
            } catch (e) {
                console.warn(
                    "transit-shard slice threw, falling through:",
                    e,
                );
            }
            if (sliced) {
                const resp = new Response(JSON.stringify(sliced.body), {
                    status: 200,
                    headers: {
                        ...corsHeadersAsObject(cors),
                        "Content-Type": "application/json",
                        "Cache-Control": `public, max-age=${CACHE_API_TTL_SECS}`,
                        "X-Cache": "SLICED",
                        "X-Cache-Shard": `${sliced.shardIso}/transit`,
                    },
                });
                ctx.waitUntil(edgeCache.put(cacheApiKey, resp.clone()));
                return resp;
            }
        }

        // Step 3 — full miss. Stream upstream → gzip → tee → [R2,
        // client]. No buffering, so NYC-scale bodies are fine.
        const missResp = await fetchUpstreamStreaming(
            env,
            ctx,
            cacheKey,
            query,
            cors,
            "MISS",
        );
        if (missResp) return missResp;
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

/* ─────────────────────── Fetch helpers ─────────────────────── */

/** Race all upstream mirrors in parallel. First mirror to
 *  return a 200 wins; all others get aborted so we don't waste
 *  upstream resources finishing their downloads. Falls back to
 *  null if every mirror errors or times out.
 *
 *  Why race instead of serial? Serial (3 × 20 s = 60 s worst case)
 *  would keep a user waiting far too long AND, when this was on the
 *  Free plan, blow past its ~30 s wall-clock cap. Parallel resolves in
 *  max(per-mirror RTT) — typically 2–10 s when at least one mirror is
 *  healthy. Still the right call on Paid: it's about user-facing
 *  latency, not just the old plan limit. */
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

async function fetchFromMirrorChain(
    query: string,
    timeoutMs: number = UPSTREAM_TIMEOUT_MS,
): Promise<Response | null> {
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
    racers.push(() => fetchFromOverpassMirrors(query, timeoutMs));

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
    timeoutMs: number = UPSTREAM_TIMEOUT_MS,
): Promise<Response | null> {
    const encoded = encodeURIComponent(query);
    const controllers = OVERPASS_MIRRORS.map(() => new AbortController());
    const timers: ReturnType<typeof setTimeout>[] = controllers.map((c) =>
        setTimeout(() => c.abort(), timeoutMs),
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
    timeoutMs: number = UPSTREAM_TIMEOUT_MS,
): Promise<Response | null> {
    const t0 = Date.now();
    const first = await fetchFromMirrorChain(query, timeoutMs);
    if (first) return first;
    if (Date.now() - t0 > 6000) return null;
    await new Promise((r) => setTimeout(r, 1200));
    return await fetchFromMirrorChain(query, timeoutMs);
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
/**
 * Stream an upstream Overpass response through gzip → tee → [R2 put,
 * client Response]. Returns the Response (built from the client-side
 * tee branch with `Content-Encoding: gzip` already set), or null if
 * every mirror failed.
 *
 * This replaced the old buffering `fetchAndCacheUpstream` that did
 * `await upstream.text()` to materialise the entire body, then cloned
 * it again into the edge cache. For an NYC-bus-sized payload that's
 * 2-3× the body in heap, which tripped Cloudflare error 1102 "Worker
 * exceeded resource limits". The streaming pipeline holds only the
 * compressor's internal buffer (KBs) at a time.
 *
 * In-flight deduplication is intentionally dropped — coalescing a
 * stream across multiple Response objects isn't possible (tee gives
 * two branches, not N). For our traffic shape concurrent requests on
 * the same query are rare; the worst case is two upstream fetches and
 * an idempotent R2 last-write-wins.
 */
async function fetchUpstreamStreaming(
    env: Env,
    ctx: ExecutionContext,
    cacheKey: string,
    query: string,
    cors: HeadersInit,
    status: string,
): Promise<Response | null> {
    // Wait for an open Overpass execution slot before racing the mirror
    // chain. This is LOAD-BEARING: without it, user-facing cold fetches
    // hit overpass-api.de while it's throttled, get an instant 429, and
    // bursting through the 429 keeps the slots pinned — making the
    // throttling WORSE. We keep pacing through the slot gate; v367 only
    // bounds how LONG the live path is willing to wait (USER_SLOT_WAIT_MS)
    // so a wedged /api/status can't hang the request into a CORS-less 500.
    // When the budget runs out we proceed and race the mirror anyway —
    // the mirror race is itself abort-bounded (UPSTREAM_TIMEOUT_MS), so
    // the whole call still resolves. The cron keeps the full 30 s budget.
    // v684: `true` = proceed-blind when uncertain (a user is waiting); the
    // cron callers keep the default (skip on uncertainty).
    await waitForOverpassSlot(`user-fetch ${status}`, USER_SLOT_WAIT_MS, true);
    // v696: user path uses the SHORTER timeout so slot-wait + race stays
    // under Cloudflare's ~30 s wall-clock (else the isolate is killed with a
    // CORS-less 500 that hard-blocks the browser instead of a clean 502).
    const upstream = await upstreamSemaphore.run(() =>
        fetchFromMirrorChainWithRetry(query, USER_UPSTREAM_TIMEOUT_MS),
    );
    if (!upstream) return null;
    return streamCompressIntoR2(env, ctx, cacheKey, upstream, {}, cors, status);
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
    // v667: an aborted body (Overpass soft timeout) must not be stored —
    // it would poison the key for CACHE_TTL_DAYS.
    if (isAbortedOverpassText(body)) {
        return { status: "upstream-failed" };
    }
    try {
        const { rawBytes } = await compressAndStoreString(env, cacheKey, body, {
            ...(sourceName ? { sourceName } : {}),
            sourceRelationId: String(relationId),
            prewarmed: "true",
        });
        return { status: "stored", sizeBytes: rawBytes };
    } catch (e) {
        console.warn("R2 put failed during prewarm:", e);
        return { status: "stored", sizeBytes: body.length };
    }
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
            await compressAndStoreString(env, cacheKey, body, {
                ...(city?.name ? { sourceName: city.name } : {}),
                sourceRelationId: String(id),
                prewarmed: "true",
                kind: "batched",
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
 * Walk an Overpass `out geom` boundary response for the min/max of every
 * coordinate and return it as a Photon-shaped extent
 * `[maxLat, minLng, minLat, maxLng]`. Byte-identical in result to the
 * laptop prewarm's `extentFromBoundaryResponse` (same source data, same
 * min/max) — interior member nodes (admin_centre / label) can't push the
 * bbox outward, so this agrees with the client's `turf.bbox(polyGeoJSON)`
 * too. v356: this is the canonical reference extent every warmer + the
 * client now share. Returns null on no usable coordinate.
 */
function extentFromBoundaryJson(
    parsed: unknown,
): [number, number, number, number] | null {
    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLng = Infinity;
    let maxLng = -Infinity;
    let found = false;
    const consume = (lat: number, lon: number) => {
        if (typeof lat !== "number" || typeof lon !== "number") return;
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
        if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return;
        found = true;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (lon < minLng) minLng = lon;
        if (lon > maxLng) maxLng = lon;
    };
    const visit = (node: any) => {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) {
            if (
                node.length >= 2 &&
                typeof node[0] === "number" &&
                typeof node[1] === "number"
            ) {
                consume(node[1], node[0]); // GeoJSON [lon, lat]
                return;
            }
            for (const child of node) visit(child);
            return;
        }
        if (typeof node.lat === "number" && typeof node.lon === "number") {
            consume(node.lat, node.lon); // Overpass {lat, lon}
        }
        if (node.geometry) visit(node.geometry);
        if (node.members) visit(node.members);
        if (node.elements) visit(node.elements);
        if (node.coordinates) visit(node.coordinates);
    };
    visit(parsed);
    if (!found) return null;
    return [maxLat, minLng, minLat, maxLng];
}

/**
 * Resolve a city's CANONICAL reference extent from the boundary the cron
 * already warmed into R2 (`relation(N);out geom;`). Falls back to the
 * stored `city.extent` only when the boundary isn't cached / unparseable.
 * v356: keeps the cron's reference cache keys aligned with the client and
 * the laptop prewarm, both of which key off the boundary geometry.
 */
async function canonicalReferenceExtent(
    env: Env,
    city: CityEntry,
): Promise<[number, number, number, number] | null> {
    try {
        const key = await r2KeyForQuery(singleRelationQuery(city.relationId));
        const obj = await env.CACHE.get(`overpass/${key}`);
        if (obj) {
            const text = await readR2Text(obj);
            if (text) {
                const derived = extentFromBoundaryJson(JSON.parse(text));
                if (derived) return derived;
            }
        }
    } catch {
        /* fall through to stored extent */
    }
    return city.extent ?? null;
}

/**
 * `GET /api/relation-extent/<id>` — the SINGLE canonical source for the
 * adjacent-area `around:` centroid (v640). Returns the stored `city.extent`
 * for a curated relation — the exact value `prewarmAdjacentSearchForCity`
 * builds its band/stations queries from (both read it via
 * `getPopularCities`) — so the client and the cron consume ONE number
 * instead of each deriving their own bbox from geometry. This is the
 * relation-ID pattern from the v359 /api/refs fix, applied to adjacency:
 * it removes the "two producers of the same coordinate" drift the 3-dp
 * rounding band-aid was papering over. Falls back to a live
 * polygons.osm.fr bbox for uncurated relations (never prewarmed, so exact
 * agreement is moot). Extent order: Photon-style [maxLat, minLng, minLat,
 * maxLng].
 */
/**
 * `GET /api/warm-cities` (public) — the relation ids of the cities that are
 * set up for fast, prewarmed play (v641): curated/discovered cities that
 * have a backfilled `extent`, which is the gate for the reference +
 * adjacency prewarm. The app stars matching play-area search results so a
 * user can see at a glance which regions load without touching Overpass.
 * Cheap (in-memory `getPopularCities`), public, and CDN/browser-cached — it
 * changes only slowly (as cities are discovered/backfilled). Does NOT leak
 * live cache contents; it's just "which cities do we prewarm".
 */
async function handleWarmCities(
    env: Env,
    cors: HeadersInit,
): Promise<Response> {
    let ids: number[] = [];
    // The star means "FULLY cached, including adjacent areas" (v679, kept as
    // the default). A star is a PROMISE: selecting a starred city offers
    // adding its adjacent areas, so if those aren't warm the player hits
    // live-Overpass errors mid-game — a broken promise. So a city is warm
    // ONLY once the cron/laptop has stamped `fullyCuratedAt` (the PRIMARY's
    // boundary+refs+stations AND every adjacent area all present in R2). It
    // takes time to warm every adjacent of the whole seed, but the operator
    // runs the laptop continuously and we get there — sparse-but-truthful
    // beats broad-but-lying. (The v690 primary-only default was reverted:
    // it dropped the adjacency guarantee the star exists to make.) Escape
    // hatch: `WARM_STAR_LENIENT="true"` reverts to the extent-only star
    // (broader, appears sooner, but NOT a full-cache guarantee) — intended
    // only as a temporary fallback. The separate `primaryCuratedAt` stamp is
    // a DIAGNOSTIC (surfaced in /admin/adjacent-curation-status so the
    // operator can watch primary-progress vs full-progress), never the star.
    const lenient = env.WARM_STAR_LENIENT === "true";
    try {
        const cities = await getPopularCities(env);
        ids = cities
            .filter((c) => {
                if (typeof c.relationId !== "number") return false;
                if (lenient)
                    return Array.isArray(c.extent) && c.extent.length === 4;
                return typeof c.fullyCuratedAt === "number";
            })
            .map((c) => c.relationId);
    } catch (e) {
        console.warn("warm-cities lookup failed:", e);
    }
    return jsonResponse({ count: ids.length, ids }, 200, {
        ...corsHeadersAsObject(cors),
        "Cache-Control": "public, max-age=3600",
    });
}

/**
 * `GET /api/seed-cities` (public) — the relation ids of the bundled
 * world-cities SEED (the top-N biggest cities). Distinct from
 * `/api/warm-cities` (which is the FULLY-CACHED subset, sparse): the seed is
 * the "which relations are major cities" signal, known immediately from the
 * bundle, so the play-area search can float a same-named big city above a
 * village WITHOUT waiting on the cron backfill. Changes only on deploy
 * (bundled), so it's long-cached. v681.
 */
function handleSeedCities(cors: HeadersInit): Response {
    const ids = SEED_CITIES.filter(
        (c) => typeof c.relationId === "number" && c.relationId > 0,
    ).map((c) => c.relationId);
    return jsonResponse({ count: ids.length, ids }, 200, {
        ...corsHeadersAsObject(cors),
        // Bundled + deploy-stable → cache hard.
        "Cache-Control": "public, max-age=21600",
    });
}

async function handleRelationExtent(
    env: Env,
    cors: HeadersInit,
    relId: number,
): Promise<Response> {
    try {
        const cities = await getPopularCities(env);
        const hit = cities.find(
            (c) =>
                c.relationId === relId &&
                Array.isArray(c.extent) &&
                c.extent.length === 4,
        );
        if (hit?.extent) {
            return jsonResponse(
                { relationId: relId, extent: hit.extent, source: "curated" },
                200,
                cors,
            );
        }
    } catch (e) {
        console.warn(`relation-extent city lookup failed r${relId}:`, e);
    }
    const extent = await bboxFromRelation(relId).catch(() => null);
    return jsonResponse(
        { relationId: relId, extent, source: extent ? "derived" : null },
        200,
        cors,
    );
}

/**
 * GET /api/refs/<relationId> — fetch prewarmed per-city references by
 * STABLE relation-id key instead of the byte-fragile SHA-256(query) key.
 *
 * v359. The per-city references live under
 * `overpass/<sha256(buildReferenceBboxQuery(extent))>`, where `extent`
 * is the boundary-geometry bbox. For the client to hit that entry it had
 * to reproduce the exact bbox to 3 decimals — which broke every time the
 * client's bbox source (Photon extent, land-clipped polygon, un-hydrated
 * boundary) drifted from the laptop's raw-boundary min/max. That single
 * fragile contract caused the v356/357/358 churn.
 *
 * This endpoint moves the bbox derivation SERVER-SIDE: given only the
 * relation id, the worker reads the boundary it already has in R2,
 * derives the identical bbox the prewarm used (same canonicalReferenceExtent
 * → extentFromBoundaryJson walk over the same bytes), rebuilds the same
 * query, and serves the existing entry. The client never computes a bbox,
 * so it cannot drift.
 *
 * Read-only by design: on any miss (no boundary cached yet, or no
 * reference entry) it returns `{ elements: [] }` with a cache marker so
 * the client falls back to its own bbox query — which, for a genuinely
 * un-warmed area, goes upstream anyway (there's no warmed entry to miss).
 * Warming stays the laptop/cron's job; this never fetches upstream, so it
 * can't hit the resource limits that the user-facing interpreter path can.
 */
async function handleReferencesByRelation(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
    cors: HeadersInit,
    relationId: number,
): Promise<Response> {
    if (request.method !== "GET") {
        return new Response("Method not allowed", {
            status: 405,
            headers: cors,
        });
    }
    const ext = await canonicalReferenceExtent(env, {
        relationId,
        name: "",
    } as CityEntry);
    if (!ext) {
        // Boundary not cached yet → can't derive the key. Client falls back.
        return jsonResponse({ elements: [], cache: "no-boundary" }, 200, cors);
    }
    const query = buildReferenceBboxQuery(ext);
    const cacheKey = await r2KeyForQuery(query);

    // Edge cache first (keyed on the derived interpreter URL, so a hit
    // here is shared with the /api/interpreter path for the same bbox).
    const cacheApiKey = new Request(
        `${new URL(request.url).origin}/api/interpreter?data=${encodeURIComponent(query)}`,
        { method: "GET" },
    );
    const edgeCache = caches.default;
    const edgeHit = await edgeCache.match(cacheApiKey);
    if (edgeHit) return appendCacheStatus(edgeHit, cors, "EDGE_HIT_RELATION");

    let r2Hit: R2ObjectBody | null = null;
    try {
        r2Hit = await env.CACHE.get(`overpass/${cacheKey}`);
    } catch (e) {
        console.warn("refs-by-relation: R2 get failed:", e);
    }
    if (r2Hit) {
        const cachedAt = parseInt(r2Hit.customMetadata?.cachedAt ?? "0", 10);
        const age = cachedAt ? Date.now() - cachedAt : 0;
        // References change slowly; serve whatever's present regardless of
        // TTL freshness (the cron/laptop refresh handles staleness). A
        // present-but-stale entry still beats a live Overpass round trip.
        return buildR2Response(r2Hit, cors, "R2_HIT_RELATION", age);
    }
    return jsonResponse({ elements: [], cache: "miss" }, 200, cors);
}

/**
 * Stream an upstream response into R2 at a full key WITHOUT a client tee
 * (v359). The user-facing path tees so it can serve + cache in one pass;
 * a background warm has no client, so it skips the tee entirely — fetch →
 * gzip → R2, holding only the compressor's KB-scale buffer. This avoids
 * both suspected causes of the interpreter-path resource kill (the
 * client-tee back-pressure and a full-body buffer).
 */
async function streamStoreNoTee(
    env: Env,
    fullKey: string,
    upstream: Response,
    metadata: R2WriteMetadata,
): Promise<boolean> {
    if (!upstream.body) return false;
    try {
        const compressed = upstream.body.pipeThrough(
            new CompressionStream(STORAGE_ENCODING),
        );
        await env.CACHE.put(fullKey, compressed, {
            customMetadata: {
                cachedAt: String(Date.now()),
                encoding: STORAGE_ENCODING,
                prewarmed: "true",
                ...metadata,
            },
        });
        return true;
    } catch (e) {
        console.warn(`warm store failed for ${fullKey}:`, e);
        return false;
    }
}

/**
 * Background warm of a single relation's references, keyed canonically so
 * a later GET /api/refs/<id> hits it (v359). Ensures the boundary is
 * cached first (it's the bbox source), derives the same extent the read
 * path derives, then warms the references under the identical key.
 *
 * Idempotent + polite: skips when the references entry is already fresh,
 * and routes every upstream fetch through the slot gate + semaphore the
 * cron uses, so a burst of warm-on-add calls can't hammer the mirrors.
 * Fire-and-forget via ctx.waitUntil; all failures are swallowed (a warm
 * miss just means the client falls back to its on-tap path, as before).
 */
async function warmRelationReferences(
    env: Env,
    relationId: number,
): Promise<void> {
    const ttlMs =
        (parseInt(env.CACHE_TTL_DAYS, 10) || 30) * 24 * 60 * 60 * 1000;

    // 1. Ensure the boundary geometry is cached — it's the bbox source.
    const boundaryQuery = singleRelationQuery(relationId);
    const boundaryKey = await r2KeyForQuery(boundaryQuery);
    let boundaryObj: R2ObjectBody | null = null;
    try {
        boundaryObj = await env.CACHE.get(`overpass/${boundaryKey}`);
    } catch {
        /* miss */
    }
    if (!boundaryObj) {
        if (!(await waitForOverpassSlot(`warm-boundary r${relationId}`))) {
            return;
        }
        const up = await upstreamSemaphore.run(() =>
            fetchFromMirrorChainWithRetry(boundaryQuery),
        );
        if (!up) return;
        const ok = await streamStoreNoTee(env, `overpass/${boundaryKey}`, up, {
            kind: "boundary",
            warmedBy: "on-add",
            sourceRelationId: String(relationId),
        });
        if (!ok) return;
        try {
            boundaryObj = await env.CACHE.get(`overpass/${boundaryKey}`);
        } catch {
            return;
        }
        if (!boundaryObj) return;
    }

    // 2. Derive the canonical extent (identical walk to the read path).
    let ext: [number, number, number, number] | null = null;
    try {
        const text = await readR2Text(boundaryObj);
        if (text) ext = extentFromBoundaryJson(JSON.parse(text));
    } catch {
        /* unparseable boundary — give up */
    }
    if (!ext) return;

    // 3. Warm the references under the canonical key, skip-if-fresh.
    const refsQuery = buildReferenceBboxQuery(ext);
    const refsKey = await r2KeyForQuery(refsQuery);
    try {
        const head = await env.CACHE.head(`overpass/${refsKey}`);
        if (head) {
            const cachedAt = parseInt(
                head.customMetadata?.cachedAt ?? "0",
                10,
            );
            if (cachedAt && Date.now() - cachedAt < ttlMs) return; // fresh
        }
    } catch {
        /* head miss — warm below */
    }
    if (!(await waitForOverpassSlot(`warm-refs r${relationId}`))) return;
    const up = await upstreamSemaphore.run(() =>
        fetchFromMirrorChainWithRetry(refsQuery),
    );
    if (!up) return;
    await streamStoreNoTee(env, `overpass/${refsKey}`, up, {
        kind: "references",
        warmedBy: "on-add",
        sourceRelationId: String(relationId),
    });
}

/**
 * GET /api/area-stations/<relationId> — the prewarmed hiding-zone STATION
 * field for a play area, by STABLE relation-id key (v668). The hider's
 * "Hiding zones" overlay + the map-tap/zone-picker "which zone am I in"
 * lookups read this so a starred city's stations paint from R2 with zero
 * live Overpass — closing the last un-prewarmed hiding-zones surface
 * (the Chicago "loaded but empty" report was a heavy, un-prewarmed
 * bus-stop scan soft-timing-out on the client's live poly query).
 *
 * Mirrors `handleReferencesByRelation` exactly: derives the SAME
 * boundary-geometry extent (`canonicalReferenceExtent`), rebuilds the
 * one station query, and serves the existing entry. Read-only — any miss
 * returns `{ elements: [] }` so the client falls back to its live poly
 * query (which is what it did before). All modes are returned; the
 * client filters to the game's allowed set.
 */
async function handleAreaStationsByRelation(
    request: Request,
    env: Env,
    cors: HeadersInit,
    relationId: number,
): Promise<Response> {
    if (request.method !== "GET") {
        return new Response("Method not allowed", {
            status: 405,
            headers: cors,
        });
    }
    const ext = await canonicalReferenceExtent(env, {
        relationId,
        name: "",
    } as CityEntry);
    if (!ext) {
        return jsonResponse({ elements: [], cache: "no-boundary" }, 200, cors);
    }
    const query = buildAreaStationsBboxQuery(ext);
    const cacheKey = await r2KeyForQuery(query);

    const cacheApiKey = new Request(
        `${new URL(request.url).origin}/api/interpreter?data=${encodeURIComponent(query)}`,
        { method: "GET" },
    );
    const edgeCache = caches.default;
    const edgeHit = await edgeCache.match(cacheApiKey);
    if (edgeHit) return appendCacheStatus(edgeHit, cors, "EDGE_HIT_RELATION");

    let r2Hit: R2ObjectBody | null = null;
    try {
        r2Hit = await env.CACHE.get(`overpass/${cacheKey}`);
    } catch (e) {
        console.warn("area-stations-by-relation: R2 get failed:", e);
    }
    if (r2Hit) {
        const cachedAt = parseInt(r2Hit.customMetadata?.cachedAt ?? "0", 10);
        const age = cachedAt ? Date.now() - cachedAt : 0;
        // Stations change slowly; serve present-but-stale rather than a
        // live round trip (the cron/laptop refresh handles staleness).
        return buildR2Response(r2Hit, cors, "R2_HIT_RELATION", age);
    }
    return jsonResponse({ elements: [], cache: "miss" }, 200, cors);
}

/**
 * Background warm of one relation's hiding-zone station field, keyed
 * canonically so a later GET /api/area-stations/<id> hits it (v668).
 * Mirrors `warmRelationReferences`: ensure the boundary (the bbox
 * source), derive the same extent the read path derives, then warm the
 * station query under the identical key. Buffered + abort-guarded (the
 * bus-heavy body is the most likely to soft-time-out) so a timed-out
 * body is never stored. Fire-and-forget; failures are swallowed.
 */
async function warmRelationAreaStations(
    env: Env,
    relationId: number,
): Promise<void> {
    const ttlMs =
        (parseInt(env.CACHE_TTL_DAYS, 10) || 30) * 24 * 60 * 60 * 1000;

    // 1. Ensure the boundary geometry is cached — it's the bbox source.
    const boundaryQuery = singleRelationQuery(relationId);
    const boundaryKey = await r2KeyForQuery(boundaryQuery);
    let boundaryObj: R2ObjectBody | null = null;
    try {
        boundaryObj = await env.CACHE.get(`overpass/${boundaryKey}`);
    } catch {
        /* miss */
    }
    if (!boundaryObj) {
        if (!(await waitForOverpassSlot(`warm-boundary(st) r${relationId}`))) {
            return;
        }
        const up = await upstreamSemaphore.run(() =>
            fetchFromMirrorChainWithRetry(boundaryQuery),
        );
        if (!up) return;
        const ok = await streamStoreNoTee(env, `overpass/${boundaryKey}`, up, {
            kind: "boundary",
            warmedBy: "on-add-stations",
            sourceRelationId: String(relationId),
        });
        if (!ok) return;
        try {
            boundaryObj = await env.CACHE.get(`overpass/${boundaryKey}`);
        } catch {
            return;
        }
        if (!boundaryObj) return;
    }

    // 2. Derive the canonical extent (identical walk to the read path).
    let ext: [number, number, number, number] | null = null;
    try {
        const text = await readR2Text(boundaryObj);
        if (text) ext = extentFromBoundaryJson(JSON.parse(text));
    } catch {
        /* unparseable boundary — give up */
    }
    if (!ext) return;

    // 3. Warm the stations under the canonical key, skip-if-fresh.
    const stationsQuery = buildAreaStationsBboxQuery(ext);
    const stationsKey = await r2KeyForQuery(stationsQuery);
    try {
        const head = await env.CACHE.head(`overpass/${stationsKey}`);
        if (head) {
            const cachedAt = parseInt(
                head.customMetadata?.cachedAt ?? "0",
                10,
            );
            if (cachedAt && Date.now() - cachedAt < ttlMs) return; // fresh
        }
    } catch {
        /* head miss — warm below */
    }
    if (!(await waitForOverpassSlot(`warm-stations r${relationId}`))) return;
    const up = await upstreamSemaphore.run(() =>
        fetchFromMirrorChainWithRetry(stationsQuery),
    );
    if (!up) return;
    const body = await up.text();
    // v667/v668: never store an aborted body (Overpass soft timeout).
    if (isAbortedOverpassText(body)) return;
    try {
        await compressAndStoreString(env, stationsKey, body, {
            kind: "area-stations",
            warmedBy: "on-add",
            sourceRelationId: String(relationId),
        });
    } catch (e) {
        console.warn(`warm area-stations r${relationId} store failed:`, e);
    }
}

/** Per-city hiding-zone station field — the combined all-mode stop query
 *  for a city's bbox, keyed identically to the read endpoint. Isolated
 *  (its own query, not batched with references) because the bus-stop
 *  clause makes it heavy in dense metros — the same reason
 *  `body-of-water` is fetched alone (v632). */
async function prewarmAreaStationsForCity(
    env: Env,
    city: CityEntry,
    ttlMs: number,
): Promise<{ status: string }> {
    const ext = await canonicalReferenceExtent(env, city);
    if (!ext) return { status: "skipped-no-extent" };
    return prewarmQuery(
        env,
        buildAreaStationsBboxQuery(ext),
        city,
        ttlMs,
        "area-stations",
    );
}

/**
 * GET /api/water/<relationId> — the prewarmed named-water-body geometry
 * for a play area, by STABLE relation-id key (v687). The measuring
 * body-of-water ELIMINATION reads this so a warm city serves the heavy
 * `out geom` water scan from R2 with zero live Overpass — closing the
 * last per-question-type live hole for starred cities.
 *
 * Mirrors `handleAreaStationsByRelation` exactly: derives the SAME
 * boundary-geometry extent (`canonicalReferenceExtent`), rebuilds the one
 * water query, and serves the existing entry. Read-only — any miss returns
 * `{ elements: [] }` so the client falls back to its live poly query.
 */
async function handleWaterByRelation(
    request: Request,
    env: Env,
    cors: HeadersInit,
    relationId: number,
): Promise<Response> {
    if (request.method !== "GET") {
        return new Response("Method not allowed", {
            status: 405,
            headers: cors,
        });
    }
    const ext = await canonicalReferenceExtent(env, {
        relationId,
        name: "",
    } as CityEntry);
    if (!ext) {
        return jsonResponse({ elements: [], cache: "no-boundary" }, 200, cors);
    }
    const query = buildWaterBboxQuery(ext);
    const cacheKey = await r2KeyForQuery(query);

    const cacheApiKey = new Request(
        `${new URL(request.url).origin}/api/interpreter?data=${encodeURIComponent(query)}`,
        { method: "GET" },
    );
    const edgeCache = caches.default;
    const edgeHit = await edgeCache.match(cacheApiKey);
    if (edgeHit) return appendCacheStatus(edgeHit, cors, "EDGE_HIT_RELATION");

    let r2Hit: R2ObjectBody | null = null;
    try {
        r2Hit = await env.CACHE.get(`overpass/${cacheKey}`);
    } catch (e) {
        console.warn("water-by-relation: R2 get failed:", e);
    }
    if (r2Hit) {
        const cachedAt = parseInt(r2Hit.customMetadata?.cachedAt ?? "0", 10);
        const age = cachedAt ? Date.now() - cachedAt : 0;
        // Water bodies change slowly; serve present-but-stale rather than a
        // live round trip (the cron/laptop refresh handles staleness).
        return buildR2Response(r2Hit, cors, "R2_HIT_RELATION", age);
    }
    return jsonResponse({ elements: [], cache: "miss" }, 200, cors);
}

/**
 * Background warm of one relation's named-water geometry, keyed
 * canonically so a later GET /api/water/<id> hits it (v687). Mirrors
 * `warmRelationAreaStations`: ensure the boundary (the bbox source),
 * derive the same extent the read path derives, then warm the water
 * query under the identical key. Buffered + abort-guarded (the `out geom`
 * water body is heavy) so a timed-out body is never stored.
 */
async function warmRelationWater(
    env: Env,
    relationId: number,
): Promise<void> {
    const ttlMs =
        (parseInt(env.CACHE_TTL_DAYS, 10) || 30) * 24 * 60 * 60 * 1000;

    // 1. Ensure the boundary geometry is cached — it's the bbox source.
    const boundaryQuery = singleRelationQuery(relationId);
    const boundaryKey = await r2KeyForQuery(boundaryQuery);
    let boundaryObj: R2ObjectBody | null = null;
    try {
        boundaryObj = await env.CACHE.get(`overpass/${boundaryKey}`);
    } catch {
        /* miss */
    }
    if (!boundaryObj) {
        if (!(await waitForOverpassSlot(`warm-boundary(wt) r${relationId}`))) {
            return;
        }
        const up = await upstreamSemaphore.run(() =>
            fetchFromMirrorChainWithRetry(boundaryQuery),
        );
        if (!up) return;
        const ok = await streamStoreNoTee(env, `overpass/${boundaryKey}`, up, {
            kind: "boundary",
            warmedBy: "on-add-water",
            sourceRelationId: String(relationId),
        });
        if (!ok) return;
        try {
            boundaryObj = await env.CACHE.get(`overpass/${boundaryKey}`);
        } catch {
            return;
        }
        if (!boundaryObj) return;
    }

    // 2. Derive the canonical extent (identical walk to the read path).
    let ext: [number, number, number, number] | null = null;
    try {
        const text = await readR2Text(boundaryObj);
        if (text) ext = extentFromBoundaryJson(JSON.parse(text));
    } catch {
        /* unparseable boundary — give up */
    }
    if (!ext) return;

    // 3. Warm the water set under the canonical key, skip-if-fresh.
    const waterQuery = buildWaterBboxQuery(ext);
    const waterKey = await r2KeyForQuery(waterQuery);
    try {
        const head = await env.CACHE.head(`overpass/${waterKey}`);
        if (head) {
            const cachedAt = parseInt(
                head.customMetadata?.cachedAt ?? "0",
                10,
            );
            if (cachedAt && Date.now() - cachedAt < ttlMs) return; // fresh
        }
    } catch {
        /* head miss — warm below */
    }
    if (!(await waitForOverpassSlot(`warm-water r${relationId}`))) return;
    const up = await upstreamSemaphore.run(() =>
        fetchFromMirrorChainWithRetry(waterQuery),
    );
    if (!up) return;
    const body = await up.text();
    // Never store an aborted body (Overpass soft timeout).
    if (isAbortedOverpassText(body)) return;
    try {
        await compressAndStoreString(env, waterKey, body, {
            kind: "water",
            warmedBy: "on-add",
            sourceRelationId: String(relationId),
        });
    } catch (e) {
        console.warn(`warm water r${relationId} store failed:`, e);
    }
}

/** Per-city named-water geometry — the `out geom` water query for a
 *  city's bbox, keyed identically to the read endpoint. Isolated (its own
 *  query, never batched with references) because the `natural=water`
 *  geometry scan is the heaviest reference family in a dense metro — the
 *  same reason it was excluded from the combined refs query (v632). */
async function prewarmWaterForCity(
    env: Env,
    city: CityEntry,
    ttlMs: number,
): Promise<{ status: string }> {
    const ext = await canonicalReferenceExtent(env, city);
    if (!ext) return { status: "skipped-no-extent" };
    return prewarmQuery(
        env,
        buildWaterBboxQuery(ext),
        city,
        ttlMs,
        "water",
    );
}

/**
 * GET /api/transit/<relationId>/<mode> — fetch prewarmed per-city transit
 * routes by STABLE relation-id key instead of the byte-fragile
 * SHA-256(query) key.
 *
 * v386. Mirrors handleReferencesByRelation. The per-city transit entries
 * live under `overpass/<sha256(transitRouteQuery(extent, mode))>`, where
 * `extent` is the boundary-geometry bbox the laptop derives from the same
 * raw OSM boundary response that this worker has in R2. The CLIENT was
 * building that bbox from polyGeoJSON (which is LAND-CLIPPED — Toronto on
 * Lake Ontario loses the water vertices), so client bbox bytes ≠ laptop
 * bbox bytes ≠ R2 key, and a perfectly-prewarmed Toronto-bus entry sat
 * unused while the client went live to Overpass for a many-second fetch
 * (with no spinner visible if the parse-then-clip path blocks the main
 * thread). This endpoint derives the bbox SERVER-SIDE from the boundary,
 * builds the identical query the laptop stored under, computes the same
 * SHA, and serves.
 *
 * Read-only: any miss (no boundary cached, or no prewarmed transit entry)
 * returns `{ elements: [] }` so the client falls back to its existing
 * bbox-query path — which is what it would have done anyway. Warming
 * stays the laptop's job (see `warmRelationTransit` below for the
 * `?warm=1` variant).
 */
async function handleTransitByRelation(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
    cors: HeadersInit,
    relationId: number,
    mode: string,
): Promise<Response> {
    if (request.method !== "GET") {
        return new Response("Method not allowed", {
            status: 405,
            headers: cors,
        });
    }
    const ext = await canonicalReferenceExtent(env, {
        relationId,
        name: "",
    } as CityEntry);
    if (!ext) {
        return jsonResponse({ elements: [], cache: "no-boundary" }, 200, cors);
    }
    const query = transitRouteQuery(ext, mode);
    const cacheKey = await r2KeyForQuery(query);

    // Edge cache first — shared with the /api/interpreter path via the
    // canonical query URL so a hit warms both routes' read paths.
    const cacheApiKey = new Request(
        `${new URL(request.url).origin}/api/interpreter?data=${encodeURIComponent(query)}`,
        { method: "GET" },
    );
    const edgeCache = caches.default;
    const edgeHit = await edgeCache.match(cacheApiKey);
    if (edgeHit) return appendCacheStatus(edgeHit, cors, "EDGE_HIT_RELATION");

    let r2Hit: R2ObjectBody | null = null;
    try {
        r2Hit = await env.CACHE.get(`overpass/${cacheKey}`);
    } catch (e) {
        console.warn("transit-by-relation: R2 get failed:", e);
    }
    if (r2Hit) {
        const cachedAt = parseInt(r2Hit.customMetadata?.cachedAt ?? "0", 10);
        const age = cachedAt ? Date.now() - cachedAt : 0;
        // Transit data changes slowly; serve whatever's present regardless
        // of TTL — mirror the references endpoint's read policy.
        return buildR2Response(r2Hit, cors, "R2_HIT_RELATION", age);
    }
    return jsonResponse({ elements: [], cache: "miss" }, 200, cors);
}

/**
 * Background warm of one (relation, mode) transit entry, keyed canonically
 * so a later GET /api/transit/<id>/<mode> hits it. Mirrors
 * warmRelationReferences (v360): ensures the boundary is cached, derives
 * the same extent, builds the identical query, fetches once, stores under
 * the canonical SHA. Skip-if-fresh + slot-gated + semaphore'd, same
 * politeness contract as the references warmer.
 */
async function warmRelationTransit(
    env: Env,
    relationId: number,
    mode: string,
): Promise<void> {
    if (!TRANSIT_MODES.has(mode)) return;
    const ttlMs =
        (parseInt(env.CACHE_TTL_DAYS, 10) || 30) * 24 * 60 * 60 * 1000;

    // 1. Ensure the boundary geometry is cached.
    const boundaryQuery = singleRelationQuery(relationId);
    const boundaryKey = await r2KeyForQuery(boundaryQuery);
    let boundaryObj: R2ObjectBody | null = null;
    try {
        boundaryObj = await env.CACHE.get(`overpass/${boundaryKey}`);
    } catch {
        /* miss */
    }
    if (!boundaryObj) {
        if (!(await waitForOverpassSlot(`warm-boundary r${relationId}`))) {
            return;
        }
        const up = await upstreamSemaphore.run(() =>
            fetchFromMirrorChainWithRetry(boundaryQuery),
        );
        if (!up) return;
        const ok = await streamStoreNoTee(env, `overpass/${boundaryKey}`, up, {
            kind: "boundary",
            warmedBy: "on-add-transit",
            sourceRelationId: String(relationId),
        });
        if (!ok) return;
        try {
            boundaryObj = await env.CACHE.get(`overpass/${boundaryKey}`);
        } catch {
            return;
        }
        if (!boundaryObj) return;
    }

    // 2. Derive the canonical extent — identical walk to the read path.
    let ext: [number, number, number, number] | null = null;
    try {
        const text = await readR2Text(boundaryObj);
        if (text) ext = extentFromBoundaryJson(JSON.parse(text));
    } catch {
        /* unparseable boundary — give up */
    }
    if (!ext) return;

    // 3. Warm the transit entry under the canonical key, skip-if-fresh.
    const tQuery = transitRouteQuery(ext, mode);
    const tKey = await r2KeyForQuery(tQuery);
    try {
        const head = await env.CACHE.head(`overpass/${tKey}`);
        if (head) {
            const cachedAt = parseInt(
                head.customMetadata?.cachedAt ?? "0",
                10,
            );
            if (cachedAt && Date.now() - cachedAt < ttlMs) return; // fresh
        }
    } catch {
        /* head miss — warm below */
    }
    if (
        !(await waitForOverpassSlot(`warm-transit r${relationId} ${mode}`))
    ) {
        return;
    }
    const up = await upstreamSemaphore.run(() =>
        fetchFromMirrorChainWithRetry(tQuery),
    );
    if (!up) return;
    await streamStoreNoTee(env, `overpass/${tKey}`, up, {
        kind: `transit-${mode}`,
        warmedBy: "on-add-transit",
        sourceRelationId: String(relationId),
    });
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

    // v356: resolve each city's CANONICAL reference extent (the boundary
    // geometry the cron warmed into R2) up front, so every reference key
    // this batch writes matches what the client now looks up. Falls back
    // to the stored `city.extent` when the boundary isn't cached yet.
    const extentByRelation = new Map<number, [number, number, number, number]>();
    for (const city of cities) {
        const ext = await canonicalReferenceExtent(env, city);
        if (ext) extentByRelation.set(city.relationId, ext);
    }

    // Skip already-fresh cities to avoid wasted upstream work.
    const stale: CityEntry[] = [];
    const perCityKey = new Map<number, string>();
    for (const city of cities) {
        const ext = extentByRelation.get(city.relationId);
        if (!ext) continue;
        const singleQuery = buildReferenceBboxQuery(ext);
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
        const bbox = paddedBboxCorners(
            extentByRelation.get(city.relationId)!,
            PAD_KM,
        );
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
        bbox: paddedBboxCorners(extentByRelation.get(city.relationId)!, PAD_KM),
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
            await compressAndStoreString(env, cacheKey, body, {
                sourceName: cb.city.name,
                sourceRelationId: String(cb.city.relationId),
                prewarmed: "true",
                kind: "references",
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
    // v685: `~"^consulate"` catches `diplomatic=consulate` AND
    // `consulate_general` (excludes `honorary_consul`) — a bare
    // `="consulate"` found 0 in Oslo. Byte-identical to the client's
    // apiLocationFilter("consulate") in src/maps/api/constants.ts.
    { family: "api:consulate", filter: '["diplomatic"~"^consulate"]' },
    { family: "api:golf_course", filter: '["leisure"="golf_course"]' },
    { family: "api:hospital", filter: '["amenity"="hospital"]' },
    { family: "api:library", filter: '["amenity"="library"]' },
    { family: "api:museum", filter: '["tourism"="museum"]' },
    { family: "api:park", filter: '["leisure"="park"]' },
    { family: "api:peak", filter: '["natural"="peak"]' },
    { family: "api:theme_park", filter: '["tourism"="theme_park"]' },
    { family: "api:zoo", filter: '["tourism"="zoo"]' },
    // NOTE: `body-of-water` (`["natural"="water"]["name"]`) is
    // DELIBERATELY absent from the combined reference query (v632).
    // Its huge multipolygon geometry (the Seine, canals, thousands of
    // named ponds) timed the whole Paris/Île-de-France reference warm
    // out upstream, which broke the cron prewarm AND tripped Overpass
    // rate limits on every Paris play-area pick. The client fetches it
    // lazily and in isolation (`runSingleFamilyBboxFetch` in
    // playAreaPrefetch.ts) — keep this list in lockstep with the
    // client's `STANDARD_REFERENCE_FAMILIES`.
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

/**
 * How many country shards to actually WARM (trigger an upstream
 * fetch for) per cron tick. Country references queries are heavy
 * (30–180 s each), so this is deliberately small — at 2/tick and
 * hourly cron, the full 214-shard world warms in ~4–5 days, then
 * skip-if-fresh keeps subsequent ticks nearly free.
 */
const COUNTRY_REFS_PER_TICK = 2;

/**
 * Upper bound on how many shards we'll even CHECK (cheap R2 read)
 * per tick while hunting for COUNTRY_REFS_PER_TICK that need
 * warming. Stops a tick where most shards are already fresh from
 * walking all 214 entries just to find two stale ones — once the
 * world is warm, a tick checks at most this many and moves on.
 */
const COUNTRY_REFS_MAX_CHECKS_PER_TICK = 30;

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

/* ───────────────── Transit-route prewarm (Phase 6) ───────────────── *
 *
 * v329 splits this by sparsity:
 *
 *   - SUBWAY + FERRY → per-country-shard, sliced at request time.
 *     Sparse globally (~50 countries have a subway, ~80 have ferries)
 *     and dense within them, so one country-scope `out skel geom`
 *     fetch is small (a few MB reduced) and covers every play area
 *     in the country — uncurated suburbs included.
 *   - BUS → per-city, exact-key match (no slicing). NYC bus alone is
 *     ~91 MB raw; a country-wide bus query blows both the worker's
 *     resource budget and the slicer's MAX_SLICE_PARSE_BYTES cap.
 *     Stays warmed only for the curated cities; mega-metros bigger
 *     than the size cap fall to the laptop prewarmer.
 *
 * All three modes share the SAME query template — only the route value
 * differs — so the canonicaliser (querySlicing.ts) strips the bbox and
 * we get one stable fingerprint per route. v328's `(s,w,n,e)`-on-the-
 * filter form is replaced by the `[bbox:s,w,n,e]` global-setting form
 * used everywhere else (reference template etc.) so the existing
 * `extractBbox` + canonicaliser already match it without special-casing.
 * KEEP THESE THREE IN LOCKSTEP (same pad, same toFixed(3), same
 * whitespace, same setting order) — any drift makes the key miss:
 *   - buildTransitBboxTuple + fetchTransitRelations  (client, transitRoutes.ts)
 *   - transitBboxTuple + transitRouteQuery           (laptop-prewarm.mjs)
 *   - the helpers below                              (this cron)
 */
/** Modes warmed at country-shard scope and sliced at request time.
 *  v334 added train + tram. v584 added bus. All are denser than
 *  subway/ferry but still tractable per-shard for the great majority of
 *  countries — the rare mega-network (German DB, Japan JR, US metro
 *  bus) exceeds the 20 MB reduce cap and skips, recording an oversize
 *  marker (so it isn't re-queried every TTL cycle) and falling through
 *  to the per-city / live path. Worst-case behaviour: the colored
 *  overlay shows nothing for those countries on first ask, and the
 *  per-query exact-key R2 cache fills as users tap. */
const TRANSIT_SHARD_MODES = ["subway", "ferry", "train", "tram", "bus"] as const;
/** Modes warmed per-city (exact-key match — no slicing). Bus stays here
 *  as the fallback for DENSE countries whose country-scope bus query is
 *  oversize at shard scope (US/DE/JP curated cities); sparse-country
 *  cities are skipped here because the shard slice already serves them
 *  (see prewarmTransitForCity). */
const TRANSIT_CITY_MODES = ["bus"] as const;
/** All transit modes valid on the public /api/transit/<id>/<mode> route. */
const TRANSIT_MODES: ReadonlySet<string> = new Set([
    ...TRANSIT_SHARD_MODES,
    ...TRANSIT_CITY_MODES,
]);
const TRANSIT_BBOX_PAD_KM = 5;
/** Decimation ceiling — must equal MAX_VERTICES in transitRoutes.ts and
 *  laptop-prewarm.mjs so prewarmed + on-demand renders are identical. */
const TRANSIT_MAX_VERTICES = 50;
/**
 * Hard ceiling on the RAW upstream transit body we'll buffer + reduce
 * inside the worker. The reduce step needs the whole response in heap
 * to JSON.parse it, and parsed Overpass JSON runs ~3-5× the text size;
 * the streaming-into-R2 path exists precisely because `.text()` on an
 * NYC-bus-sized body (≈90 MB) trips Cloudflare error 1102. 20 MB raw →
 * ~80-100 MB parsed leaves headroom under the 128 MB isolate limit.
 * Anything bigger is skipped here and left to the laptop prewarmer
 * (Node, GBs of RAM) / the live on-tap path. Subway + ferry are tiny
 * everywhere; only dense mega-metro bus networks exceed this. */
const MAX_TRANSIT_REDUCE_BYTES = 20 * 1024 * 1024;
/** Cities to prewarm BUS transit for per cron tick. v329 dropped this
 *  from "3 modes per city" to "bus only per city" since subway/ferry
 *  moved to per-shard, so each tick does less per-city work and we can
 *  cover the curated bus list faster. Long-tail mega-metro bus is
 *  still left to the laptop prewarmer (size-cap fall-through). */
const TRANSIT_CITIES_PER_TICK = 3;

/** Country shards to prewarm transit (subway + ferry) for per cron
 *  tick. Each shard tick does up to TRANSIT_SHARD_MODES.length upstream
 *  fetches, so this slice times the shard-warm cadence. With ~214
 *  shards × 2 modes / 3 shards per hourly tick the world warms in
 *  ~3 days from cold, then skip-if-fresh keeps subsequent ticks cheap.
 *  Many shards (countries with no subway, no ferry) will store nothing
 *  but still consume an Overpass slot — keep this small. */
const TRANSIT_SHARDS_PER_TICK = 3;

/** Byte-identical to `buildTransitBboxTuple` (transitRoutes.ts) and
 *  `transitBboxTuple` (laptop-prewarm.mjs). extent is
 *  [maxLat, minLng, minLat, maxLng]. */
function transitBboxTuple(
    extent: [number, number, number, number],
): string {
    const [maxLat, minLng, minLat, maxLng] = extent;
    const south = minLat;
    const west = minLng;
    const north = maxLat;
    const east = maxLng;
    const latPad = TRANSIT_BBOX_PAD_KM / 111;
    const midLat = (south + north) / 2;
    const lngPad =
        TRANSIT_BBOX_PAD_KM / (111 * Math.cos((midLat * Math.PI) / 180));
    const s = (south - latPad).toFixed(3);
    const w = (west - lngPad).toFixed(3);
    const n = (north + latPad).toFixed(3);
    const e = (east + lngPad).toFixed(3);
    return `${s},${w},${n},${e}`;
}

/** Byte-identical to `fetchTransitRelations`'s query string. The newline
 *  framing is load-bearing — the SHA-256 R2 key includes it. v329:
 *  bbox moved to the `[bbox:...]` global setting form so the existing
 *  query canonicaliser (querySlicing.ts) strips it during template-
 *  fingerprint computation. */
function transitRouteQuery(
    extent: [number, number, number, number],
    routeType: string,
): string {
    const tuple = transitBboxTuple(extent);
    return `\n[out:json][timeout:180][bbox:${tuple}];\nrelation["route"="${routeType}"];\nout skel geom;\n`;
}

/** Cron-side shard query. Same template as `transitRouteQuery`, with
 *  the country-shard bbox in place of the city extent. Stored under
 *  `transitShardKey(iso, routeType)` (not the query-hash space) so it's
 *  read by the slicing path, not the exact-key lookup. */
function transitShardQuery(
    shardBbox: [number, number, number, number],
    routeType: string,
): string {
    // CountryShard.bbox is GeoJSON-order [minLng, minLat, maxLng, maxLat];
    // Overpass wants `s,w,n,e`. Match the per-city 3-decimal precision so
    // the shard query is also tractable at Overpass's parser.
    const [w, s, e, n] = shardBbox;
    const sf = s.toFixed(3);
    const wf = w.toFixed(3);
    const nf = n.toFixed(3);
    const ef = e.toFixed(3);
    return `\n[out:json][timeout:180][bbox:${sf},${wf},${nf},${ef}];\nrelation["route"="${routeType}"];\nout skel geom;\n`;
}

/** Decimate a way's geometry to TRANSIT_MAX_VERTICES points, same
 *  stride algorithm as the client + laptop reducer so the stored
 *  geometry matches an on-demand fetch. Rounds to 5 decimals (~1 m). */
function decimateTransitGeom(
    geom: Array<{ lat: number; lon: number }>,
): Array<{ lat: number; lon: number }> {
    const round5 = (x: number) => Math.round(x * 1e5) / 1e5;
    const n = geom.length;
    let pts: Array<{ lat: number; lon: number }>;
    if (n <= TRANSIT_MAX_VERTICES) {
        pts = geom;
    } else {
        const stride = Math.ceil(n / TRANSIT_MAX_VERTICES);
        pts = [];
        for (let i = 0; i < n; i += stride) pts.push(geom[i]);
        const last = geom[n - 1];
        const tail = pts[pts.length - 1];
        if (tail.lat !== last.lat || tail.lon !== last.lon) pts.push(last);
    }
    return pts.map((p) => ({ lat: round5(p.lat), lon: round5(p.lon) }));
}

/**
 * Shrink a raw transit Overpass response, keeping the SAME Overpass
 * JSON shape so the client parser reads it unchanged. Mirror of
 * `reduceTransitResponse` in laptop-prewarm.mjs: dedupe ways by ref,
 * decimate geometry, round coords, collapse to one synthetic relation
 * (the client draws each way as a bare LineString, so route grouping
 * is discarded anyway). A dense bus network shrinks from tens of MB to
 * a few hundred KB, which is what lets us store it at all.
 */
function reduceTransitResponse(text: string): {
    text: string;
    wayCount: number;
} {
    const parsed = JSON.parse(text) as {
        version?: unknown;
        generator?: unknown;
        osm3s?: unknown;
        elements?: Array<{
            type: string;
            members?: Array<{
                type?: string;
                ref?: number;
                geometry?: Array<{ lat: number; lon: number }>;
            }>;
        }>;
    };
    const seen = new Set<number>();
    const members: Array<{
        type: "way";
        ref: number | undefined;
        geometry: Array<{ lat: number; lon: number }>;
    }> = [];
    for (const el of parsed.elements ?? []) {
        if (el.type !== "relation") continue;
        for (const m of el.members ?? []) {
            if (m.type !== "way") continue;
            if (!Array.isArray(m.geometry) || m.geometry.length < 2) continue;
            if (m.ref !== undefined) {
                if (seen.has(m.ref)) continue;
                seen.add(m.ref);
            }
            members.push({
                type: "way",
                ref: m.ref,
                geometry: decimateTransitGeom(m.geometry),
            });
        }
    }
    const reduced = {
        version: parsed.version,
        generator: parsed.generator,
        osm3s: parsed.osm3s,
        elements: [{ type: "relation", id: 0, tags: {}, members }],
    };
    return { text: JSON.stringify(reduced), wayCount: members.length };
}

/**
 * Read a Response body to text but abort once it exceeds `capBytes`,
 * returning null instead of buffering the whole thing. This is the
 * memory guard that lets the worker reduce transit responses without
 * risking the OOM the streaming path was built to avoid: we accumulate
 * decoded chunks, and the moment the running total crosses the cap we
 * cancel the stream and bail. The skipped (oversized) city stays
 * covered by the laptop prewarmer / live path.
 */
async function readBodyCapped(
    resp: Response,
    capBytes: number,
): Promise<string | null> {
    if (!resp.body) {
        // No stream to meter — fall back to a plain read, but only when
        // a Content-Length (if present) is within cap.
        const len = parseInt(resp.headers.get("content-length") ?? "0", 10);
        if (Number.isFinite(len) && len > capBytes) return null;
        const text = await resp.text();
        return text.length > capBytes ? null : text;
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let total = 0;
    let out = "";
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > capBytes) {
                await reader.cancel();
                return null;
            }
            out += decoder.decode(value, { stream: true });
        }
        out += decoder.decode();
        return out;
    } catch {
        try {
            await reader.cancel();
        } catch {
            /* already closed */
        }
        return null;
    }
}

/**
 * Prewarm the per-CITY transit overlays. v329 scopes this to bus only
 * (TRANSIT_CITY_MODES) — subway + ferry are warmed per-shard instead
 * and sliced at request time. Reduces server-side before storing so
 * the client reads a few hundred KB instead of tens of MB. Per-mode
 * skip-if-fresh; oversized raw bodies (mega-metro bus) are skipped via
 * the readBodyCapped guard rather than OOM-ing the worker.
 */
async function prewarmTransitForCity(
    env: Env,
    city: CityEntry,
    ttlMs: number,
): Promise<{ stored: number; skippedFresh: number; skippedBig: number }> {
    let stored = 0;
    let skippedFresh = 0;
    let skippedBig = 0;
    if (!city.extent) return { stored, skippedFresh, skippedBig };
    for (const routeType of TRANSIT_CITY_MODES) {
        // v584: skip per-city bus when the city's containing shard already
        // holds a fresh bus shard entry — the runtime slicer serves the
        // city from there, so a redundant per-city Overpass fetch only
        // adds load. (Dense countries oversize-skip at shard scope, so
        // their cities have no fresh shard entry and still warm here.)
        if (routeType === "bus") {
            // CityEntry.extent is Photon order [maxLat, minLng, minLat,
            // maxLng]; findContainingShard wants GeoJSON [w, s, e, n].
            const shard = findContainingShard([
                city.extent[1],
                city.extent[2],
                city.extent[3],
                city.extent[0],
            ]);
            if (shard) {
                try {
                    const shardObj = await env.CACHE.get(
                        transitShardKey(shard.iso, "bus"),
                    );
                    if (shardObj) {
                        const at = parseInt(
                            shardObj.customMetadata?.cachedAt ?? "0",
                            10,
                        );
                        if (at && Date.now() - at < ttlMs) {
                            skippedFresh++;
                            continue;
                        }
                    }
                } catch {
                    /* fall through to the per-city warm */
                }
            }
        }
        const query = transitRouteQuery(city.extent, routeType);
        const cacheKey = await r2KeyForQuery(query);
        // Skip if a fresh entry already exists.
        try {
            const hit = await env.CACHE.get(`overpass/${cacheKey}`);
            if (hit) {
                const cachedAt = parseInt(
                    hit.customMetadata?.cachedAt ?? "0",
                    10,
                );
                if (cachedAt && Date.now() - cachedAt < ttlMs) {
                    skippedFresh++;
                    continue;
                }
            }
        } catch (e) {
            console.warn(
                `R2 get failed during transit prewarm (${city.name} ${routeType}):`,
                e,
            );
        }
        // Each mode is its own upstream round-trip; pace through the
        // shared slot gate so a transit batch can't starve live traffic.
        const slotOk = await waitForOverpassSlot(
            `transit ${city.name} ${routeType}`,
        );
        if (!slotOk) continue;
        const upstream = await upstreamSemaphore.run(() =>
            fetchFromMirrorChainWithRetry(query),
        );
        if (!upstream) continue;
        const raw = await readBodyCapped(upstream, MAX_TRANSIT_REDUCE_BYTES);
        if (raw === null) {
            skippedBig++;
            console.warn(
                `[prewarm] transit ${city.name} ${routeType}: response over ${MAX_TRANSIT_REDUCE_BYTES} B cap — skipping (laptop prewarmer covers it)`,
            );
            continue;
        }
        let reduced: { text: string; wayCount: number };
        try {
            reduced = reduceTransitResponse(raw);
        } catch (e) {
            console.warn(
                `[prewarm] transit ${city.name} ${routeType} reduce failed:`,
                e,
            );
            continue;
        }
        try {
            await compressAndStoreString(env, cacheKey, reduced.text, {
                sourceName: `${city.name} (${routeType})`,
                sourceRelationId: String(city.relationId),
                prewarmed: "true",
                kind: "transit",
            });
            stored++;
        } catch (e) {
            console.warn(
                `R2 put failed during transit prewarm (${city.name} ${routeType}):`,
                e,
            );
        }
    }
    return { stored, skippedFresh, skippedBig };
}

/**
 * Prewarm ONE (shard, routeType) transit response into R2 under
 * `transit-routes/v1/<iso>/<routeType>/all`. Used for subway + ferry
 * (TRANSIT_SHARD_MODES) — sparse modes where a whole-country
 * `out skel geom` is small enough to reduce + store under the
 * MAX_TRANSIT_REDUCE_BYTES cap. Stored at the shard key (not the
 * query-hash key) because the runtime slicer reads by shard, not by
 * exact-query match. Skip-if-fresh; oversize → skipped, the laptop
 * prewarmer covers it.
 */
async function prewarmTransitForShard(
    env: Env,
    shard: CountryShard,
    routeType: string,
    ttlMs: number,
): Promise<{ status: string; ageMs?: number; sizeBytes?: number }> {
    const key = transitShardKey(shard.iso, routeType);
    let r2Hit: R2ObjectBody | null = null;
    try {
        r2Hit = await env.CACHE.get(key);
    } catch (e) {
        console.warn(
            `R2 get failed during transit-shard prewarm (${shard.iso} ${routeType}):`,
            e,
        );
    }
    if (r2Hit) {
        const cachedAt = parseInt(r2Hit.customMetadata?.cachedAt ?? "0", 10);
        const ageMs = Date.now() - cachedAt;
        if (cachedAt && ageMs < ttlMs) {
            return { status: "skipped-fresh", ageMs };
        }
    }
    // v584: oversize marker. Bus (a shard mode since v584) is tractable
    // at country scope for sparse/medium countries but blows the
    // MAX_TRANSIT_REDUCE_BYTES cap for dense ones (US/DE/JP). Without a
    // marker we'd re-issue the doomed country-scope query every TTL cycle
    // and burn an Overpass slot for nothing. A prior oversize verdict (a
    // tiny sibling object) lets later ticks skip cheaply; it expires on
    // the same TTL so a network that genuinely shrinks gets re-tried.
    const oversizeKey = `${key}__oversize`;
    try {
        const marker = await env.CACHE.get(oversizeKey);
        if (marker) {
            const markedAt = parseInt(
                marker.customMetadata?.cachedAt ?? "0",
                10,
            );
            if (markedAt && Date.now() - markedAt < ttlMs) {
                return {
                    status: "skipped-oversize",
                    ageMs: Date.now() - markedAt,
                };
            }
        }
    } catch (e) {
        console.warn(
            `R2 get failed for transit-shard oversize marker (${shard.iso} ${routeType}):`,
            e,
        );
    }
    const slotOk = await waitForOverpassSlot(
        `transit-shard ${shard.iso} ${routeType}`,
    );
    if (!slotOk) return { status: "slot-timeout" };
    const query = transitShardQuery(shard.bbox, routeType);
    const upstream = await upstreamSemaphore.run(() =>
        fetchFromMirrorChainWithRetry(query),
    );
    if (!upstream) return { status: "upstream-failed" };
    const raw = await readBodyCapped(upstream, MAX_TRANSIT_REDUCE_BYTES);
    if (raw === null) {
        // Record the oversize verdict so the next TTL cycle skips this
        // (shard, mode) without another doomed upstream fetch.
        try {
            await env.CACHE.put(oversizeKey, "1", {
                customMetadata: {
                    cachedAt: String(Date.now()),
                    kind: "transit-shard-oversize",
                    shardIso: shard.iso,
                    routeType,
                },
            });
        } catch {
            /* best-effort marker — a re-fetch next tick is the only cost */
        }
        return { status: "oversize-skipped" };
    }
    let reduced: { text: string; wayCount: number };
    try {
        reduced = reduceTransitResponse(raw);
    } catch (e) {
        console.warn(
            `transit-shard reduce failed (${shard.iso} ${routeType}):`,
            e,
        );
        return { status: "reduce-failed" };
    }
    try {
        const { rawBytes } = await compressAndStoreAtKey(
            env,
            key,
            reduced.text,
            {
                sourceName: `${shard.label} (${routeType})`,
                shardIso: shard.iso,
                prewarmed: "true",
                kind: "transit-shard",
                wayCount: String(reduced.wayCount),
            },
        );
        return { status: "stored", sizeBytes: rawBytes };
    } catch (e) {
        console.warn(
            `R2 put failed during transit-shard prewarm (${shard.iso} ${routeType}):`,
            e,
        );
        return { status: "r2-put-failed" };
    }
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
 * Hiding-zone STOP selectors, byte-identical (as a set) to the client's
 * `HIDING_ZONE_FILTERS_BY_MODE` in src/lib/gameSetup.ts, enumerated for
 * ALL transit modes. The hiding-zones overlay fetches every mode and
 * filters to the game's allowed set client-side, so ONE prewarmed
 * station set per city covers every allowed-mode subset. Keep in
 * lockstep with the client's per-mode filters.
 *
 * Byte-identity is entirely WITHIN this worker: `buildAreaStationsBboxQuery`
 * is the single producer used by BOTH the prewarm and the read endpoint's
 * key derivation. The client never builds this query — it hits
 * `/api/area-stations/<id>` and gets the served set — so there's no
 * cross-codebase drift (the same lesson as the v359 /api/refs endpoint).
 */
const AREA_STATION_FILTERS: string[] = [
    "[railway=station][subway=yes]",
    "[station=subway]",
    "[railway=station][subway!=yes]",
    "[railway=halt]",
    "[railway=tram_stop]",
    "[railway=halt][light_rail=yes]",
    "[highway=bus_stop]",
    "[amenity=ferry_terminal]",
    "[public_transport=platform][platform=ferry]",
];

/** Hiding zones sit INSIDE the play area, so the station bbox needs no
 *  reference-style 50 km pad — a small pad just catches boundary-edge
 *  stops. Keeping it small also keeps the (bus-heavy) query lighter. */
const AREA_STATION_PAD_KM = 2;

/**
 * Build the combined hiding-zone STATION query for a play area's bbox.
 * `[timeout:180]` (not the interpreter default) because a dense metro's
 * bus-stop scan is heavy and we want every second Overpass will give
 * before it soft-aborts — the exact Chicago failure that motivated
 * prewarming this. Same `buildBboxFilter` + `out center` shape as the
 * reference query so the derived R2 key is stable.
 */
function buildAreaStationsBboxQuery(
    extent: [number, number, number, number],
): string {
    const bboxFilter = buildBboxFilter(extent, AREA_STATION_PAD_KM);
    const body = AREA_STATION_FILTERS.map((f) => `nwr${f};`).join("\n");
    return `
[out:json][timeout:180]${bboxFilter};
(
${body}
);
out center;
`;
}

/**
 * Named-water filters for the measuring body-of-water ELIMINATION.
 * MUST stay byte-identical to the client's live-fallback query:
 *   - primary filter + first alternative in `measuring.ts` (case
 *     "body-of-water"), and
 *   - `filterForFamily("body-of-water")` in `playAreaPrefetch.ts`.
 * MAJOR named bodies only — the `["water"!~...]` exclusion drops the
 * minor/artificial subtypes (ponds, basins, pools, fountains, moats,
 * tanks, ditches, wastewater) that flood a dense metro (v685); the
 * second filter adds named river/canal centrelines (mapped as lines,
 * not areas). Rulebook p11: "any named body of water … excluding pools".
 */
const WATER_FILTERS: string[] = [
    '["natural"="water"]["name"]["water"!~"pond|basin|pool|fountain|wastewater|moat|tank|ditch"]',
    // v690: NO `["name"]` on the line filter — OSM tags a river's name on
    // only some segments, so per-segment name-gating left the overlay
    // skipping unnamed segments of an obvious river. Type filter still
    // excludes drains/streams/ditches. Keep byte-identical to measuring.ts
    // + laptop-prewarm.mjs + NearestReferencePreview.tsx.
    '["waterway"~"^(river|canal)$"]',
];

/** Small pad like the station field — the play area plus a touch of its
 *  surroundings, so a shore just outside the boundary still counts as the
 *  nearest body of water (rulebook p17), without ballooning the heavy
 *  `out geom` scan the way a reference-style 50 km pad would. */
const WATER_PAD_KM = 2;

/**
 * Build the named-water GEOMETRY query for a play area's bbox. `out geom`
 * (not `out center`) so the client gets full lake/river shore geometry for
 * the seeker-distance buffer, matching what the live poly query returns.
 * `[timeout:180]` because the `natural=water` geometry scan is the heaviest
 * reference family in a dense metro (the reason it's isolated — v632).
 */
function buildWaterBboxQuery(
    extent: [number, number, number, number],
): string {
    const bboxFilter = buildBboxFilter(extent, WATER_PAD_KM);
    const body = WATER_FILTERS.map((f) => `nwr${f};`).join("\n");
    return `
[out:json][timeout:180]${bboxFilter};
(
${body}
);
out geom;
`;
}

/**
 * Build the combined-references query for a whole country shard.
 *
 * Differs from `buildReferenceBboxQuery` in two ways:
 *   - Input bbox is GeoJSON order [minLng, minLat, maxLng, maxLat]
 *     (the shard table's convention) rather than Photon extent.
 *   - timeout:180 instead of 120 — country-scale bbox queries are
 *     slow and we want every second Overpass will give us before it
 *     kills the request server-side.
 *
 * The query string itself is internal: the slicing path reads the
 * STORED RESPONSE (filtered by bbox at request time), not this
 * query, so it doesn't need to byte-match any client template.
 */
function buildCountryReferencesQuery(
    bbox: [number, number, number, number],
): string {
    const [w, s, e, n] = bbox;
    const sf = s.toFixed(3);
    const wf = w.toFixed(3);
    const nf = n.toFixed(3);
    const ef = e.toFixed(3);
    const body = REFERENCE_FAMILY_FILTERS.map(
        ({ filter }) => `nwr${filter};`,
    ).join("\n");
    return `
[out:json][timeout:180][bbox:${sf},${wf},${nf},${ef}];
(
${body}
);
out center;
`;
}

/**
 * Prewarm one country shard's combined-references response into R2
 * under `country-refs/v1/<iso>/all`. Skips when a fresh entry
 * already exists. The slicing path (Phase 6) reads this object and
 * filters elements to a play-area bbox, so any play area inside the
 * shard gets a fast reference fetch without an upstream round-trip.
 */
async function prewarmCountryReferences(
    env: Env,
    shard: CountryShard,
    ttlMs: number,
): Promise<{ status: string; ageMs?: number; sizeBytes?: number }> {
    const key = countryRefsKey(shard.iso);
    let r2Hit: R2ObjectBody | null = null;
    try {
        r2Hit = await env.CACHE.get(key);
    } catch (e) {
        console.warn(`R2 get failed during country-refs prewarm of ${shard.iso}:`, e);
    }
    if (r2Hit) {
        const cachedAt = parseInt(r2Hit.customMetadata?.cachedAt ?? "0", 10);
        const ageMs = Date.now() - cachedAt;
        if (cachedAt && ageMs < ttlMs) {
            return { status: "skipped-fresh", ageMs };
        }
    }
    // Pace against overpass-api.de's execution slots ONLY once we know
    // we actually need to fetch (the freshness check above is free).
    // Keeps the heavy country query polite without burning a slot wait
    // on already-warm shards.
    const slotOk = await waitForOverpassSlot(`country-refs ${shard.iso}`);
    if (!slotOk) return { status: "slot-timeout" };
    const query = buildCountryReferencesQuery(shard.bbox);
    const upstream = await upstreamSemaphore.run(() =>
        fetchFromMirrorChainWithRetry(query),
    );
    if (!upstream) return { status: "upstream-failed" };
    const body = await upstream.text();
    try {
        const { rawBytes } = await compressAndStoreAtKey(env, key, body, {
            sourceName: shard.label,
            shardIso: shard.iso,
            prewarmed: "true",
            kind: "country-references",
        });
        return { status: "stored", sizeBytes: rawBytes };
    } catch (e) {
        console.warn(`R2 put failed during country-refs prewarm of ${shard.iso}:`, e);
        return { status: "r2-put-failed" };
    }
}

/**
 * Fingerprint of the combined-references query template (the query
 * minus its bbox, whitespace-collapsed). Computed once per isolate
 * from `buildReferenceBboxQuery` — which is byte-identical to the
 * client's combined prefetch query — and memoised. Only queries
 * whose fingerprint matches this are eligible for shard-slicing;
 * everything else (single-family on-tap queries, boundary fetches,
 * arbitrary upstream queries) falls through to the normal path.
 */
let _refTemplateFp: string | null = null;
async function referenceTemplateFingerprint(): Promise<string> {
    if (_refTemplateFp) return _refTemplateFp;
    // Any extent works — the bbox is stripped during canonicalisation.
    const dummy = buildReferenceBboxQuery([1, 0, 0, 1]);
    _refTemplateFp = await templateFingerprint(dummy);
    return _refTemplateFp;
}

/**
 * Max RAW (uncompressed) shard size we'll parse in-Worker. The
 * densest country shards (Germany, Japan, US-east) can be tens of
 * MB; `JSON.parse` on a 50 MB string plus the parsed object can
 * approach the Worker's 128 MB memory ceiling and OOM the isolate
 * — which kills the request rather than throwing catchably. Shards
 * over this threshold skip the slicing path and fall through to a
 * normal upstream fetch (those dense countries are well covered by
 * the per-city prewarm anyway). Sparse countries — exactly where
 * prewarming helps most, e.g. a JetLag endgame in a rural village —
 * are comfortably under it. Raise once we've measured real headroom
 * or move to per-family shard files (see global-prewarm.md).
 */
// v352: raised 8 → 12 MB now that we're on the Paid plan. The 8 MB cap
// was a Free-plan workaround: the ~10 ms CPU limit there killed any
// non-trivial JSON.parse + slice. Paid's 30 s CPU budget removes that
// constraint entirely, so CPU is no longer the limiter — MEMORY is
// (still 128 MB per isolate on every plan). A 12 MB shard parses to
// ~48-60 MB heap; v351's amplification fix means the client now fires
// ONE combined slice (not 16), so concurrent memory pressure is far
// lower than the cascade that forced the 8 MB floor. 12 MB re-enables
// the fast slice path for medium-country shards while keeping headroom.
// Shards bigger than this (dense regions like US-west) still fall
// through to upstream — a whole-region reference set is too large to
// parse safely regardless of plan; that case wants seeker-centric
// prefetching, not a bigger cap.
const MAX_SLICE_PARSE_BYTES = 12 * 1024 * 1024;

// v358: hard ceiling on the COMPRESSED R2 object size, checked first and
// always (the compressed size is the one field that's never missing).
// The Frankfurt-v357 1101: the Germany country-refs shard is ~2 MB
// gzipped; the old `compressed × 5` estimate put it at ~10 MB (under the
// 12 MB cap), so it parsed — but OSM JSON gzips ~8-12×, so the real
// uncompressed text was ~20 MB, JSON.parse amplified that to ~70 MB of
// object heap (plus the ~40 MB UTF-16 string), and the 128 MB isolate
// was killed mid-parse. A memory kill is UNCATCHABLE, so the slice's
// try/catch can't save it — it surfaces as a CORS-less 1101 that stalls
// the client into hammering public mirrors. Capping the compressed size
// directly is the only guard that can't be fooled by a bad ratio
// estimate: 1.5 MB gzipped ≈ 12-18 MB uncompressed ≈ the safe parse
// ceiling. Bigger shards (DE, US-west) skip the slice and fall through —
// the per-city exact-key warm covers the cities players actually use.
const MAX_SLICE_COMPRESSED_BYTES = 1.5 * 1024 * 1024;

interface SlicedResult {
    body: OverpassResponse;
    shardIso: string;
}

/**
 * v351/v358: decide whether a stored shard is too big to JSON.parse +
 * slice safely in-Worker. Guards, in order:
 *   1. COMPRESSED R2 size (`obj.size`) over MAX_SLICE_COMPRESSED_BYTES —
 *      the always-present, can't-be-fooled primary guard (v358).
 *   2. Uncompressed `sizeBytes` metadata when present.
 *   3. Else estimate uncompressed from compressed at a CONSERVATIVE 12×
 *      gzip ratio (was 5×, which under-counted and let the DE shard
 *      through — the v357 1101).
 * Anything over a cap skips the slice and falls through to upstream
 * rather than risking the uncatchable memory kill. Better to lose the
 * fast path than crash the request.
 */
function sliceTooBigToParse(obj: R2ObjectBody): boolean {
    // v358: primary guard — compressed size is always known and is the
    // safest proxy for peak parse memory. Catches shards whose
    // uncompressed `sizeBytes` metadata is missing/understated.
    if ((obj.size || 0) > MAX_SLICE_COMPRESSED_BYTES) return true;
    const rawSize = parseInt(obj.customMetadata?.sizeBytes ?? "0", 10);
    if (Number.isFinite(rawSize) && rawSize > 0) {
        return rawSize > MAX_SLICE_PARSE_BYTES;
    }
    // Unknown uncompressed size — estimate from compressed bytes at a
    // conservative gzip ratio (OSM JSON compresses ~8-12×; the old 5×
    // under-counted and let the Germany shard through → 1101).
    const estimated = (obj.size || 0) * 12;
    return estimated > MAX_SLICE_PARSE_BYTES;
}

/**
 * Attempt to answer a reference query by slicing a prewarmed
 * country shard. Returns null (→ caller falls through to the normal
 * upstream path) on any of: query has no bbox, query isn't the
 * combined-references template, bbox not contained in any shard,
 * shard not warmed, shard too large to parse safely, or any parse
 * error. Slicing is a pure optimisation — every failure mode is a
 * clean fall-through, never wrong data.
 */
async function trySliceFromCountryShard(
    query: string,
    env: Env,
): Promise<SlicedResult | null> {
    const bbox = extractBbox(query);
    if (!bbox) return null;

    const fp = await templateFingerprint(query);
    if (fp !== (await referenceTemplateFingerprint())) return null;

    const shard = findContainingShard(bbox);
    if (!shard) return null;

    let obj: R2ObjectBody | null = null;
    try {
        obj = await env.CACHE.get(countryRefsKey(shard.iso));
    } catch (e) {
        console.warn(`country-refs slice: R2 get failed for ${shard.iso}:`, e);
        return null;
    }
    if (!obj) return null;

    if (sliceTooBigToParse(obj)) return null;

    let parsed: OverpassResponse;
    try {
        const text = await readR2Text(obj);
        parsed = JSON.parse(text) as OverpassResponse;
    } catch (e) {
        console.warn(`country-refs slice: parse failed for ${shard.iso}:`, e);
        return null;
    }

    const sliced = sliceResponseByBbox(parsed, bbox);
    return { body: sliced, shardIso: shard.iso };
}

/**
 * Memoised template fingerprints for the per-mode transit-route
 * queries. The canonicaliser strips the `[bbox:...]` setting but keeps
 * the route literal ("subway"/"ferry"/"bus"), so each mode has its own
 * stable fingerprint. Only the shard-warmed modes are tracked here;
 * bus queries are answered by the exact-key R2 hash path (or a live
 * upstream miss), so we deliberately don't fingerprint-match them
 * into the slicer.
 */
const _transitTemplateFps: Map<string, string> = new Map();
async function transitShardTemplateFp(routeType: string): Promise<string> {
    const cached = _transitTemplateFps.get(routeType);
    if (cached) return cached;
    // Any extent works — the bbox is stripped during canonicalisation.
    const dummy = transitRouteQuery([1, 0, 0, 1], routeType);
    const fp = await templateFingerprint(dummy);
    _transitTemplateFps.set(routeType, fp);
    return fp;
}

/**
 * Attempt to answer a transit-route overlay query by slicing a
 * prewarmed country-shard transit cache. Mirrors the reference-shard
 * pattern (`trySliceFromCountryShard`):
 *
 *   1. Extract bbox; bail if absent.
 *   2. Match the query template fingerprint against the SUBWAY/FERRY
 *      shapes — anything else (notably bus) falls through.
 *   3. Find the smallest shard fully containing the bbox.
 *   4. Read the shard's `transit-routes/v1/<iso>/<routeType>/all`.
 *   5. Decompress, parse, way-bbox-intersect with `sliceTransitByBbox`,
 *      return. Empty ways result is fine — same shape Overpass would
 *      return for a clean miss.
 *
 * Pure optimisation: every failure mode is a clean fall-through, never
 * wrong data. Same MAX_SLICE_PARSE_BYTES cap as country-refs.
 */
async function trySliceFromTransitShard(
    query: string,
    env: Env,
): Promise<SlicedResult | null> {
    const bbox = extractBbox(query);
    if (!bbox) return null;

    const fp = await templateFingerprint(query);
    let matchedRouteType: string | null = null;
    for (const mode of TRANSIT_SHARD_MODES) {
        if (fp === (await transitShardTemplateFp(mode))) {
            matchedRouteType = mode;
            break;
        }
    }
    if (!matchedRouteType) return null;

    const shard = findContainingShard(bbox);
    if (!shard) return null;

    let obj: R2ObjectBody | null = null;
    try {
        obj = await env.CACHE.get(transitShardKey(shard.iso, matchedRouteType));
    } catch (e) {
        console.warn(
            `transit-shard slice: R2 get failed for ${shard.iso} ${matchedRouteType}:`,
            e,
        );
        return null;
    }
    if (!obj) return null;

    // v351: same defensive size guard as the country-refs slice.
    if (sliceTooBigToParse(obj)) return null;

    let parsed: TransitReducedResponse;
    try {
        const text = await readR2Text(obj);
        parsed = JSON.parse(text) as TransitReducedResponse;
    } catch (e) {
        console.warn(
            `transit-shard slice: parse failed for ${shard.iso} ${matchedRouteType}:`,
            e,
        );
        return null;
    }

    const sliced = sliceTransitByBbox(parsed, bbox);
    return { body: sliced as OverpassResponse, shardIso: shard.iso };
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
    // v667: refuse to store an aborted body (Overpass soft timeout).
    if (isAbortedOverpassText(body)) return { status: "upstream-aborted" };
    try {
        const { rawBytes } = await compressAndStoreString(env, cacheKey, body, {
            sourceName: iso,
            prewarmed: "true",
            kind: "hsr",
        });
        return { status: "stored", sizeBytes: rawBytes };
    } catch (e) {
        console.warn(`R2 put failed during HSR prewarm of ${iso}:`, e);
        return { status: "r2-put-failed" };
    }
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
    // v667: refuse to store an aborted body (Overpass soft timeout) —
    // this is the exact path that used to cache an empty combined-
    // reference set as "stored" when a dense metro's query timed out.
    if (isAbortedOverpassText(body)) return { status: "upstream-aborted" };
    try {
        const { rawBytes } = await compressAndStoreString(env, cacheKey, body, {
            sourceName: city.name,
            sourceRelationId: String(city.relationId),
            prewarmed: "true",
            kind,
        });
        return { status: "stored", sizeBytes: rawBytes };
    } catch (e) {
        console.warn(`R2 put failed during ${kind} prewarm:`, e);
        return { status: "stored", sizeBytes: body.length };
    }
}

/** Per-city reference cache — one combined query covering every
 *  standard reference family (museums / hospitals / airports / …). */
async function prewarmReferencesForCity(
    env: Env,
    city: CityEntry,
    ttlMs: number,
): Promise<{ status: string }> {
    // v356: prefer the canonical boundary-geometry extent (what the
    // client + laptop key off). Also unblocks legacy entries that have
    // no `city.extent` but whose boundary IS cached — they used to
    // return "skipped-no-extent" and never warm references at all.
    const ext = await canonicalReferenceExtent(env, city);
    if (!ext) return { status: "skipped-no-extent" };
    return prewarmQuery(
        env,
        buildReferenceBboxQuery(ext),
        city,
        ttlMs,
        "references",
    );
}

/* ───────────────── Adjacent-search prewarm (v268) ──────────────── */

/**
 * Default radius the seeker app uses for adjacent-area discovery.
 * MUST match `ADJACENT_SEARCH_DEFAULT_RADIUS_KM` in
 * src/maps/api/playAreaExtensions.ts — different values produce
 * different cache keys and the prewarm misses.
 */
const ADJACENT_SEARCH_RADIUS_KM = 25;

/** v639: cap on how many adjacent-neighbour BOUNDARY polygons we prewarm
 *  per city, so a dense metro's ~14 neighbours can't blow the cron's wall
 *  budget. Matches the client's candidate `limit` (14). Each is only
 *  fetched once per TTL (prewarmQuery skips fresh entries). */
const MAX_NEIGHBOUR_BOUNDARIES = 14;

/**
 * Build the admin-level-lookup query for a relation. Byte-identical
 * to `buildAdminLevelQuery` in src/maps/api/playAreaExtensions.ts.
 */
function buildAdminLevelQuery(osmId: number): string {
    return `
[out:json][timeout:25];
relation(${osmId});
out tags;
`;
}

/**
 * Build the adjacent-admin-relations query. Byte-identical to
 * `buildAdjacentAdminQuery` in src/maps/api/playAreaExtensions.ts.
 */
function buildAdjacentAdminQuery(
    adminLevel: string,
    lat: number,
    lng: number,
    radiusKm: number,
): string {
    // v640: no rounding — both the cron and the client build this from the
    // ONE canonical extent (the cron reads city.extent; the client fetches
    // the same value from /api/relation-extent), so the string already
    // matches. MUST match buildAdjacentAdminQuery in
    // src/maps/api/playAreaExtensions.ts exactly.
    return `
[out:json][timeout:60];
relation["admin_level"="${adminLevel}"]["type"="boundary"](around:${radiusKm * 1000},${lat},${lng});
out tags bb;
`;
}

/**
 * Build the all-mode adjacent transit-stations query. Byte-identical
 * to `buildAdjacentStationsQuery` in
 * src/maps/api/playAreaExtensions.ts. Bus is deliberately omitted —
 * buses cross every admin boundary and would pre-check every
 * candidate.
 */
function buildAdjacentStationsQuery(
    lat: number,
    lng: number,
    radiusKm: number,
): string {
    return `
[out:json][timeout:45];
(
  node["station"="subway"](around:${radiusKm * 1000},${lat},${lng});
  node["railway"="station"](around:${radiusKm * 1000},${lat},${lng});
  node["railway"="halt"](around:${radiusKm * 1000},${lat},${lng});
  node["railway"="tram_stop"](around:${radiusKm * 1000},${lat},${lng});
  node["amenity"="ferry_terminal"](around:${radiusKm * 1000},${lat},${lng});
);
out;
`;
}

/**
 * Build the topological-adjacency query (the v427 rework's PRIMARY
 * adjacency pass — every relation sharing a member way with the
 * primary). Byte-identical to `buildTopologicalAdjacencyQuery` in
 * src/maps/api/playAreaExtensions.ts.
 */
function buildTopologicalAdjacencyQuery(primaryOsmId: number): string {
    return `
[out:json][timeout:120];
relation(${primaryOsmId});
way(r);
rel(bw);
out tags bb;
`;
}

/**
 * Build the megacity sub-units query (admin boundaries one/two levels
 * BELOW the primary, inside its area — NYC → boroughs). Byte-identical
 * to the query in `fetchSubUnitsInArea` in
 * src/maps/api/playAreaExtensions.ts. Only meaningful for primaries at
 * admin_level ≤ 5; the caller gates on that.
 */
function buildSubUnitsInAreaQuery(
    primaryOsmId: number,
    primaryLevel: number,
): string {
    const areaId = 3_600_000_000 + primaryOsmId;
    const lower = primaryLevel + 1;
    const upper = primaryLevel + 2;
    const levelRegex = `^[${lower}${upper}]$`;
    return `
[out:json][timeout:60];
area(id:${areaId});
relation["admin_level"~"${levelRegex}"]["type"="boundary"]["boundary"="administrative"](area);
out tags bb;
`;
}

/**
 * Prewarm every R2 entry the wizard's adjacent-areas picker reads for
 * one city. Mirrors `findExtensionCandidates` in
 * src/maps/api/playAreaExtensions.ts, which fires (in order):
 *   0. topological adjacency  (relation-id keyed — the PRIMARY pass)
 *   1. admin-level lookup     (relation-id keyed — yields the level)
 *   2. adjacent admin band    (centroid + level keyed)
 *   3. transit stations       (centroid keyed, all modes, 25 km)
 *   4. sub-units in area      (megacities ≤ level 5 only — boroughs)
 * Fired serially so we don't blow the per-tick Overpass slot budget;
 * each shares the skip-if-fresh logic via `prewarmQuery`.
 *
 * The relation-keyed queries (0, 1) warm cheap and stay warm. The
 * band/sub-units queries depend on the city's actual admin_level, so
 * we resolve it from query 1 first; the band query is also keyed by
 * the city's centroid (computed from `city.extent`) — the same centroid
 * the wizard derives at runtime.
 */
async function prewarmAdjacentSearchForCity(
    env: Env,
    city: CityEntry,
    ttlMs: number,
    // v684: whether THIS city may do the heavy per-neighbour refs+stations
    // warm this tick. The caller gates it on a per-tick budget so a single
    // cron tick can't queue hundreds of cold heavy fetches (which is what
    // pressured Overpass's rate limit). When false, neighbours still get
    // their cheap boundary warmed — the city just doesn't fully-curate its
    // adjacents this tick and will on a later tick when it's in budget.
    allowHeavyCuration: boolean = true,
): Promise<{
    stored: number;
    neighbourIds: number[];
    adjacencyKnown: boolean;
}> {
    if (!city.extent)
        return { stored: 0, neighbourIds: [], adjacencyKnown: false };
    // Photon-style extent: [maxLat, minLng, minLat, maxLng].
    const [maxLat, minLng, minLat, maxLng] = city.extent;
    const lat = (maxLat + minLat) / 2;
    const lng = (minLng + maxLng) / 2;
    const radius = ADJACENT_SEARCH_RADIUS_KM;
    let stored = 0;

    // 0. Topological adjacency — the v427 rework's PRIMARY pass and
    //    the FIRST query the wizard fires, so warming it matters most.
    //    Keyed on the relation id alone (stable), independent of the
    //    admin_level lookup below.
    {
        const r = await prewarmQuery(
            env,
            buildTopologicalAdjacencyQuery(city.relationId),
            city,
            ttlMs,
            "adjacent-topological",
        );
        if (r.status === "stored") stored++;
    }

    // 1. Admin level lookup — also yields the level we need for
    //    queries 2 and 4. Look in cache first; only fetch upstream when
    //    cache is stale / missing.
    const adminLevelQuery = buildAdminLevelQuery(city.relationId);
    let adminLevel: string | null = null;
    {
        const r = await prewarmQuery(
            env,
            adminLevelQuery,
            city,
            ttlMs,
            "adjacent-admin-level",
        );
        if (r.status === "stored" || r.status === "skipped-fresh") {
            // Re-read from cache to extract the admin_level tag.
            try {
                const key = await r2KeyForQuery(adminLevelQuery);
                const obj = await env.CACHE.get(`overpass/${key}`);
                if (obj) {
                    const body = await readR2Text(obj);
                    const parsed = JSON.parse(body) as {
                        elements?: Array<{
                            tags?: Record<string, string>;
                        }>;
                    };
                    adminLevel =
                        parsed.elements?.[0]?.tags?.admin_level ?? null;
                    if (r.status === "stored") stored++;
                }
            } catch (e) {
                console.warn(
                    `[adjacent] failed to extract admin_level for ${city.name}:`,
                    e,
                );
            }
        }
    }

    // 2. Adjacent admin relations — only fires if we know the level.
    if (adminLevel) {
        const r = await prewarmQuery(
            env,
            buildAdjacentAdminQuery(adminLevel, lat, lng, radius),
            city,
            ttlMs,
            "adjacent-admin",
        );
        if (r.status === "stored") stored++;
    }

    // 3. Adjacent transit stations (all modes, 25 km). The client
    //    filters by user's allowed-transit selection locally.
    {
        const r = await prewarmQuery(
            env,
            buildAdjacentStationsQuery(lat, lng, radius),
            city,
            ttlMs,
            "adjacent-stations",
        );
        if (r.status === "stored") stored++;
    }

    // 4. Megacity sub-units (boroughs etc.) — only for consolidated
    //    cities at admin_level ≤ 5, mirroring the client's gate in
    //    `findExtensionCandidates`. For everything else the client
    //    never fires this query, so warming it would be wasted work.
    if (adminLevel) {
        const lvl = parseInt(adminLevel, 10);
        if (Number.isFinite(lvl) && lvl <= 5) {
            const r = await prewarmQuery(
                env,
                buildSubUnitsInAreaQuery(city.relationId, lvl),
                city,
                ttlMs,
                "adjacent-subunits",
            );
            if (r.status === "stored") stored++;
        }
    }

    // 5. v639: prewarm each adjacent NEIGHBOUR's boundary polygon. The
    //    wizard/lobby preview is now worker-first (client
    //    doFetchRawBoundaryPolygon), so warming these lets a curated city's
    //    adjacent-area outlines paint from R2 instead of firing a
    //    throttle-prone burst of per-neighbour polygons.osm.fr requests.
    //    Neighbour ids come from the topological + admin-band results we
    //    just stored; keyed on `singleRelationQuery` (byte-identical to the
    //    client's worker boundary fetch). Capped + only fetched once per
    //    TTL, so this doesn't balloon the cron.
    let neighbourResult: number[] = [];
    let adjacencyKnown = false;
    try {
        // Neighbour ids come from the topological + admin-band results the
        // steps above just stored, via the shared read-only derivation so
        // the cron gate and the /admin/adjacent-curation-status readout see
        // a byte-identical neighbour set (one producer — no drift).
        const derived = await deriveAdjacentNeighbourIds(env, city);
        const cappedNeighbours = derived.ids;
        adjacencyKnown = derived.adjacencyKnown;
        // v676: FULL adjacent-area curation. The user's rule is that an
        // added adjacent area is a first-class part of the play area — so
        // its references AND hiding-zone stations must be prewarmed too,
        // not just its boundary outline. For each neighbour we warm the
        // boundary (the bbox source), then its references + stations under
        // the SAME canonical relation-id keys the client reads via
        // `/api/refs/<id>` and `/api/area-stations/<id>`. Both warm helpers
        // are skip-if-fresh + slot-throttled, so a city whose neighbours
        // are already warm costs a handful of cheap R2 HEADs. Opt-OUT via
        // ADJACENT_CURATION_ENABLED="false" (then only boundaries warm, the
        // pre-v676 behaviour).
        const fullCuration =
            env.ADJACENT_CURATION_ENABLED !== "false" && allowHeavyCuration;
        for (const id of cappedNeighbours) {
            const r = await prewarmQuery(
                env,
                singleRelationQuery(id),
                city,
                ttlMs,
                "adjacent-boundary",
            );
            if (r.status === "stored") stored++;
            if (fullCuration) {
                try {
                    await warmRelationReferences(env, id);
                } catch (e) {
                    console.warn(
                        `[adjacent] neighbour refs warm failed r${id} (${city.name}):`,
                        e,
                    );
                }
                try {
                    await warmRelationAreaStations(env, id);
                } catch (e) {
                    console.warn(
                        `[adjacent] neighbour stations warm failed r${id} (${city.name}):`,
                        e,
                    );
                }
            }
        }
        neighbourResult = cappedNeighbours;
    } catch (e) {
        console.warn(
            `[adjacent] neighbour boundary prewarm failed for ${city.name}:`,
            e,
        );
    }

    return { stored, neighbourIds: neighbourResult, adjacencyKnown };
}

/**
 * Is a single relation FULLY curated — boundary, references, AND
 * hiding-zone stations all present in R2 (v676)? Mirrors the read paths:
 * derive the canonical boundary-geometry extent (the same walk
 * `warmRelationReferences` / `handleReferencesByRelation` use), then HEAD
 * the reference + area-station entries under their canonical query keys.
 * Read-only — never fetches upstream. Used to decide whether a city's
 * adjacent areas are all curated before stamping `adjacentsCuratedAt`.
 */
async function relationFullyCurated(
    env: Env,
    relationId: number,
): Promise<boolean> {
    let boundaryObj: R2ObjectBody | null = null;
    try {
        const boundaryKey = await r2KeyForQuery(singleRelationQuery(relationId));
        boundaryObj = await env.CACHE.get(`overpass/${boundaryKey}`);
    } catch {
        return false;
    }
    if (!boundaryObj) return false;
    let ext: [number, number, number, number] | null = null;
    try {
        const text = await readR2Text(boundaryObj);
        if (text) ext = extentFromBoundaryJson(JSON.parse(text));
    } catch {
        return false;
    }
    if (!ext) return false;
    try {
        const refsKey = await r2KeyForQuery(buildReferenceBboxQuery(ext));
        const stationsKey = await r2KeyForQuery(buildAreaStationsBboxQuery(ext));
        const [refsHead, stHead] = await Promise.all([
            env.CACHE.head(`overpass/${refsKey}`),
            env.CACHE.head(`overpass/${stationsKey}`),
        ]);
        return Boolean(refsHead) && Boolean(stHead);
    } catch {
        return false;
    }
}

/**
 * Read-only derivation of a city's adjacent-area neighbour relation ids
 * (v676) — the SINGLE producer of that set, used by both the cron's
 * curation gate (`prewarmAdjacentSearchForCity` step 5) and the
 * `/admin/adjacent-curation-status` readout, so they can't drift. Reads
 * the already-cached topological-adjacency + admin-band results (the same
 * queries the cron warms in the steps above and the client fires in the
 * wizard) and returns the boundary/administrative relation ids among them,
 * excluding the city itself, capped at MAX_NEIGHBOUR_BOUNDARIES. Never
 * fetches upstream.
 *
 * `adjacencyKnown` reports whether the topological-adjacency query was
 * found in cache at all — so a caller can distinguish "genuinely no
 * neighbours" (known, empty) from "adjacency not prewarmed yet" (unknown).
 * The cron path always has it warmed in the same pass, so it's true there;
 * the read-only status endpoint uses it to avoid reporting an un-warmed
 * city as vacuously fully-curated.
 */
async function deriveAdjacentNeighbourIds(
    env: Env,
    city: CityEntry,
): Promise<{ ids: number[]; adjacencyKnown: boolean }> {
    if (!city.extent) return { ids: [], adjacencyKnown: false };
    const [maxLat, minLng, minLat, maxLng] = city.extent;
    const lat = (maxLat + minLat) / 2;
    const lng = (minLng + maxLng) / 2;
    const radius = ADJACENT_SEARCH_RADIUS_KM;

    // Admin level from the cached admin-level query (needed for the band).
    let adminLevel: string | null = null;
    try {
        const alKey = await r2KeyForQuery(buildAdminLevelQuery(city.relationId));
        const alObj = await env.CACHE.get(`overpass/${alKey}`);
        if (alObj) {
            const parsed = JSON.parse(await readR2Text(alObj)) as {
                elements?: Array<{ tags?: Record<string, string> }>;
            };
            adminLevel = parsed.elements?.[0]?.tags?.admin_level ?? null;
        }
    } catch {
        /* no admin level — topological source still works */
    }

    // Primary's admin_level as a number, for the containing-boundary filter
    // below (drop the state/county that engulfs the city — v697).
    const primaryLevelNum =
        adminLevel && Number.isFinite(parseInt(adminLevel, 10))
            ? parseInt(adminLevel, 10)
            : null;

    const neighbourIds = new Set<number>();
    let adjacencyKnown = false;
    const topoQuery = buildTopologicalAdjacencyQuery(city.relationId);
    const sources = [topoQuery];
    if (adminLevel) {
        sources.push(buildAdjacentAdminQuery(adminLevel, lat, lng, radius));
    }
    for (const q of sources) {
        try {
            const key = await r2KeyForQuery(q);
            const obj = await env.CACHE.get(`overpass/${key}`);
            if (!obj) continue;
            if (q === topoQuery) adjacencyKnown = true;
            const parsed = JSON.parse(await readR2Text(obj)) as {
                elements?: Array<{
                    type?: string;
                    id?: number;
                    tags?: Record<string, string>;
                }>;
            };
            for (const el of parsed.elements ?? []) {
                if (
                    el?.type === "relation" &&
                    typeof el.id === "number" &&
                    el.id !== city.relationId &&
                    el.tags?.type === "boundary" &&
                    el.tags?.boundary === "administrative"
                ) {
                    // v697: EXCLUDE containing/parent boundaries — the topo
                    // pass returns the county/state/country whose boundary
                    // shares ways with the city's coast/border (New York
                    // STATE #61320 came back as an NYC "neighbour", a
                    // state-sized play area that soft-timed-out on refs).
                    // A real adjacent municipality is at the SAME admin_level
                    // or FINER (numerically >=); anything coarser (smaller
                    // number) engulfs the primary — never a play-area
                    // expansion. Mirrors the client's `withinLevelWindow`
                    // lower bound. Missing/unparseable levels are kept (can't
                    // reason — same as the client's no-op fallback).
                    const elLvlRaw = el.tags.admin_level;
                    const elLvl = elLvlRaw ? parseInt(elLvlRaw, 10) : NaN;
                    if (
                        primaryLevelNum !== null &&
                        Number.isFinite(elLvl) &&
                        elLvl < primaryLevelNum
                    ) {
                        continue;
                    }
                    neighbourIds.add(el.id);
                }
            }
        } catch {
            /* skip this source */
        }
    }
    return {
        ids: [...neighbourIds].slice(0, MAX_NEIGHBOUR_BOUNDARIES),
        adjacencyKnown,
    };
}

/**
 * Verify a city's full-curation state and stamp `adjacentsCuratedAt` /
 * `fullyCuratedAt` on state change (v684). The SINGLE producer of the star
 * stamp — used by the cron's Phase-4 caller AND the `/admin/verify-city`
 * endpoint the laptop-prewarmer calls, so stars can be earned the instant
 * the laptop finishes a city instead of waiting on the cron. Read-only
 * except the one conditional stamp write; never fetches upstream.
 *
 *   adjacentsCurated = every neighbour fully cached (boundary+refs+stations),
 *     or — for a genuinely neighbour-less city (adjacency KNOWN + empty) —
 *     vacuously true. Unknown adjacency (not prewarmed) is NOT curated.
 *   fullyCurated     = adjacentsCurated AND the PRIMARY itself fully cached.
 *                      This is exactly what the in-app star reflects.
 */
async function verifyAndStampCity(
    env: Env,
    city: CityEntry,
    ttlMs: number,
): Promise<{
    primaryCached: boolean;
    adjacentsCurated: boolean;
    fullyCurated: boolean;
    neighboursTotal: number;
    neighboursCurated: number;
    uncuratedNeighbours: number[];
    stamped: boolean;
}> {
    const { ids, adjacencyKnown } = await deriveAdjacentNeighbourIds(env, city);
    // v697: capture PER-neighbour curation so the caller can report exactly
    // which adjacent(s) are holding a star back (the strict gate needs ALL).
    const perNeighbour =
        ids.length > 0
            ? await Promise.all(
                  ids.map(async (id) => ({
                      id,
                      ok: await relationFullyCurated(env, id),
                  })),
              )
            : [];
    const uncuratedNeighbours = perNeighbour
        .filter((p) => !p.ok)
        .map((p) => p.id);
    const neighboursCurated = perNeighbour.length - uncuratedNeighbours.length;
    const adjacentsCurated =
        ids.length > 0 ? uncuratedNeighbours.length === 0 : adjacencyKnown;
    const primaryCached = await relationFullyCurated(env, city.relationId);
    const fullyCurated = primaryCached && adjacentsCurated;

    const patch: Partial<CityEntry> = {};
    let changed = false;

    const adjStamp = city.adjacentsCuratedAt;
    const adjAge =
        typeof adjStamp === "number" ? Date.now() - adjStamp : Infinity;
    if (adjacentsCurated && adjAge > ttlMs) {
        patch.adjacentsCuratedAt = Date.now();
        changed = true;
    } else if (!adjacentsCurated && adjStamp !== undefined) {
        patch.adjacentsCuratedAt = undefined;
        changed = true;
    }

    const fullStamp = city.fullyCuratedAt;
    const fullAge =
        typeof fullStamp === "number" ? Date.now() - fullStamp : Infinity;
    if (fullyCurated && fullAge > ttlMs) {
        patch.fullyCuratedAt = Date.now();
        changed = true;
    } else if (!fullyCurated && fullStamp !== undefined) {
        patch.fullyCuratedAt = undefined;
        changed = true;
    }

    // v690: the DEFAULT star gate — PRIMARY fully cached (boundary+refs+
    // stations), independent of adjacents. Stamped/cleared just like
    // fullyCuratedAt so `handleWarmCities` reads a cheap marker, not a live
    // R2 sweep.
    const primStamp = city.primaryCuratedAt;
    const primAge =
        typeof primStamp === "number" ? Date.now() - primStamp : Infinity;
    if (primaryCached && primAge > ttlMs) {
        patch.primaryCuratedAt = Date.now();
        changed = true;
    } else if (!primaryCached && primStamp !== undefined) {
        patch.primaryCuratedAt = undefined;
        changed = true;
    }

    if (changed) await upsertDiscoveredCity(env, { ...city, ...patch });
    return {
        primaryCached,
        adjacentsCurated,
        fullyCurated,
        neighboursTotal: ids.length,
        neighboursCurated,
        uncuratedNeighbours,
        stamped: changed,
    };
}

/** Read an R2 object as text. Handles the gzip-compressed entries
 *  the upstream cacher writes; falls back to raw text otherwise. */
async function readR2Text(obj: R2ObjectBody): Promise<string> {
    const encoding = obj.customMetadata?.encoding;
    if (encoding === "gzip") {
        try {
            const stream = obj.body.pipeThrough(
                new DecompressionStream("gzip"),
            );
            return await new Response(stream).text();
        } catch (e) {
            console.warn("[adjacent] gzip decompress failed:", e);
            return "";
        }
    }
    return await obj.text();
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
 * Coarse place-type ranking — MIRROR of src/maps/api/geocode.ts's
 * PLACE_TYPE_SCORE. Keep in sync. Used so the discovery resolver picks
 * the SAME relation the client's play-area search would.
 */
const DISCOVERY_PLACE_TYPE_SCORE: Record<string, number> = {
    country: 1200,
    city: 1000,
    town: 900,
    municipality: 850,
    village: 800,
    suburb: 600,
    hamlet: 500,
    borough: 450,
    district: 400,
    neighbourhood: 300,
    quarter: 300,
    locality: 200,
    state: 500,
    region: 400,
    province: 300,
    county: 200,
    administrative: 100,
};

function discoveryStripSuffix(s: string): string {
    return s.replace(
        /\s+(kommun|län|municipality|county|district|prefecture|province|borough)$/i,
        "",
    );
}

interface PhotonProps {
    osm_type?: string;
    osm_id?: number;
    osm_key?: string;
    osm_value?: string;
    type?: string;
    name?: string;
    country?: string;
    extent?: number[];
}

/**
 * Score a Photon relation result for play-area relevance — a faithful
 * port of scorePlayAreaResult() in src/maps/api/geocode.ts. `index` is
 * the position within the FILTERED+DEDUPED relation list (matches the
 * client). Area math uses absolute diffs so it's order-independent w.r.t.
 * the raw [minLng,maxLat,maxLng,minLat] extent.
 */
function discoveryScore(p: PhotonProps, index: number, query: string): number {
    const name = (p.name ?? "").toLowerCase();
    const q = query.toLowerCase().trim();
    const photonRankBonus = 80 / Math.sqrt(index + 1);
    const typeFromValue =
        DISCOVERY_PLACE_TYPE_SCORE[(p.osm_value ?? "").toLowerCase()] ?? 0;
    const typeFromType =
        DISCOVERY_PLACE_TYPE_SCORE[(p.type ?? "").toLowerCase()] ?? 0;
    const typeBonus = Math.max(typeFromValue, typeFromType);

    let areaBonus = 0;
    const e = p.extent;
    if (Array.isArray(e) && e.length >= 4) {
        const latA = e[1];
        const latB = e[3];
        const lngA = e[0];
        const lngB = e[2];
        if ([latA, latB, lngA, lngB].every((v) => Number.isFinite(v))) {
            const midLat = (latA + latB) / 2;
            const km2 =
                Math.abs(latA - latB) *
                111 *
                Math.abs(lngA - lngB) *
                111 *
                Math.cos((midLat * Math.PI) / 180);
            if (km2 > 0) areaBonus = Math.min(600, Math.log10(km2) * 100);
        }
    }

    const strippedName = discoveryStripSuffix(name);
    const strippedQ = discoveryStripSuffix(q);
    let exactNameBonus = 0;
    if (strippedName === strippedQ) exactNameBonus = 500;
    else if (strippedName.startsWith(strippedQ + " ")) exactNameBonus = 300;

    return photonRankBonus + typeBonus + areaBonus + exactNameBonus;
}

/**
 * Resolve a "City, Country" string to the OSM relation ID the CLIENT
 * would fetch. v: previously picked the FIRST place/boundary relation in
 * Photon's raw order, but the client RE-RANKS results (place-type + area
 * + exact-name + famous-country) and fetches the top of THAT order — so
 * the discovered id drifted from the client's for ~31% of cities (the
 * drift audit). Now mirrors geocode.ts: same query shape, same
 * place/boundary filter, same dedupe, same re-rank, return the top.
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
        // Match the client's query exactly (lang=en, no limit → Photon
        // default), so the candidate set — and thus the re-rank — agrees.
        const resp = await ufetch(
            `${PHOTON_API}?lang=en&q=${encodeURIComponent(name)}`,
            { signal: ctrl.signal },
        );
        if (!resp.ok) return null;
        const data = (await resp.json()) as {
            features?: Array<{ properties?: PhotonProps }>;
        };
        const features = data.features ?? [];

        // famousCountry = country of Photon's RAW #1 result (pre-filter),
        // same signal the client uses to pull the famous-city relation up.
        const famousCountry =
            features[0]?.properties?.country?.toLowerCase() ?? null;

        // Filter to place/boundary relations, dedupe by osm_id (first wins).
        const seen = new Set<number>();
        const cands: PhotonProps[] = [];
        for (const f of features) {
            const p = f.properties;
            if (
                !p ||
                p.osm_type !== "R" ||
                typeof p.osm_id !== "number" ||
                p.osm_id <= 0
            ) {
                continue;
            }
            if (p.osm_key !== "place" && p.osm_key !== "boundary") continue;
            if (seen.has(p.osm_id)) continue;
            seen.add(p.osm_id);
            cands.push(p);
        }
        if (cands.length === 0) return null;

        const bareQuery = name.split(",")[0].trim();
        let bestIdx = -1;
        let bestScore = -Infinity;
        for (let i = 0; i < cands.length; i++) {
            const p = cands[i];
            const country = (p.country ?? "").toLowerCase();
            const famousBonus =
                famousCountry && country === famousCountry ? 700 : 0;
            const score = discoveryScore(p, i, bareQuery) + famousBonus;
            if (score > bestScore) {
                bestScore = score;
                bestIdx = i;
            }
        }
        if (bestIdx < 0) return null;
        const best = cands[bestIdx];
        if (typeof best.osm_id !== "number") return null;

        // Photon's raw `extent` is [minLng, maxLat, maxLng, minLat]; the
        // client normalises to [maxLat, minLng, minLat, maxLng] — mirror
        // that so a CityEntry's extent matches mapGeoLocation's.
        let extent: [number, number, number, number] | undefined;
        const raw = best.extent;
        if (Array.isArray(raw) && raw.length === 4) {
            const [minLng, maxLat, maxLng, minLat] = raw;
            if ([minLng, maxLat, maxLng, minLat].every((v) => Number.isFinite(v))) {
                extent = [maxLat, minLng, minLat, maxLng];
            }
        }
        return { relationId: best.osm_id, extent };
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

/* ──────────────────────── City tile packs ──────────────────────── *
 *
 * v336. The map-preload bucket used to warm the basemap by issuing one
 * PMTiles byte-range request per tile in the play-area bbox — thousands
 * of round-trips (Trondheim alone planned 6,621 tiles at z13). Even at
 * 32-way concurrency that's a slow, chatty preload.
 *
 * A "city pack" replaces that with ONE download: a small self-contained
 * PMTiles archive (`pmtiles extract` of the master over the city bbox,
 * z0..15) that the client fetches whole, holds in memory, and serves
 * tiles from with zero per-tile network. The live map reads pack-first
 * with master-fallback via a custom MapLibre protocol (see
 * src/lib/tilePack.ts), so panning outside the pack still works.
 *
 * Storage: packs live in the SAME `env.TILES` bucket as the master,
 * keyed `tile-packs/v1/<osmId>.pmtiles`, and are SERVED by the existing
 * `/tiles/<key>` route (range support + immutable caching, no new serve
 * code). Only the WRITE path is new — this admin upload endpoint, hit
 * by the laptop prewarmer after it runs `pmtiles extract`.
 *
 * Key namespace `v1/` lets us bust every pack at once if the master
 * basemap is re-rendered (tile contents change) — bump to v2 and the
 * client's pack URL changes, old packs become orphans.
 */

/** R2 key for a city tile pack, keyed on the play area's OSM relation
 *  id. Kept in one function so the laptop uploader and the client URL
 *  builder (src/lib/tilePack.ts tilePackKey) stay byte-identical. */
function tilePackKey(osmId: string | number): string {
    return `tile-packs/v1/${osmId}.pmtiles`;
}

/**
 * Admin endpoint: store a city tile pack. The laptop prewarmer POSTs
 * the raw .pmtiles bytes with `?osmId=<id>`; we stream them into
 * `env.TILES` under `tilePackKey(osmId)` with immutable cache headers
 * (matching the master tile serving). The existing `/tiles/<key>`
 * route serves them straight back out.
 *
 * Bounded by MAX_STORE_BYTES (60 MB) — a city pack should be a few to
 * a few tens of MB; anything bigger means the bbox was too large
 * (country-scale) and the laptop should have skipped it.
 */
/**
 * `GET /admin/list-tile-packs?secret=<…>` — list every city tile pack
 * currently in R2 under the `tile-packs/v1/` prefix. One row per pack:
 * its `osmId` (from customMetadata, falling back to the key), byte size,
 * and stored timestamp. Handy for confirming a laptop upload landed and
 * under WHICH relation id (the common "still 404s after upload" cause is
 * a pack keyed to a different osm_id than the play area resolves to).
 * Read-only; paginated R2 list.
 */
async function handleAdminListTilePacks(
    request: Request,
    env: Env,
    cors: HeadersInit,
): Promise<Response> {
    if (!checkAdminAuth(request, env)) {
        return new Response("Unauthorized", { status: 401, headers: cors });
    }
    try {
        const packs: Array<{
            osmId: string;
            key: string;
            bytes: number;
            storedAt: number | null;
        }> = [];
        let cursor: string | undefined = undefined;
        do {
            const page: R2Objects = await env.TILES.list({
                prefix: "tile-packs/v1/",
                cursor,
                limit: 1000,
                include: ["customMetadata"],
            });
            for (const obj of page.objects) {
                const md = obj.customMetadata ?? {};
                const osmId =
                    md.osmId ??
                    obj.key
                        .slice("tile-packs/v1/".length)
                        .replace(/\.pmtiles$/, "");
                const storedAtRaw = md.storedAt ? Number(md.storedAt) : NaN;
                packs.push({
                    osmId,
                    key: obj.key,
                    bytes: obj.size,
                    storedAt: Number.isFinite(storedAtRaw)
                        ? storedAtRaw
                        : null,
                });
            }
            cursor = page.truncated ? page.cursor : undefined;
        } while (cursor);
        packs.sort((a, b) => a.osmId.localeCompare(b.osmId));
        return jsonResponse({ count: packs.length, packs }, 200, cors);
    } catch (e) {
        console.warn("[tile-pack] list failed:", e);
        return jsonResponse(
            { error: e instanceof Error ? e.message : String(e) },
            500,
            cors,
        );
    }
}

/**
 * `POST /admin/store-city-extent` (secret) — backfill a city's canonical
 * `extent` on demand (v640) instead of waiting on the cron's ~5-per-tick
 * backfill pass. Body `{name, relationId}` (name optional if the relation
 * is already in the city list). The WORKER derives the extent via
 * `bboxFromRelation` — the SAME polygons.osm.fr walk the cron uses, so it's
 * one canonical producer and the stored value byte-matches the adjacency
 * `around:` keys the client (`/api/relation-extent`) and cron read. Lets a
 * laptop run fully bootstrap a brand-new city (extent → adjacency →
 * references → …) with no cron wait. Returns the stored extent.
 */
async function handleAdminStoreCityExtent(
    request: Request,
    env: Env,
    cors: HeadersInit,
): Promise<Response> {
    if (request.method !== "POST") {
        return new Response("Method not allowed", {
            status: 405,
            headers: { ...cors, Allow: "POST" },
        });
    }
    if (!checkAdminAuth(request, env)) {
        return new Response("Unauthorized", { status: 401, headers: cors });
    }
    let body: { name?: unknown; relationId?: unknown };
    try {
        body = (await request.json()) as {
            name?: unknown;
            relationId?: unknown;
        };
    } catch {
        return jsonResponse({ error: "invalid JSON body" }, 400, cors);
    }
    const relationId = Number(body.relationId);
    if (!Number.isFinite(relationId) || relationId <= 0) {
        return jsonResponse(
            { error: "relationId (positive number) required" },
            400,
            cors,
        );
    }
    // Name: prefer the caller's; else keep whatever's already stored under
    // this relation id (upsert merges, so an existing name is preserved
    // anyway — but we need one when the relation is brand new).
    let name =
        typeof body.name === "string" && body.name.trim()
            ? body.name.trim()
            : null;
    if (!name) {
        try {
            const cities = await getPopularCities(env);
            name =
                cities.find((c) => c.relationId === relationId)?.name ?? null;
        } catch {
            /* ignore — handled by the null check below */
        }
    }
    if (!name) {
        return jsonResponse(
            { error: "name required (relation not already in the city list)" },
            400,
            cors,
        );
    }
    const extent = await bboxFromRelation(relationId).catch(() => null);
    if (!extent) {
        return jsonResponse(
            {
                error: "could not derive extent (polygons.osm.fr miss/timeout)",
                relationId,
            },
            502,
            cors,
        );
    }
    try {
        await upsertDiscoveredCity(env, { name, relationId, extent });
        return jsonResponse(
            { status: "stored", relationId, name, extent },
            200,
            cors,
        );
    } catch (e) {
        console.warn(`store-city-extent upsert failed r${relationId}:`, e);
        return jsonResponse({ error: "store failed" }, 500, cors);
    }
}

/** Hard cap on how large the R2 growth doc may get via the PUBLIC
 *  register-area endpoint — a backstop against someone spamming junk
 *  relation ids into the prewarm list. The curated seed is separate
 *  (bundled), so this only bounds organic player-driven growth. */
const REGISTER_AREA_MAX_GROWTH = 20000;

/**
 * `POST /api/register-area` (PUBLIC) — the runtime-growth path (v680): when
 * a player picks a play area that ISN'T already in the prewarm set, the
 * client registers it here so the cron starts caching it (and its adjacent
 * areas) and it eventually earns a star. This is how "the list grows as
 * players use the app" — the curated world-cities seed is the floor, actual
 * usage extends it.
 *
 * Body `{relationId, name}`. The WORKER derives the extent via
 * `bboxFromRelation` (same canonical producer as the cron/admin path), then
 * upserts into the R2 growth doc — identical to `/admin/store-city-extent`
 * but keyless. Guardrails, since it's public: it no-ops for a relation
 * already known-with-extent (idempotent, no churn), refuses once the growth
 * doc hits `REGISTER_AREA_MAX_GROWTH`, and only stores relations that
 * actually resolve to a real boundary extent (junk ids derive nothing and
 * are dropped). All non-fatal outcomes return 200 with a `status` so the
 * client can fire-and-forget.
 */
async function handleRegisterArea(
    request: Request,
    env: Env,
    cors: HeadersInit,
): Promise<Response> {
    if (request.method !== "POST") {
        return new Response("Method not allowed", {
            status: 405,
            headers: { ...cors, Allow: "POST" },
        });
    }
    let body: { name?: unknown; relationId?: unknown };
    try {
        body = (await request.json()) as { name?: unknown; relationId?: unknown };
    } catch {
        return jsonResponse({ error: "invalid JSON body" }, 400, cors);
    }
    const relationId = Number(body.relationId);
    if (!Number.isFinite(relationId) || relationId <= 0) {
        return jsonResponse(
            { error: "relationId (positive number) required" },
            400,
            cors,
        );
    }
    const name =
        typeof body.name === "string" && body.name.trim()
            ? body.name.trim()
            : null;
    if (!name) {
        return jsonResponse({ error: "name required" }, 400, cors);
    }
    // Idempotent: already seeded/registered with an extent → nothing to do.
    try {
        const cities = await getPopularCities(env);
        const existing = cities.find((c) => c.relationId === relationId);
        if (existing?.extent) {
            return jsonResponse(
                { status: "already-registered", relationId },
                200,
                cors,
            );
        }
    } catch {
        /* fall through — treat as unknown */
    }
    // Abuse backstop: bound the public growth doc.
    try {
        const growth = await loadDiscoveredCities(env);
        if (growth.length >= REGISTER_AREA_MAX_GROWTH) {
            return jsonResponse({ status: "growth-full", relationId }, 200, cors);
        }
    } catch {
        /* ignore — proceed best-effort */
    }
    const extent = await bboxFromRelation(relationId).catch(() => null);
    if (!extent) {
        // Not a resolvable boundary (or a transient miss) — don't store junk.
        return jsonResponse({ status: "no-extent", relationId }, 200, cors);
    }
    try {
        await upsertDiscoveredCity(env, { name, relationId, extent });
        return jsonResponse({ status: "registered", relationId, name }, 200, cors);
    } catch (e) {
        console.warn(`register-area upsert failed r${relationId}:`, e);
        return jsonResponse({ status: "store-failed", relationId }, 200, cors);
    }
}

/**
 * `POST /admin/verify-city` (secret) — run the star verification for one
 * city NOW and stamp `fullyCuratedAt` / `adjacentsCuratedAt` if it passes
 * (v684). Same server-side check as the cron's Phase-4 stamp (shared
 * `verifyAndStampCity`), exposed so the laptop-prewarmer can earn the star
 * the instant it finishes warming a city + its adjacents — instead of
 * waiting for the cron to happen to pick that city. Body `{relationId}`.
 * Returns the live verification result + whether a stamp was written.
 */
async function handleAdminVerifyCity(
    request: Request,
    env: Env,
    cors: HeadersInit,
): Promise<Response> {
    if (request.method !== "POST") {
        return new Response("Method not allowed", {
            status: 405,
            headers: { ...cors, Allow: "POST" },
        });
    }
    if (!checkAdminAuth(request, env)) {
        return new Response("Unauthorized", { status: 401, headers: cors });
    }
    let body: { relationId?: unknown };
    try {
        body = (await request.json()) as { relationId?: unknown };
    } catch {
        return jsonResponse({ error: "invalid JSON body" }, 400, cors);
    }
    const relationId = Number(body.relationId);
    if (!Number.isFinite(relationId) || relationId <= 0) {
        return jsonResponse(
            { error: "relationId (positive number) required" },
            400,
            cors,
        );
    }
    const ttlMs =
        (parseInt(env.CACHE_TTL_DAYS, 10) || 30) * 24 * 60 * 60 * 1000;
    // Use the stored city (extent + current stamps) so the verifier can
    // derive neighbours and preserve name; fall back to a bare entry.
    let city: CityEntry | undefined;
    try {
        city = (await getPopularCities(env)).find(
            (c) => c.relationId === relationId,
        );
    } catch {
        /* fall through to bare */
    }
    if (!city) city = { name: `relation ${relationId}`, relationId };
    try {
        const v = await verifyAndStampCity(env, city, ttlMs);
        return jsonResponse({ relationId, name: city.name, ...v }, 200, cors);
    } catch (e) {
        return jsonResponse(
            { error: e instanceof Error ? e.message : String(e) },
            500,
            cors,
        );
    }
}

/**
 * `GET /admin/city-neighbours?relationId=<N>&secret=<…>` (v696) — the EXACT
 * adjacent-area relation ids the star gate checks for this city
 * (`deriveAdjacentNeighbourIds`, from cached topological adjacency, capped at
 * 14), plus best-effort names. The laptop-prewarmer's `--city-complete` mode
 * warms precisely THESE so the neighbours it caches match the ones
 * `verifyAndStampCity` requires — the laptop's own `findNeighbors`
 * (admin_level-around) diverges badly for megacities (NYC is admin_level 5:
 * no same-level neighbours, so it found none, and the city could never earn
 * its star). Requires the city's adjacent-search queries to be cached first
 * (the caller warms the primary before asking). Read-only.
 */
async function handleAdminCityNeighbours(
    request: Request,
    env: Env,
    cors: HeadersInit,
): Promise<Response> {
    if (!checkAdminAuth(request, env)) {
        return new Response("Unauthorized", { status: 401, headers: cors });
    }
    const relationId = Number(
        new URL(request.url).searchParams.get("relationId"),
    );
    if (!Number.isFinite(relationId) || relationId <= 0) {
        return jsonResponse(
            { error: "relationId (positive number) required" },
            400,
            cors,
        );
    }
    let city: CityEntry | undefined;
    try {
        city = (await getPopularCities(env)).find(
            (c) => c.relationId === relationId,
        );
    } catch {
        /* fall through */
    }
    if (!city) city = { name: `relation ${relationId}`, relationId };
    // deriveAdjacentNeighbourIds needs an extent for the admin-band midpoint;
    // fall back to the boundary-geometry extent if the stored one is absent.
    if (!city.extent) {
        const ext = await canonicalReferenceExtent(env, city);
        if (ext) city = { ...city, extent: ext };
    }
    const { ids, adjacencyKnown } = await deriveAdjacentNeighbourIds(env, city);
    // Best-effort names from the cached topological adjacency result (the
    // same source the ids come from) so the laptop's logs are readable.
    const nameById = new Map<number, string>();
    try {
        const topoKey = await r2KeyForQuery(
            buildTopologicalAdjacencyQuery(relationId),
        );
        const obj = await env.CACHE.get(`overpass/${topoKey}`);
        if (obj) {
            const parsed = JSON.parse(await readR2Text(obj)) as {
                elements?: Array<{
                    type?: string;
                    id?: number;
                    tags?: Record<string, string>;
                }>;
            };
            for (const el of parsed.elements ?? []) {
                if (el?.type === "relation" && typeof el.id === "number") {
                    const nm = el.tags?.name ?? el.tags?.["name:en"];
                    if (nm) nameById.set(el.id, nm);
                }
            }
        }
    } catch {
        /* names best-effort */
    }
    const neighbours = ids.map((id) => ({
        relationId: id,
        name: nameById.get(id) ?? `r${id}`,
    }));
    return jsonResponse(
        { relationId, adjacencyKnown, count: neighbours.length, neighbours },
        200,
        cors,
    );
}

/** Does an OSM element's tags satisfy an Overpass filter string like
 *  `["diplomatic"="consulate"]` or `["aeroway"="aerodrome"]["iata"]`?
 *  Parses the `["key"="value"]` / `["key"]` clauses and checks each. */
function elementMatchesFilter(
    tags: Record<string, string> | undefined,
    filter: string,
): boolean {
    if (!tags) return false;
    // Clauses: ["key"], ["key"="v"], ["key"~"re"], ["key"!~"re"].
    const re = /\["([^"]+)"(?:(=|!=|~|!~)"([^"]+)")?\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(filter)) !== null) {
        const key = m[1];
        const op = m[2];
        const value = m[3];
        const has = Object.prototype.hasOwnProperty.call(tags, key);
        if (op === "!~") {
            // Overpass !~ matches when the key is absent OR doesn't match.
            if (has && new RegExp(value).test(tags[key])) return false;
            continue;
        }
        if (!has) return false;
        if (op === "=" && tags[key] !== value) return false;
        if (op === "!=" && tags[key] === value) return false;
        if (op === "~" && !new RegExp(value).test(tags[key])) return false;
    }
    return true;
}

/**
 * `GET /admin/inspect-refs?id=<relationId>&secret=…` (v684) — read a city's
 * STORED combined reference body from R2 and report the per-family element
 * count. Diagnostic for "why is family X empty on this play area": tells a
 * genuinely-0 family (filter too narrow, e.g. `["diplomatic"="consulate"]`
 * missing `consulate_general`) apart from a truncated warm (many families
 * suspiciously low + an abort remark). Read-only; never fetches upstream.
 */
async function handleAdminInspectRefs(
    request: Request,
    env: Env,
    cors: HeadersInit,
): Promise<Response> {
    if (!checkAdminAuth(request, env)) {
        return new Response("Unauthorized", { status: 401, headers: cors });
    }
    const relationId = parseInt(
        new URL(request.url).searchParams.get("id") ?? "",
        10,
    );
    if (!Number.isFinite(relationId) || relationId <= 0) {
        return jsonResponse({ error: "id (relation) query param required" }, 400, cors);
    }
    const ext = await canonicalReferenceExtent(env, {
        relationId,
        name: "",
    } as CityEntry);
    if (!ext) {
        return jsonResponse(
            { relationId, cached: false, reason: "no-boundary/extent" },
            200,
            cors,
        );
    }
    const query = buildReferenceBboxQuery(ext);
    const key = await r2KeyForQuery(query);
    let obj: R2ObjectBody | null = null;
    try {
        obj = await env.CACHE.get(`overpass/${key}`);
    } catch {
        /* miss */
    }
    if (!obj) {
        return jsonResponse(
            { relationId, extent: ext, cached: false, reason: "no-refs-entry" },
            200,
            cors,
        );
    }
    let text = "";
    try {
        text = await readR2Text(obj);
    } catch {
        /* unreadable */
    }
    const hasRemark = isAbortedOverpassText(text);
    let elements: Array<{ tags?: Record<string, string> }> = [];
    try {
        elements = (JSON.parse(text).elements ?? []) as typeof elements;
    } catch {
        /* unparseable */
    }
    const families = REFERENCE_FAMILY_FILTERS.map(({ family, filter }) => ({
        family,
        filter,
        count: elements.filter((el) => elementMatchesFilter(el.tags, filter))
            .length,
    }));
    const cachedAt = parseInt(obj.customMetadata?.cachedAt ?? "0", 10) || null;
    return jsonResponse(
        {
            relationId,
            extent: ext,
            cached: true,
            cachedAt,
            hasRemark,
            totalElements: elements.length,
            families,
            zeroFamilies: families.filter((f) => f.count === 0).map((f) => f.family),
        },
        200,
        cors,
    );
}

async function handleAdminStoreTilePack(
    request: Request,
    env: Env,
    cors: HeadersInit,
): Promise<Response> {
    if (request.method !== "POST") {
        return new Response("Method not allowed", {
            status: 405,
            headers: { ...cors, Allow: "POST" },
        });
    }
    if (!checkAdminAuth(request, env)) {
        return new Response("Unauthorized", { status: 401, headers: cors });
    }
    const url = new URL(request.url);
    const osmId = url.searchParams.get("osmId");
    if (!osmId || !/^\d+$/.test(osmId)) {
        return jsonResponse(
            { error: "missing or non-numeric osmId param" },
            400,
            cors,
        );
    }
    const key = tilePackKey(osmId);
    const tilePackHttpMeta = {
        httpMetadata: {
            contentType: "application/octet-stream",
            // Immutable: a pack for a given osmId + pack-version is
            // byte-stable. Matches the master tile serving so the
            // client's plain GET is browser-cached forever (instant
            // reload). When the master basemap changes we bump the
            // v1/ namespace, not this header.
            cacheControl: "public, max-age=31536000, immutable",
        },
        customMetadata: {
            storedAt: String(Date.now()),
            osmId: String(osmId),
            prewarmed: "true",
            kind: "tile-pack",
        },
    } as const;

    // v345: multipart protocol for packs over Cloudflare's single-
    // request body limit. The laptop drives it: ?action=create →
    // ?action=part (×N) → ?action=complete. Absent action = the
    // original single-shot put (small packs).
    const action = url.searchParams.get("action");

    if (action === "create") {
        try {
            const mpu = await env.TILES.createMultipartUpload(
                key,
                tilePackHttpMeta,
            );
            return jsonResponse(
                { status: "created", key, uploadId: mpu.uploadId },
                200,
                cors,
            );
        } catch (e) {
            console.warn(`[tile-pack] createMultipart failed ${key}:`, e);
            return jsonResponse({ error: "create failed" }, 500, cors);
        }
    }

    if (action === "part") {
        const uploadId = url.searchParams.get("uploadId");
        const partNumber = parseInt(
            url.searchParams.get("partNumber") ?? "",
            10,
        );
        if (!uploadId || !Number.isFinite(partNumber) || partNumber < 1) {
            return jsonResponse(
                { error: "missing uploadId / partNumber" },
                400,
                cors,
            );
        }
        if (!request.body) {
            return jsonResponse({ error: "missing body" }, 400, cors);
        }
        try {
            const mpu = env.TILES.resumeMultipartUpload(key, uploadId);
            const uploaded = await mpu.uploadPart(
                partNumber,
                request.body,
            );
            return jsonResponse(
                {
                    status: "part-ok",
                    partNumber: uploaded.partNumber,
                    etag: uploaded.etag,
                },
                200,
                cors,
            );
        } catch (e) {
            console.warn(
                `[tile-pack] uploadPart ${partNumber} failed ${key}:`,
                e,
            );
            return jsonResponse({ error: "part upload failed" }, 500, cors);
        }
    }

    if (action === "complete") {
        const uploadId = url.searchParams.get("uploadId");
        if (!uploadId) {
            return jsonResponse({ error: "missing uploadId" }, 400, cors);
        }
        let parts: Array<{ partNumber: number; etag: string }>;
        try {
            parts = (await request.json()) as Array<{
                partNumber: number;
                etag: string;
            }>;
        } catch {
            return jsonResponse({ error: "bad parts JSON" }, 400, cors);
        }
        try {
            const mpu = env.TILES.resumeMultipartUpload(key, uploadId);
            await mpu.complete(parts);
            return jsonResponse(
                { status: "stored", key, osmId, parts: parts.length },
                200,
                cors,
            );
        } catch (e) {
            console.warn(`[tile-pack] complete failed ${key}:`, e);
            return jsonResponse({ error: "complete failed" }, 500, cors);
        }
    }

    // ── Single-shot path (default) ──────────────────────────────────
    if (!request.body) {
        return jsonResponse({ error: "missing body" }, 400, cors);
    }
    const declaredLen = parseInt(
        request.headers.get("Content-Length") ?? "",
        10,
    );
    if (
        Number.isFinite(declaredLen) &&
        declaredLen > TILE_PACK_SINGLE_SHOT_MAX
    ) {
        // Too big for one request — the laptop should have used
        // multipart. Reject so it's visible rather than silently
        // truncated.
        return jsonResponse(
            {
                status: "use-multipart",
                sizeBytes: declaredLen,
                singleShotLimit: TILE_PACK_SINGLE_SHOT_MAX,
            },
            413,
            cors,
        );
    }
    try {
        await env.TILES.put(key, request.body, tilePackHttpMeta);
    } catch (e) {
        console.warn(`[tile-pack] R2 put failed for ${key}:`, e);
        return jsonResponse({ error: "r2 put failed" }, 500, cors);
    }
    return jsonResponse(
        {
            status: "stored",
            key,
            osmId,
            ...(Number.isFinite(declaredLen)
                ? { sizeBytes: declaredLen }
                : {}),
        },
        200,
        cors,
    );
}

/* ──────────────── OpenRailwayMap tile proxy (v351) ─────────────────── *
 *
 * The "Transit lines" overlay rendered OpenRailwayMap raster tiles
 * straight from *.tiles.openrailwaymap.org. Their servers were 503ing
 * hard (140 of them in one session's HAR) — a single overloaded
 * volunteer service the app has no control over. Proxy + R2-cache them
 * through the worker:
 *   - Self-hosted, per the everything-from-R2 principle.
 *   - RESILIENT: once a tile is cached, it serves from R2 even while
 *     OpenRailwayMap is down. Cold tiles during an outage still 503
 *     (nothing to cache yet) but degrade to a blank overlay, which is
 *     exactly today's behaviour — strictly an improvement.
 *
 *   GET /api/railtile/{z}/{x}/{y}.png
 *       → upstream https://tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png
 *
 * Rail tiles change slowly; a 30-day TTL keeps R2 fresh-ish without
 * re-hammering the upstream. Stored under env.TILES key
 * `railtile/v1/{z}/{x}/{y}.png`.
 */
const RAILTILE_UPSTREAM = "https://tiles.openrailwaymap.org/standard";
const RAILTILE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

async function handleRailTile(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
    cors: HeadersInit,
): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method not allowed", {
            status: 405,
            headers: { ...cors, Allow: "GET, HEAD" },
        });
    }
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/api\/railtile\/(\d+)\/(\d+)\/(\d+)\.png$/);
    if (!m) {
        return new Response("Bad rail tile path", {
            status: 400,
            headers: cors,
        });
    }
    const [, z, x, y] = m;
    const r2Key = `railtile/v1/${z}/${x}/${y}.png`;

    let obj: R2ObjectBody | null = null;
    try {
        obj = await env.TILES.get(r2Key);
    } catch (e) {
        console.warn(`[railtile] R2 get failed for ${r2Key}:`, e);
    }
    if (obj) {
        const cachedAt = parseInt(obj.customMetadata?.storedAt ?? "0", 10);
        const fresh = cachedAt && Date.now() - cachedAt < RAILTILE_TTL_MS;
        if (fresh) {
            return new Response(request.method === "HEAD" ? null : obj.body, {
                status: 200,
                headers: {
                    ...corsHeadersAsObject(cors),
                    "Content-Type": "image/png",
                    "Cache-Control": "public, max-age=604800",
                    "X-Cache": "R2_HIT",
                },
            });
        }
    }

    const upstreamUrl = `${RAILTILE_UPSTREAM}/${z}/${x}/${y}.png`;
    let upstream: Response;
    try {
        upstream = await fetch(upstreamUrl, {
            headers: {
                // OpenRailwayMap blocks blank UAs; identify politely.
                "User-Agent":
                    "jlhs-tile-proxy/1.0 (+https://github.com/kmja/jetlaghideandseek)",
            },
        });
    } catch (e) {
        console.warn(`[railtile] upstream fetch failed ${upstreamUrl}:`, e);
        // Serve a stale R2 copy if we have one — better a slightly
        // old rail overlay than a hole.
        if (obj) {
            return new Response(request.method === "HEAD" ? null : obj.body, {
                status: 200,
                headers: {
                    ...corsHeadersAsObject(cors),
                    "Content-Type": "image/png",
                    "X-Cache": "R2_STALE",
                },
            });
        }
        return new Response(null, { status: 503, headers: cors });
    }
    if (!upstream.ok) {
        // Upstream 503/404 — fall back to stale R2 if present.
        if (obj) {
            return new Response(request.method === "HEAD" ? null : obj.body, {
                status: 200,
                headers: {
                    ...corsHeadersAsObject(cors),
                    "Content-Type": "image/png",
                    "X-Cache": "R2_STALE",
                },
            });
        }
        return new Response(null, { status: upstream.status, headers: cors });
    }
    const bytes = await upstream.arrayBuffer();
    ctx.waitUntil(
        env.TILES.put(r2Key, bytes, {
            httpMetadata: {
                contentType: "image/png",
                cacheControl: "public, max-age=604800",
            },
            customMetadata: { storedAt: String(Date.now()), kind: "railtile" },
        }).catch((e) =>
            console.warn(`[railtile] R2 put failed for ${r2Key}:`, e),
        ),
    );
    return new Response(request.method === "HEAD" ? null : bytes, {
        status: 200,
        headers: {
            ...corsHeadersAsObject(cors),
            "Content-Type": "image/png",
            "Cache-Control": "public, max-age=604800",
            "X-Cache": "MISS",
        },
    });
}

/* ───────────────────── Satellite tile proxy (v664) ─────────────────── *
 *
 * Esri World Imagery was the LAST unproxied external map dependency at
 * game time (CLAUDE.md's self-hosting audit). Same R2-backed pattern as
 * the rail-tile proxy above — self-hosted once warm, resilient to an
 * upstream outage (stale R2 beats a hole in the basemap).
 *
 *   GET /api/sattile/{z}/{y}/{x}
 *       → upstream https://server.arcgisonline.com/ArcGIS/rest/services/
 *         World_Imagery/MapServer/tile/{z}/{y}/{x}
 *
 * NOTE the {z}/{y}/{x} order — Esri's tile scheme puts y before x; the
 * proxy keeps the SAME order so the client template swap is mechanical.
 * Imagery changes very slowly; 90-day R2 TTL. Stored under env.TILES
 * key `sattile/v1/{z}/{y}/{x}.jpg`.
 */
const SATTILE_UPSTREAM =
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile";
const SATTILE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

async function handleSatTile(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
    cors: HeadersInit,
): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method not allowed", {
            status: 405,
            headers: { ...cors, Allow: "GET, HEAD" },
        });
    }
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/api\/sattile\/(\d+)\/(\d+)\/(\d+)$/);
    if (!m) {
        return new Response("Bad satellite tile path", {
            status: 400,
            headers: cors,
        });
    }
    const [, z, y, x] = m;
    const r2Key = `sattile/v1/${z}/${y}/${x}.jpg`;

    let obj: R2ObjectBody | null = null;
    try {
        obj = await env.TILES.get(r2Key);
    } catch (e) {
        console.warn(`[sattile] R2 get failed for ${r2Key}:`, e);
    }
    if (obj) {
        const cachedAt = parseInt(obj.customMetadata?.storedAt ?? "0", 10);
        const fresh = cachedAt && Date.now() - cachedAt < SATTILE_TTL_MS;
        if (fresh) {
            return new Response(request.method === "HEAD" ? null : obj.body, {
                status: 200,
                headers: {
                    ...corsHeadersAsObject(cors),
                    "Content-Type": "image/jpeg",
                    "Cache-Control": "public, max-age=604800",
                    "X-Cache": "R2_HIT",
                },
            });
        }
    }

    const upstreamUrl = `${SATTILE_UPSTREAM}/${z}/${y}/${x}`;
    let upstream: Response;
    try {
        upstream = await fetch(upstreamUrl, {
            headers: {
                "User-Agent":
                    "jlhs-tile-proxy/1.0 (+https://github.com/kmja/jetlaghideandseek)",
            },
        });
    } catch (e) {
        console.warn(`[sattile] upstream fetch failed ${upstreamUrl}:`, e);
        if (obj) {
            return new Response(request.method === "HEAD" ? null : obj.body, {
                status: 200,
                headers: {
                    ...corsHeadersAsObject(cors),
                    "Content-Type": "image/jpeg",
                    "X-Cache": "R2_STALE",
                },
            });
        }
        return new Response(null, { status: 503, headers: cors });
    }
    if (!upstream.ok) {
        if (obj) {
            return new Response(request.method === "HEAD" ? null : obj.body, {
                status: 200,
                headers: {
                    ...corsHeadersAsObject(cors),
                    "Content-Type": "image/jpeg",
                    "X-Cache": "R2_STALE",
                },
            });
        }
        return new Response(null, { status: upstream.status, headers: cors });
    }
    const bytes = await upstream.arrayBuffer();
    const contentType =
        upstream.headers.get("Content-Type") ?? "image/jpeg";
    ctx.waitUntil(
        env.TILES.put(r2Key, bytes, {
            httpMetadata: {
                contentType,
                cacheControl: "public, max-age=604800",
            },
            customMetadata: { storedAt: String(Date.now()), kind: "sattile" },
        }).catch((e) =>
            console.warn(`[sattile] R2 put failed for ${r2Key}:`, e),
        ),
    );
    return new Response(request.method === "HEAD" ? null : bytes, {
        status: 200,
        headers: {
            ...corsHeadersAsObject(cors),
            "Content-Type": contentType,
            "Cache-Control": "public, max-age=604800",
            "X-Cache": "MISS",
        },
    });
}

/* ───────────────── Map glyph + sprite proxy (v349) ──────────────────── *
 *
 * The MapLibre basemap style loads label fonts (glyph PBFs) and
 * highway-shield sprites (PNG + JSON) from protomaps.github.io. Those
 * were the last external map dependency at game time — every fresh map
 * view hit github.io directly. This proxies them through the worker,
 * R2-cached + immutable, so they're self-hosted like the basemap tiles
 * and elevation tiles. They're GLOBAL (same fonts/icons everywhere),
 * so the R2 cache fills once and serves every player thereafter.
 *
 *   GET /api/mapasset/fonts/<fontstack>/<range>.pbf
 *   GET /api/mapasset/sprites/v4/<dark|light>[@2x].<json|png>
 *       → upstream https://protomaps.github.io/basemaps-assets/<path>
 *
 * The client points the style's `glyphs` + `sprite` URLs here (see
 * src/lib/protomapsStyle.ts). Stored under env.TILES key
 * `mapasset/v1/<path>`. Upstream Content-Type is forwarded so MapLibre
 * gets image/png / application/json / the glyph PBF type unchanged.
 */
const MAPASSET_UPSTREAM = "https://protomaps.github.io/basemaps-assets";

async function handleMapAsset(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
    cors: HeadersInit,
): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method not allowed", {
            status: 405,
            headers: { ...cors, Allow: "GET, HEAD" },
        });
    }
    const url = new URL(request.url);
    // Everything after /api/mapasset/ is the upstream path.
    const path = url.pathname.slice("/api/mapasset/".length);
    // Reject path traversal; allow the slashes + @ + . the asset paths
    // legitimately contain.
    if (!path || path.includes("..")) {
        return new Response("Bad asset path", {
            status: 400,
            headers: cors,
        });
    }
    const r2Key = `mapasset/v1/${path}`;

    let obj: R2ObjectBody | null = null;
    try {
        obj = await env.TILES.get(r2Key);
    } catch (e) {
        console.warn(`[mapasset] R2 get failed for ${r2Key}:`, e);
    }
    if (obj) {
        const ct =
            obj.httpMetadata?.contentType ?? "application/octet-stream";
        return new Response(request.method === "HEAD" ? null : obj.body, {
            status: 200,
            headers: {
                ...corsHeadersAsObject(cors),
                "Content-Type": ct,
                "Cache-Control": "public, max-age=31536000, immutable",
                "X-Cache": "R2_HIT",
            },
        });
    }

    // Upstream protomaps basemaps-assets bucket.
    const upstreamUrl = `${MAPASSET_UPSTREAM}/${path}`;
    let upstream: Response;
    try {
        upstream = await fetch(upstreamUrl);
    } catch (e) {
        console.warn(`[mapasset] upstream fetch failed ${upstreamUrl}:`, e);
        return new Response("Upstream map asset unreachable", {
            status: 502,
            headers: cors,
        });
    }
    if (!upstream.ok) {
        // 404 is normal for font ranges with no glyphs — forward it;
        // MapLibre treats a missing range as "no glyphs here".
        return new Response(null, { status: upstream.status, headers: cors });
    }
    const contentType =
        upstream.headers.get("Content-Type") ?? "application/octet-stream";
    const bytes = await upstream.arrayBuffer();
    ctx.waitUntil(
        env.TILES.put(r2Key, bytes, {
            httpMetadata: {
                contentType,
                cacheControl: "public, max-age=31536000, immutable",
            },
            customMetadata: {
                storedAt: String(Date.now()),
                kind: "mapasset",
            },
        }).catch((e) =>
            console.warn(`[mapasset] R2 put failed for ${r2Key}:`, e),
        ),
    );
    return new Response(request.method === "HEAD" ? null : bytes, {
        status: 200,
        headers: {
            ...corsHeadersAsObject(cors),
            "Content-Type": contentType,
            "Cache-Control": "public, max-age=31536000, immutable",
            "X-Cache": "MISS",
        },
    });
}

/* ──────────────────── Elevation tile proxy (v342) ──────────────────── *
 *
 * Sea-level measuring questions need a digital elevation model to split
 * the map by altitude contour. We self-host it the same way as the
 * basemap: proxy the public AWS "Terrain Tiles" dataset (Terrarium PNG
 * encoding) through this worker, cache each tile in R2, and serve it
 * back with immutable cache headers + CORS so the client can decode it
 * with a Canvas without tainting it.
 *
 *   GET /api/elevation/{z}/{x}/{y}.png
 *       → upstream https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png
 *
 * Terrarium encoding: elevation_m = (R*256 + G + B/256) - 32768. The
 * client does that decode; the worker just moves + caches bytes. Tiles
 * are immutable (the DEM doesn't change), so first request per tile
 * hits AWS, every subsequent request anywhere hits R2 / the edge.
 * Prewarmable per-city by the laptop, same as basemap tile packs.
 *
 * Stored under env.TILES (same bucket as the basemap) keyed
 * `elevation/v1/{z}/{x}/{y}.png`.
 */
const ELEVATION_UPSTREAM =
    "https://s3.amazonaws.com/elevation-tiles-prod/terrarium";

async function handleElevationTile(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
    cors: HeadersInit,
): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method not allowed", {
            status: 405,
            headers: { ...cors, Allow: "GET, HEAD" },
        });
    }
    const url = new URL(request.url);
    // Path: /api/elevation/{z}/{x}/{y}.png
    const m = url.pathname.match(
        /^\/api\/elevation\/(\d+)\/(\d+)\/(\d+)\.png$/,
    );
    if (!m) {
        return new Response("Bad elevation tile path", {
            status: 400,
            headers: cors,
        });
    }
    const [, z, x, y] = m;
    const r2Key = `elevation/v1/${z}/${x}/${y}.png`;

    // R2 first.
    let obj: R2ObjectBody | null = null;
    try {
        obj = await env.TILES.get(r2Key);
    } catch (e) {
        console.warn(`[elevation] R2 get failed for ${r2Key}:`, e);
    }
    if (obj) {
        return new Response(
            request.method === "HEAD" ? null : obj.body,
            {
                status: 200,
                headers: {
                    ...corsHeadersAsObject(cors),
                    "Content-Type": "image/png",
                    "Cache-Control":
                        "public, max-age=31536000, immutable",
                    "X-Cache": "R2_HIT",
                },
            },
        );
    }

    // Upstream AWS Terrain Tiles.
    const upstreamUrl = `${ELEVATION_UPSTREAM}/${z}/${x}/${y}.png`;
    let upstream: Response;
    try {
        upstream = await fetch(upstreamUrl);
    } catch (e) {
        console.warn(`[elevation] upstream fetch failed ${upstreamUrl}:`, e);
        return new Response("Upstream elevation unreachable", {
            status: 502,
            headers: cors,
        });
    }
    if (!upstream.ok) {
        // AWS 404s for tiles outside data coverage (e.g. far ocean at
        // high zoom). Forward the status; the client treats a missing
        // tile as "no data here" and skips it.
        return new Response(null, {
            status: upstream.status,
            headers: cors,
        });
    }
    // Tee: one copy to the client, one buffered into R2.
    const bytes = await upstream.arrayBuffer();
    ctx.waitUntil(
        env.TILES.put(r2Key, bytes, {
            httpMetadata: {
                contentType: "image/png",
                cacheControl: "public, max-age=31536000, immutable",
            },
            customMetadata: {
                storedAt: String(Date.now()),
                kind: "elevation",
            },
        }).catch((e) =>
            console.warn(`[elevation] R2 put failed for ${r2Key}:`, e),
        ),
    );
    return new Response(request.method === "HEAD" ? null : bytes, {
        status: 200,
        headers: {
            ...corsHeadersAsObject(cors),
            "Content-Type": "image/png",
            "Cache-Control": "public, max-age=31536000, immutable",
            "X-Cache": "MISS",
        },
    });
}

/* ────────────────────── Photon geocoding proxy ─────────────────────── *
 *
 * v333. The client (src/maps/api/geocode.ts) used to hit
 * photon.komoot.io directly for every search box submission, every
 * map-tap reverse lookup, and every play-area picker reverse
 * candidate. That's a free public service, but it's the only
 * external API not gated by our R2 cache — so it was the one
 * remaining unbounded-rate cold path. Two routes here proxy it:
 *
 *   GET /api/photon/forward?lang=en&q=stockholm
 *       → upstream `https://photon.komoot.io/api/?lang=en&q=stockholm`
 *   GET /api/photon/reverse?lat=59.3&lon=18.0&lang=en
 *       → upstream `https://photon.komoot.io/reverse?lat=59.3&lon=18.0&lang=en`
 *
 * Same edge-cache + R2 + upstream cascade as `/api/interpreter`,
 * but simpler — Photon responses are kilobytes, not megabytes, so
 * we just buffer-and-store rather than streaming through gzip.
 * Canonical key is SHA-256 over `<kind>|<sorted-params>`; same kind
 * + same params from any client land on the same R2 entry.
 *
 * 30-day TTL (geocoding data rarely changes meaningfully). Empty
 * Photon responses are cached too — the worst case is "Photon
 * couldn't resolve this string" stays cached for 30 days, but that
 * answer is stable for any practical input.
 */
async function handlePhoton(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
    cors: HeadersInit,
    kind: "forward" | "reverse",
): Promise<Response> {
    if (request.method !== "GET") {
        return new Response("Method not allowed", {
            status: 405,
            headers: { ...cors, Allow: "GET" },
        });
    }
    const url = new URL(request.url);
    const params = url.searchParams;

    // Canonical key: sort params for byte-stable hashing across
    // clients that emit them in different orders.
    const collected: Array<[string, string]> = [];
    params.forEach((v, k) => collected.push([k, v]));
    collected.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const canonical = collected.map(([k, v]) => `${k}=${v}`).join("&");
    const hash = await r2KeyForQuery(`${kind}|${canonical}`);
    const r2Key = `photon/v1/${kind}/${hash}`;

    // Edge cache (Cache API). Synthetic key over a fixed host so
    // the cache lookup is stable regardless of the worker's public
    // URL. Same trick the /api/interpreter handler uses.
    const cacheUrl = `https://jlhs-photon-cache/${kind}/${hash}`;
    const edgeCache = (caches as unknown as { default: Cache }).default;
    const cacheReq = new Request(cacheUrl);
    const edgeHit = await edgeCache.match(cacheReq);
    if (edgeHit) {
        return appendCacheStatus(edgeHit, cors, "EDGE_HIT");
    }

    // R2.
    const ttlMs =
        (parseInt(env.CACHE_TTL_DAYS, 10) || 30) * 24 * 60 * 60 * 1000;
    let r2Obj: R2ObjectBody | null = null;
    try {
        r2Obj = await env.CACHE.get(r2Key);
    } catch (e) {
        console.warn(`[photon] R2 get failed for ${r2Key}:`, e);
    }
    if (r2Obj) {
        const cachedAt = parseInt(
            r2Obj.customMetadata?.cachedAt ?? "0",
            10,
        );
        if (cachedAt && Date.now() - cachedAt < ttlMs) {
            const body = await readR2Text(r2Obj);
            const resp = new Response(body, {
                status: 200,
                headers: {
                    ...corsHeadersAsObject(cors),
                    "Content-Type": "application/json",
                    "Cache-Control": `public, max-age=${CACHE_API_TTL_SECS}`,
                    "X-Cache": "R2_HIT",
                },
            });
            ctx.waitUntil(edgeCache.put(cacheReq, resp.clone()));
            return resp;
        }
    }

    // Upstream — go straight to Photon. No mirror chain because
    // Photon doesn't have public-mirror equivalents; if it's down,
    // every client falls back to graceful nulls via geocode.ts's
    // existing `.catch(() => null)` paths.
    const upstreamUrl =
        kind === "forward"
            ? `https://photon.komoot.io/api/?${params.toString()}`
            : `https://photon.komoot.io/reverse?${params.toString()}`;
    let upstreamResp: Response;
    try {
        upstreamResp = await fetch(upstreamUrl, {
            headers: { Accept: "application/json" },
        });
    } catch (e) {
        console.warn(`[photon] upstream fetch failed for ${upstreamUrl}:`, e);
        return new Response("Upstream Photon unreachable", {
            status: 502,
            headers: cors,
        });
    }
    if (!upstreamResp.ok) {
        // Forward Photon's error status (e.g. 4xx for malformed
        // params, 5xx for outages) so the client can decide what to
        // do. Don't cache errors — only successes go into R2.
        return new Response(await upstreamResp.text(), {
            status: upstreamResp.status,
            headers: { ...cors, "Content-Type": "application/json" },
        });
    }
    const bodyText = await upstreamResp.text();

    // Store in R2 + edge cache. Both are best-effort via waitUntil
    // so a slow R2 write doesn't delay the response.
    ctx.waitUntil(
        compressAndStoreAtKey(env, r2Key, bodyText, {
            kind: "photon",
        }).catch((e) =>
            console.warn(`[photon] R2 put failed for ${r2Key}:`, e),
        ),
    );
    const resp = new Response(bodyText, {
        status: 200,
        headers: {
            ...corsHeadersAsObject(cors),
            "Content-Type": "application/json",
            "Cache-Control": `public, max-age=${CACHE_API_TTL_SECS}`,
            "X-Cache": "MISS",
        },
    });
    ctx.waitUntil(edgeCache.put(cacheReq, resp.clone()));
    return resp;
}

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

    // CORS-friendly proxy for the Protomaps demo bucket. Browser
    // requests to `demo-bucket.protomaps.com` are blocked by CORS, but
    // a Worker fetch is server-side and has no such restriction. We
    // forward the Range header so the pmtiles protocol's byte-range
    // reads work transparently, then staple on our own CORS headers.
    // This path is only reached when our R2 file is missing — it's the
    // last-resort fallback, not the hot path.
    if (key === "protomaps-fallback") {
        const DEMO_URL = "https://demo-bucket.protomaps.com/v4.pmtiles";
        const fwdHeaders: Record<string, string> = {};
        const rawRange = request.headers.get("Range");
        if (rawRange) fwdHeaders["Range"] = rawRange;
        let proxyResp: Response;
        try {
            proxyResp = await ufetch(DEMO_URL, {
                method: request.method,
                headers: fwdHeaders,
            });
        } catch (e) {
            return new Response("Demo proxy unreachable", {
                status: 502,
                headers: cors,
            });
        }
        const outHeaders: HeadersInit = { ...cors };
        for (const h of [
            "Content-Type",
            "Content-Length",
            "Content-Range",
            "Accept-Ranges",
            "ETag",
        ]) {
            const v = proxyResp.headers.get(h);
            if (v) (outHeaders as Record<string, string>)[h] = v;
        }
        return new Response(
            request.method === "HEAD" ? null : proxyResp.body,
            { status: proxyResp.status, headers: outHeaders },
        );
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

interface CacheStats {
    cachedEntries: number;
    totalBytes: number;
    prewarmedEntries: number;
    tooManyToCountExactly: boolean;
    /** Entry counts keyed by the `kind` customMetadata tag
     *  (boundary, references, transit, adjacent-topological, …).
     *  Entries written without a kind (on-demand caches) bucket under
     *  "(unlabelled)". Lets you watch a specific prewarm phase fill. */
    byKind: Record<string, number>;
    computedAt: number;
}

/** ~60 s memo so the public /status route can't be turned into a flood
 *  of R2 list operations. Shared by the admin + public handlers. */
let cacheStatsMemo: CacheStats | null = null;
const CACHE_STATS_TTL_MS = 60_000;

/** Safety ceiling on the scan. Each R2 list page is 1000 keys (=1
 *  subrequest), so this is up to 80 list calls — well inside the
 *  per-invocation subrequest budget, and only ever paid once per memo
 *  window. Big enough to count the whole cache exactly at our scale
 *  (well past the ~10–20k entries we run today). */
const CACHE_STATS_MAX_SCAN = 80_000;

/** Walk the `overpass/` prefix and tally counts, bytes, prewarmed
 *  count, and a per-`kind` breakdown. Pages the full prefix (up to
 *  CACHE_STATS_MAX_SCAN) so `byKind` is exact, not a sample. Memoised
 *  ~60 s. */
async function computeCacheStats(env: Env): Promise<CacheStats> {
    if (cacheStatsMemo && Date.now() - cacheStatsMemo.computedAt < CACHE_STATS_TTL_MS) {
        return cacheStatsMemo;
    }
    // R2 doesn't surface a cheap "count + total size" without
    // listing every key. Page the whole prefix, bounded by
    // CACHE_STATS_MAX_SCAN so a runaway cache can't hang the request.
    let cursor: string | undefined = undefined;
    let count = 0;
    let totalBytes = 0;
    let prewarmedCount = 0;
    const byKind: Record<string, number> = {};
    do {
        const page: R2Objects = await env.CACHE.list({
            prefix: "overpass/",
            cursor,
            limit: 1000,
            include: ["customMetadata"],
        });
        for (const obj of page.objects) {
            count++;
            const sb = parseInt(
                obj.customMetadata?.sizeBytes ?? String(obj.size),
                10,
            );
            if (!isNaN(sb)) totalBytes += sb;
            if (obj.customMetadata?.prewarmed === "true") prewarmedCount++;
            const kind = obj.customMetadata?.kind ?? "(unlabelled)";
            byKind[kind] = (byKind[kind] ?? 0) + 1;
        }
        cursor = page.truncated ? page.cursor : undefined;
        if (count >= CACHE_STATS_MAX_SCAN) break;
    } while (cursor);
    cacheStatsMemo = {
        cachedEntries: count,
        totalBytes,
        prewarmedEntries: prewarmedCount,
        tooManyToCountExactly: count >= CACHE_STATS_MAX_SCAN,
        byKind,
        computedAt: Date.now(),
    };
    return cacheStatsMemo;
}

async function handleAdminStatus(
    request: Request,
    env: Env,
    cors: HeadersInit,
): Promise<Response> {
    if (!checkAdminAuth(request, env)) {
        return new Response("Unauthorized", { status: 401, headers: cors });
    }
    try {
        const stats = await computeCacheStats(env);
        return jsonResponse(stats, 200, cors);
    } catch (e) {
        return jsonResponse(
            {
                error: "R2 list failed — bucket may not exist yet.",
                details: e instanceof Error ? e.message : String(e),
            },
            503,
            cors,
        );
    }
}

/** Public (no-secret) prewarm progress. Same aggregates as
 *  handleAdminStatus — non-sensitive — so it's safe to open in a
 *  browser and bookmark. */
async function handlePublicStatus(
    env: Env,
    cors: HeadersInit,
): Promise<Response> {
    try {
        const stats = await computeCacheStats(env);
        return new Response(JSON.stringify(stats, null, 2), {
            status: 200,
            headers: {
                ...cors,
                "Content-Type": "application/json",
                // Let the browser/CDN hold it briefly too.
                "Cache-Control": "public, max-age=60",
            },
        });
    } catch (e) {
        return jsonResponse(
            {
                error: "R2 list failed — bucket may not exist yet.",
                details: e instanceof Error ? e.message : String(e),
            },
            503,
            cors,
        );
    }
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
 * `GET /admin/prewarmed-cities?secret=<…>` — the cities that are
 * ACTUALLY warmed in R2 right now (vs. `/admin/list-cities`, which is the
 * candidate table of what COULD be warmed). The R2 keys are opaque
 * hashes, so this reads each object's `customMetadata` and dedupes by
 * `sourceRelationId`, returning one row per city with its name, the set
 * of warmed `kind`s present (boundary / references / hsr / transit-shard
 * …), and how many cache entries it owns. Memoised ~60 s, bounded by the
 * same scan ceiling as `/admin/status` so it can't flood R2 list ops.
 */
interface PrewarmedCity {
    relationId: string;
    name: string | null;
    kinds: string[];
    entries: number;
}
let prewarmedCitiesMemo: {
    cities: PrewarmedCity[];
    scanned: number;
    truncated: boolean;
    computedAt: number;
} | null = null;

async function handleAdminPrewarmedCities(
    request: Request,
    env: Env,
    cors: HeadersInit,
): Promise<Response> {
    if (!checkAdminAuth(request, env)) {
        return new Response("Unauthorized", { status: 401, headers: cors });
    }
    try {
        if (
            prewarmedCitiesMemo &&
            Date.now() - prewarmedCitiesMemo.computedAt < CACHE_STATS_TTL_MS
        ) {
            const { cities, scanned, truncated } = prewarmedCitiesMemo;
            return jsonResponse(
                { count: cities.length, scanned, truncated, cities },
                200,
                cors,
            );
        }
        const byRel = new Map<
            string,
            { name: string | null; kinds: Set<string>; entries: number }
        >();
        let cursor: string | undefined = undefined;
        let scanned = 0;
        do {
            const page: R2Objects = await env.CACHE.list({
                prefix: "overpass/",
                cursor,
                limit: 1000,
                include: ["customMetadata"],
            });
            for (const obj of page.objects) {
                scanned++;
                const md = obj.customMetadata ?? {};
                // Only entries tagged with a city relation id are
                // "cities" — country-shard references / transit shards key
                // on ISO, not a relation, so they're skipped here.
                const rel = md.sourceRelationId;
                if (!rel) continue;
                const cur = byRel.get(rel) ?? {
                    name: null,
                    kinds: new Set<string>(),
                    entries: 0,
                };
                if (md.sourceName && !cur.name) cur.name = md.sourceName;
                if (md.kind) cur.kinds.add(md.kind);
                cur.entries++;
                byRel.set(rel, cur);
            }
            cursor = page.truncated ? page.cursor : undefined;
            if (scanned >= CACHE_STATS_MAX_SCAN) break;
        } while (cursor);

        const cities: PrewarmedCity[] = [...byRel.entries()]
            .map(([relationId, v]) => ({
                relationId,
                name: v.name,
                kinds: [...v.kinds].sort(),
                entries: v.entries,
            }))
            .sort(
                (a, b) =>
                    (a.name ?? "~").localeCompare(b.name ?? "~") ||
                    a.relationId.localeCompare(b.relationId),
            );
        const truncated = scanned >= CACHE_STATS_MAX_SCAN;
        prewarmedCitiesMemo = {
            cities,
            scanned,
            truncated,
            computedAt: Date.now(),
        };
        return jsonResponse(
            { count: cities.length, scanned, truncated, cities },
            200,
            cors,
        );
    } catch (e) {
        return jsonResponse(
            { error: e instanceof Error ? e.message : String(e) },
            500,
            cors,
        );
    }
}

/**
 * `GET /admin/adjacent-curation-status?secret=<…>` — the AUTHORITATIVE
 * readout of the v676 adjacent-area curation gate, per curated city. Unlike
 * `/admin/prewarmed-cities` (which infers coverage from R2 `customMetadata`
 * and so under-reports `batched` references + on-demand warms), this runs
 * the EXACT server-side `relationFullyCurated` check — reading the real
 * boundary/refs/stations R2 keys — over each city's neighbour set (derived
 * by the shared `deriveAdjacentNeighbourIds`, byte-identical to the cron
 * gate). So its `allCurated` per city is precisely what would stamp
 * `adjacentsCuratedAt` and what `WARM_REQUIRE_ADJACENTS` would gate the star
 * on.
 *
 * Query params:
 *   scope   = "hand-curated" (default) | "all" | "top"
 *   top     = N when scope=top (default 100)
 *   limit   = max cities to actually probe (default 60, cap 200) — bounds
 *             the R2-op cost, since each city does ~3 + neighbours×3 reads.
 *
 * Per-city row: { name, relationId, hasExtent, adjacencyKnown,
 *   neighboursTotal, neighboursCurated, allCurated, stamped }. Top-level:
 *   { scope, targets, probed, fullyCurated, stamped, adjacencyUnknown }.
 */
async function handleAdminAdjacentCurationStatus(
    request: Request,
    env: Env,
    cors: HeadersInit,
): Promise<Response> {
    if (!checkAdminAuth(request, env)) {
        return new Response("Unauthorized", { status: 401, headers: cors });
    }
    try {
        const url = new URL(request.url);
        // scope: "seed" (default) = the top-N of the bundled world-cities
        // seed (biggest cities, population-sorted); "top" = first N of the
        // full merged list; "all" = everything.
        const scope = url.searchParams.get("scope") ?? "seed";
        const topN = parseInt(url.searchParams.get("top") ?? "100", 10) || 100;
        const limit = Math.min(
            parseInt(url.searchParams.get("limit") ?? "60", 10) || 60,
            200,
        );

        const all = await getPopularCities(env);
        let targets: CityEntry[];
        if (scope === "all") {
            targets = all;
        } else if (scope === "top") {
            targets = all.slice(0, topN);
        } else {
            // seed: the merged (extent/stamp-carrying) copies of the first
            // topN seed relation ids (the biggest cities).
            const seedIds = new Set(
                SEED_CITIES.slice(0, topN).map((c) => c.relationId),
            );
            targets = all.filter((c) => seedIds.has(c.relationId));
        }
        const probe = targets.slice(0, limit);

        const rows: Array<{
            name: string;
            relationId: number;
            hasExtent: boolean;
            primaryCached: boolean;
            adjacencyKnown: boolean;
            neighboursTotal: number;
            neighboursCurated: number;
            adjacentsCurated: boolean;
            fullyCached: boolean;
            stampedAdjacents: number | null;
            stampedFully: number | null;
        }> = [];
        let fullyCached = 0; // live-verified primary + adjacents
        let stampedFully = 0; // carry the fullyCuratedAt stamp
        let primaryCachedCount = 0; // live-verified PRIMARY (the v690 star)
        let stampedPrimary = 0; // carry the primaryCuratedAt stamp (the star)
        let adjacencyUnknown = 0;

        for (const city of probe) {
            const adjStamp =
                typeof city.adjacentsCuratedAt === "number"
                    ? city.adjacentsCuratedAt
                    : null;
            const fullStamp =
                typeof city.fullyCuratedAt === "number"
                    ? city.fullyCuratedAt
                    : null;
            if (fullStamp !== null) stampedFully++;
            if (typeof city.primaryCuratedAt === "number") stampedPrimary++;
            if (!city.extent) {
                rows.push({
                    name: city.name,
                    relationId: city.relationId,
                    hasExtent: false,
                    primaryCached: false,
                    adjacencyKnown: false,
                    neighboursTotal: 0,
                    neighboursCurated: 0,
                    adjacentsCurated: false,
                    fullyCached: false,
                    stampedAdjacents: adjStamp,
                    stampedFully: fullStamp,
                });
                continue;
            }
            const primaryCached = await relationFullyCurated(
                env,
                city.relationId,
            );
            const { ids, adjacencyKnown } = await deriveAdjacentNeighbourIds(
                env,
                city,
            );
            if (!adjacencyKnown) adjacencyUnknown++;
            const results = await Promise.all(
                ids.map((id) => relationFullyCurated(env, id)),
            );
            const neighboursCurated = results.filter(Boolean).length;
            // Non-empty neighbour set → curated iff every one is (regardless
            // of which source found them; a city can have a full neighbour
            // set from the admin band with the topological query uncached —
            // Rome in the snapshot). Empty set → only vacuously curated when
            // adjacency is actually KNOWN (topological cached + genuinely
            // empty), never when it just hasn't been prewarmed.
            const adjacentsCurated =
                ids.length > 0
                    ? neighboursCurated === ids.length
                    : adjacencyKnown;
            // The star = primary fully cached AND adjacents fully cached.
            const fully = primaryCached && adjacentsCurated;
            if (fully) fullyCached++;
            if (primaryCached) primaryCachedCount++;
            rows.push({
                name: city.name,
                relationId: city.relationId,
                hasExtent: true,
                primaryCached,
                adjacencyKnown,
                neighboursTotal: ids.length,
                neighboursCurated,
                adjacentsCurated,
                fullyCached: fully,
                stampedAdjacents: adjStamp,
                stampedFully: fullStamp,
            });
        }

        rows.sort(
            (a, b) =>
                Number(a.fullyCached) - Number(b.fullyCached) ||
                (a.name ?? "~").localeCompare(b.name ?? "~"),
        );
        return jsonResponse(
            {
                scope,
                starMeaning:
                    env.WARM_STAR_LENIENT === "true"
                        ? "lenient: has-extent"
                        : "strict: fully cached incl. adjacents",
                targets: targets.length,
                probed: probe.length,
                // The star = fullyCached (primary + adjacents). primaryCached
                // is a DIAGNOSTIC — how many primaries are done, so the
                // operator can watch progress toward the (stricter) star.
                primaryCached: primaryCachedCount,
                stampedPrimary,
                fullyCached,
                stampedFully,
                adjacencyUnknown,
                cities: rows,
            },
            200,
            cors,
        );
    } catch (e) {
        return jsonResponse(
            { error: e instanceof Error ? e.message : String(e) },
            500,
            cors,
        );
    }
}

/**
 * `GET /admin/rediscover?secret=<…>&offset=<N>&limit=<M>` — re-resolve a
 * batch of EXISTING discovered cities through the re-rank-fixed
 * resolveNameViaPhoton and rewrite any whose relation id drifted. The old
 * resolver picked Photon's raw first place/boundary relation; discovered
 * entries stored under that logic point at relations the client never
 * fetches (~750 per the drift audit). This walks the discovered doc in
 * batches — Photon is ~1 req/s, so a batch of 20 ≈ 20 s, under the
 * worker's wall-clock budget — and corrects them in place. Loop with the
 * returned `nextOffset` until `done` is true.
 */
async function handleAdminRediscover(
    request: Request,
    env: Env,
    cors: HeadersInit,
): Promise<Response> {
    if (!checkAdminAuth(request, env)) {
        return new Response("Unauthorized", { status: 401, headers: cors });
    }
    try {
        const url = new URL(request.url);
        const offset = Math.max(
            0,
            parseInt(url.searchParams.get("offset") ?? "0", 10) || 0,
        );
        const limit = Math.min(
            25,
            Math.max(
                1,
                parseInt(url.searchParams.get("limit") ?? "20", 10) || 20,
            ),
        );
        const discovered = await loadDiscoveredCities(env);
        const total = discovered.length;
        const updated = discovered.slice();
        const end = Math.min(offset + limit, total);
        let changed = 0;
        let unchanged = 0;
        let failed = 0;
        let dirty = false;
        const changes: Array<{ name: string; from: number; to: number }> = [];
        for (let i = offset; i < end; i++) {
            const entry = discovered[i];
            const r = await resolveNameViaPhoton(entry.name);
            if (!r) {
                failed++;
            } else if (r.relationId !== entry.relationId) {
                updated[i] = {
                    name: entry.name,
                    relationId: r.relationId,
                    extent: r.extent ?? entry.extent,
                };
                changed++;
                dirty = true;
                if (changes.length < 100) {
                    changes.push({
                        name: entry.name,
                        from: entry.relationId,
                        to: r.relationId,
                    });
                }
            } else {
                unchanged++;
                if (r.extent && !entry.extent) {
                    updated[i] = { ...entry, extent: r.extent };
                    dirty = true;
                }
            }
            // Photon courtesy delay; skip after the last item in the batch.
            if (i < end - 1) {
                await new Promise((res) => setTimeout(res, 1000));
            }
        }
        if (dirty) await setDiscoveredCities(env, updated);
        const nextOffset = end;
        const done = nextOffset >= total;
        return jsonResponse(
            {
                total,
                offset,
                limit,
                processed: end - offset,
                changed,
                unchanged,
                failed,
                done,
                nextOffset: done ? null : nextOffset,
                changes,
            },
            200,
            cors,
        );
    } catch (e) {
        return jsonResponse(
            { error: e instanceof Error ? e.message : String(e) },
            500,
            cors,
        );
    }
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
 *
 * Two protocols (v249-fix):
 *   - STREAMING (preferred): `query` + metadata in the URL query
 *     string, the raw Overpass response as the POST body. The body is
 *     streamed straight to R2 — never buffered or re-stringified in the
 *     Worker heap. This is what lets us store big transit payloads
 *     (NYC's bus network is tens of MB) without blowing Cloudflare's
 *     128 MB Worker memory limit. The old JSON-wrapper path did
 *     `request.json()` (parses the whole body into an object tree) then
 *     `JSON.stringify(body)` (a second full copy) — 2-3x the payload in
 *     heap, which tripped Cloudflare error 1102 "Worker exceeded
 *     resource limits" and crashed the worker mid-prewarm.
 *   - LEGACY JSON wrapper: `{ query, body, kind, ... }` as the JSON
 *     body. Kept for small callers; size-guarded so it can't repeat
 *     the 1102.
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

    const url = new URL(request.url);
    const declaredLen = parseInt(
        request.headers.get("Content-Length") ?? "",
        10,
    );

    // ── Streaming protocol: ?query=…&kind=… + raw body ──────────────
    const queryParam = url.searchParams.get("query");
    if (queryParam) {
        if (!request.body) {
            return jsonResponse({ error: "missing body" }, 400, cors);
        }
        // Backstop against a body bigger than the streaming cap (the
        // laptop pre-reduces transit, so this rarely triggers). The
        // stream itself wouldn't OOM, but we don't want to store
        // something a client could never parse, and very large bodies
        // approach Cloudflare's inbound request limit.
        if (Number.isFinite(declaredLen) && declaredLen > MAX_STORE_BYTES) {
            return jsonResponse(
                {
                    status: "skipped-too-large",
                    sizeBytes: declaredLen,
                    limit: MAX_STORE_BYTES,
                },
                200,
                cors,
            );
        }
        const cacheKey = await r2KeyForQuery(queryParam);
        const kind = url.searchParams.get("kind") ?? undefined;
        const sourceName = url.searchParams.get("sourceName") ?? undefined;
        const sourceRelationId =
            url.searchParams.get("sourceRelationId") ?? undefined;
        try {
            // request.body is a fixed-length ReadableStream (the runner
            // sends a string body, so Content-Length is set); R2 streams
            // it to storage without the Worker buffering the whole thing.
            // Preserve the laptop's Content-Encoding (gzip) so reads
            // serve it back with the same header — the browser
            // decompresses transparently and the worker never has to.
            const reqEncoding = request.headers.get("Content-Encoding") ?? "";
            const obj = await env.CACHE.put(
                `overpass/${cacheKey}`,
                request.body,
                {
                    customMetadata: {
                        cachedAt: String(Date.now()),
                        prewarmed: "true",
                        source: "external-runner",
                        ...(reqEncoding ? { encoding: reqEncoding } : {}),
                        ...(Number.isFinite(declaredLen)
                            ? { sizeBytes: String(declaredLen) }
                            : {}),
                        ...(kind ? { kind } : {}),
                        ...(sourceName ? { sourceName } : {}),
                        ...(sourceRelationId ? { sourceRelationId } : {}),
                    },
                },
            );
            return jsonResponse(
                {
                    status: "stored",
                    cacheKey,
                    sizeBytes: obj?.size ?? (Number.isFinite(declaredLen) ? declaredLen : null),
                    kind,
                },
                200,
                cors,
            );
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
    }

    // ── Legacy JSON-wrapper protocol (small payloads only) ──────────
    if (Number.isFinite(declaredLen) && declaredLen > MAX_CACHE_BYTES) {
        return jsonResponse(
            {
                status: "skipped-too-large",
                sizeBytes: declaredLen,
                limit: MAX_CACHE_BYTES,
                hint: "use the streaming protocol (?query=… + raw body) for large payloads",
            },
            200,
            cors,
        );
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
        // Compress the legacy-protocol body before storing so it
        // matches the encoding contract reads use. The bodyStr is
        // already in heap (we just JSON.parsed and re-stringified it),
        // so the additional gzip pass through a stream is a wash.
        await compressAndStoreString(env, cacheKey, bodyStr, {
            prewarmed: "true",
            source: "external-runner",
            ...(payload.kind ? { kind: payload.kind } : {}),
            ...(payload.sourceName ? { sourceName: payload.sourceName } : {}),
            ...(payload.sourceRelationId
                ? { sourceRelationId: payload.sourceRelationId }
                : {}),
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
/**
 * GET /admin/country-refs-status — country-shard prewarm progress.
 *
 * Authless (read-only summary, no per-shard query bodies revealed).
 * Walks `COUNTRY_SHARDS` and for each issues an R2 HEAD against
 * `country-refs/v1/<iso>/all` to pull cachedAt + sizeBytes from
 * customMetadata without touching the body. Returns:
 *
 *   {
 *     enabled: boolean,
 *     totals: { shards, warmed, stale, missing, bytes },
 *     ttlDays: number,
 *     freshTtlDays: number,
 *     shards: [
 *       { iso, label, status: "fresh" | "stale" | "missing",
 *         sizeBytes?, ageHours?, parent? },
 *       ...
 *     ]
 *   }
 *
 * Total response is ~30 KB for 214 shards. Used to watch warming
 * progress without grepping logs and to decide when to bump
 * COUNTRY_REFS_PER_TICK.
 */
async function handleAdminCountryRefsStatus(
    request: Request,
    env: Env,
    cors: HeadersInit,
): Promise<Response> {
    if (request.method !== "GET") {
        return new Response("Method not allowed", {
            status: 405,
            headers: cors,
        });
    }
    const ttlDays = parseInt(env.CACHE_TTL_DAYS, 10) || 30;
    // Country shards intentionally get 2× TTL (see Phase 5 cron).
    const freshTtlMs = ttlDays * 2 * 24 * 60 * 60 * 1000;

    const heads = await Promise.all(
        COUNTRY_SHARDS.map(async (shard) => {
            const key = countryRefsKey(shard.iso);
            let obj: R2Object | null = null;
            try {
                obj = await env.CACHE.head(key);
            } catch (e) {
                console.warn(
                    `country-refs-status: head failed for ${shard.iso}:`,
                    e,
                );
            }
            return { shard, obj };
        }),
    );

    let warmed = 0;
    let stale = 0;
    let missing = 0;
    let totalBytes = 0;
    const now = Date.now();
    const shards = heads.map(({ shard, obj }) => {
        if (!obj) {
            missing++;
            return {
                iso: shard.iso,
                label: shard.label,
                status: "missing" as const,
                ...(shard.parent ? { parent: shard.parent } : {}),
            };
        }
        const cachedAt = parseInt(obj.customMetadata?.cachedAt ?? "0", 10);
        const sizeBytes = parseInt(obj.customMetadata?.sizeBytes ?? "0", 10);
        const ageMs = cachedAt ? now - cachedAt : Infinity;
        const fresh = cachedAt > 0 && ageMs < freshTtlMs;
        if (fresh) warmed++;
        else stale++;
        totalBytes += Number.isFinite(sizeBytes) ? sizeBytes : 0;
        return {
            iso: shard.iso,
            label: shard.label,
            status: (fresh ? "fresh" : "stale") as "fresh" | "stale",
            sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : null,
            ageHours: Number.isFinite(ageMs)
                ? Math.round(ageMs / 3_600_000)
                : null,
            ...(shard.parent ? { parent: shard.parent } : {}),
        };
    });

    return jsonResponse(
        {
            enabled: env.COUNTRY_REFS_PREWARM_ENABLED === "true",
            ttlDays,
            freshTtlDays: ttlDays * 2,
            totals: {
                shards: COUNTRY_SHARDS.length,
                warmed,
                stale,
                missing,
                bytes: totalBytes,
            },
            shards,
        },
        200,
        cors,
    );
}

/**
 * POST /admin/prewarm-country-ref — fast-fill single shard.
 *
 * Auth: Bearer ADMIN_SECRET. Body: `{ "iso": "SE" }` or `{ "iso":
 * "US-east" }`. Triggers `prewarmCountryReferences` for that one
 * shard on demand. Used by `scripts/country-refs-warm.mjs` (the PC
 * looping script) so the operator can drain the full shard list in
 * hours instead of waiting days for the hourly cron.
 *
 * Idempotent: respects the same skip-if-fresh logic the cron uses.
 * Asking for a shard that's already fresh just returns
 * `{ status: "skipped-fresh", ageMs }` cheaply — re-running the
 * script on a partially-warmed list is safe.
 */
async function handleAdminPrewarmCountryRef(
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
    let payload: { iso?: string };
    try {
        payload = await request.json();
    } catch {
        return jsonResponse({ error: "invalid JSON" }, 400, cors);
    }
    const iso = payload?.iso;
    if (typeof iso !== "string" || iso.length === 0) {
        return jsonResponse(
            { error: "expected { iso: string }" },
            400,
            cors,
        );
    }
    const shard = COUNTRY_SHARDS.find((s) => s.iso === iso);
    if (!shard) {
        return jsonResponse(
            { error: `unknown shard '${iso}'`, hint: "see /admin/country-refs-status for the list" },
            404,
            cors,
        );
    }
    // Country shards get the same 2× TTL the cron uses.
    const ttlMs =
        (parseInt(env.CACHE_TTL_DAYS, 10) || 30) * 2 * 24 * 60 * 60 * 1000;
    try {
        const result = await prewarmCountryReferences(env, shard, ttlMs);
        return jsonResponse(
            { iso: shard.iso, label: shard.label, ...result },
            200,
            cors,
        );
    } catch (e) {
        return jsonResponse(
            {
                iso: shard.iso,
                status: "threw",
                error: e instanceof Error ? e.message : String(e),
            },
            500,
            cors,
        );
    }
}

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
/**
 * `POST /admin/evict-query` — remove the cached body for one specific
 * Overpass query from R2. Used by the laptop prewarm script to drop a
 * boundary that was cached but turned out to carry no usable geometry
 * (so the next pass re-fetches it from upstream). Payload:
 * `{ query: string }`. Hashes the query through `r2KeyForQuery` so the
 * key matches the one `handleOverpass` uses on store; the script
 * never has to know the key shape.
 */
async function handleAdminEvictQuery(
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
    const cacheKey = await r2KeyForQuery(payload.query);
    try {
        await env.CACHE.delete(`overpass/${cacheKey}`);
    } catch (e) {
        return jsonResponse(
            {
                error: "R2 delete failed",
                detail: e instanceof Error ? e.message : String(e),
            },
            500,
            cors,
        );
    }
    return jsonResponse({ status: "ok", cacheKey }, 200, cors);
}

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

/**
 * On-demand cache cap (the /api/interpreter path). That path BUFFERS
 * the whole upstream response via `await upstream.text()` and then
 * clones it into the edge cache, so a big body lives in the 128 MB
 * Worker heap twice — keep this conservative. Over the cap we still
 * SERVE the body (the caller has it in hand); we just skip persisting
 * it. The prewarm path uses MAX_STORE_BYTES instead — it streams, so
 * it can go much higher.
 */
const MAX_CACHE_BYTES = 25 * 1024 * 1024; // 25 MB

/**
 * Prewarm-upload cap (the streaming /admin/store-prewarmed path).
 * That path streams `request.body` straight to R2 without buffering,
 * so it isn't bound by the heap limit — only by Cloudflare's inbound
 * request-body limit (~100 MB on workers.dev). The laptop prewarmer
 * pre-reduces transit payloads (dedupe + decimate + round) so they
 * arrive well under this; the cap is just a backstop.
 */
const MAX_STORE_BYTES = 60 * 1024 * 1024; // 60 MB (Overpass bodies)
/** v345: city tile packs get a much higher ceiling than Overpass
 *  bodies — full-z15 major-metro packs (NYC, Tokyo, London) run well
 *  past 60 MB, and loading-speed for those cities matters more than
 *  the storage. 150 MB exceeds Cloudflare's ~100 MB single-request
 *  body limit, so packs over MULTIPART_THRESHOLD are uploaded via R2
 *  multipart (see handleAdminStoreTilePack). */
const MAX_TILE_PACK_BYTES = 150 * 1024 * 1024; // 150 MB
/** Packs at/under this go in one request; larger use multipart. Kept
 *  under Cloudflare's inbound request-body limit with headroom. */
const TILE_PACK_SINGLE_SHOT_MAX = 90 * 1024 * 1024; // 90 MB

/* ─────────────────────── Response builders ─────────────────────── */

/* ─────────────────── Compressed-storage helpers ──────────────────── *
 *
 * Stores Overpass responses gzip-compressed in R2 (typical 80-90 %
 * shrink on text JSON) and serves them with `Content-Encoding: gzip`
 * so the browser transparently decompresses — the client never sees a
 * change. Wins:
 *
 *   - **R2 storage shrinks ~6-10×**, on every category of data
 *     (boundary, references, HSR, transit).
 *   - **On-demand path no longer OOMs.** The previous code did
 *     `await upstream.text()` to buffer the entire body, then cloned
 *     it again into the edge cache — for an NYC-sized response that
 *     was multiple copies of the body in the 128 MB Worker heap, and
 *     Cloudflare error 1102 followed. The new path pipes
 *     upstream → gzip → tee → [R2 stream put, client response stream]
 *     so the worker never holds more than the compression-stream's
 *     internal buffer (KBs) at once.
 *   - **Wire transfer drops 80 %+** for any response Cloudflare
 *     wouldn't auto-gzip on egress (e.g. uncached repeat hits).
 *
 * Reads honour the per-object `encoding` metadata: if "gzip", we set
 * `Content-Encoding: gzip` on the outgoing Response and pass R2's
 * body stream through untouched. Legacy uncompressed entries (no
 * encoding tag, or "identity") serve as plain JSON. */

const STORAGE_ENCODING = "gzip" as const;

/* ────────────── Overpass soft-failure ("abort remark") sniffing ──────────────
 *
 * v667. When the Overpass interpreter hits its server-side time/memory
 * limit it does NOT return an error status — it returns HTTP 200 whose
 * JSON body carries a `remark` like
 *   "runtime error: Query timed out in \"query\" at line 4 after 26 seconds."
 * with `elements` empty or silently truncated. Before this fix that body
 * flowed through the normal success path and was CACHED under the
 * query's R2 key for CACHE_TTL_DAYS — so one bad upstream moment served
 * "no stations in Chicago" to every retry for a month (the
 * hiding-zones-say-loaded-but-the-map-is-empty bug). Three defences:
 *
 *   1. WRITE: `streamCompressIntoR2` peeks small bodies and returns an
 *      aborted one to the client uncached (`Cache-Control: no-store`).
 *   2. READ: the interpreter handler sniffs small R2 hits and deletes a
 *      poisoned entry (self-heal for entries written pre-fix).
 *   3. CRON: the prewarm paths refuse to store an aborted body.
 *
 * The client (`src/maps/api/overpass.ts`) mirrors the same sniff so an
 * aborted body — from this worker OR a public mirror — counts as a
 * per-mirror miss in its failover race. */

/** Bodies at/under this size get fully buffered for the write-path
 *  sniff; larger bodies stream straight through untouched (the
 *  zero-buffering pipeline exists for NYC-scale multi-MB responses,
 *  and an aborted body is a few hundred bytes). */
const ABORT_SNIFF_MAX_BYTES = 256 * 1024;
/** Compressed-size ceiling for the read-path self-heal sniff — R2
 *  stores gzip, and a poisoned body is well under 1 KB compressed. */
const ABORT_SNIFF_MAX_GZ_BYTES = 64 * 1024;

const OVERPASS_ABORT_RE = /runtime error|timed out|out of memory/i;

/** True when an Overpass JSON body carries an abort remark. The remark
 *  sits at the END of the JSON output, so the tail pre-check keeps
 *  clean bodies cheap — the full parse only runs when the tail actually
 *  contains a remark key. */
function isAbortedOverpassText(text: string): boolean {
    const tail = text.length > 4096 ? text.slice(-4096) : text;
    if (!tail.includes('"remark"')) return false;
    try {
        const parsed = JSON.parse(text) as { remark?: unknown };
        return (
            typeof parsed?.remark === "string" &&
            OVERPASS_ABORT_RE.test(parsed.remark)
        );
    } catch {
        return false;
    }
}

/** Decompress + read a (small) R2 hit's body as text, honouring its
 *  encoding metadata. Consumes the object's one-shot body stream — the
 *  caller must serve from the returned text, not `hit.body`. */
async function readR2BodyText(hit: R2ObjectBody): Promise<string> {
    const encoding = hit.customMetadata?.encoding;
    if (encoding && encoding !== "identity") {
        return await new Response(
            hit.body.pipeThrough(new DecompressionStream("gzip")),
        ).text();
    }
    return await new Response(hit.body).text();
}

interface R2WriteMetadata {
    sourceName?: string;
    sourceRelationId?: string;
    prewarmed?: string;
    source?: string;
    kind?: string;
    /** Country-shard ISO for `kind: "country-references"` and
     *  `kind: "transit-shard"` entries. */
    shardIso?: string;
    /** Number of deduplicated ways stored, for `kind: "transit-shard"`.
     *  Stringified so it can ride in R2 custom metadata (which is
     *  string-only). Cheap diagnostic; not load-bearing. */
    wayCount?: string;
    /** Provenance for entries warmed by the on-demand relation warmer
     *  (v359: warm-on-add / laptop one-ring). Diagnostic only. */
    warmedBy?: string;
}

/**
 * Pipe an upstream Response through gzip → tee → [R2 write, client
 * Response]. Returns a Response built from the client-side branch with
 * `Content-Encoding: gzip` already set. The R2 write runs under
 * ctx.waitUntil so the worker doesn't return until it's flushed.
 *
 * v667: peeks bodies up to ABORT_SNIFF_MAX_BYTES for an Overpass abort
 * remark first — an aborted body goes back to the client UNCACHED so a
 * soft timeout can't poison the R2 key. Bodies that outgrow the peek
 * window are real results; the buffered head is stitched back onto the
 * remaining stream and the zero-buffering pipeline continues as before.
 */
async function streamCompressIntoR2(
    env: Env,
    ctx: ExecutionContext,
    cacheKey: string,
    upstream: Response,
    metadata: R2WriteMetadata,
    cors: HeadersInit,
    status: string,
): Promise<Response | null> {
    if (!upstream.body) return null;

    const reader = upstream.body.getReader();
    const head: Uint8Array<ArrayBuffer>[] = [];
    let headBytes = 0;
    let completed = false;
    while (headBytes <= ABORT_SNIFF_MAX_BYTES) {
        const { done, value } = await reader.read();
        if (done) {
            completed = true;
            break;
        }
        head.push(value);
        headBytes += value.byteLength;
    }

    let bodyStream: ReadableStream<Uint8Array<ArrayBuffer>>;
    if (completed) {
        // Whole body fits in the peek window — sniff it.
        const whole = new Uint8Array(headBytes);
        let offset = 0;
        for (const chunk of head) {
            whole.set(chunk, offset);
            offset += chunk.byteLength;
        }
        if (isAbortedOverpassText(new TextDecoder().decode(whole))) {
            console.warn(
                `[interpreter] upstream body carries an Overpass abort remark — returning uncached (${status})`,
            );
            return new Response(whole, {
                status: 200,
                headers: {
                    ...corsHeadersAsObject(cors),
                    "Content-Type": "application/json",
                    "Cache-Control": "no-store",
                    "X-Cache": `${status}_UNCACHED_ABORT`,
                },
            });
        }
        bodyStream = new Response(whole).body!;
    } else {
        // Body outgrew the window — re-stitch head + rest of the stream.
        bodyStream = new ReadableStream<Uint8Array<ArrayBuffer>>({
            start(controller) {
                for (const chunk of head) controller.enqueue(chunk);
            },
            async pull(controller) {
                const { done, value } = await reader.read();
                if (done) controller.close();
                else controller.enqueue(value);
            },
            cancel(reason) {
                void reader.cancel(reason);
            },
        });
    }

    const compressed = bodyStream.pipeThrough(
        new CompressionStream(STORAGE_ENCODING),
    );
    const [toR2, toClient] = compressed.tee();
    ctx.waitUntil(
        env.CACHE.put(`overpass/${cacheKey}`, toR2, {
            customMetadata: {
                cachedAt: String(Date.now()),
                encoding: STORAGE_ENCODING,
                ...metadata,
            },
        }).catch((e) => {
            console.warn("R2 streaming put failed:", e);
        }),
    );
    return new Response(toClient, {
        status: 200,
        headers: {
            ...corsHeadersAsObject(cors),
            "Content-Type": "application/json",
            "Content-Encoding": STORAGE_ENCODING,
            "Cache-Control": `public, max-age=${CACHE_API_TTL_SECS}`,
            "X-Cache": status,
        },
    });
}

/**
 * Compress an in-memory body string and write it to R2. Used by paths
 * that already had the whole body in hand (the cron-triggered prewarms
 * for boundary / HSR / etc — small enough to buffer, and we want the
 * byte count for logging). Uses `gzipSync`-equivalent via
 * CompressionStream + a single-shot Response wrapper.
 */
async function compressAndStoreString(
    env: Env,
    cacheKey: string,
    body: string,
    metadata: R2WriteMetadata,
): Promise<{ compressedBytes: number; rawBytes: number }> {
    return compressAndStoreAtKey(env, `overpass/${cacheKey}`, body, metadata);
}

/**
 * Like `compressAndStoreString` but writes at a FULL R2 key without
 * the `overpass/` prefix. Used by the country-shard prewarm, which
 * lives in its own `country-refs/v1/...` namespace (see
 * querySlicing.ts → countryRefsKey) rather than the query-hash
 * namespace.
 */
async function compressAndStoreAtKey(
    env: Env,
    fullKey: string,
    body: string,
    metadata: R2WriteMetadata,
): Promise<{ compressedBytes: number; rawBytes: number }> {
    const rawBytes = new TextEncoder().encode(body).byteLength;
    const compressedBuf = await new Response(
        new Response(body).body!.pipeThrough(
            new CompressionStream(STORAGE_ENCODING),
        ),
    ).arrayBuffer();
    await env.CACHE.put(fullKey, compressedBuf, {
        customMetadata: {
            cachedAt: String(Date.now()),
            encoding: STORAGE_ENCODING,
            sizeBytes: String(rawBytes),
            ...metadata,
        },
    });
    return { compressedBytes: compressedBuf.byteLength, rawBytes };
}

/**
 * Build a Response from an R2-hit object, honouring its `encoding`
 * metadata. Legacy entries (no encoding) serve plain; new
 * gzip-compressed entries serve with `Content-Encoding: gzip` so the
 * browser decompresses transparently.
 */
function buildR2Response(
    r2Hit: R2ObjectBody,
    cors: HeadersInit,
    status: string,
    ageMs: number,
): Response {
    const encoding = r2Hit.customMetadata?.encoding;
    const headers: Record<string, string> = {
        ...corsHeadersAsObject(cors),
        "Content-Type": "application/json",
        "Cache-Control": `public, max-age=${CACHE_API_TTL_SECS}`,
        "X-Cache": status,
        "X-Cache-Age-Ms": String(ageMs),
    };
    if (encoding && encoding !== "identity") {
        headers["Content-Encoding"] = encoding;
    }
    return new Response(r2Hit.body, { status: 200, headers });
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
    // v470: an origin that ISN'T in the allowlist now falls back to "*"
    // — NOT to `allowed[0]`. Echoing a different allowed origin back as
    // Access-Control-Allow-Origin guarantees a CORS failure for the
    // actual requester (the browser requires ACAO to match the request
    // origin or be "*"), so an unlisted-but-legit origin (e.g. a new
    // deploy domain like hideandseek.game before it's added to
    // ALLOWED_ORIGINS) got blocked on EVERY response. This is a
    // read-only cache with no credentials, so "*" is safe; a matched
    // origin is still echoed verbatim.
    const allow =
        origin && originMatches(origin, allowed) ? origin : "*";
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
