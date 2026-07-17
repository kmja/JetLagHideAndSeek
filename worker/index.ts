/**
 * Worker entrypoint — HTTP router for the multiplayer backend.
 *
 * Endpoints:
 *
 *   POST /games
 *     Create a new game room. Server generates a 6-char alphanumeric
 *     code, stores nothing else (the actual DO instance is lazily
 *     materialized when the host's first WebSocket arrives). Returns
 *     `{ code }`.
 *
 *   GET  /games/:code/ws
 *     Upgrade to WebSocket. Routes to the DO instance for `:code`.
 *     The DO handles the rest of the connection lifecycle.
 *
 *   GET  /health
 *     Boring health probe. Returns "ok".
 *
 * CORS is gated by the `ALLOWED_ORIGINS` env var (comma-separated).
 *
 * Anti-abuse: per-IP sliding-window rate limits on room creation
 * and WebSocket upgrades. Cloudflare's edge already absorbs the
 * worst of layer 4/7 DDoS; these limits handle the rest (curl-loop
 * teenager, runaway script, accidentally-recursive client). Limits
 * are per-isolate so a determined attacker hitting multiple PoPs
 * could exceed them; that's acceptable because (a) the absolute
 * budget is the Worker request quota, and (b) Cloudflare's account-
 * level DDoS protection kicks in well before that hurts.
 */

export { GameRoom } from "./GameRoom";

/* ────────────────── Game-code generation ────────────────── */

// Letters only — typing a code on mobile shouldn't force the user to
// flip between the letter and number keyboards. Omit ambiguous
// characters (I/O, lowercase l) so codes are easy to read out loud
// over voice. v932: 3 letters — 24³ = ~13.8k codes. There's no
// collision check (a code just names the Durable Object lazily), but at
// the scale we care about (a handful of concurrent small-group games
// inside the 30 min idle / 18 h lifetime window) a clash is very
// unlikely, and short codes are far easier to read out / type.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const CODE_LENGTH = 3;

function generateGameCode(): string {
    const bytes = new Uint8Array(CODE_LENGTH);
    crypto.getRandomValues(bytes);
    let out = "";
    for (let i = 0; i < CODE_LENGTH; i++) {
        out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    }
    return out;
}

/* ────────────────── Per-IP rate limiting ────────────────── */

/**
 * Per-IP sliding-window counter. Lives in module scope so it survives
 * within a single Worker isolate, which gives reasonable protection
 * against a single source hammering one PoP. Across multiple isolates
 * (cold starts, different PoPs) limits are independent — that's fine
 * because Cloudflare's account-level DDoS protection covers the
 * broader-fanout case.
 */
interface IpTracker {
    /** Timestamps of recent hits, in ms. */
    hits: number[];
}

const createTrackers = new Map<string, IpTracker>();
const wsTrackers = new Map<string, IpTracker>();
const photoTrackers = new Map<string, IpTracker>();

/**
 * Sliding-window rate check. Returns `true` if the request should
 * be rejected. Also opportunistically prunes the tracker map so it
 * doesn't grow unbounded.
 */
function rateLimited(
    bucket: Map<string, IpTracker>,
    ip: string,
    windowMs: number,
    maxHits: number,
): boolean {
    const now = Date.now();
    let entry = bucket.get(ip);
    if (!entry) {
        entry = { hits: [] };
        bucket.set(ip, entry);
    }
    entry.hits = entry.hits.filter((t) => now - t < windowMs);
    if (entry.hits.length >= maxHits) return true;
    entry.hits.push(now);

    // Best-effort GC: every 64th call, drop trackers that haven't
    // been touched in 5x the window. Keeps memory bounded under
    // sustained traffic without paying GC cost on every request.
    if (bucket.size > 256 && entry.hits.length === 1) {
        const cutoff = now - windowMs * 5;
        for (const [k, v] of bucket.entries()) {
            if (v.hits.length === 0 || v.hits[v.hits.length - 1] < cutoff) {
                bucket.delete(k);
            }
        }
    }
    return false;
}

/** Extract the client's IP from Cloudflare's standard header. */
function clientIp(request: Request): string {
    return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

// Limits — generous enough that a normal player never hits them, low
// enough that a curl-loop gets shut down fast.
const CREATE_LIMIT_WINDOW_MS = 60_000;
const CREATE_LIMIT_MAX = 6; // 6 games created per minute per IP
const WS_LIMIT_WINDOW_MS = 60_000;
const WS_LIMIT_MAX = 30; // 30 connection attempts per minute per IP
const PHOTO_LIMIT_WINDOW_MS = 60_000;
const PHOTO_LIMIT_MAX = 40; // 40 photo uploads per minute per IP

// Hard ceiling on a single uploaded photo. Comfortably fits a
// full-detail ~2560px JPEG (typically 1–2 MB) with headroom for the
// "send near-original" case, while still bounding R2 writes and abuse.
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

/* ────────────────── CORS ────────────────── */

/**
 * Match an Origin against the ALLOWED_ORIGINS list. Entries
 * with `*` are treated as glob patterns (the `*` matches any
 * run of non-`/` characters), which lets us allow Cloudflare's
 * per-branch preview URLs (e.g.
 * `https://migration-vite-maplibre-jetlaghideandseek.<acct>.workers.dev`)
 * with a single entry like `https://*-jetlaghideandseek.<acct>.workers.dev`.
 * A literal `*` on its own still means "allow everything" for
 * dev convenience.
 */
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

function corsHeaders(env: Env, request: Request): Record<string, string> {
    const origin = request.headers.get("Origin") ?? "";
    const allowed = (env.ALLOWED_ORIGINS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    const allow = originMatches(origin, allowed) ? origin : "";
    return {
        "Access-Control-Allow-Origin": allow,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "content-type, x-game-code",
        "Access-Control-Max-Age": "86400",
        Vary: "Origin",
    };
}

/* ────────────────── Router ────────────────── */

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);

        // OPTIONS pre-flight for browser CORS.
        if (request.method === "OPTIONS") {
            return new Response(null, {
                status: 204,
                headers: corsHeaders(env, request),
            });
        }

        if (url.pathname === "/health") {
            return new Response("ok", {
                headers: corsHeaders(env, request),
            });
        }

        if (request.method === "GET" && url.pathname === "/vapid-public-key") {
            return new Response(
                JSON.stringify({ publicKey: env.VAPID_PUBLIC_KEY ?? "" }),
                {
                    headers: {
                        "content-type": "application/json",
                        ...corsHeaders(env, request),
                    },
                },
            );
        }

        if (request.method === "POST" && url.pathname === "/games") {
            const ip = clientIp(request);
            if (
                rateLimited(
                    createTrackers,
                    ip,
                    CREATE_LIMIT_WINDOW_MS,
                    CREATE_LIMIT_MAX,
                )
            ) {
                return new Response(
                    JSON.stringify({
                        error: "rate_limited",
                        message:
                            "Too many games created from this address. Try again in a minute.",
                    }),
                    {
                        status: 429,
                        headers: {
                            "content-type": "application/json",
                            "retry-after": "60",
                            ...corsHeaders(env, request),
                        },
                    },
                );
            }
            const code = generateGameCode();
            return new Response(JSON.stringify({ code }), {
                headers: {
                    "content-type": "application/json",
                    ...corsHeaders(env, request),
                },
            });
        }

        // /games/:code/ws — WebSocket upgrade.
        const wsMatch = url.pathname.match(/^\/games\/([A-Z0-9]{3,8})\/ws$/i);
        if (wsMatch) {
            const ip = clientIp(request);
            if (
                rateLimited(
                    wsTrackers,
                    ip,
                    WS_LIMIT_WINDOW_MS,
                    WS_LIMIT_MAX,
                )
            ) {
                return new Response("rate_limited", {
                    status: 429,
                    headers: {
                        "retry-after": "60",
                        ...corsHeaders(env, request),
                    },
                });
            }
            const code = wsMatch[1].toUpperCase();
            const id = env.GAME_ROOM.idFromName(code);
            const stub = env.GAME_ROOM.get(id);

            // The DO doesn't see the code from its own identifier, so
            // we relay it via a header (it'll imprint on the room).
            // Cloudflare Headers doesn't implement .entries() in the
            // TS types — iterate via forEach instead.
            const fwdHeaders = new Headers();
            request.headers.forEach((v, k) => fwdHeaders.set(k, v));
            fwdHeaders.set("x-game-code", code);
            const forwarded = new Request("https://internal/ws", {
                method: request.method,
                headers: fwdHeaders,
            });
            return stub.fetch(forwarded);
        }

        // POST /games/:code/photo — store a hider photo answer in R2,
        // return its URL. The image rides HTTP (not the WS), so it can
        // be multiple megabytes; only the URL goes over the socket.
        const photoUploadMatch = url.pathname.match(
            // v935: {3,8} — v932 shortened codes to 3 letters; the {4,8} here
            // was missed, so a 3-letter game's photo upload 404'd and every
            // photo answer fell back to the tiny inline thumbnail.
            /^\/games\/([A-Z0-9]{3,8})\/photo$/i,
        );
        if (request.method === "POST" && photoUploadMatch) {
            return handlePhotoUpload(
                request,
                env,
                photoUploadMatch[1].toUpperCase(),
            );
        }

        // GET /games/:code/photo/:id — serve a stored photo answer.
        const photoGetMatch = url.pathname.match(
            /^\/games\/([A-Z0-9]{3,8})\/photo\/([A-Za-z0-9_-]{1,64})$/i,
        );
        if (
            (request.method === "GET" || request.method === "HEAD") &&
            photoGetMatch
        ) {
            return handlePhotoServe(
                request,
                env,
                photoGetMatch[1].toUpperCase(),
                photoGetMatch[2],
            );
        }

        return new Response("not found", {
            status: 404,
            headers: corsHeaders(env, request),
        });
    },
} satisfies ExportedHandler<Env>;

/* ────────────────── Photo upload / serve ────────────────── */

function jsonResponse(
    body: unknown,
    status: number,
    extraHeaders: Record<string, string>,
): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...extraHeaders },
    });
}

/**
 * Store a hider's photo answer in R2 and hand back a stable URL. Scoped
 * to the game code (the key prefix), image-only, size-capped and per-IP
 * rate-limited. We deliberately don't round-trip the Durable Object to
 * verify the room exists — the cost isn't worth it, the key is namespaced
 * by code, and games are ephemeral (photos age out with a lifecycle rule
 * / get purged), so the blast radius of a junk upload is a few stray
 * objects under a non-existent code.
 */
async function handlePhotoUpload(
    request: Request,
    env: Env,
    code: string,
): Promise<Response> {
    const cors = corsHeaders(env, request);
    if (!env.PHOTOS) {
        return jsonResponse({ error: "photos_unconfigured" }, 503, cors);
    }
    const ip = clientIp(request);
    if (
        rateLimited(
            photoTrackers,
            ip,
            PHOTO_LIMIT_WINDOW_MS,
            PHOTO_LIMIT_MAX,
        )
    ) {
        return jsonResponse({ error: "rate_limited" }, 429, {
            ...cors,
            "retry-after": "60",
        });
    }

    const contentType = (request.headers.get("content-type") ?? "")
        .split(";")[0]
        .trim();
    if (!contentType.startsWith("image/")) {
        return jsonResponse({ error: "not_an_image" }, 415, cors);
    }

    // Cheap pre-check from the declared length before we buffer.
    const declared = parseInt(request.headers.get("content-length") ?? "", 10);
    if (Number.isFinite(declared) && declared > MAX_PHOTO_BYTES) {
        return jsonResponse(
            { error: "too_large", maxBytes: MAX_PHOTO_BYTES },
            413,
            cors,
        );
    }

    const buf = await request.arrayBuffer();
    if (buf.byteLength === 0) {
        return jsonResponse({ error: "empty" }, 400, cors);
    }
    if (buf.byteLength > MAX_PHOTO_BYTES) {
        return jsonResponse(
            { error: "too_large", maxBytes: MAX_PHOTO_BYTES },
            413,
            cors,
        );
    }

    const id = crypto.randomUUID();
    const key = `photos/${code}/${id}`;
    try {
        await env.PHOTOS.put(key, buf, {
            httpMetadata: {
                contentType,
                // A given id is byte-stable, so let browsers cache it
                // hard once fetched.
                cacheControl: "public, max-age=604800, immutable",
            },
            customMetadata: { code, storedAt: String(Date.now()) },
        });
    } catch (e) {
        console.warn(`[photo] R2 put failed ${key}:`, e);
        return jsonResponse({ error: "store_failed" }, 500, cors);
    }

    const photoUrl = `${new URL(request.url).origin}/games/${code}/photo/${id}`;
    return jsonResponse({ url: photoUrl, id }, 200, cors);
}

/** Serve a stored photo answer straight from R2. */
async function handlePhotoServe(
    request: Request,
    env: Env,
    code: string,
    id: string,
): Promise<Response> {
    const cors = corsHeaders(env, request);
    if (!env.PHOTOS) {
        return new Response("not found", { status: 404, headers: cors });
    }
    const key = `photos/${code}/${id}`;
    let obj: R2ObjectBody | null;
    try {
        obj = await env.PHOTOS.get(key);
    } catch (e) {
        console.warn(`[photo] R2 get failed ${key}:`, e);
        obj = null;
    }
    if (!obj) {
        return new Response("not found", { status: 404, headers: cors });
    }
    const headers: Record<string, string> = {
        ...cors,
        "content-type": obj.httpMetadata?.contentType ?? "image/jpeg",
        "cache-control": "public, max-age=604800, immutable",
        etag: obj.httpEtag,
    };
    return new Response(request.method === "HEAD" ? null : obj.body, {
        headers,
    });
}

/* ────────────────── Env shape ────────────────── */

interface Env {
    GAME_ROOM: DurableObjectNamespace;
    ALLOWED_ORIGINS?: string;
    VAPID_PUBLIC_KEY?: string;
    VAPID_KEYS?: string;
    /** R2 bucket holding hider photo answers under `photos/<code>/<id>`.
     *  Optional so the worker still boots if the binding is missing —
     *  the upload endpoint then 503s and the client falls back to an
     *  inline thumbnail. */
    PHOTOS?: R2Bucket;
}
