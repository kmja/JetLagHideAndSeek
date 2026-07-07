import { atom } from "nanostores";

import { SEED_CITIES_URL } from "./constants";

/**
 * Seed-city relation ids — the bundled top-N biggest cities (v681). This is
 * the "which relations are major cities" signal, distinct from the warm set
 * (`warmCities.ts`, the FULLY-CACHED subset). It's known from the bundle
 * immediately, so the play-area search can float a same-named big city above
 * a village without waiting on the cron backfill — the primary disambiguation
 * key, with the geocode.ts scoring kept as the tiebreaker/fallback.
 *
 * `null` = not loaded yet (or the fetch failed and can retry). The endpoint
 * is deploy-stable and long-cached, so the one fetch is cheap.
 */
export const seedCityIds = atom<Set<number> | null>(null);

let inFlight: Promise<void> | null = null;

/** Fetch the seed-city set once and cache it. Idempotent + coalesced;
 *  silent on failure (leaves the atom null so a later call can retry). */
export function ensureSeedCitiesLoaded(): Promise<void> {
    if (seedCityIds.get() !== null) return Promise.resolve();
    if (inFlight) return inFlight;
    inFlight = (async () => {
        try {
            const resp = await fetch(SEED_CITIES_URL);
            if (!resp.ok) return;
            const data = (await resp.json()) as { ids?: number[] };
            const ids = Array.isArray(data.ids) ? data.ids : [];
            seedCityIds.set(new Set(ids.filter((n) => Number.isFinite(n))));
        } catch {
            /* leave null so a later mount can retry */
        } finally {
            inFlight = null;
        }
    })();
    return inFlight;
}

/** Whether an OSM relation id is a seed (major) city, given the loaded set
 *  (or null while it's still loading — treated as "unknown → not seed" so the
 *  search falls back to score-only ranking until the data lands). */
export function isSeedCity(
    osmId: number | null | undefined,
    set: Set<number> | null,
): boolean {
    return Boolean(set && osmId != null && set.has(osmId));
}
