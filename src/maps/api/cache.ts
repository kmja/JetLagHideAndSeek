import _ from "lodash";
import { toast } from "react-toastify";

import {
    markPieceDone,
    markPieceFailed,
    registerPiece,
    setBytesForUrl,
} from "@/lib/loadingProgress";

import { CacheType } from "./types";

const determineQuestionCache = _.memoize(() => caches.open(CacheType.CACHE));
const determineZoneCache = _.memoize(() => caches.open(CacheType.ZONE_CACHE));
const determinePermanentCache = _.memoize(() =>
    caches.open(CacheType.PERMANENT_CACHE),
);

const inFlightFetches = new Map<string, Promise<Response>>();

export const determineCache = async (cacheType: CacheType) => {
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

const fetchWithTimeout = async (
    url: string,
    timeoutMs: number,
    init?: RequestInit,
) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } finally {
        clearTimeout(timeoutId);
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

function getCachedSize(url: string): number | null {
    const m = readSizeCache();
    const v = m[url];
    return typeof v === "number" && v > 0 ? v : null;
}

function rememberSize(url: string, size: number) {
    if (!Number.isFinite(size) || size <= 0) return;
    const m = readSizeCache();
    // Re-insert to refresh recency (delete then set bumps to tail).
    delete m[url];
    m[url] = size;
    writeSizeCache(m);
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
 *  without sharing a body stream. */
function responseFromBuffer(
    bytes: Uint8Array,
    template: Response,
): Response {
    // Copy to a fresh ArrayBuffer so each Response owns its own
    // memory and can be consumed independently — passing the
    // same Uint8Array to multiple Response constructors causes
    // their bodies to share the underlying buffer.
    return new Response(bytes.slice().buffer, {
        status: template.status,
        statusText: template.statusText,
        headers: template.headers,
    });
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
            const rawResponse = await fetchWithTimeout(url, timeoutMs);
            if (!rawResponse.ok) {
                await cache.delete(url);
                if (reportProgress && progressLabel) {
                    markPieceFailed(url);
                }
                return rawResponse;
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
                try {
                    await cache.put(
                        url,
                        responseFromBuffer(bytes, rawResponse),
                    );
                } catch (e) {
                    console.warn("Cache write failed:", e);
                }
                return responseFromBuffer(bytes, rawResponse);
            }
            // Non-progress path: original behaviour — clone for
            // the cache, return the original to the caller. No
            // custom stream involved, no tee deadlock risk.
            await cache.put(url, rawResponse.clone());
            return rawResponse;
        };

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
