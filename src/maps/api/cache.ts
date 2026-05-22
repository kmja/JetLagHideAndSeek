import _ from "lodash";
import { toast } from "react-toastify";

import { setBytes } from "@/lib/loadingProgress";

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
 * Tee a Response body through a progress reporter so the loading
 * overlay can surface download progress. Returns a new Response
 * with an identical body but with `loadingProgress` bytes ticking
 * up as the original streams.
 *
 * Total bytes for the determinate progress bar are picked, in
 * priority order:
 *   1. Server's `Content-Length` header (rare on Overpass —
 *      chunked responses skip it).
 *   2. The size we last cached for THIS URL in localStorage. So a
 *      second visit to Sweden's boundary shows "X / ~17 MB" even
 *      though the server didn't tell us the total.
 *   3. None — the overlay falls back to "X downloaded" without a
 *      total.
 *
 * After the body fully reads, the actual size is written back to
 * the cache so subsequent fetches use the freshest number.
 */
const wrapResponseWithProgress = (
    response: Response,
    reportProgress: boolean,
    url: string,
): Response => {
    if (!reportProgress) return response;
    if (!response.body) return response;
    const contentLengthHeader = response.headers.get("Content-Length");
    const headerTotal = contentLengthHeader
        ? parseInt(contentLengthHeader, 10)
        : null;
    const headerTotalSafe =
        headerTotal && Number.isFinite(headerTotal) && headerTotal > 0
            ? headerTotal
            : null;
    const cachedTotal = headerTotalSafe ?? getCachedSize(url);

    let downloaded = 0;
    const reader = response.body.getReader();

    const stream = new ReadableStream({
        async pull(controller) {
            try {
                const { done, value } = await reader.read();
                if (done) {
                    // Save the final size for next time.
                    rememberSize(url, downloaded);
                    controller.close();
                    return;
                }
                downloaded += value.byteLength;
                // If our cached estimate underestimated, bump it
                // up so the bar never appears stuck at 100% with
                // bytes still arriving.
                const effectiveTotal =
                    cachedTotal !== null && downloaded > cachedTotal
                        ? downloaded
                        : cachedTotal;
                setBytes(downloaded, effectiveTotal);
                controller.enqueue(value);
            } catch (e) {
                controller.error(e);
            }
        },
        cancel(reason) {
            reader.cancel(reason);
        },
    });

    return new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
    });
};

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
) => {
    try {
        const cache = await determineCache(cacheType);

        const cachedResponse = await cache.match(url);
        if (cachedResponse) {
            if (!cachedResponse.ok) {
                await cache.delete(url);
            } else {
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
            // Wrap with progress BEFORE the cache.put so the byte
            // counter ticks during the actual network read rather
            // than jumping to 100% after the cache write finishes.
            const response = wrapResponseWithProgress(
                rawResponse,
                reportProgress,
                url,
            );
            if (response.ok) {
                await cache.put(url, response.clone());
            } else {
                await cache.delete(url);
            }
            return response;
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
        // Propagate AbortError (timeout) and TypeError (network failure)
        // so the caller can fail over to a fallback mirror instead of
        // burning another full timeout retrying the same dead URL.
        if (e instanceof Error && (e.name === "AbortError" || e.name === "TypeError")) {
            throw e;
        }
        // Otherwise it's probably a Cache API issue (e.g. private
        // browsing) — fall back to a direct timed fetch.
        console.log(e);
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
        console.log(e); // Probably a caches not supported error
    }
};
