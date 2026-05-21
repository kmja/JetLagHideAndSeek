import _ from "lodash";
import { toast } from "react-toastify";

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

export const cacheFetch = async (
    url: string,
    loadingText?: string,
    cacheType: CacheType = CacheType.CACHE,
    timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
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
            const response = await fetchWithTimeout(url, timeoutMs);
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
