/**
 * Persistence backend for the play-area boundary polygon.
 *
 * Why this exists: a country-sized OSM relation's GeoJSON can run
 * 5–10 MB stringified. localStorage's per-origin quota (~5 MB in
 * most browsers) silently fails the write — nanostores' persistent
 * atom catches the QuotaExceededError, so the atom looks set
 * in-memory but nothing actually lands on disk. On reload the atom
 * deserialises as `null`, Map.tsx sees no boundary, and the user
 * eats another determineMapBoundaries() round-trip — sometimes
 * mid-game while the timer is already ticking down.
 *
 * The Cache API has no practical size limit in modern browsers
 * (gigabytes are fine; it's quota'd per-origin against the device's
 * disk budget) and is the same primitive Overpass already uses for
 * HTTP response caching. We store the boundary as a JSON Response
 * at a synthetic URL inside a dedicated cache name.
 */

const CACHE_NAME = "jlhs-boundary-v1";
const KEY = "https://_internal/polyGeoJSON";

/** Stash the play-area boundary so the next page load can hydrate
 *  instantly without re-fetching from Overpass. No-op (with a
 *  console warn) when Cache API is unavailable. */
export async function saveBoundary(geoJSON: unknown): Promise<void> {
    if (typeof caches === "undefined") return;
    try {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(
            KEY,
            new Response(JSON.stringify(geoJSON), {
                headers: { "Content-Type": "application/json" },
            }),
        );
    } catch (e) {
        console.warn("Failed to persist play-area boundary:", e);
    }
}

/** Read the cached boundary, if any. Returns null on cache miss,
 *  parse failure, or any Cache API error. */
export async function loadBoundary<T = unknown>(): Promise<T | null> {
    if (typeof caches === "undefined") return null;
    try {
        const cache = await caches.open(CACHE_NAME);
        const resp = await cache.match(KEY);
        if (!resp) return null;
        return (await resp.json()) as T;
    } catch {
        return null;
    }
}

/** Drop the cached boundary — called when the user picks a new
 *  play area or starts a new game. */
export async function clearBoundary(): Promise<void> {
    if (typeof caches === "undefined") return;
    try {
        const cache = await caches.open(CACHE_NAME);
        await cache.delete(KEY);
    } catch {
        /* no-op */
    }
}
