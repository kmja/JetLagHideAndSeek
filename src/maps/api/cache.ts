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
 * Tee a Response body through a progress reporter so the loading
 * overlay can surface download progress. Returns a new Response
 * with an identical body but with `loadingProgress` bytes ticking
 * up as the original streams. Honours Content-Length where the
 * server provides it; falls back to "indeterminate but counting"
 * otherwise (most Overpass mirrors omit Content-Length on
 * dynamically-generated responses).
 */
const wrapResponseWithProgress = (response: Response, reportProgress: boolean): Response => {
    if (!reportProgress) return response;
    if (!response.body) return response;
    const contentLengthHeader = response.headers.get("Content-Length");
    const total = contentLengthHeader ? parseInt(contentLengthHeader, 10) : null;
    const totalSafe = total && Number.isFinite(total) && total > 0 ? total : null;

    let downloaded = 0;
    const reader = response.body.getReader();

    const stream = new ReadableStream({
        async pull(controller) {
            try {
                const { done, value } = await reader.read();
                if (done) {
                    controller.close();
                    return;
                }
                downloaded += value.byteLength;
                setBytes(downloaded, totalSafe);
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
            const response = wrapResponseWithProgress(rawResponse, reportProgress);
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
