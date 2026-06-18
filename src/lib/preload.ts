import { startMeter, stopMeter } from "@/lib/bandwidthMeter";
import { gameStartPosition } from "@/lib/gameSetup";
import {
    gameSize,
    HIDING_PERIOD_MINUTES,
    hidingPeriodEndsAt,
    playArea,
    preloadBucketBytes,
    preloadBucketInFlight,
    preloadBucketTimestamps,
    preloadChoices,
    preloadTransitProgress,
    type TransitPreloadStep,
} from "@/lib/gameSetup";
import { activeJourneyProvider } from "@/lib/journey/registry";
import type { JourneyStop } from "@/lib/journey/types";
import { preloadTilesForPlayArea } from "@/lib/tilePreload";
import { getOverpassData } from "@/maps/api/overpass";
import {
    buildHsrQuery,
    getCachedCategory,
    prefetchCategory,
    prefetchFamiliesInOneQuery,
    STANDARD_REFERENCE_FAMILIES,
} from "@/maps/api/playAreaPrefetch";
import { fetchTransitRoutesFeatures } from "@/maps/api/transitRoutes";
import { CacheType } from "@/maps/api/types";

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
 *   - The play-area boundary polygon: already loaded by Map.tsx the
 *     moment the play area is chosen, well before the hiding period.
 *   - Major city / coastline: resolved from bundled datasets, no
 *     Overpass at all.
 *
 * The "map" bucket DOES fire here (v262): it walks every basemap tile
 * inside the play-area bbox at z11..z15 and pulls the PMTiles range
 * for each into the browser HTTP cache. Without this, the user only
 * has tiles at whatever zoom they happened to be at; the first zoom-in
 * after the hiding period kicks off a fresh cascade of range fetches
 * and the map noticeably lags. See `tilePreload.ts`.
 *
 * Best-effort and silent: never toasts, never throws. The on-tap
 * `prefetchCategory` fallback still covers any family this misses, and
 * the map's own on-demand tile fetch still covers any preload misses.
 */
export function preloadDuringHidingPeriod(): void {
    if (!playArea.get()) return;
    const choices = preloadChoices.get();

    // Diagnostic (v220) for the cache-pill stall.
    console.warn("[cache-pill] preloadDuringHidingPeriod fired", {
        playArea: playArea.get(),
        size: gameSize.get(),
        choices,
        at: new Date().toISOString(),
    });

    // v236: each bucket is gated on the user's preloadChoices. A
    // disabled bucket is silently skipped — the lazy on-tap fetch
    // still covers it later, and the user can also flip the toggle
    // back on from Settings mid-game to trigger `runPreloadForBucket`
    // explicitly.
    if (choices.map) runMapPreload();
    if (choices.references) runReferencesPreload();
    if (choices.transit) runTransitPreload();
}

/**
 * Trigger a single bucket on demand — e.g. from the Settings UI when
 * the user un-deferred a bucket mid-game. Safe to call any time;
 * each bucket internally dedupes against in-flight + cached state.
 */
export function runPreloadForBucket(
    bucket: "map" | "references" | "transit",
): void {
    if (!playArea.get()) return;
    if (bucket === "map") runMapPreload();
    else if (bucket === "references") runReferencesPreload();
    else if (bucket === "transit") runTransitPreload();
}

function runMapPreload(): void {
    // Idempotent — a second call while one is in flight just returns.
    if (preloadBucketInFlight.get().map) return;
    console.debug("[preload] warming basemap tiles for play-area bbox");
    preloadBucketInFlight.set({ ...preloadBucketInFlight.get(), map: true });
    // Wire-byte accounting — CountingSource inside tilePreload calls
    // `recordBytes` on every range response. Re-runs of an already-warm
    // play area will mostly hit the browser HTTP cache, so the
    // recorded total drops to ~the directory size — honest.
    startMeter("map");
    void preloadTilesForPlayArea()
        .then((result) => {
            console.debug("[preload] map tiles done", result);
            preloadBucketBytes.set({
                ...preloadBucketBytes.get(),
                map: stopMeter("map"),
            });
            preloadBucketTimestamps.set({
                ...preloadBucketTimestamps.get(),
                map: Date.now(),
            });
        })
        .catch((e) => {
            console.warn("[preload] map tiles failed:", e);
            stopMeter("map");
        })
        .finally(() => {
            preloadBucketInFlight.set({
                ...preloadBucketInFlight.get(),
                map: false,
            });
        });
}

function runReferencesPreload(): void {
    // Question references — one combined query for the canonical
    // family set, which BOTH this preload and the worker cron use.
    // They produce the same query string → same R2 key → if the cron
    // warmed this city, the client gets a cache hit here and skips
    // the Overpass round-trip entirely. The list is the same
    // regardless of game size; a large game can't ask the -full
    // subtypes but warming them anyway is one extra response field,
    // not a separate request.
    console.debug(
        `[preload] warming ${STANDARD_REFERENCE_FAMILIES.length} reference families in one query`,
    );
    preloadBucketInFlight.set({ ...preloadBucketInFlight.get(), references: true });
    // Wire-byte accounting via cacheFetch instrumentation. Cache hits
    // contribute zero bytes — accurate "data the user actually downloaded".
    startMeter("references");
    void prefetchFamiliesInOneQuery(STANDARD_REFERENCE_FAMILIES)
        .then(() => {
            preloadBucketBytes.set({
                ...preloadBucketBytes.get(),
                references: stopMeter("references"),
            });
            preloadBucketTimestamps.set({
                ...preloadBucketTimestamps.get(),
                references: Date.now(),
            });
        })
        .finally(() => {
            preloadBucketInFlight.set({
                ...preloadBucketInFlight.get(),
                references: false,
            });
        });
}

function runTransitPreload(): void {
    const size = gameSize.get();
    preloadBucketInFlight.set({ ...preloadBucketInFlight.get(), transit: true });

    // Wire-byte accounting via cacheFetch instrumentation — see
    // bandwidthMeter.ts. Cache hits don't count, so a repeat preload
    // of an already-warmed play area honestly reports 0 bytes.
    startMeter("transit");

    // v335: per-step progress detail. We track each route mode + the
    // HSR query as a distinct step so the panel can show "Subway,
    // Bus…" instead of just "Downloading…". v334 fix: train + tram
    // are full first-class overlays now, so they belong in the
    // preload list too.
    const hsrQuery = size !== "large" ? buildHsrQuery() : null;
    // `modes` is typed for fetchTransitRoutesFeatures (route-mode
    // subset); `steps` is the broader TransitPreloadStep set the
    // UI tracks (route modes + hsr + arrivals).
    const modes = ["subway", "bus", "ferry", "train", "tram"] as const;
    const steps: TransitPreloadStep[] = hsrQuery
        ? ["hsr", ...modes]
        : [...modes];
    preloadTransitProgress.set({ active: [...steps], done: [], total: steps.length });
    const markDone = (step: TransitPreloadStep) => {
        const curr = preloadTransitProgress.get();
        if (!curr) return;
        preloadTransitProgress.set({
            ...curr,
            active: curr.active.filter((s) => s !== step),
            done: [...curr.done, step],
        });
    };

    const transitPromises: Promise<unknown>[] = [];

    if (hsrQuery) {
        transitPromises.push(
            getOverpassData(
                hsrQuery,
                undefined,
                CacheType.ZONE_CACHE,
                undefined,
                false,
                undefined,
                true,
            )
                .catch(() => {})
                .finally(() => markDone("hsr")),
        );
    }

    for (const mode of modes) {
        transitPromises.push(
            fetchTransitRoutesFeatures(mode)
                .catch(() => {})
                .finally(() => markDone(mode)),
        );
    }

    void Promise.allSettled(transitPromises).then(() => {
        preloadBucketBytes.set({
            ...preloadBucketBytes.get(),
            transit: stopMeter("transit"),
        });
        preloadBucketTimestamps.set({
            ...preloadBucketTimestamps.get(),
            transit: Date.now(),
        });
        preloadBucketInFlight.set({
            ...preloadBucketInFlight.get(),
            transit: false,
        });
        preloadTransitProgress.set(null);
    });

    // Transit arrival times — the Travel Times overlay. We can't fire
    // this synchronously because it needs (a) the station list, which
    // gets warmed by the references bucket, and (b) the seeker's GPS,
    // which GameStartWatcher captures asynchronously a fraction of a
    // second after this function runs. So spin up a one-shot
    // scheduler that polls both inputs and fires the fetch the moment
    // they're both ready. Caches in the journey worker's R2 (per-stop,
    // per 5-min depart bucket) so toggling the overlay on mid-game is
    // instant.
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
        // Surface "Arrivals…" in the bucket UI for the duration of
        // this last warm-up pass. The transit bucket's main fetch
        // promise has already settled by this point, but the
        // top-level inFlight stays true while arrivals are
        // outstanding — see preloadDuringHidingPeriod's wait wiring.
        const curr = preloadTransitProgress.get();
        if (curr) {
            preloadTransitProgress.set({
                ...curr,
                active: [...curr.active, "arrivals"],
                total: curr.total + 1,
            });
        }
        provider
            .fetchArrivals(anchor, stations)
            .catch(() => {
                /* journey proxy failure is fine — the overlay's
                   own fetch will retry on demand */
            })
            .finally(() => {
                transitScheduled = false;
                const c = preloadTransitProgress.get();
                if (c) {
                    preloadTransitProgress.set({
                        ...c,
                        active: c.active.filter((s) => s !== "arrivals"),
                        done: [...c.done, "arrivals"],
                    });
                }
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
