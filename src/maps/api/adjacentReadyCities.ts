import { atom } from "nanostores";

import { ADJACENT_READY_CITIES_URL } from "./constants";

/**
 * "Adjacent-ready" city set (v699.1) — the relation ids the worker reports as
 * having their ADJACENT areas fully prewarmed (`adjacentsCuratedAt`: every
 * neighbour's boundary + references + hiding-zone stations present in R2). The
 * wizard offers the "add neighbouring area" picker ONLY for a primary in this
 * set, so a player can never fold in a cold adjacent that would drop them to
 * live Overpass mid-game.
 *
 * Orthogonal to the ⭐ star (`warmCityIds`, which is "the PRIMARY is warm"): a
 * city can be starred and fully playable while its adjacents are still warming,
 * in which case it just offers no extend option yet.
 *
 * `null` = not loaded yet (or the fetch failed and can retry). An empty Set =
 * loaded, nothing adjacent-ready. Small set, CDN/browser-cached endpoint.
 */
export const adjacentReadyIds = atom<Set<number> | null>(null);

let inFlight: Promise<void> | null = null;

/** Fetch the adjacent-ready set once and cache it. Idempotent + coalesced —
 *  concurrent callers share one request; a successful load is never
 *  re-fetched (the atom stays populated for the session). Silent on failure
 *  (leaves the atom null so a later call can retry). */
export function ensureAdjacentReadyLoaded(): Promise<void> {
    if (adjacentReadyIds.get() !== null) return Promise.resolve();
    if (inFlight) return inFlight;
    inFlight = (async () => {
        try {
            const resp = await fetch(ADJACENT_READY_CITIES_URL);
            if (!resp.ok) return;
            const data = (await resp.json()) as { ids?: number[] };
            const ids = Array.isArray(data.ids) ? data.ids : [];
            adjacentReadyIds.set(new Set(ids.filter((n) => Number.isFinite(n))));
        } catch {
            /* leave null so a later mount can retry */
        } finally {
            inFlight = null;
        }
    })();
    return inFlight;
}

/** Whether an OSM relation id has its adjacent areas prewarmed, given the
 *  loaded set (or null while it's still loading — treated as "unknown → not
 *  ready" so the extend UI is hidden until the data lands rather than
 *  offering a possibly-cold adjacent). */
export function isAdjacentReady(
    osmId: number | null | undefined,
    set: Set<number> | null,
): boolean {
    return Boolean(set && osmId != null && set.has(osmId));
}
