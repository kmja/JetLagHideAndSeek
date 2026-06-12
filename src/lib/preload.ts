import { gameStartPosition } from "@/lib/gameSetup";
import {
    gameSize,
    HIDING_PERIOD_MINUTES,
    hidingPeriodEndsAt,
    playArea,
} from "@/lib/gameSetup";
import { activeJourneyProvider } from "@/lib/journey/registry";
import type { JourneyStop } from "@/lib/journey/types";
import { getSubtypes } from "@/lib/subtypes";
import { findPlacesInZone } from "@/maps/api/overpass";
import {
    cacheableFamilyForType,
    type FamilyKey,
    getCachedCategory,
    prefetchCategory,
    prefetchFamiliesInOneQuery,
} from "@/maps/api/playAreaPrefetch";

/**
 * Single hiding-period preload orchestrator.
 *
 * Fires once, on the seeker's device, the moment the hiding period
 * starts (GameStartWatcher) — the ideal window, since seekers can't
 * ask anything yet. Its whole job is to make sure that when the chase
 * begins, every question reference the seeker might need is already
 * sitting in memory, so no question ever shows a spinner or a "could
 * not load Overpass" banner mid-game.
 *
 * Consolidation note (v183): this used to be a fan-out of ~14
 * separate `findPlacesInZone` calls run two-at-a-time, which is what
 * tripped the public mirrors' per-IP rate limit and produced the
 * cascade of failure toasts. It is now ONE combined Overpass query
 * for every `out center` reference family (museums, zoos, hospitals,
 * airports, train stations, brand shops, ...), partitioned back into
 * the per-family caches client-side. High-speed rail is the only
 * straggler — it needs `out geom` rather than `out center`, so it
 * rides a second (small) query.
 *
 * What is deliberately NOT here:
 *   - The play-area boundary + tiles: already loaded by Map.tsx the
 *     moment the play area is chosen, well before the hiding period.
 *   - Major city / coastline: resolved from bundled datasets, no
 *     Overpass at all.
 *
 * Best-effort and silent: never toasts, never throws. The on-tap
 * `prefetchCategory` fallback still covers any family this misses.
 */
export function preloadDuringHidingPeriod(): void {
    if (!playArea.get()) return;
    const size = gameSize.get();

    // 1. Question references — one combined query for everything the
    //    matching/measuring picker can actually offer at this size.
    //    Routes through findPlacesInZone → getOverpassData → primary
    //    URL = jlhs-overpass-cache worker, so the response body
    //    lands in R2 once and every later seeker hits cache.
    const families = referenceFamiliesForSize(size);
    if (families.length > 0) {
        console.debug(
            `[preload] warming ${families.length} reference families in one query`,
        );
        void prefetchFamiliesInOneQuery(families);
    }

    // 2. High-speed rail — separate, since it needs out:geom. Small/
    //    medium only per rulebook. Silent + best-effort. Same R2
    //    write-back path as above.
    if (size !== "large") {
        void findPlacesInZone(
            "[highspeed=yes]",
            undefined,
            "nwr",
            "geom",
            [],
            0,
            true,
        ).catch(() => {});
    }

    // 3. Transit arrival times — the Travel Times overlay. We can't
    //    fire this synchronously because it needs (a) the station
    //    list, which gets warmed by step 1, and (b) the seeker's
    //    GPS, which GameStartWatcher captures asynchronously a
    //    fraction of a second after this function runs. So spin up
    //    a one-shot scheduler that polls both inputs and fires the
    //    fetch the moment they're both ready. Caches in the journey
    //    worker's R2 (per-stop, per 5-min depart bucket) so toggling
    //    the overlay on mid-game is instant.
    scheduleTransitPreload();
}

let transitScheduled = false;

function scheduleTransitPreload(): void {
    if (transitScheduled) return;
    transitScheduled = true;

    const startedAt = Date.now();
    const TIMEOUT_MS = 60_000; // give the rail-station prefetch + GPS up to a minute

    const tick = () => {
        if (Date.now() - startedAt > TIMEOUT_MS) {
            transitScheduled = false;
            return;
        }

        const provider = activeJourneyProvider();
        if (!provider) {
            // No journey provider configured — nothing to warm.
            transitScheduled = false;
            return;
        }

        const startPos = gameStartPosition.get();
        const endsAt = hidingPeriodEndsAt.get();
        if (!startPos || !endsAt) {
            window.setTimeout(tick, 1000);
            return;
        }

        const stations = stationStopsFromCache();
        if (stations.length === 0) {
            // Either the rail-station prefetch hasn't landed yet or
            // it failed. Nudge a per-family retry once and re-poll.
            void prefetchCategory("rail-station").catch(() => {});
            window.setTimeout(tick, 1000);
            return;
        }

        const size = gameSize.get();
        const hidingStartAt = endsAt - HIDING_PERIOD_MINUTES[size] * 60_000;
        const anchor = {
            lat: startPos.lat,
            lng: startPos.lng,
            departAt: hidingStartAt,
        };

        console.debug(
            `[preload] warming transit arrivals for ${stations.length} stations`,
        );
        provider
            .fetchArrivals(anchor, stations)
            .catch(() => {
                /* journey proxy failure is fine — the overlay's
                   own fetch will retry on demand */
            })
            .finally(() => {
                transitScheduled = false;
            });
    };

    tick();
}

/** Lift the warmed `rail-station` cache into the `JourneyStop` shape
 *  the journey provider expects. The id is just the rounded lat,lng
 *  pair — the journey worker's R2 cache keys on rounded coords so
 *  there's no station-id mismatch between the preload and the
 *  on-toggle overlay fetch. */
function stationStopsFromCache(): JourneyStop[] {
    const features = getCachedCategory("rail-station");
    if (!features) return [];
    return features.map((f) => ({
        id: `${f.lat.toFixed(5)},${f.lng.toFixed(5)}`,
        name: f.name,
        lat: f.lat,
        lng: f.lng,
    }));
}

/** Backwards-compatible alias for the old export name. */
export const preloadCommonQuestionData = preloadDuringHidingPeriod;

/**
 * The set of cacheable reference families the picker can offer at the
 * given game size — derived straight from `getSubtypes`, so we only
 * ever warm what's actually askable (e.g. the -full subtypes for
 * small/medium, the base set for large). City / coastline / high-
 * speed-rail map to null here and are handled elsewhere.
 */
function referenceFamiliesForSize(size: ReturnType<typeof gameSize.get>): FamilyKey[] {
    const set = new Set<FamilyKey>();
    for (const cat of ["matching", "measuring"] as const) {
        for (const s of getSubtypes(cat, size) ?? []) {
            const fam = cacheableFamilyForType(s.value);
            if (fam) set.add(fam);
        }
    }
    return [...set];
}

/**
 * Whether a hiding period is currently active (for the hooking site
 * in GameStartWatcher).
 */
export function isHidingPeriodActive(): boolean {
    const endsAt = hidingPeriodEndsAt.get();
    if (endsAt === null) return false;
    return endsAt - Date.now() > 0;
}

/**
 * How long the active hiding period has left (ms), or 0 if none.
 * Capped at HIDING_PERIOD_MINUTES so a wonky clock can't return
 * something silly.
 */
export function hidingPeriodRemainingMs(): number {
    const endsAt = hidingPeriodEndsAt.get();
    if (endsAt === null) return 0;
    const remaining = endsAt - Date.now();
    if (remaining <= 0) return 0;
    const cap = HIDING_PERIOD_MINUTES[gameSize.get()] * 60_000;
    return Math.min(remaining, cap);
}
