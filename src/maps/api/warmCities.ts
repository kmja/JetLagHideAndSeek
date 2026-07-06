import { atom } from "nanostores";

import { WARM_CITIES_URL } from "./constants";

/**
 * "Warm" (fully cached) city set — the relation ids the worker reports as
 * FULLY cached for Overpass-free play: the primary area's boundary +
 * references + hiding-zone stations AND every adjacent area, all present in
 * R2 (v679, the `fullyCuratedAt` gate; a star means "fully cached, including
 * adjacent areas"). Fetched once from `GET /api/warm-cities`, cached in this
 * atom, and read by the play-area search to star matching results.
 *
 * `null` = not loaded yet (or the fetch failed and can retry). An empty
 * Set = loaded, nothing warm. The set is small (a few hundred to ~1k ids)
 * and the endpoint is CDN/browser-cached, so the one fetch is cheap.
 */
export const warmCityIds = atom<Set<number> | null>(null);

let inFlight: Promise<void> | null = null;

/** Fetch the warm-city set once and cache it. Idempotent + coalesced —
 *  concurrent callers share one request; a successful load is never
 *  re-fetched (the atom stays populated for the session). Silent on
 *  failure (leaves the atom null so a later call can retry). */
export function ensureWarmCitiesLoaded(): Promise<void> {
    if (warmCityIds.get() !== null) return Promise.resolve();
    if (inFlight) return inFlight;
    inFlight = (async () => {
        try {
            const resp = await fetch(WARM_CITIES_URL);
            if (!resp.ok) return;
            const data = (await resp.json()) as { ids?: number[] };
            const ids = Array.isArray(data.ids) ? data.ids : [];
            warmCityIds.set(new Set(ids.filter((n) => Number.isFinite(n))));
        } catch {
            /* leave null so a later mount can retry */
        } finally {
            inFlight = null;
        }
    })();
    return inFlight;
}

/** Whether an OSM relation id is a prewarmed/"warm" city, given the loaded
 *  set (or null while it's still loading — treated as "unknown → not warm"
 *  so nothing is wrongly starred before the data lands). */
export function isWarmCity(
    osmId: number | null | undefined,
    set: Set<number> | null,
): boolean {
    return Boolean(set && osmId != null && set.has(osmId));
}
