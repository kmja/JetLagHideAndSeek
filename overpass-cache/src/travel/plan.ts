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
import { ADAPTERS, dispatchPlan, selectAdapters } from "./router";
import type { Journey, PlanRequest, PlanResponse, TravelMode } from "./types";

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

    // Diagnostic mode (`?debug=1`): bypass the cache, run EVERY candidate
    // adapter independently for this origin, and report what each one
    // did — which adapters the live build even has, which `canServe`
    // the origin, whether their API key is present, and whether the
    // upstream call yielded a journey / null / threw. No secrets are
    // returned (only booleans for key presence). This is the only way
    // to see, in production, why a coordinate fell through to walking.
    if (new URL(request.url).searchParams.get("debug") === "1") {
        return jsonResponse(await diagnose(req, departAt, env), 200, cors);
    }

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

    // Write back through both layers, best-effort + non-blocking. The
    // walking fallback is NOT persisted: it's produced whenever every
    // real adapter declines OR transiently fails, so caching it for
    // 24h would mask a recovered upstream (a one-off Transitous hiccup
    // would pin "walking estimate" on a route that actually has
    // transit). Walking is a cheap haversine to recompute, so we just
    // re-dispatch next time and pick up the real journey once the
    // upstream is healthy again.
    if (source !== "walking") {
        ctx.waitUntil(writeCached(env, edgeCache, key, payload));
    }

    return jsonResponse(payload, 200, cors, "MISS");
}

/* ─────────────────────── Diagnostics ─────────────────────── */

/** Per-adapter env-key presence, reported as a coarse status so the
 *  diagnostic can distinguish "deferred: no key" from "called upstream
 *  and got nothing". Never returns the key value itself. */
function keyStatus(id: string, env: Env): "keyless" | "present" | "missing" {
    const present = (...keys: (keyof Env)[]) =>
        keys.every((k) => Boolean(env[k])) ? "present" : "missing";
    switch (id) {
        case "trafiklab":
            return present("TRAFIKLAB_API_KEY");
        case "digitransit":
            return present("DIGITRANSIT_API_KEY");
        case "nsw":
            return present("TFNSW_API_KEY");
        case "barcelona":
            return present("TMB_APP_ID", "TMB_APP_KEY");
        case "netherlands":
            return present("NS_API_KEY");
        case "korea":
            return present("ODSAY_API_KEY");
        case "navitia":
            return present("NAVITIA_API_KEY");
        case "motis-self-hosted":
            return present("MOTIS_SELF_HOSTED_URL");
        case "tfl":
            // Works keyless; a key only raises the rate limit.
            return env.TFL_API_KEY ? "present" : "keyless";
        default:
            // denmark / entur / swiss / germany / austria / estonia /
            // ireland / transitous / walking — all keyless.
            return "keyless";
    }
}

interface AdapterDiagnosis {
    id: string;
    selected: boolean;
    key: "keyless" | "present" | "missing";
    /** "journey" | "null" | `threw: …` — only set when the adapter ran. */
    result?: string;
    durationMin?: number;
    transfers?: number;
    ms?: number;
}

/**
 * Run each candidate adapter for `req.origin` in isolation and report
 * the outcome. Adapters NOT selected (origin outside their `canServe`)
 * are listed too, with `selected:false`, so a missing adapter in the
 * deployed build is obvious. Walking is skipped (it always succeeds).
 */
async function diagnose(
    req: PlanRequest,
    departAt: number,
    env: Env,
): Promise<unknown> {
    const selected = new Set(
        selectAdapters(req.origin.lat, req.origin.lng).map((a) => a.id),
    );
    const rows: AdapterDiagnosis[] = [];
    for (const adapter of ADAPTERS) {
        if (adapter.id === "walking") continue;
        const isSelected = selected.has(adapter.id);
        const key = keyStatus(adapter.id, env);
        const row: AdapterDiagnosis = { id: adapter.id, selected: isSelected, key };
        if (isSelected) {
            const t0 = Date.now();
            try {
                const j: Journey | null = await adapter.plan(
                    req,
                    departAt,
                    env,
                );
                row.result = j ? "journey" : "null";
                if (j) {
                    row.durationMin = j.durationMin;
                    row.transfers = j.transfers;
                }
            } catch (e) {
                row.result = `threw: ${e instanceof Error ? e.message : String(e)}`;
            }
            row.ms = Date.now() - t0;
        }
        rows.push(row);
    }
    return {
        debug: true,
        origin: req.origin,
        destination: req.destination,
        departAt,
        adapterIdsInBuild: ADAPTERS.map((a) => a.id),
        adapters: rows,
    };
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
