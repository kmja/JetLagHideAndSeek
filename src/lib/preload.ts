import { recordBytes, startMeter, stopMeter } from "@/lib/bandwidthMeter";
import {
    displayHidingZonesOptions,
    mapGeoLocation,
    polyGeoJSON,
    polyGeoJSONHydrated,
} from "@/lib/context";
import { devLog } from "@/lib/devLog";
import {
    allowedTransit,
    gameStartPosition,
} from "@/lib/gameSetup";
import {
    gameSize,
    HIDING_PERIOD_MINUTES,
    hidingPeriodEndsAt,
    playArea,
    preloadBucketBytes,
    preloadBucketInFlight,
    preloadBucketTimestamps,
    preloadChoices,
    preloadMapProgress,
    preloadPaused,
    preloadTransitProgress,
    type TransitPreloadStep,
} from "@/lib/gameSetup";
import { activeJourneyProvider } from "@/lib/journey/registry";
import type { JourneyStop } from "@/lib/journey/types";
import {
    clearTilePack,
    loadTilePackForPlayArea,
} from "@/lib/tilePack";
import { preloadTilesForPlayArea } from "@/lib/tilePreload";
import {
    findPlacesInZone,
    getOverpassData,
    overpassFailureCount,
} from "@/maps/api/overpass";
import {
    buildHsrQuery,
    getCachedCategory,
    hasAnyReferenceCached,
    prefetchCategory,
    prefetchFamiliesInOneQuery,
    STANDARD_REFERENCE_FAMILIES,
} from "@/maps/api/playAreaPrefetch";
import { fetchTransitRoutesFeatures } from "@/maps/api/transitRoutes";
import { CacheType } from "@/maps/api/types";

/**
 * v367: clear the preload "Downloaded" badges when the play area changes.
 *
 * `preloadBucketTimestamps` is a PERSISTENT atom (so "Downloaded" survives
 * a reload of the SAME area), but it was only ever reset by the full
 * new-game flow (roundActions.ts) — never when switching play areas. So a
 * new city inherited the previous city's green badges even though none of
 * its data had been fetched (the Bordeaux report: "settings say
 * downloaded when they clearly haven't").
 *
 * We track the play-area identity and wipe the badges on a real change.
 * The first observation (on load/reload) only RECORDS the identity — it
 * doesn't wipe — so a reload of the same area keeps its honest badges.
 * Deferred via queueMicrotask to stay clear of the maps/api import cycle
 * (see the v362 TDZ fix).
 */
function playAreaIdentity(): string | null {
    const id = mapGeoLocation.get()?.properties?.osm_id;
    if (id) return `r${id}`;
    const pa = playArea.get();
    return pa ? `${pa.lat.toFixed(4)},${pa.lng.toFixed(4)}` : null;
}
if (typeof window !== "undefined") {
    queueMicrotask(() => {
        let lastIdentity: string | null = playAreaIdentity();
        const sync = () => {
            const id = playAreaIdentity();
            if (id === lastIdentity) return;
            // Only wipe when moving BETWEEN two real areas — not on the
            // first resolve, and not when the area momentarily clears.
            if (lastIdentity !== null && id !== null) {
                preloadBucketTimestamps.set({
                    map: null,
                    references: null,
                    transit: null,
                });
                preloadBucketBytes.set({
                    map: null,
                    references: null,
                    transit: null,
                });
            }
            if (id !== null) lastIdentity = id;
        };
        mapGeoLocation.subscribe(sync);
        playArea.subscribe(sync);
    });
}

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
    // v931: a user STOP suppresses all (re)starts until they resume.
    if (preloadPaused.get()) return;
    const choices = preloadChoices.get();

    // Diagnostic (v220) for the cache-pill stall — dev-only so it
    // doesn't clutter the production console.
    devLog("[cache-pill] preloadDuringHidingPeriod fired", {
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
    if (preloadPaused.get()) return;
    if (bucket === "map") runMapPreload();
    else if (bucket === "references") runReferencesPreload();
    else if (bucket === "transit") runTransitPreload();
}

/**
 * User STOP (v931): halt the preload. Aborts the in-flight map download
 * (the heavy MB-scale transfer — it's the only abortable bucket) and sets
 * the persisted `preloadPaused` flag so the orchestrator + every auto-
 * trigger (lobby-open effect, GameStartWatcher, per-bucket re-runs) refuse
 * to start anything until `resumePreload()`. References/transit in flight
 * finish their (cheap, cache-keyed) current query; they just won't restart.
 */
export function stopPreload(): void {
    preloadPaused.set(true);
    if (mapAbort) {
        mapAbort.abort();
        mapAbort = null;
    }
    // Clear the map spinner/progress immediately so the UI reads "paused",
    // and drop the in-flight flag so a resume can restart the bucket.
    preloadMapProgress.set(null);
    preloadBucketInFlight.set({ ...preloadBucketInFlight.get(), map: false });
}

/**
 * User RESUME (v931): clear the pause and re-run the enabled buckets.
 * Completed work is a cache hit, and the map tile-walk skips tiles already
 * in the SW range cache, so resume CONTINUES rather than restarts.
 */
export function resumePreload(): void {
    preloadPaused.set(false);
    preloadDuringHidingPeriod();
}

/**
 * Bound a preload step so it always reaches a terminal state (v703). A
 * hung fetch — the transit relation-endpoint `fetch()` has no timeout, and
 * the live-Overpass fallback is a 190 s wait — otherwise left a step's
 * `await` pending forever, so the progress stuck at e.g. "5/6" and the
 * bucket stayed in-flight with no failure ever surfaced. On timeout the
 * race rejects, the caller's catch treats it as a failed step (no data,
 * no timestamp) and the loop moves on, so the bucket resolves to an honest
 * un-badged state the user can retry with "Load now".
 */
const PRELOAD_STEP_TIMEOUT_MS = 45_000;
function withPreloadTimeout<T>(p: Promise<T>, label: string): Promise<T> {
    return Promise.race([
        p,
        new Promise<T>((_, reject) =>
            setTimeout(
                () => reject(new Error(`preload step timed out: ${label}`)),
                PRELOAD_STEP_TIMEOUT_MS,
            ),
        ),
    ]);
}

// v931: the map bucket's abort controller, so `stopPreload()` can cancel
// the in-flight tile-pack / range-walk download (the heavy transfer).
let mapAbort: AbortController | null = null;

function runMapPreload(): void {
    // Idempotent — a second call while one is in flight just returns.
    if (preloadBucketInFlight.get().map) return;
    if (preloadPaused.get()) return;
    console.debug("[preload] warming basemap for play-area");
    preloadBucketInFlight.set({ ...preloadBucketInFlight.get(), map: true });
    mapAbort = new AbortController();
    const signal = mapAbort.signal;
    // Wire-byte accounting — CountingSource inside tilePreload calls
    // `recordBytes` on every range response; the pack path records the
    // single download total. Re-runs of an already-warm play area
    // mostly hit the browser HTTP cache, so the recorded total drops —
    // honest either way.
    startMeter("map");

    const finishBucket = () => {
        preloadBucketBytes.set({
            ...preloadBucketBytes.get(),
            map: stopMeter("map"),
        });
        preloadBucketTimestamps.set({
            ...preloadBucketTimestamps.get(),
            map: Date.now(),
        });
    };

    void (async () => {
        try {
            // v336: prefer a city tile pack. One download (a few to a
            // few tens of MB) instead of thousands of per-tile range
            // requests. loadTilePackForPlayArea returns "absent" /
            // "skipped" / "error" when there's no usable pack, and we
            // fall back to the original range-walk preload.
            const pack = await loadTilePackForPlayArea({
                signal,
                onProgress: (loaded, total) => {
                    preloadMapProgress.set({
                        phase: "pack",
                        bytesFetched: loaded,
                        packTotalBytes: total,
                        tilesDone: 0,
                        tilesTotal: 0,
                        currentZoom: 0,
                    });
                },
            });
            if (pack.status === "loaded") {
                if (pack.bytes) recordBytes(pack.bytes);
                console.debug(
                    `[preload] city pack active (osm ${pack.osmId}, ${pack.bytes} B)`,
                );
                preloadMapProgress.set(null);
                finishBucket();
                return;
            }
            if (signal.aborted) return; // stopped during the pack download
            // No usable pack — log WHY (absent 404 / skipped non-relation /
            // error) so a "why is it range-walking a starred city" report is
            // diagnosable from devtools instead of guesswork. `absent` = the
            // pack 404'd in R2 (operator gap / stale star / wrong relation
            // id); `skipped` = the play area isn't an OSM relation (a custom
            // polygon can't have a pack).
            console.warn(
                `[preload] no city tile pack (status=${pack.status}, osm=${pack.osmId ?? "?"}) — falling back to per-tile range walk`,
            );
            // No pack for this area — clear any stale one and warm via
            // the range walk exactly as before.
            clearTilePack();
            const result = await preloadTilesForPlayArea({ signal });
            if (signal.aborted) return; // stopped mid-walk — not complete
            console.debug("[preload] map tiles done (range walk)", result);
            finishBucket();
        } catch (e) {
            // A user STOP aborts the download — not a failure, and we must
            // NOT stamp a completion timestamp (so it reads resumable).
            if (signal.aborted) {
                stopMeter("map");
                return;
            }
            console.warn("[preload] map preload failed:", e);
            stopMeter("map");
            preloadMapProgress.set(null);
        } finally {
            if (mapAbort?.signal === signal) mapAbort = null;
            preloadBucketInFlight.set({
                ...preloadBucketInFlight.get(),
                map: false,
            });
        }
    })();
}

let referencesPreloadAwaitingBoundary = false;

function runReferencesPreload(): void {
    // v358: the reference query keys off the CANONICAL boundary-geometry
    // extent (referenceExtent → turf.bbox(polyGeoJSON)). The boundary
    // hydrates ASYNC from the Cache API; if we fire before it lands,
    // referenceExtent silently falls back to Photon's extent — a bbox
    // that differs in the 3rd decimal from what the laptop/cron warmed,
    // so every key misses and the request goes live to Overpass (the
    // Frankfurt-v357 symptom: a Photon-keyed bbox identical to the broken
    // pre-fix run). Wait for hydration before warming. If hydration lands
    // with no boundary (a Photon-only play area), proceed anyway — the
    // Photon fallback is then the only and correct source.
    if (!polyGeoJSON.get() && !polyGeoJSONHydrated.get()) {
        if (referencesPreloadAwaitingBoundary) return; // already queued
        referencesPreloadAwaitingBoundary = true;
        const unsub = polyGeoJSONHydrated.subscribe((hydrated) => {
            if (!hydrated) return;
            unsub();
            referencesPreloadAwaitingBoundary = false;
            runReferencesPreload();
        });
        return;
    }
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
    void withPreloadTimeout(
        prefetchFamiliesInOneQuery(STANDARD_REFERENCE_FAMILIES),
        "references",
    )
        .catch(() => {
            // Timed out / failed — fall through to the .then so the bucket
            // resolves (badge stays off if nothing cached) instead of hanging.
        })
        .then(() => {
            preloadBucketBytes.set({
                ...preloadBucketBytes.get(),
                references: stopMeter("references"),
            });
            // v367: only mark "Downloaded" if the prefetch actually landed
            // data. prefetchFamiliesInOneQuery resolves even on total
            // failure (it swallows its own errors), so the unconditional
            // timestamp showed "Downloaded" for a city whose references
            // all failed (Bordeaux, Overpass down).
            if (hasAnyReferenceCached(STANDARD_REFERENCE_FAMILIES)) {
                preloadBucketTimestamps.set({
                    ...preloadBucketTimestamps.get(),
                    references: Date.now(),
                });
            }
            // Serialize the hiding-zone overlay warm AFTER the families
            // land (one Overpass query at a time keeps us off the rate
            // limit).
            warmHidingZoneQuery();
        })
        .finally(() => {
            preloadBucketInFlight.set({
                ...preloadBucketInFlight.get(),
                references: false,
            });
        });
}

/**
 * Warm the exact Overpass query the Zone Sidebar runs when the seeker
 * first toggles the hiding-zone overlay, so that first toggle is a cache
 * hit instead of a live round-trip.
 *
 * A SINGLE station option already rides `findPlacesInZone`'s warm
 * per-family fast path (covered by the references prefetch above). But
 * when several transit modes are allowed, `displayHidingZonesOptions`
 * holds MULTIPLE filters, and the overlay passes the extras as
 * `alternatives` — which bypasses the fast path and runs a cold
 * `poly:`-shaped query that nothing else warms. That's the slow first
 * load. Warming it here (same args as `ZoneSidebar`) populates the cache.
 */
function warmHidingZoneQuery(): void {
    const opts = displayHidingZonesOptions.get();
    if (!opts || opts.length < 2) return; // single option → already warm
    void findPlacesInZone(
        opts[0],
        undefined,
        "nwr",
        "center",
        opts.slice(1),
        0,
        true, // silent — background warm, no failure toast
    ).catch(() => {
        /* best-effort; the live toggle will still fetch if this missed */
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
    // v583: warm ONLY the modes this game actually allows. Warming all
    // five regardless (the old behaviour) fired Overpass queries for modes
    // the player can't even use — wasted requests that helped trip the
    // per-IP rate limit. `allowedTransit` is the game's enabled set;
    // intersect it with the route-mode universe (stable order). Empty
    // (shouldn't happen) falls back to all five.
    const ALL_MODES = ["subway", "bus", "ferry", "train", "tram"] as const;
    const allowed = allowedTransit.get();
    const modes =
        allowed.length > 0
            ? ALL_MODES.filter((m) => allowed.includes(m))
            : [...ALL_MODES];
    // `steps` is the broader TransitPreloadStep set the UI tracks (route
    // modes + hsr).
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

    // v367: track whether ANY transit query actually returned data, so a
    // total failure (Overpass down) doesn't mark the bucket "Downloaded".
    // v583: also snapshot the Overpass failure counter. A city like Oslo
    // has its subway/ferry shards cron-prewarmed but NOT bus/train/tram,
    // so those modes go LIVE during preload and can be rate-limited —
    // returning an empty result indistinguishable from a genuinely
    // transit-less mode. If any warm hit the rate-limit/outage path we
    // must NOT claim the bucket is cached: otherwise the panel says
    // "Downloaded", the user toggles that overlay, it goes to Overpass
    // live, and they hit the very rate-limit errors this guards against.
    let anyTransitData = false;
    const failuresBefore = overpassFailureCount();

    // Serialize the warms. Firing five heavy `relation[route];out skel
    // geom` queries in parallel against one Overpass instance is itself a
    // reliable way to get rate-limited; one at a time lets each either hit
    // R2 fast or make a single live request the mirrors tolerate. Silent
    // throughout — a background warm must not splatter error toasts; the
    // failure is reported honestly via the bucket badge instead.
    void (async () => {
        if (hsrQuery) {
            try {
                const d = await withPreloadTimeout(
                    getOverpassData(
                        hsrQuery,
                        undefined,
                        CacheType.ZONE_CACHE,
                        undefined,
                        false,
                        undefined,
                        true,
                    ),
                    "hsr",
                );
                if (
                    d &&
                    Array.isArray((d as { elements?: unknown[] }).elements) &&
                    (d as { elements: unknown[] }).elements.length > 0
                ) {
                    anyTransitData = true;
                }
            } catch {
                /* swallow — surfaced via the badge gate below */
            } finally {
                markDone("hsr");
            }
        }

        for (const mode of modes) {
            try {
                const fc = await withPreloadTimeout(
                    fetchTransitRoutesFeatures(mode, true),
                    mode,
                );
                if (fc?.features && fc.features.length > 0) {
                    anyTransitData = true;
                }
            } catch {
                /* swallow — timeout or fetch error; badge stays honest */
            } finally {
                markDone(mode);
            }
        }

        preloadBucketBytes.set({
            ...preloadBucketBytes.get(),
            transit: stopMeter("transit"),
        });
        // Badge "Downloaded" only when a warm landed data AND no warm hit
        // the rate-limit/outage path. A genuinely transit-less area
        // honestly stays un-badged; a partially-warmed city (Oslo:
        // subway/ferry cached, bus/train/tram rate-limited) also stays
        // un-badged so the panel never promises data that isn't cached.
        const rateLimited = overpassFailureCount() > failuresBefore;
        if (anyTransitData && !rateLimited) {
            preloadBucketTimestamps.set({
                ...preloadBucketTimestamps.get(),
                transit: Date.now(),
            });
        }
        preloadBucketInFlight.set({
            ...preloadBucketInFlight.get(),
            transit: false,
        });
        preloadTransitProgress.set(null);
    })();

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
