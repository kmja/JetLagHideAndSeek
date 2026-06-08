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

// Omit ambiguous characters (I/O/0/1, lowercase l) so codes are easy
// to read out loud over voice. 30 chars × 6 positions = ~729M codes;
// collision risk inside a 30 min idle window is negligible at the
// scales we care about (small groups of friends).
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;

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
        const wsMatch = url.pathname.match(/^\/games\/([A-Z0-9]{4,8})\/ws$/i);
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

        return new Response("not found", {
            status: 404,
            headers: corsHeaders(env, request),
        });
    },
} satisfies ExportedHandler<Env>;

/* ────────────────── Env shape ────────────────── */

interface Env {
    GAME_ROOM: DurableObjectNamespace;
    ALLOWED_ORIGINS?: string;
    VAPID_PUBLIC_KEY?: string;
    VAPID_KEYS?: string;
}
