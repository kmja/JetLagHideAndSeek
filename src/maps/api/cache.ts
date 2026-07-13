import memoize from "lodash/memoize";
import uniq from "lodash/uniq";
import uniqBy from "lodash/uniqBy";
import { toast } from "react-toastify";

import { recordBytes } from "@/lib/bandwidthMeter";
import {
    markPieceDone,
    markPieceFailed,
    registerPiece,
    setBytesForUrl,
} from "@/lib/loadingProgress";

import { CacheType } from "./types";

/**
 * iOS Safari (particularly in PWA / private-mode contexts) sometimes
 * lets `caches.open()` resolve but then hangs `cache.match()` /
 * `cache.put()` indefinitely. The whole boundary-fetch pipeline
 * waits on those promises with no inner timeout, so the user sat
 * forever on "Fetching boundary…". This wrapper races every Cache-
 * API call against a short timer; if the cache doesn't answer in
 * time we yield to the direct-fetch fallback in `cacheFetch`.
 */
const CACHE_OP_TIMEOUT_MS = 2500;

function withCacheTimeout<T>(p: Promise<T>, op: string): Promise<T> {
    return Promise.race([
        p,
        new Promise<T>((_, reject) =>
            setTimeout(
                () =>
                    reject(
                        new Error(`Cache API '${op}' timed out after ${CACHE_OP_TIMEOUT_MS}ms`),
                    ),
                CACHE_OP_TIMEOUT_MS,
            ),
        ),
    ]);
}

function wrapCacheStorage(cache: Cache): Cache {
    return new Proxy(cache, {
        get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver);
            if (typeof value !== "function") return value;
            if (prop === "match" || prop === "put" || prop === "delete" || prop === "keys") {
                return (...args: unknown[]) =>
                    withCacheTimeout(
                        (value as (...a: unknown[]) => Promise<unknown>).apply(
                            target,
                            args,
                        ),
                        String(prop),
                    );
            }
            return value.bind(target);
        },
    });
}

async function openCacheSafe(name: string): Promise<Cache> {
    if (typeof caches === "undefined") {
        throw new Error("Cache API unavailable");
    }
    const cache = await withCacheTimeout(caches.open(name), `open(${name})`);
    return wrapCacheStorage(cache);
}

const determineQuestionCache = memoize(() => openCacheSafe(CacheType.CACHE));
const determineZoneCache = memoize(() => openCacheSafe(CacheType.ZONE_CACHE));
const determinePermanentCache = memoize(() =>
    openCacheSafe(CacheType.PERMANENT_CACHE),
);

const inFlightFetches = new Map<string, Promise<Response>>();

export const determineCache = async (cacheType: CacheType): Promise<Cache> => {
    switch (cacheType) {
        case CacheType.CACHE:
            return await determineQuestionCache();
        case CacheType.ZONE_CACHE:
            return await determineZoneCache();
        case CacheType.PERMANENT_CACHE:
            return await determinePermanentCache();
    }
};

/**
 * Default per-request budget. Overpass relations can be slow on the
 * public mirrors when they're loaded — and at least one of the public
 * mirrors will hang indefinitely on overload — so we hard-cap each
 * attempt. The caller (e.g. getOverpassData) can still chain attempts
 * across multiple mirrors after a timeout.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25000;

/**
 * Length at which we switch the Overpass request from GET-with-query
 * to POST-with-body. Many servers (and CDNs in front of them) reject
 * GETs with `414 Request-URI Too Long` around 8 KB — that's the failure
 * mode for large play-area polygons baked into `poly:"…"` filters.
 * 4 KB is a comfortably safe ceiling that leaves room for headers,
 * proxy decoration, and Cloudflare's own request URI cap.
 */
const URL_POST_THRESHOLD = 4000;

const fetchWithTimeout = async (
    url: string,
    timeoutMs: number,
    init?: RequestInit,
    /** Optional external canceller (the mirror race's per-racer signal).
     *  Folded into this fetch's own timeout controller so a losing racer
     *  stops downloading its body the moment another mirror wins. */
    externalSignal?: AbortSignal,
) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const onExternalAbort = () => controller.abort();
    if (externalSignal) {
        if (externalSignal.aborted) controller.abort();
        else
            externalSignal.addEventListener("abort", onExternalAbort, {
                once: true,
            });
    }
    try {
        // Long-URL escape hatch: when the URL crosses the GET-friendly
        // limit AND it's an Overpass `?data=…` query, split it and
        // POST the data field as a form-encoded body. Every Overpass
        // mirror — including our cache worker (v131+) — accepts either
        // shape, and the public CDNs only 414-out on the GET path.
        // Cloudflare also 414s GETs past ~8 KB, so the worker needs
        // the POST conversion just as much as the public mirrors do
        // for the largest poly:-filtered queries.
        const queryIdx = url.indexOf("?data=");
        const useFormPost =
            !init?.method &&
            queryIdx >= 0 &&
            url.length > URL_POST_THRESHOLD &&
            url.includes("/interpreter");
        if (useFormPost) {
            const base = url.slice(0, queryIdx);
            const encodedData = url.slice(queryIdx + "?data=".length);
            return await fetch(base, {
                ...init,
                method: "POST",
                headers: {
                    ...(init?.headers ?? {}),
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                body: `data=${encodedData}`,
                signal: controller.signal,
            });
        }
        return await fetch(url, { ...init, signal: controller.signal });
    } finally {
        clearTimeout(timeoutId);
        if (externalSignal)
            externalSignal.removeEventListener("abort", onExternalAbort);
    }
};

/**
 * localStorage cache of "how big was this URL's response last time"
 * so we can show a determinate progress bar / "X / Y MB" label even
 * when the server doesn't send Content-Length (Overpass mirrors
 * stream with Transfer-Encoding: chunked, no length header). On
 * first fetch we only have the running byte count; on every
 * subsequent fetch of the same URL we use the cached size as the
 * estimated total.
 *
 * Keyed by full URL. Stored as a tiny JSON blob so the cache fits
 * in localStorage's per-key budget even for huge sets — boundary
 * fetches are typically a few hundred unique URLs at most.
 */
const SIZE_CACHE_KEY = "jlhs:fetchSizeCache";
const SIZE_CACHE_LIMIT = 200;

function readSizeCache(): Record<string, number> {
    try {
        const raw = localStorage.getItem(SIZE_CACHE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") return parsed;
        return {};
    } catch {
        return {};
    }
}

function writeSizeCache(map: Record<string, number>) {
    try {
        // Cap the cache so it doesn't grow without bound across
        // months of use. Drops oldest-inserted entries (insertion
        // order is preserved in object literals).
        const keys = Object.keys(map);
        if (keys.length > SIZE_CACHE_LIMIT) {
            const overflow = keys.length - SIZE_CACHE_LIMIT;
            for (let i = 0; i < overflow; i++) delete map[keys[i]];
        }
        localStorage.setItem(SIZE_CACHE_KEY, JSON.stringify(map));
    } catch {
        /* localStorage full / private mode — non-fatal. */
    }
}

// In-memory copy, hydrated once from localStorage on first access. The old
// code JSON.parsed (and rememberSize also stringified + wrote) the WHOLE
// size-cache object on EVERY progress-reporting fetch — repeated synchronous
// main-thread parse/stringify of up to 200 entries per fetch, worst during a
// parallel adjacent-area warm (the exact load-heavy moment we don't want to
// jank). Now reads hit memory and writes are debounced to at most 1/s.
let sizeCacheMem: Record<string, number> | null = null;
let sizeCacheFlushTimer: number | null = null;

function ensureSizeCache(): Record<string, number> {
    if (sizeCacheMem === null) sizeCacheMem = readSizeCache();
    return sizeCacheMem;
}

function scheduleSizeCacheFlush() {
    if (sizeCacheFlushTimer !== null) return;
    sizeCacheFlushTimer = window.setTimeout(() => {
        sizeCacheFlushTimer = null;
        // writeSizeCache trims the cap in place, keeping mem + disk in sync.
        if (sizeCacheMem) writeSizeCache(sizeCacheMem);
    }, 1000);
}

function getCachedSize(url: string): number | null {
    const m = ensureSizeCache();
    const v = m[url];
    return typeof v === "number" && v > 0 ? v : null;
}

function rememberSize(url: string, size: number) {
    if (!Number.isFinite(size) || size <= 0) return;
    const m = ensureSizeCache();
    // Re-insert to refresh recency (delete then set bumps to tail).
    delete m[url];
    m[url] = size;
    scheduleSizeCacheFlush();
}

/**
 * Read a Response body fully while reporting progress to the
 * global `loadingProgress` atom. Returns the bytes plus a "best
 * available" total for the progress bar.
 *
 * Total bytes are picked, in priority order:
 *   1. Server's `Content-Length` header (rare on Overpass —
 *      chunked responses skip it).
 *   2. The size we last cached for THIS URL in localStorage. So a
 *      second visit to Sweden's boundary shows "X / ~17 MB" even
 *      though the server didn't tell us the total.
 *   3. None — the overlay shows just the downloaded byte count.
 *
 * After the body fully reads, the actual size is written back to
 * the cache so subsequent fetches use the freshest number.
 *
 * Why fully-read into a buffer instead of streaming through a
 * `Response.clone() + tee` wrapper: the previous wrapper had a
 * cross-stream contention bug where `cache.put` and the caller
 * both consumed branches of a tee'd custom `ReadableStream`,
 * which in practice deadlocked some browsers and left the
 * loading overlay stuck on "Starting…". Buffering trades a
 * small amount of memory for a deterministic, single-owner
 * read path.
 */
async function readBodyWithProgress(
    response: Response,
    url: string,
    progressLabel?: string,
): Promise<Uint8Array> {
    if (!response.body) {
        const ab = await response.arrayBuffer();
        const bytes = new Uint8Array(ab);
        // Even on the no-body fallback, still record the piece so
        // the overlay shows it ticked through.
        setBytesForUrl(url, bytes.byteLength, bytes.byteLength, progressLabel);
        markPieceDone(url);
        return bytes;
    }
    const contentLengthHeader = response.headers.get("Content-Length");
    const headerTotal = contentLengthHeader
        ? parseInt(contentLengthHeader, 10)
        : null;
    const headerTotalSafe =
        headerTotal && Number.isFinite(headerTotal) && headerTotal > 0
            ? headerTotal
            : null;
    const cachedTotal = headerTotalSafe ?? getCachedSize(url);

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let downloaded = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        downloaded += value.byteLength;
        // If our cached estimate underestimated, bump it up so
        // the bar never appears stuck at 100% with bytes still
        // arriving.
        const effectiveTotal =
            cachedTotal !== null && downloaded > cachedTotal
                ? downloaded
                : cachedTotal;
        setBytesForUrl(url, downloaded, effectiveTotal, progressLabel);
    }

    rememberSize(url, downloaded);
    // Mark this piece complete so the row reads as "done" rather
    // than sitting on "streaming" while the parse/union steps run.
    markPieceDone(url);

    // Concat chunks into one Uint8Array.
    const out = new Uint8Array(downloaded);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}

/** Build a fresh Response from a previously-read body buffer.
 *  Used so we can hand the SAME bytes to both `cache.put` (one
 *  Response) and the eventual JSON consumer (another Response)
 *  without sharing a body stream. Exported for `getOverpassData`'s
 *  abort-remark sniff (v667), which buffers each racer's body. */
export function responseFromBuffer(
    bytes: Uint8Array,
    template: Response,
): Response {
    // ⚠️ Strip Content-Encoding (and the now-wrong Content-Length).
    // `bytes` is the already-DECODED body — the browser transparently
    // gunzips a fetch response when we read its stream/arrayBuffer. Our
    // overpass-cache worker serves R2 gzip entries with an explicit
    // `Content-Encoding: gzip` header; copying that header onto a
    // response whose body is plain JSON means a later `.json()` on the
    // CACHED entry tries to gunzip plain text and throws "Unexpected
    // token" (a raw 0x1f byte) — surfacing as "[overpass] winning
    // response wasn't valid JSON — treating as empty", which silently
    // blanks the transit overlays AND the hiding-zone station query.
    const headers = new Headers(template.headers);
    headers.delete("Content-Encoding");
    headers.delete("Content-Length");
    // Copy to a fresh ArrayBuffer so each Response owns its own
    // memory and can be consumed independently — passing the
    // same Uint8Array to multiple Response constructors causes
    // their bodies to share the underlying buffer.
    return new Response(bytes.slice().buffer, {
        status: template.status,
        statusText: template.statusText,
        headers,
    });
}

/**
 * Defensive JSON parse for a Response read from CacheStorage. CacheStorage
 * is byte-faithful: it stores exactly what we put in, headers and all.
 * If a previous build wrote raw gzip bytes (or a header that confuses
 * `.json()`) into the namespace, `.json()` throws on the gzip magic byte
 * (0x1f). This helper reads the body, sniffs the first two bytes, and
 * runs the body through `DecompressionStream("gzip")` if it looks
 * gzipped — healing legacy entries without needing the user to clear
 * site data.
 *
 * Use at every CacheStorage read site; harmless for already-plain
 * responses (the magic-byte check is two byte comparisons).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function safeJsonFromCachedResponse(resp: Response): Promise<any> {
    const buf = new Uint8Array(await resp.arrayBuffer());
    if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
        // Looks like gzip magic. Pipe it through DecompressionStream and
        // parse the result. Available in all evergreen browsers and
        // Cloudflare Workers.
        try {
            const blob = new Blob([buf]);
            const stream = blob
                .stream()
                .pipeThrough(new DecompressionStream("gzip"));
            const decoded = await new Response(stream).text();
            return JSON.parse(decoded);
        } catch {
            // Fall through to the raw parse — caller catches.
        }
    }
    return JSON.parse(new TextDecoder().decode(buf));
}

/**
 * `cache.put` that survives a full origin storage quota. When the put
 * throws `QuotaExceededError`, we evict the oldest ~25% of this cache's
 * entries (CacheStorage.keys() preserves insertion order, so the head is
 * oldest) and retry once. Without this, the FIRST write that overflows
 * the quota leaves the cache permanently full — every subsequent write
 * then fails too, which is the "Cache write failed: QuotaExceededError"
 * cascade seen when warming a big play area (Toronto, London). Mirrors
 * the Workbox SW's `purgeOnQuotaError`, but for our own namespaces.
 */
async function putWithQuotaRetry(
    cache: Cache,
    url: string,
    response: Response,
): Promise<void> {
    try {
        await cache.put(url, response.clone());
        return;
    } catch (e) {
        if (!(e instanceof DOMException) || e.name !== "QuotaExceededError") {
            throw e;
        }
    }
    // Quota hit — reclaim space and retry once.
    try {
        const keys = await cache.keys();
        const evictCount = Math.max(1, Math.ceil(keys.length * 0.25));
        for (let i = 0; i < evictCount && i < keys.length; i++) {
            await cache.delete(keys[i]);
        }
        console.warn(
            `Cache quota exceeded — evicted ${evictCount}/${keys.length} oldest entries and retrying.`,
        );
        await cache.put(url, response.clone());
    } catch (e) {
        // Eviction or the retry still failed — give up on caching this
        // entry (the caller still gets the live response).
        console.warn("Cache write failed after quota eviction:", e);
    }
}

export const cacheFetch = async (
    url: string,
    loadingText?: string,
    cacheType: CacheType = CacheType.CACHE,
    timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
    /** When true, the response body is streamed through a progress
     *  tee that updates the global loadingProgress atom. The caller
     *  is responsible for opening (`startLoading`) and closing
     *  (`finishLoading`) the overlay around its full operation. */
    reportProgress: boolean = false,
    /** User-visible label for this fetch's piece row in the loading
     *  overlay (e.g. "Stockholm Municipality"). Only meaningful when
     *  `reportProgress` is true — otherwise the piece atom isn't
     *  touched. */
    progressLabel?: string,
    /** Optional per-caller abort signal (the mirror race's loser-canceller).
     *  When present, the in-flight coalescing is bypassed so aborting this
     *  caller never cancels a different caller that coalesced onto the same
     *  URL. Same-URL concurrency across races is rare, so an isolated fetch
     *  is a safe trade for clean per-racer cancellation. */
    signal?: AbortSignal,
) => {
    // Register this piece up front (waiting state) so the overlay
    // shows a row IMMEDIATELY when the fetch is queued, even before
    // any bytes have arrived. This is the main visible cue that
    // multiple adjacents are loading in parallel. We register before
    // touching the Cache API because cache reads themselves can take
    // tens of ms on slow storage and we don't want a perceived stall.
    if (reportProgress && progressLabel) {
        registerPiece(url, progressLabel);
    }
    try {
        const cache = await determineCache(cacheType);

        const cachedResponse = await cache.match(url);
        if (cachedResponse) {
            if (!cachedResponse.ok) {
                await cache.delete(url);
            } else {
                // Cache hit: count it as instantly-done for the
                // piece row so the user sees that adjacent area
                // flick to ✓ without waiting on the network.
                if (reportProgress && progressLabel) {
                    markPieceDone(url);
                }
                return cachedResponse.clone();
            }
        }

        const inflightKey = `${cacheType}:${url}`;
        const existingFetch = inFlightFetches.get(inflightKey);
        if (existingFetch) {
            const response = await existingFetch;
            return response.clone();
        }

        const fetchAndMaybeCache = async () => {
            const rawResponse = await fetchWithTimeout(
                url,
                timeoutMs,
                undefined,
                signal,
            );
            if (!rawResponse.ok) {
                await cache.delete(url);
                if (reportProgress && progressLabel) {
                    markPieceFailed(url);
                }
                return rawResponse;
            }
            // Wire-byte accounting for any open bandwidth meters (e.g.
            // the preload buckets). Content-Length on a gzipped response
            // is the compressed wire size, which is what mobile users
            // actually pay for in data. Cache hits skip this path
            // entirely — accurate, since nothing crossed the network.
            const contentLengthHeader = rawResponse.headers.get("Content-Length");
            if (contentLengthHeader) {
                const cl = parseInt(contentLengthHeader, 10);
                if (Number.isFinite(cl)) recordBytes(cl);
            }
            if (reportProgress) {
                // Read fully through the progress reporter, then
                // hand back a fresh Response from the same bytes.
                // Caching uses another fresh Response from those
                // bytes so there's no body-stream sharing between
                // the cache write and the caller.
                const bytes = await readBodyWithProgress(
                    rawResponse,
                    url,
                    progressLabel,
                );
                await putWithQuotaRetry(
                    cache,
                    url,
                    responseFromBuffer(bytes, rawResponse),
                );
                return responseFromBuffer(bytes, rawResponse);
            }
            // Non-progress path: read the DECODED body once, then build
            // header-stripped Responses for both the cache and the
            // caller. We can't just `cache.put(rawResponse.clone())`:
            // the worker's `Content-Encoding: gzip` header would ride
            // along into CacheStorage, and re-reads of that entry fail
            // to gunzip plain JSON (the "winning response wasn't valid
            // JSON" bug that blanks transit overlays + hiding zones).
            // `arrayBuffer()` transparently decodes the gzip, so the
            // bytes are plain JSON and `responseFromBuffer` drops the
            // stale encoding headers.
            const decoded = new Uint8Array(await rawResponse.arrayBuffer());
            await putWithQuotaRetry(
                cache,
                url,
                responseFromBuffer(decoded, rawResponse),
            );
            return responseFromBuffer(decoded, rawResponse);
        };

        // Abort-signal callers bypass coalescing (see the `signal` param
        // doc): each racer owns an isolated fetch so cancelling a loser
        // can't take down a coalesced sibling.
        if (signal) {
            const response = await (loadingText
                ? toast.promise(fetchAndMaybeCache(), { pending: loadingText })
                : fetchAndMaybeCache());
            return response.clone();
        }

        const fetchPromise = fetchAndMaybeCache();
        inFlightFetches.set(inflightKey, fetchPromise);

        try {
            const response = await (loadingText
                ? toast.promise(fetchPromise, {
                      pending: loadingText,
                  })
                : fetchPromise);

            return response.clone();
        } finally {
            inFlightFetches.delete(inflightKey);
        }
    } catch (e) {
        // Mark the piece failed so the user sees that this adjacent
        // didn't make it (vs. silently sitting at "streaming").
        if (reportProgress && progressLabel) {
            markPieceFailed(url);
        }
        // Propagate AbortError (timeout) and TypeError (network failure)
        // so the caller can fail over to a fallback mirror instead of
        // burning another full timeout retrying the same dead URL.
        if (e instanceof Error && (e.name === "AbortError" || e.name === "TypeError")) {
            throw e;
        }
        // Otherwise it's probably a Cache API issue (e.g. private
        // browsing) — fall back to a direct timed fetch.
        console.warn("cacheFetch fell back to direct fetch:", e);
        return fetchWithTimeout(url, timeoutMs);
    }
};

export const clearCache = async (cacheType: CacheType = CacheType.CACHE) => {
    try {
        const cache = await determineCache(cacheType);
        await cache.keys().then((keys) => {
            keys.forEach((key) => {
                cache.delete(key);
            });
        });
    } catch (e) {
        console.warn("clearCache failed (Cache API unavailable?):", e);
    }
};
