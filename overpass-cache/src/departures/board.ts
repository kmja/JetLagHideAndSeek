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
import { DEPARTURE_ADAPTERS, dispatchBoard } from "./dispatcher";
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

    // Diagnostic mode (`?debug=1`): bypass the cache, run EVERY candidate
    // board adapter for this stop independently, and report what each did
    // — mirrors the trip planner's `?debug=1`. The only way to see, in
    // production, why a stop's board is empty / which backend served it.
    if (new URL(request.url).searchParams.get("debug") === "1") {
        return jsonResponse(await diagnoseBoard(req, when, env), 200, cors);
    }

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

/* ─────────────────────── Diagnostics ─────────────────────── */

interface BoardAdapterDiagnosis {
    id: string;
    selected: boolean;
    key: "keyless" | "present" | "missing";
    /** `"board (N departures)"` | `"null"` | `threw: …` — set when run. */
    result?: string;
    stopName?: string;
    firstDeparture?: string;
    ms?: number;
}

/** Per-adapter env-key presence (booleans only, never the values). */
function boardKeyStatus(
    id: string,
    env: Env,
): "keyless" | "present" | "missing" {
    switch (id) {
        case "trafiklab":
            return env.TRAFIKLAB_API_KEY ? "present" : "missing";
        case "motis-self-hosted":
            return env.MOTIS_SELF_HOSTED_URL ? "present" : "missing";
        default:
            // entur / swiss / germany / austria / transitous — keyless.
            return "keyless";
    }
}

/**
 * Run each candidate board adapter for the stop in isolation and report
 * the outcome — which adapters the live build has, which `canServe` the
 * coordinate, whether the key is present, and what the upstream returned.
 */
async function diagnoseBoard(
    req: DepartureBoardRequest,
    when: number,
    env: Env,
): Promise<unknown> {
    const rows: BoardAdapterDiagnosis[] = [];
    for (const adapter of DEPARTURE_ADAPTERS) {
        const selected = adapter.canServe(req.lat, req.lng);
        const row: BoardAdapterDiagnosis = {
            id: adapter.id,
            selected,
            key: boardKeyStatus(adapter.id, env),
        };
        if (selected) {
            const t0 = Date.now();
            try {
                const board = await adapter.fetchBoard(
                    req,
                    env,
                    when,
                    MAX_DEPARTURES,
                );
                if (board) {
                    row.result = `board (${board.departures.length} departures)`;
                    row.stopName = board.stopName;
                    const first = board.departures[0];
                    if (first) {
                        row.firstDeparture = `${new Date(first.time).toISOString()} ${first.line ?? first.mode}`;
                    }
                } else {
                    row.result = "null";
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
        stop: { lat: req.lat, lng: req.lng, name: req.name },
        when,
        adapterIdsInBuild: DEPARTURE_ADAPTERS.map((a) => a.id),
        adapters: rows,
    };
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
