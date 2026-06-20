/**
 * Journey-time arrival proxy.
 *
 * Sits between the seeker app and Trafiklab's ResRobot 2.1 API so
 * the API key stays a server-side secret instead of every player
 * having to register for one. Same trust + CORS model as the
 * Overpass cache endpoint next door: anyone who hits the deployed
 * worker from an allow-listed origin gets to spend the worker
 * owner's free-tier quota.
 *
 * Wire shape:
 *   POST /api/journey/arrivals
 *   Content-Type: application/json
 *   Body: {
 *     anchor: { lat: number, lng: number, departAt: number },
 *     stops:  [{ id: string, lat: number, lng: number, name?: string }],
 *   }
 *   200 → { results: [{ stopId, arrivalAt: number|null }] }
 *   ordered the same as the input `stops`.
 *
 * Cache strategy:
 *   - Per (anchor lat/lng, stop lat/lng, 5-minute departure bucket)
 *     hash. ResRobot replies are deterministic enough at that
 *     granularity that bucket misses don't matter for gameplay.
 *   - Cloudflare Cache API first (per-colo, sub-ms); R2 second
 *     (durable, persists across colos + deploys). Misses fall
 *     through to ResRobot.
 *   - Bucket-keyed values get bucket-relative TTLs: a value
 *     computed at 14:00 for a 14:30 departure is still good at
 *     14:15. Anything older than 24h is treated as missing.
 *
 * Request budget:
 *   - Trafiklab free tier: ~10k req/month.
 *   - Cache hit ratio is high in practice because the seeker is
 *     mostly toggling the overlay on/off across the same anchor —
 *     the second look at the same play area is fully warm.
 */

import type { Env } from "./envTypes";

interface JourneyAnchor {
    lat: number;
    lng: number;
    /** Unix ms. */
    departAt: number;
}
interface JourneyStop {
    id: string;
    lat: number;
    lng: number;
    name?: string;
}
interface ArrivalResult {
    stopId: string;
    /** Unix ms or null when the upstream couldn't plan a journey. */
    arrivalAt: number | null;
}

const RESROBOT_TRIP_URL = "https://api.resrobot.se/v2.1/trip";

/** 5-minute granularity on departure timestamps — fine enough for
 *  human-perceptible accuracy, coarse enough for cache hits. */
const DEPART_BUCKET_MS = 5 * 60 * 1000;

const UPSTREAM_TIMEOUT_MS = 8_000;
const R2_TTL_MS = 24 * 60 * 60 * 1000;
const EDGE_CACHE_TTL_SECS = 60 * 60; // 1h

/** Subrequest concurrency cap. The Workers Free plan allows 50
 *  subrequests per invocation; cap upstream fan-out lower so an
 *  unexpectedly large stop list doesn't blow the budget AND so
 *  ResRobot gets polite request pacing. */
const UPSTREAM_PARALLEL = 8;

export async function handleJourneyArrivals(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
    cors: HeadersInit,
): Promise<Response> {
    if (request.method !== "POST") {
        return jsonResponse({ error: "POST required" }, 405, cors);
    }
    if (!env.TRAFIKLAB_API_KEY) {
        // Operator hasn't configured the secret. v363: return 200 with
        // the SAME empty-results shape the client uses as its fallback —
        // a 503 here surfaced in browser devtools as a noisy network
        // error every time the Travel Times overlay was enabled, even
        // though the client already silenced it (resrobot.ts:91-102).
        // The body's `available: false` flag lets a future client
        // gate-check before firing at all. Parse the input so we can
        // mirror its stops array; on any parse failure, send a single
        // empty result rather than 400 (same "graceful" intent).
        let stops: JourneyStop[] = [];
        try {
            const parsed = (await request.json()) as {
                stops?: JourneyStop[];
            };
            if (Array.isArray(parsed?.stops)) stops = parsed.stops;
        } catch {
            /* empty fallback below */
        }
        return jsonResponse(
            {
                available: false,
                reason: "TRAFIKLAB_API_KEY not configured on the worker.",
                results: stops.map((s) => ({
                    stopId: s.id,
                    arrivalAt: null,
                })),
            },
            200,
            cors,
        );
    }
    let body: {
        anchor?: JourneyAnchor;
        stops?: JourneyStop[];
    };
    try {
        body = (await request.json()) as typeof body;
    } catch {
        return jsonResponse({ error: "invalid JSON body" }, 400, cors);
    }
    const anchor = body.anchor;
    const stops = body.stops;
    if (
        !anchor ||
        typeof anchor.lat !== "number" ||
        typeof anchor.lng !== "number" ||
        typeof anchor.departAt !== "number"
    ) {
        return jsonResponse({ error: "anchor invalid" }, 400, cors);
    }
    if (!Array.isArray(stops) || stops.length === 0) {
        return jsonResponse({ error: "stops empty" }, 400, cors);
    }
    if (stops.length > 200) {
        // Soft cap. A single play area realistically has 20–80
        // stops; 200 is generous headroom before we start
        // worrying about hitting the subrequest budget.
        return jsonResponse(
            { error: "too many stops (max 200)" },
            400,
            cors,
        );
    }

    const departBucket = Math.floor(anchor.departAt / DEPART_BUCKET_MS) * DEPART_BUCKET_MS;
    const edgeCache = caches.default;

    // Phase 1: probe edge + R2 cache for every stop in parallel.
    const cached = await Promise.all(
        stops.map((s) =>
            readCachedArrival(env, edgeCache, anchor, s, departBucket),
        ),
    );
    const arrivals: (ArrivalResult | null)[] = cached.map((c, i) =>
        c != null ? { stopId: stops[i].id, arrivalAt: c } : null,
    );

    // Phase 2: fetch the misses from upstream, concurrency-capped.
    const misses: number[] = [];
    for (let i = 0; i < stops.length; i++) {
        if (arrivals[i] == null) misses.push(i);
    }
    if (misses.length > 0) {
        await runConcurrently(misses, UPSTREAM_PARALLEL, async (i) => {
            const upstream = await fetchArrivalFromResRobot(
                anchor,
                stops[i],
                env.TRAFIKLAB_API_KEY!,
            );
            arrivals[i] = { stopId: stops[i].id, arrivalAt: upstream };
            // Write back through both cache layers. Both writes
            // are best-effort + non-blocking; if either fails the
            // user still gets the live result.
            ctx.waitUntil(
                writeCachedArrival(
                    env,
                    edgeCache,
                    anchor,
                    stops[i],
                    departBucket,
                    upstream,
                ),
            );
        });
    }

    const results: ArrivalResult[] = arrivals.map((a, i) => ({
        stopId: stops[i].id,
        arrivalAt: a?.arrivalAt ?? null,
    }));
    return jsonResponse({ results }, 200, cors);
}

/* ─────────────────────── Upstream fetch ─────────────────────── */

async function fetchArrivalFromResRobot(
    anchor: JourneyAnchor,
    stop: JourneyStop,
    apiKey: string,
): Promise<number | null> {
    const depart = new Date(anchor.departAt);
    const url = new URL(RESROBOT_TRIP_URL);
    url.searchParams.set("accessId", apiKey);
    url.searchParams.set("format", "json");
    url.searchParams.set("originCoordLat", anchor.lat.toFixed(6));
    url.searchParams.set("originCoordLong", anchor.lng.toFixed(6));
    url.searchParams.set("destCoordLat", stop.lat.toFixed(6));
    url.searchParams.set("destCoordLong", stop.lng.toFixed(6));
    url.searchParams.set("date", dateYmd(depart));
    url.searchParams.set("time", timeHm(depart));
    url.searchParams.set("numF", "1");
    url.searchParams.set("passlist", "0");
    url.searchParams.set("rtMode", "OFF");

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
    let resp: Response;
    try {
        resp = await fetch(url.toString(), {
            signal: ctrl.signal,
            headers: { Accept: "application/json" },
        });
    } catch (e) {
        console.warn("ResRobot fetch failed:", e);
        return null;
    } finally {
        clearTimeout(timer);
    }
    if (!resp.ok) {
        console.warn("ResRobot non-OK:", resp.status, resp.statusText);
        return null;
    }
    let json: unknown;
    try {
        json = await resp.json();
    } catch {
        return null;
    }
    const trips = (json as { Trip?: unknown[] }).Trip;
    if (!Array.isArray(trips) || trips.length === 0) return null;
    const first = trips[0] as {
        LegList?: {
            Leg?: Array<{ Destination?: { date?: string; time?: string } }>;
        };
    };
    const legs = first.LegList?.Leg;
    if (!Array.isArray(legs) || legs.length === 0) return null;
    const lastDest = legs[legs.length - 1].Destination;
    if (!lastDest?.date || !lastDest?.time) return null;
    return parseLocalDateTime(lastDest.date, lastDest.time);
}

/* ─────────────────────── Cache layers ─────────────────────── */

async function readCachedArrival(
    env: Env,
    edgeCache: Cache,
    anchor: JourneyAnchor,
    stop: JourneyStop,
    departBucket: number,
): Promise<number | null> {
    const key = await cacheKeyFor(anchor, stop, departBucket);

    // Edge cache first.
    const edgeReq = syntheticReq(key);
    const edgeHit = await edgeCache.match(edgeReq);
    if (edgeHit) {
        try {
            const body = (await edgeHit.json()) as { arrivalAt: number | null };
            return body.arrivalAt;
        } catch {
            /* corrupt entry — fall through */
        }
    }

    // R2 second.
    try {
        const obj = await env.CACHE.get(`journey/${key}`);
        if (obj) {
            const cachedAt = parseInt(
                obj.customMetadata?.cachedAt ?? "0",
                10,
            );
            if (Date.now() - cachedAt < R2_TTL_MS) {
                const text = await obj.text();
                const parsed = JSON.parse(text) as { arrivalAt: number | null };
                return parsed.arrivalAt;
            }
        }
    } catch (e) {
        console.warn("Journey R2 get failed:", e);
    }

    return null;
}

async function writeCachedArrival(
    env: Env,
    edgeCache: Cache,
    anchor: JourneyAnchor,
    stop: JourneyStop,
    departBucket: number,
    arrivalAt: number | null,
): Promise<void> {
    const key = await cacheKeyFor(anchor, stop, departBucket);
    const body = JSON.stringify({ arrivalAt });

    // R2.
    try {
        await env.CACHE.put(`journey/${key}`, body, {
            customMetadata: {
                cachedAt: String(Date.now()),
                kind: "journey-arrival",
            },
        });
    } catch (e) {
        console.warn("Journey R2 put failed:", e);
    }

    // Edge cache. Manual Cache-Control because Workers' edge
    // cache reads it off the response.
    try {
        const edgeResp = new Response(body, {
            headers: {
                "Content-Type": "application/json",
                "Cache-Control": `public, max-age=${EDGE_CACHE_TTL_SECS}`,
            },
        });
        await edgeCache.put(syntheticReq(key), edgeResp);
    } catch (e) {
        console.warn("Journey edge put failed:", e);
    }
}

async function cacheKeyFor(
    anchor: JourneyAnchor,
    stop: JourneyStop,
    departBucket: number,
): Promise<string> {
    const s = [
        anchor.lat.toFixed(5),
        anchor.lng.toFixed(5),
        stop.lat.toFixed(5),
        stop.lng.toFixed(5),
        String(departBucket),
    ].join("|");
    const bytes = new TextEncoder().encode(s);
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(hash))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

function syntheticReq(key: string): Request {
    // Per-colo cache key. Origin is irrelevant — it's just a
    // bucket name from Workers' perspective.
    return new Request(`https://_journey-cache/${key}`, { method: "GET" });
}

/* ─────────────────────── Helpers ─────────────────────── */

function jsonResponse(
    body: unknown,
    status: number,
    cors: HeadersInit,
): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            ...corsAsObject(cors),
            "Content-Type": "application/json",
        },
    });
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

function dateYmd(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function timeHm(d: Date): string {
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function parseLocalDateTime(date: string, time: string): number | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    const tm = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time);
    if (!m || !tm) return null;
    const t = new Date(
        Number(m[1]),
        Number(m[2]) - 1,
        Number(m[3]),
        Number(tm[1]),
        Number(tm[2]),
        Number(tm[3] ?? "0"),
    ).getTime();
    return Number.isFinite(t) ? t : null;
}

async function runConcurrently<T>(
    items: T[],
    limit: number,
    worker: (item: T) => Promise<void>,
): Promise<void> {
    let next = 0;
    const runners = Array.from(
        { length: Math.min(limit, items.length) },
        async () => {
            while (true) {
                const i = next++;
                if (i >= items.length) return;
                await worker(items[i]);
            }
        },
    );
    await Promise.all(runners);
}
