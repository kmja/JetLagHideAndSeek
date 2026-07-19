import * as turf from "@turf/turf";
import type { FeatureCollection, MultiPolygon } from "geojson";
import uniq from "lodash/uniq";
import osmtogeojson from "osmtogeojson";
import { toast } from "react-toastify";

import {
    additionalMapGeoLocations,
    mapGeoLocation,
    polyGeoJSON,
} from "@/lib/context";
import { devLog, devWarn } from "@/lib/devLog";
import { combineBoundary } from "@/lib/geometry/client";
import { playArea } from "@/lib/gameSetup";
import {
    finishLoading,
    setPhase,
    startLoading,
} from "@/lib/loadingProgress";

import { fetchPrewarmedAreaAdmin } from "./adminBoundary";
import {
    cacheFetch,
    determineCache,
    responseFromBuffer,
    safeJsonFromCachedResponse,
} from "./cache";
import {
    LOCATION_FIRST_TAG,
    OVERPASS_API,
    OVERPASS_API_FALLBACK,
    OVERPASS_API_QUATERNARY,
    OVERPASS_API_TERTIARY,
    TRANSIT_ROUTES_BY_RELATION_BASE,
} from "./constants";
import {
    isAbortedOverpassJson,
    sniffAbortedOverpassBytes,
} from "./overpassAbort";
import {
    cacheableFamilyForType,
    familyForFilter,
    findCachedPlaces,
    pointInsideCacheCoverage,
    prefetchCategory,
} from "./playAreaPrefetch";
import {
    extractBoundaryRelationId,
    fetchBoundaryAsOverpassShape,
} from "./polygonsOsmFr";
import type {
    EncompassingTentacleQuestionSchema,
    HomeGameMatchingQuestions,
    HomeGameMeasuringQuestions,
    QuestionSpecificLocation,
} from "./types";
import { CacheType } from "./types";

/**
 * Monotonic counter of "all mirrors timed out or rate-limited" events —
 * i.e. every time `getOverpassData` falls through every tier and returns
 * an empty result because nothing answered (the rate-limit / outage path,
 * NOT a query that legitimately matched zero elements).
 *
 * Background callers that need to know whether a warm actually succeeded
 * (the transit preload, which can't otherwise distinguish a rate-limited
 * empty from a genuinely transit-less mode) snapshot this before/after and
 * treat an increase as "the warm failed — don't claim it's cached".
 */
let _overpassFailureCount = 0;
export const overpassFailureCount = (): number => _overpassFailureCount;


export const getOverpassData = async (
    query: string,
    loadingText?: string,
    cacheType: CacheType = CacheType.CACHE,
    /** Per-mirror fetch timeout in ms. Defaults to whatever
     *  `cacheFetch` uses (25 s at time of writing). Pass higher
     *  for queries with long server-side timeouts. */
    fetchTimeoutMs?: number,
    /** When true, the network read streams through the global
     *  loadingProgress atom so the LoadingOverlay can show byte
     *  counts. The caller still owns startLoading/finishLoading. */
    reportProgress: boolean = false,
    /** User-visible label for THIS query's piece row in the loading
     *  overlay. */
    progressLabel?: string,
    /** When true, the "Could not load data from Overpass" toast is
     *  suppressed on total mirror failure. Background callers
     *  (preload pass, lazy prefetch on first matching/measuring tap)
     *  pass this so a fully-rate-limited R2 cache worker doesn't
     *  splatter a dozen identical toasts at the user during the
     *  hiding period. */
    silent: boolean = false,
) => {
    const encodedQuery = encodeURIComponent(query);
    const primaryUrl = `${OVERPASS_API}?data=${encodedQuery}`;
    const fallbackUrl = `${OVERPASS_API_FALLBACK}?data=${encodedQuery}`;
    const tertiaryUrl = `${OVERPASS_API_TERTIARY}?data=${encodedQuery}`;
    const quaternaryUrl = `${OVERPASS_API_QUATERNARY}?data=${encodedQuery}`;

    // v349: cache-first short-circuit. If our own cache already holds
    // this query's response, serve it and fire NOTHING external — not
    // the polygons.openstreetmap.fr boundary fast-path below, not the
    // public Overpass mirrors. This is the common case for a play area
    // that's been loaded before on this device (or that the cron/laptop
    // prewarmed into R2 and the worker leg has since cached locally),
    // and it's what stops a re-opened game from re-hitting
    // polygons.osm.fr just to redraw a boundary it already has. On any
    // cache miss / Cache-API hiccup we fall through to the normal race.
    try {
        const cache = await determineCache(cacheType);
        const hit = await cache.match(primaryUrl);
        if (hit && hit.ok) {
            // Use the gzip-sniffing safe parser — heals any cache entry
            // a previous build poisoned with raw gzip bytes.
            const parsed = await safeJsonFromCachedResponse(hit.clone());
            // v667: self-heal an aborted-body entry (an Overpass soft
            // timeout a pre-fix build cached as a success) — purge it
            // and fall through to the live race.
            if (!isAbortedOverpassJson(parsed)) return parsed;
            devWarn(
                "[overpass] cached body carries an Overpass abort remark — purging + refetching",
            );
            await cache.delete(primaryUrl);
        }
    } catch {
        /* Cache API unavailable (private mode / iOS quirk) — race. */
    }

    // Fast-path racer: if this is a simple relation-boundary
    // fetch (the heavy hitter for play-area loading), also race
    // polygons.openstreetmap.fr in parallel. Their pre-computed
    // polygons return in 1-5 s even for monsters like Shanghai
    // / Tokyo that bring Overpass to its knees AND blow past
    // the per-IP rate limit. Returns null silently if the
    // relation isn't a boundary or the query is anything more
    // complex; in that case only the four Overpass mirrors race.
    const fastPathRelationId = extractBoundaryRelationId(query);

    // Wrap a cacheFetch in a Promise that resolves to either a
    // successful Response or null. Never throws. Each branch
    // logs to console so DevTools shows which mirror beat or
    // failed which — invaluable when 'all mirrors timed out'
    // and the user needs to know if it's their network, their
    // Cloudflare worker, or the public mirrors that are sad.
    const tryFetch = async (
        url: string,
        signal?: AbortSignal,
    ): Promise<Response | null> => {
        const t0 = Date.now();
        const shortName = url.replace(/^https?:\/\//, "").split("/")[0];
        try {
            const r = await cacheFetch(
                url,
                loadingText,
                cacheType,
                fetchTimeoutMs,
                reportProgress,
                progressLabel,
                signal,
            );
            const ms = Date.now() - t0;
            if (r && r.ok) {
                // v667: a 200 body can still be an Overpass soft failure
                // (abort `remark` + empty/truncated elements). Sniff it
                // INSIDE the race so an aborted body counts as a
                // per-mirror miss and the race falls over to the next
                // tier (e.g. a poisoned worker cache entry loses to a
                // healthy public mirror). Purge any cached copy so
                // retries refetch instead of re-serving the poison.
                const bytes = new Uint8Array(await r.arrayBuffer());
                if (sniffAbortedOverpassBytes(bytes)) {
                    devWarn(
                        `[overpass] ${shortName} returned an aborted body (remark) (${ms}ms) — treating as a miss`,
                    );
                    try {
                        const cache = await determineCache(cacheType);
                        await cache.delete(url);
                    } catch {
                        /* no-op */
                    }
                    return null;
                }
                devLog(`[overpass] ${shortName} OK (${ms}ms)`);
                return responseFromBuffer(bytes, r);
            }
            // Per-attempt non-OK in a multi-mirror race is expected (a
            // mirror 502s, we fall through to the next). Dev-only so the
            // production console isn't flooded with fallback breadcrumbs.
            devWarn(
                `[overpass] ${shortName} returned`,
                r ? `${r.status} ${r.statusText}` : "no response",
                `(${ms}ms)`,
            );
            return null;
        } catch (e) {
            const ms = Date.now() - t0;
            // Aborts are expected and noisy: every mirror race cancels
            // its losers, and slow mirrors hit the fetch timeout. Neither
            // a cancelled loser nor a single mirror failing is a
            // user-facing error (another mirror still wins), so all
            // per-attempt throws are dev-only breadcrumbs.
            devWarn(
                `[overpass] ${shortName} threw (${ms}ms):`,
                e instanceof Error ? e.message : e,
            );
            return null;
        }
    };

    // Race all three mirrors in parallel. First 200-OK wins. The
    // previous strategy was strictly serial — wait for primary to
    // time out (45 s on big boundaries) before even kicking off
    // the fallback. With three mirrors that's up to 135 s for the
    // user to see "Fetching boundary…" with no progress before
    // anything happens. Worse, an unresponsive primary mirror
    // (e.g. our R2 cache worker if it's mid-deploy or
    // mis-configured) consumed the FULL primary timeout every
    // time, dominating the wall clock even when the public mirrors
    // would respond in 2 seconds.
    //
    // Racing means the fastest healthy mirror sets the user-
    // visible response time, and a broken primary doesn't stall
    // the whole flow. Cost: we briefly hold three concurrent
    // upstream connections per query. Overpass mirrors don't
    // mind being asked nicely, and we only race for boundary
    // fetches that the user is actively waiting on.
    // Build the racers. Each is a thunk that resolves to a
    // Response (or null on failure). The Overpass racers go
    // through cacheFetch (cache-aware, timeout-managed); the
    // polygons.osm.fr racer wraps its JSON in a Response so the
    // downstream code path doesn't care which mirror won.
    type Racer = {
        name: string;
        run: (signal: AbortSignal) => Promise<Response | null>;
    };
    const hostOf = (url: string) =>
        url.replace(/^https?:\/\//, "").split("/")[0];

    // Tier 1 — our own R2-backed cache worker. Starts immediately. On
    // a prewarmed / previously-fetched boundary this returns from R2
    // in a few hundred ms, before tier 1.5 even starts — so the
    // external polygons.osm.fr request is never made.
    const tier1: Racer[] = [
        {
            name: hostOf(primaryUrl),
            run: (signal) => tryFetch(primaryUrl, signal),
        },
    ];

    // Tier 1.5 — polygons.openstreetmap.fr's pre-computed polygons.
    // v349: moved out of the immediate race and behind a short stagger
    // so it ONLY fires when the worker hasn't answered quickly (a cold
    // / un-prewarmed boundary). It's still the fast path for monster
    // relations (Shanghai / Tokyo) where Overpass crawls — but for the
    // common cached case the worker wins first and this never runs,
    // keeping the request off an external service per the
    // self-hosted-first principle. Only added for boundary queries.
    const midTier: Racer[] = [];
    if (fastPathRelationId !== null) {
        midTier.push({
            name: "polygons.osm.fr",
            // Signal unused: this racer fetches a small pre-computed JSON
            // polygon, not a multi-MB body, so cancelling it saves nothing
            // worth threading a signal into the separate module for.
            run: async () => {
                const t0 = Date.now();
                const json = await fetchBoundaryAsOverpassShape(
                    fastPathRelationId,
                );
                const ms = Date.now() - t0;
                if (!json) {
                    devWarn(`[overpass] polygons.osm.fr no-data (${ms}ms)`);
                    return null;
                }
                devLog(`[overpass] polygons.osm.fr OK (${ms}ms)`);
                return new Response(JSON.stringify(json), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            },
        });
    }

    // Tier 2 — the public Overpass mirrors, held back behind a longer
    // stagger. They only kick in when the worker AND the polygon fast-
    // path have failed or been slow, so a healthy cache hit never
    // touches them and the per-IP rate limit isn't tripped.
    const tier2: Racer[] = [fallbackUrl, tertiaryUrl, quaternaryUrl].map(
        (url) => ({
            name: hostOf(url),
            run: (signal) => tryFetch(url, signal),
        }),
    );

    const winner = await raceWithStaggeredFallback([
        { racers: tier1, afterMs: 0 },
        ...(midTier.length > 0
            ? [{ racers: midTier, afterMs: POLYGON_FAST_PATH_STAGGER_MS }]
            : []),
        { racers: tier2, afterMs: PUBLIC_MIRROR_STAGGER_MS },
    ]);

    if (winner) {
        // Best-effort: warm the cache key for the primary URL so
        // a subsequent identical fetch shortcuts even if the
        // winning mirror wasn't primary.
        try {
            const cache = await determineCache(cacheType);
            // Strip Content-Encoding/Length defensively before
            // caching — the same poisoning trap that bit responses
            // coming back through cacheFetch can bite this code path
            // if `winner` ever ends up with a stale encoding header.
            const cloned = winner.clone();
            const safeHeaders = new Headers(cloned.headers);
            safeHeaders.delete("Content-Encoding");
            safeHeaders.delete("Content-Length");
            const body = new Uint8Array(await cloned.arrayBuffer());
            await cache.put(
                primaryUrl,
                new Response(body.slice().buffer, {
                    status: cloned.status,
                    statusText: cloned.statusText,
                    headers: safeHeaders,
                }),
            );
        } catch {
            /* no-op */
        }
        // v351: a "winning" 200 can still carry a non-JSON body — e.g.
        // a Cloudflare error page that slipped through as 200, or a
        // truncated/garbled gzip. Parsing must NOT throw out of here:
        // callers like the transit overlay would crash with
        // "JSON.parse: unexpected character at line 1 column 1". Treat
        // a parse failure as "no data" (same as a total miss) so the
        // caller degrades gracefully.
        try {
            // safeJsonFromCachedResponse handles the legacy poisoned-
            // cache case too, in case `winner` came from a cache hit.
            return await safeJsonFromCachedResponse(winner);
        } catch (e) {
            console.warn(
                "[overpass] winning response wasn't valid JSON — treating as empty:",
                e,
            );
            return { elements: [] };
        }
    }

    // No mirror answered — rate-limited / outage. Bump the failure
    // counter (see overpassFailureCount) so background warmers can tell
    // this apart from a query that legitimately matched zero elements.
    _overpassFailureCount++;
    if (!silent) {
        toast.error(
            "Could not load data from Overpass (all mirrors timed out or rate-limited). Try again in a minute.",
            { toastId: "overpass-error" },
        );
    }
    return { elements: [] };
};

/** How long the client gives its own cache worker (tier 1) before it
 *  brings the public mirrors (tier 2) into the race as insurance.
 *  A cache hit returns in well under a second, so on the happy path
 *  the mirrors are never touched. A cache *miss* lets the worker
 *  fetch + persist once within this window; only a genuinely
 *  slow/stuck worker leaks past it. Worker hard-failures don't wait
 *  for this timer — tier 2 starts the instant tier 1 has all
 *  failed. */
const PUBLIC_MIRROR_STAGGER_MS = 7000;

/** v349: how long the R2-backed worker gets before the
 *  polygons.openstreetmap.fr boundary fast-path joins the race. Long
 *  enough that a prewarmed / cached boundary (R2 hit, typically
 *  100-500 ms) wins first and the external call never fires; short
 *  enough that a genuinely cold boundary still gets the fast pre-
 *  computed polygon promptly. */
const POLYGON_FAST_PATH_STAGGER_MS = 1500;

/**
 * Two-tier first-success-wins race with a staggered second tier.
 *
 * `tier1` racers all start immediately. `tier2` racers start either
 * (a) as soon as every started racer has failed, or (b) `staggerMs`
 * after the start, whichever comes first. The first racer in either
 * tier to return a non-null Response wins and the rest are
 * abandoned; if everything fails, resolves null.
 *
 * This replaces the old "race all four endpoints at once" so the
 * client stops flooding the public Overpass mirrors directly on
 * every query — they're now a delayed fallback behind our own
 * R2-backed cache worker.
 */
async function raceWithStaggeredFallback(
    tiers: Array<{
        racers: Array<{
            name: string;
            run: (signal: AbortSignal) => Promise<Response | null>;
        }>;
        /** ms after start at which this tier kicks in (0 = immediate).
         *  A tier also starts early if every racer started so far has
         *  already failed. */
        afterMs: number;
    }>,
): Promise<Response | null> {
    return new Promise((resolve) => {
        let resolved = false;
        let pending = 0;
        const startedTiers = new Set<number>();
        const timers: Array<ReturnType<typeof setTimeout>> = [];
        // One AbortController per racer so a winner can cancel the LOSERS
        // without touching its own already-resolved body. Losing mirrors
        // otherwise download their full multi-MB boundary body (Sweden
        // ≈17 MB × 3) even after another mirror wins — real mobile data +
        // battery for bytes we throw away. The winner's controller is left
        // un-aborted (its Response body is already buffered by tryFetch's
        // abort-sniff anyway, but we skip it to be safe).
        const controllers: AbortController[] = [];

        const abortLosers = (winner: AbortController | null) => {
            for (const c of controllers) {
                if (c !== winner) {
                    try {
                        c.abort();
                    } catch {
                        /* no-op */
                    }
                }
            }
        };

        const finish = (r: Response | null, winner: AbortController | null) => {
            if (resolved) return;
            resolved = true;
            for (const t of timers) clearTimeout(t);
            abortLosers(winner);
            resolve(r);
        };

        const startTier = (i: number) => {
            if (resolved || startedTiers.has(i) || i >= tiers.length) return;
            startedTiers.add(i);
            const tier = tiers[i];
            pending += tier.racers.length;
            tier.racers.forEach(({ run }) => {
                const controller = new AbortController();
                controllers.push(controller);
                run(controller.signal).then(
                    (r) => onSettled(r, controller),
                    () => onSettled(null, controller),
                );
            });
        };

        const startNextUnstarted = () => {
            for (let i = 0; i < tiers.length; i++) {
                if (!startedTiers.has(i)) {
                    startTier(i);
                    return true;
                }
            }
            return false;
        };

        function onSettled(r: Response | null, controller: AbortController) {
            if (resolved) return;
            if (r) {
                finish(r, controller);
                return;
            }
            pending--;
            if (pending === 0) {
                // Everything started so far failed — bring the next
                // unstarted tier in immediately rather than waiting on
                // its timer.
                if (!startNextUnstarted()) finish(null, null);
            }
        }

        // Tier 0 immediate; each later tier on its own timer.
        startTier(0);
        for (let i = 1; i < tiers.length; i++) {
            const afterMs = tiers[i].afterMs;
            timers.push(
                setTimeout(() => {
                    if (!resolved) startTier(i);
                }, afterMs),
            );
        }
    });
}

export const determineGeoJSON = async (
    osmId: string,
    osmTypeLetter: "W" | "R" | "N",
    /** Suppress the per-fetch "Loading map data..." toast. Used by
     *  callers that fan this function out in parallel (like
     *  `determineMapBoundaries` below) and want a single toast for
     *  the whole batch instead of N stacking ones. */
    silent: boolean = false,
    /** Report download progress to the global loadingProgress atom
     *  (used by determineMapBoundaries which owns the overlay). */
    reportProgress: boolean = false,
    /** User-visible label for this fetch's piece row in the loading
     *  overlay (e.g. "Stockholm Municipality"). Only meaningful when
     *  `reportProgress` is true. */
    progressLabel?: string,
): Promise<any> => {
    const osmTypeMap: { [key: string]: string } = {
        W: "way",
        R: "relation",
        N: "node",
    };
    const osmType = osmTypeMap[osmTypeLetter];

    // `out geom` (with tags) — `osmtogeojson` relies on the
    // relation's `type=boundary` / `boundary=administrative`
    // tags AND each member way's `role=outer|inner` to assemble
    // a MultiPolygon. Stripping tags via `out skel geom` made the
    // library fall back to raw LineString features, which then
    // crashed `turf.union` with "Input geometry is not a valid
    // Polygon or MultiPolygon" downstream in
    // `determineMapBoundaries`. The bandwidth savings (~20-40 %)
    // weren't worth the broken polygon assembly.
    //
    // `[timeout:120]` gives Overpass headroom server-side for
    // countries — the default 25 s would otherwise time out
    // before the boundary geometry is assembled.
    const query = `[out:json][timeout:120];${osmType}(${osmId});out geom;`;
    // Per-attempt client timeout. Was 130 s (matching the server
    // [timeout:120] + slack), but in practice a mirror that hasn't
    // sent headers within ~30 s is silently hung — and waiting the
    // full 130 s blocks failover to a healthy mirror. 45 s keeps
    // headroom for legitimate slow boundaries (Sweden ~30 s)
    // while letting us fail over from a stuck primary in
    // reasonable time. The chain has three mirrors now
    // (overpass-api.de → private.coffee → kumi.systems), so worst
    // case is 3 × 45 s = 135 s before we surface the error.
    const data = await getOverpassData(
        query,
        silent ? undefined : "Loading map data...",
        CacheType.PERMANENT_CACHE,
        // 30 s per mirror. With the race (all four Overpass
        // mirrors plus polygons.openstreetmap.fr fire in parallel
        // — see getOverpassData) the fastest healthy mirror wins
        // anyway; this timeout governs how long a genuinely-hung
        // one keeps its connection slot. 30 s gives Shanghai-
        // scale relations on the public mirrors a fighting
        // chance — those routinely take 20-25 s of server compute
        // even on a fresh slot. polygons.osm.fr usually beats
        // them all to 1-3 s when it has data.
        30_000,
        reportProgress,
        progressLabel,
        // Forward `silent` to the total-failure toast path too —
        // determineMapBoundaries owns the loading overlay and
        // schedules its own retry, so a single piece failing
        // shouldn't fire a scary "could not load Overpass" banner
        // on top.
        silent,
    );
    const geo = osmtogeojson(data);
    return {
        ...geo,
        features: geo.features.filter(
            (feature: any) => feature.geometry.type !== "Point",
        ),
    };
};

export const findTentacleLocations = async (
    question: EncompassingTentacleQuestionSchema,
    text: string = "Determining tentacle locations...",
) => {
    const radiusMeters = turf.convertLength(
        question.radius,
        question.unit,
        "meters",
    );

    // v749: PREFER the prewarmed reference-family cache. A tentacle POI type
    // (museum/hospital/park/…) is the SAME `api:*` family matching/measuring
    // prewarm across the whole play area, so the old per-tentacle
    // `nwr[...](around:radius,lat,lng)` query — position-keyed → a UNIQUE
    // query string → a guaranteed R2 MISS → a LIVE Overpass fetch → the
    // rate-limit errors the user hit — is unnecessary whenever the tentacle
    // centre sits inside the cache's coverage. Read the cached family (an R2
    // hit for a warm city; NO position-keyed live query), filter it to the
    // tentacle radius client-side, and only fall through to the live query on
    // a cold miss / out-of-coverage centre.
    const family = cacheableFamilyForType(question.locationType);
    if (family && pointInsideCacheCoverage(question.lat, question.lng)) {
        try {
            const features = await prefetchCategory(family);
            if (features.length > 0) {
                const response = turf.points([]);
                const seen = new Set<string>();
                for (const f of features) {
                    if (!f.name || seen.has(f.name)) continue;
                    const distMeters =
                        turf.distance(
                            [question.lng, question.lat],
                            [f.lng, f.lat],
                        ) * 1000;
                    if (distMeters > radiusMeters) continue;
                    seen.add(f.name);
                    response.features.push(
                        turf.point([f.lng, f.lat], { name: f.name }),
                    );
                }
                return response;
            }
        } catch (e) {
            console.warn(
                "tentacle cache path failed; falling back to live query:",
                e,
            );
        }
    }

    // Fallback: live `around:` query (cold city / tentacle centre outside the
    // cache coverage). This is the only path that still touches Overpass.
    const query = `
[out:json][timeout:25];
nwr["${LOCATION_FIRST_TAG[question.locationType]}"="${question.locationType}"](around:${radiusMeters}, ${question.lat}, ${question.lng});
out center;
    `;
    const data = await getOverpassData(query, text);
    const elements = data.elements;
    const response = turf.points([]);
    elements.forEach((element: any) => {
        if (!element.tags["name"] && !element.tags["name:en"]) return;
        if (element.lat && element.lon) {
            const name = element.tags["name:en"] ?? element.tags["name"];
            if (
                response.features.find(
                    (feature: any) => feature.properties.name === name,
                )
            )
                return;
            response.features.push(
                turf.point([element.lon, element.lat], { name }),
            );
        }
        if (!element.center || !element.center.lon || !element.center.lat)
            return;
        const name = element.tags["name:en"] ?? element.tags["name"];
        if (
            response.features.find(
                (feature: any) => feature.properties.name === name,
            )
        )
            return;
        response.features.push(
            turf.point([element.center.lon, element.center.lat], { name }),
        );
    });
    return response;
};

export const findAdminBoundary = async (
    latitude: number,
    longitude: number,
    adminLevel: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10,
) => {
    // v826: AREA-keyed, not position-keyed. The old `is_in(lat,lng)` query
    // embedded the raw coordinates, so EVERY position was a unique Overpass
    // query string → guaranteed R2 cache MISS → live Overpass every time
    // (the rate-limit errors the user hit on the admin-division / "admin
    // border" question, even in a fully-prewarmed city — same one-producer
    // lesson as v640's `around:GPS`). Instead fetch ALL admin_level=N
    // boundaries in the PLAY AREA once via `findPlacesInZone` (a poly-scoped
    // query the worker caches in R2 and can prewarm — reused across every
    // position in the game, for BOTH the seeker's reference point and the
    // hider's live GPS) and find the one CONTAINING the point client-side.
    // Falls back to the position-keyed `is_in` query only if the area fetch
    // fails or finds no containing area (edge cases near the boundary).
    const pt = turf.point([longitude, latitude]);

    // v830 fast path: a warm city serves this level's boundaries from R2 via
    // `/api/admin/<id>/<level>` (fanned over every play-area relation), so
    // the admin question never touches Overpass — the reported "1st admin
    // border" error even in a prewarmed city. Cold areas return null (and
    // background-warm themselves), so we fall through to the live poly query.
    try {
        const prewarmed = await fetchPrewarmedAreaAdmin(adminLevel);
        if (prewarmed) {
            const geo = osmtogeojson({ elements: prewarmed.elements });
            const hit = geo.features?.find((f) => {
                const g = f.geometry;
                if (g?.type !== "Polygon" && g?.type !== "MultiPolygon") {
                    return false;
                }
                try {
                    return turf.booleanPointInPolygon(pt, f as any);
                } catch {
                    return false;
                }
            });
            if (hit) return hit;
            // Warm-but-no-containing-boundary is AUTHORITATIVE "no zone here",
            // NOT a reason to go live. The prewarmed set is the whole
            // admin_level=N field across a 2 km-PADDED bbox superset of the
            // play area, so any boundary that could contain a point INSIDE the
            // play area is already in it (with full `out geom`). Falling
            // through to live Overpass here was the reported NYC bug: NYC has
            // no admin_level=8 municipality inside it (it's level 5, boroughs
            // level 6), so "City / Town (OSM 8)" found no containing boundary
            // and then hammered Overpass → the 3× "Determining matching zone…"
            // toasts + "all mirrors timed out". A warm miss returns undefined.
            return undefined;
        }
    } catch {
        /* fall through to the live poly query below (cold / fetch failed) */
    }

    try {
        const areaData = await findPlacesInZone(
            `["boundary"="administrative"]["admin_level"="${adminLevel}"]`,
            undefined,
            "relation",
            "geom",
            [],
            0,
            true, // silent — the is_in fallback below owns the failure toast
        );
        const areaGeo = osmtogeojson(areaData);
        const containing = areaGeo.features?.find((f) => {
            const g = f.geometry;
            if (g?.type !== "Polygon" && g?.type !== "MultiPolygon") {
                return false;
            }
            try {
                return turf.booleanPointInPolygon(pt, f as any);
            } catch {
                return false;
            }
        });
        if (containing) return containing;
    } catch {
        /* fall through to the position-keyed query below */
    }

    // Fallback: the exact containing area via is_in (position-keyed, live).
    const query = `
[out:json];
is_in(${latitude}, ${longitude})->.a;
rel(pivot.a)["admin_level"="${adminLevel}"];
out geom;
    `;
    const data = await getOverpassData(query, "Determining matching zone...");
    const geo = osmtogeojson(data);
    return geo.features?.[0];
};

export const fetchCoastline = async () => {
    // v981: no loadingText — the configure dialog / question preview owns its
    // own loading state; a separate "Fetching coastline data…" toaster for an
    // internal step of body-of-water / coastline / same-landmass just read as
    // noise (and leaked an implementation detail to the user).
    const response = await cacheFetch(
        import.meta.env.BASE_URL + "/coastline50.geojson",
        undefined,
        CacheType.PERMANENT_CACHE,
    );
    const data = await response.json();
    return data;
};

/* ── v341: bundled Natural Earth 1:50m datasets ──────────────────────── *
 *
 * Per the "preloaded and stable" project principle, these three helpers
 * replace the v340 Overpass round-trips for international-border,
 * admin1-border, and body-of-water with single PERMANENT_CACHE hits on
 * static assets — fetched once per device per app version, then served
 * from disk forever. Zero external dependency at game time.
 *
 * Coverage notes (so the call sites don't lie about precision):
 *   - 1:50m simplification means fjord / inlet shapes are smoothed and
 *     some border points sit a few hundred metres off true OSM. Fine
 *     for km-precision questions ("closer to or further from a state
 *     border?") which is the whole class these answer.
 *   - admin0 = country borders (390 land border lines, no maritime).
 *     Matches rulebook p23 "International Border — Enclaves count!".
 *   - admin1 = state / province / canton / prefecture borders (581
 *     lines). Matches rulebook's "1st Administrative Division Border".
 *   - lakes = named lake POLYGONS (411 worldwide, 326 named). Matches
 *     "Body of Water — Any named body of water on your maps app,
 *     excluding pools." Caveat: lakes only — named bays / channels /
 *     rivers aren't in this dataset, so the seeker-side cut is
 *     conservatively narrow. Hiders still answer based on their own
 *     mapping app per the rulebook, so a hider near a named bay
 *     correctly answers from their app even though we didn't auto-cut
 *     for it.
 *
 * 2nd-administrative-division borders (county / district) aren't in
 * Natural Earth at any global resolution — those still go through
 * Overpass (cached at the worker, not bundled) for the foreseeable
 * future. See the admin2-border case comment in measuring.ts.
 */
export const fetchBorders0Land = async () => {
    // v981: no loadingText — these bundled datasets are fetched both by the
    // measuring elimination AND (silently) by the subtype-availability gate,
    // so a user-facing toaster here is noise.
    const response = await cacheFetch(
        import.meta.env.BASE_URL + "/borders0_50m.geojson",
        undefined,
        CacheType.PERMANENT_CACHE,
    );
    return await response.json();
};

export const fetchBorders1States = async () => {
    const response = await cacheFetch(
        import.meta.env.BASE_URL + "/borders1_50m.geojson",
        undefined,
        CacheType.PERMANENT_CACHE,
    );
    return await response.json();
};

export const fetchLakes = async () => {
    const response = await cacheFetch(
        import.meta.env.BASE_URL + "/lakes50.geojson",
        "Fetching lake data...",
        CacheType.PERMANENT_CACHE,
    );
    return await response.json();
};

export const trainLineNodeFinder = async (node: string): Promise<number[]> => {
    const nodeId = node.split("/")[1];
    const tagQuery = `
[out:json];
node(${nodeId});
wr(bn);
out tags;
`;
    const tagData = await getOverpassData(tagQuery);
    const query = `
[out:json];
(
${tagData.elements
    .map((element: any) => {
        if (
            !element.tags.name &&
            !element.tags["name:en"] &&
            !element.tags.network
        )
            return "";
        let query = "";
        if (element.tags.name) query += `wr["name"="${element.tags.name}"];`;
        if (element.tags["name:en"])
            query += `wr["name:en"="${element.tags["name:en"]}"];`;
        if (element.tags["network"])
            query += `wr["network"="${element.tags["network"]}"];`;
        return query;
    })
    .join("\n")}
);
out geom;
`;
    const data = await getOverpassData(query);
    const geoJSON = osmtogeojson(data);
    const nodes: number[] = [];
    geoJSON.features.forEach((feature: any) => {
        if (feature && feature.id && feature.id.startsWith("node")) {
            nodes.push(parseInt(feature.id.split("/")[1]));
        }
    });
    data.elements.forEach((element: any) => {
        if (element && element.type === "node") {
            nodes.push(element.id);
        } else if (element && element.type === "way") {
            nodes.push(...element.nodes);
        }
    });
    const uniqNodes = uniq(nodes);
    return uniqNodes;
};

/**
 * v877: the actual RAIL LINE geometry (LineString/MultiLineString features)
 * the given station node sits on — the SAME 2-step name/name:en/network query
 * `trainLineNodeFinder` uses (so a drawn line matches the same-train-line
 * grading), but KEEPS the line features instead of extracting node ids. Used
 * only to DRAW the line on the configure-question preview; the elimination
 * path (`trainLineNodeFinder`) is untouched.
 */
export const findTrainLineGeometry = async (
    node: string,
): Promise<GeoJSON.Feature[]> => {
    const nodeId = node.split("/")[1];
    const tagQuery = `[out:json];node(${nodeId});wr(bn);out tags;`;
    const tagData = await getOverpassData(tagQuery);
    const query = `
[out:json];
(
${tagData.elements
    .map((element: any) => {
        if (
            !element.tags?.name &&
            !element.tags?.["name:en"] &&
            !element.tags?.network
        )
            return "";
        let q = "";
        if (element.tags.name) q += `wr["name"="${element.tags.name}"];`;
        if (element.tags["name:en"])
            q += `wr["name:en"="${element.tags["name:en"]}"];`;
        if (element.tags["network"])
            q += `wr["network"="${element.tags["network"]}"];`;
        return q;
    })
    .join("\n")}
);
out geom;
`;
    const data = await getOverpassData(query);
    const geoJSON = osmtogeojson(data);
    return geoJSON.features.filter(
        (f) =>
            f.geometry?.type === "LineString" ||
            f.geometry?.type === "MultiLineString",
    );
};

/* ────────────────── Transit-route picker (v966) ────────────────── */

export interface TransitRouteSummary {
    /** OSM element id, e.g. "relation/123456". */
    id: string;
    /** Display name (falls back to ref, then "<mode> route"). */
    name: string;
    ref?: string;
    /** OSM `route` tag value: subway / train / light_rail / tram / … */
    mode: string;
}

export interface TransitRouteStop {
    lat: number;
    lng: number;
    name?: string;
}

export interface TransitRouteDetail {
    stops: TransitRouteStop[];
    /** Flattened line as [lng, lat] pairs, for drawing the route. */
    geometry: number[][];
}

/**
 * v968: the play-area's prewarmed transit-route set — served Overpass-free
 * from `GET /api/transit-routes/<relationId>` (R2) for a warm city, the SAME
 * per-city set the laptop/cron warm. Contains ALL rail transit routes in the
 * play area with geometry + member stop nodes. Both the route picker (list
 * near GPS) and the route-detail extractor read this, so a starred city never
 * hits live Overpass. `null` when the play area isn't a single OSM relation or
 * the entry is cold (→ callers fall back to a live query + fire `?warm=1`).
 * Memoised per relation id so the list + detail share one fetch.
 */
const transitRoutesCache = new Map<number, any>();
const transitRoutesWarmRequested = new Set<number>();
async function fetchPrewarmedTransitRoutes(): Promise<any> {
    const primary = mapGeoLocation.get();
    const props = primary?.properties as
        | { osm_id?: number; osm_type?: string }
        | undefined;
    const extrasAdded = additionalMapGeoLocations.get().some((e) => e.added);
    if (
        extrasAdded ||
        props?.osm_type !== "R" ||
        typeof props?.osm_id !== "number" ||
        props.osm_id <= 0
    ) {
        return null;
    }
    const relId = props.osm_id;
    if (transitRoutesCache.has(relId)) return transitRoutesCache.get(relId);
    try {
        const resp = await fetch(`${TRANSIT_ROUTES_BY_RELATION_BASE}/${relId}`);
        if (resp.ok) {
            const json = (await resp.json()) as { elements?: unknown[] };
            if (Array.isArray(json?.elements) && json.elements.length > 0) {
                transitRoutesCache.set(relId, json);
                return json;
            }
        }
    } catch {
        /* network issue → cold fallback */
    }
    // Cold (miss / no-boundary) — warm in the background so the NEXT game is
    // served from R2; this game falls to the live query per-function.
    if (!transitRoutesWarmRequested.has(relId)) {
        transitRoutesWarmRequested.add(relId);
        fetch(`${TRANSIT_ROUTES_BY_RELATION_BASE}/${relId}?warm=1`, {
            method: "GET",
        }).catch(() => transitRoutesWarmRequested.delete(relId));
    }
    return null;
}

/** Summarise a route relation Overpass element. */
function routeSummaryFromEl(el: any): TransitRouteSummary | null {
    if (el?.type !== "relation" || !el.tags) return null;
    const tags = el.tags as Record<string, string>;
    const mode = tags.route ?? "";
    const ref = tags.ref;
    const name =
        tags["name:en"] ??
        tags.name ??
        (ref ? `${mode} ${ref}` : `${mode} route`);
    return { id: `relation/${el.id}`, name, ref, mode };
}

/** All [lng,lat] vertices of a route relation's member ways. */
function routeMemberCoords(el: any): [number, number][] {
    const coords: [number, number][] = [];
    for (const m of el?.members ?? []) {
        if (m.type === "way" && Array.isArray(m.geometry)) {
            for (const p of m.geometry) {
                if (
                    typeof p.lat === "number" &&
                    typeof p.lon === "number"
                )
                    coords.push([p.lon, p.lat]);
            }
        } else if (
            m.type === "node" &&
            typeof m.lat === "number" &&
            typeof m.lon === "number"
        ) {
            coords.push([m.lon, m.lat]);
        }
    }
    return coords;
}

function dedupeRoutes(routes: TransitRouteSummary[]): TransitRouteSummary[] {
    const seen = new Set<string>();
    const out: TransitRouteSummary[] = [];
    for (const r of routes) {
        const key = `${r.mode}|${r.name}|${r.ref ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(r);
    }
    out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    return out;
}

/**
 * v966/v968: list the transit ROUTES with a member within `radiusMeters` of
 * the given point — the routes the seeker could currently be riding, for the
 * `same-train-line` question's route picker. `modes` are OSM `route` tag
 * values (subway/train/light_rail/tram/monorail/ferry/bus). Prefers the
 * prewarmed per-city set (Overpass-free for a warm city), filtering it to the
 * allowed modes + near the point; falls back to a live `around:` query on a
 * cold / non-relation play area.
 */
export const findTransitRoutesNear = async (
    lat: number,
    lng: number,
    modes: string[] = ["subway", "train", "light_rail", "tram", "monorail"],
    radiusMeters = 500,
): Promise<TransitRouteSummary[]> => {
    const allowed = new Set(modes);
    // Prewarmed play-area set first — filter to allowed modes + near the point.
    const prewarmed = await fetchPrewarmedTransitRoutes();
    if (prewarmed) {
        const near: TransitRouteSummary[] = [];
        for (const el of prewarmed.elements ?? []) {
            const summary = routeSummaryFromEl(el);
            if (!summary || !allowed.has(summary.mode)) continue;
            const coords = routeMemberCoords(el);
            const isNear = coords.some(
                (c) =>
                    turf.distance(
                        turf.point([lng, lat]),
                        turf.point(c),
                        { units: "meters" },
                    ) <= radiusMeters,
            );
            if (isNear) near.push(summary);
        }
        // The prewarmed set covers rail modes only; if the game additionally
        // allows bus/ferry, supplement with a live around-query for those.
        const missing = modes.filter(
            (m) => m === "bus" || m === "ferry",
        );
        if (missing.length > 0) {
            near.push(...(await liveRoutesNear(lat, lng, missing, radiusMeters)));
        }
        return dedupeRoutes(near);
    }
    return dedupeRoutes(await liveRoutesNear(lat, lng, modes, radiusMeters));
};

/** Live `around:` route-listing query (cold-city / bus-ferry fallback). */
async function liveRoutesNear(
    lat: number,
    lng: number,
    modes: string[],
    radiusMeters: number,
): Promise<TransitRouteSummary[]> {
    const modeRe = modes.map((m) => m.replace(/[^a-z_]/gi, "")).join("|");
    if (!modeRe) return [];
    const query = `[out:json];
relation(around:${radiusMeters},${lat},${lng})["type"="route"]["route"~"^(${modeRe})$"];
out tags;`;
    const data = await getOverpassData(query);
    const routes: TransitRouteSummary[] = [];
    for (const el of data.elements ?? []) {
        const s = routeSummaryFromEl(el);
        if (s) routes.push(s);
    }
    return routes;
}

/**
 * v966/v968: fetch one transit route's STOPS + line geometry (for the picked
 * route). Prefers the prewarmed per-city set (Overpass-free); falls back to a
 * live `relation(ID)` query on a cold / non-relation play area. Extracts:
 *   - stops: member nodes whose role is a stop/platform role OR whose tags
 *     mark them a station/halt/stop/platform — de-duplicated by nearness so a
 *     PTv2 stop-position + platform pair collapses to one stop.
 *   - geometry: the concatenated way-member vertices ([lng,lat]).
 */
export const fetchTransitRouteDetail = async (
    routeId: string,
): Promise<TransitRouteDetail> => {
    const relId = routeId.split("/")[1];
    let data: any;
    let rel: any;
    const prewarmed = await fetchPrewarmedTransitRoutes();
    if (prewarmed) {
        rel = (prewarmed.elements ?? []).find(
            (e: any) =>
                e.type === "relation" && String(e.id) === String(relId),
        );
        if (rel) data = prewarmed;
    }
    if (!rel) {
        const query = `[out:json];relation(${relId});(._;>;);out geom;`;
        data = await getOverpassData(query);
        rel = (data.elements ?? []).find(
            (e: any) => e.type === "relation" && String(e.id) === String(relId),
        );
    }
    const nodeById = new Map<number, any>();
    for (const e of data.elements ?? []) {
        if (e.type === "node") nodeById.set(e.id, e);
    }
    const isStopNode = (node: any, role: string): boolean => {
        if (/^(stop|platform)/.test(role)) return true;
        const t = (node?.tags ?? {}) as Record<string, string>;
        return (
            ["station", "halt", "stop", "tram_stop"].includes(t.railway) ||
            ["stop_position", "platform", "station"].includes(
                t.public_transport,
            )
        );
    };
    const rawStops: TransitRouteStop[] = [];
    const geometry: number[][] = [];
    for (const m of rel?.members ?? []) {
        if (m.type === "node") {
            const node = nodeById.get(m.ref);
            if (!isStopNode(node, m.role ?? "")) continue;
            const la = m.lat ?? node?.lat;
            const ln = m.lon ?? node?.lon;
            if (!Number.isFinite(la) || !Number.isFinite(ln)) continue;
            rawStops.push({ lat: la, lng: ln, name: node?.tags?.name });
        } else if (m.type === "way" && Array.isArray(m.geometry)) {
            for (const g of m.geometry) {
                if (g && Number.isFinite(g.lat) && Number.isFinite(g.lon))
                    geometry.push([g.lon, g.lat]);
            }
        }
    }
    // De-dupe stops: a PTv2 route lists a stop_position node AND a platform
    // node for the same stop. Collapse points within ~60 m, preferring the
    // one that carries a name.
    const stops: TransitRouteStop[] = [];
    for (const s of rawStops) {
        const near = stops.find(
            (t) =>
                turf.distance(
                    turf.point([t.lng, t.lat]),
                    turf.point([s.lng, s.lat]),
                    { units: "meters" },
                ) < 60,
        );
        if (near) {
            if (!near.name && s.name) near.name = s.name;
            continue;
        }
        stops.push({ ...s });
    }
    return { stops, geometry };
};

/** Soft cap on how many coordinate pairs go into a `poly:` filter
 *  string. The string is repeated once per sub-statement in a
 *  combined query, so the effective query size is roughly
 *  `MAX_POLY_POINTS * filters * ~18 bytes`. 600 points × 8 filters ×
 *  18 ≈ 85 KB — comfortably under the public mirrors' request-size
 *  ceiling while preserving the play-area silhouette. */
const MAX_POLY_POINTS = 600;

/**
 * Serialise a play-area polygon into an Overpass `poly:` coordinate
 * string ("lat lon lat lon …"), progressively simplifying until the
 * point count is under `MAX_POLY_POINTS`. Small play areas (a
 * neighbourhood, a town) are already under the cap and pass through
 * untouched; large/complex ones (a county, a metropolis with a
 * crenellated coastline) get simplified just enough to fit.
 *
 * turf.coordAll flattens every ring of every polygon into one
 * sequence — fine for our purposes since Overpass treats the whole
 * point list as the filter region, and the v190 land-clip already
 * dropped far-flung islands that would otherwise corrupt that.
 */
function buildPolyFilterString(
    geojson: GeoJSON.FeatureCollection | GeoJSON.Feature | GeoJSON.Geometry,
): string {
    let coords = turf.coordAll(geojson as any);
    if (coords.length > MAX_POLY_POINTS) {
        for (const tolerance of [0.001, 0.002, 0.005, 0.01, 0.02, 0.05]) {
            try {
                const simplified = turf.simplify(geojson as any, {
                    tolerance,
                    highQuality: false,
                    mutate: false,
                });
                const next = turf.coordAll(simplified as any);
                // Guard against simplification collapsing the polygon
                // to nothing — keep the last usable set.
                if (next.length >= 4) coords = next;
                if (coords.length <= MAX_POLY_POINTS) break;
            } catch {
                break;
            }
        }
    }
    return coords.map(([lon, lat]) => `${lat} ${lon}`).join(" ");
}

export const findPlacesInZone = async (
    filter: string,
    loadingText?: string,
    searchType:
        | "node"
        | "way"
        | "relation"
        | "nwr"
        | "nw"
        | "wr"
        | "nr"
        | "area" = "nwr",
    outType: "center" | "geom" = "center",
    alternatives: string[] = [],
    timeoutDuration: number = 0,
    /** Suppress the user-visible Overpass-failure toast. Background
     *  callers (hiding-period preload, lazy category prefetch) pass
     *  this so a downed cache worker doesn't show the same scary
     *  toast a dozen times before the seeker can even ask anything. */
    silent: boolean = false,
) => {
    // v331 fast path. If the caller's filter matches one of the
    // standard reference families AND the requested shape (nwr +
    // out center, no alternatives) is what the cache holds, serve
    // from the per-family in-memory cache (warm) or trigger the
    // combined-families bbox prewarm (cold) instead of building a
    // poly:-shaped Overpass query that misses the R2 cache.
    //
    // Two wins: (a) per-question matching/measuring answers become
    // instant once the play-area prewarm has landed, since the cron
    // already populates the shard-scope bbox entry; (b) references
    // outside the play-area polygon are included — per the rulebook
    // a hospital just outside the boundary still counts as "nearest
    // hospital", and the prefetch bbox is padded for exactly this.
    //
    // Dynamic filters (letter-zone admin-level regex, `[highspeed=yes]`,
    // anything not in `STANDARD_REFERENCE_FAMILIES`) return null from
    // `familyForFilter` and fall through to the original implementation.
    if (
        searchType === "nwr" &&
        outType === "center" &&
        alternatives.length === 0
    ) {
        const family = familyForFilter(filter);
        if (family) {
            try {
                return await findCachedPlaces(family);
            } catch (e) {
                // Fast-path failure (cache miss + upstream down,
                // typically) — fall through to the poly: path so the
                // caller still gets a real answer attempt rather than
                // an empty result that looks like "no features".
                console.warn(
                    `[findPlacesInZone] fast path for family ${family} threw, falling through:`,
                    e,
                );
            }
        }
    }

    let query = "";
    const $polyGeoJSON = polyGeoJSON.get();
    if ($polyGeoJSON) {
        // Overpass poly: expects "lat lon" pairs; GeoJSON stores
        // [lon, lat]. We build the string from a SIMPLIFIED polygon
        // (see buildPolyFilterString) — a raw county boundary can
        // carry thousands of vertices, and this string is repeated
        // once per sub-statement in a combined multi-category query.
        // Left unsimplified, an 8-category query for a complex region
        // (Dalarna) balloons past the public mirrors' request-size
        // limit and they silently drop sub-statements — the
        // "8/8 warm but only one category has results" bug. A ~500m
        // simplification is invisible to "is this amenity in the
        // play area" while cutting the vertex count (and query size)
        // by 10-50x.
        const polyStr = buildPolyFilterString($polyGeoJSON);
        query = `
[out:json]${timeoutDuration != 0 ? `[timeout:${timeoutDuration}]` : ""};
(
${searchType}${filter}(poly:"${polyStr}");
${
    alternatives.length > 0
        ? alternatives
              .map(
                  (alternative) =>
                      `${searchType}${alternative}(poly:"${polyStr}");`,
              )
              .join("\n")
        : ""
}
);
out ${outType};
`;
    } else {
        const primaryLocation = mapGeoLocation.get();
        const additionalLocations = additionalMapGeoLocations
            .get()
            .filter((entry) => entry.added)
            .map((entry) => entry.location);
        const allLocations = [primaryLocation, ...additionalLocations];
        const relationToAreaBlocks = allLocations
            .map((loc, idx) => {
                const regionVar = `.region${idx}`;
                return `relation(${loc.properties.osm_id});map_to_area->${regionVar};`;
            })
            .join("\n");
        const searchBlocks = allLocations
            .map((_, idx) => {
                const regionVar = `area.region${idx}`;
                const altQueries =
                    alternatives.length > 0
                        ? alternatives
                              .map(
                                  (alt) => `${searchType}${alt}(${regionVar});`,
                              )
                              .join("\n")
                        : "";
                return `
            ${searchType}${filter}(${regionVar});
            ${altQueries}
          `;
            })
            .join("\n");
        query = `
        [out:json]${timeoutDuration !== 0 ? `[timeout:${timeoutDuration}]` : ""};
        ${relationToAreaBlocks}
        (
        ${searchBlocks}
        );
        out ${outType};
        `;
    }
    const data = await getOverpassData(
        query,
        loadingText,
        CacheType.ZONE_CACHE,
        undefined,
        false,
        undefined,
        silent,
    );
    const subtractedEntries = additionalMapGeoLocations
        .get()
        .filter((e) => !e.added);
    const subtractedPolygons = subtractedEntries.map((entry) => entry.location);
    if (subtractedPolygons.length > 0 && data && data.elements) {
        const turfPolys = await Promise.all(
            subtractedPolygons.map(
                async (location) =>
                    turf.combine(
                        await determineGeoJSON(
                            location.properties.osm_id.toString(),
                            location.properties.osm_type,
                        ),
                    ).features[0],
            ),
        );
        data.elements = data.elements.filter((el: any) => {
            const lon = el.center ? el.center.lon : el.lon;
            const lat = el.center ? el.center.lat : el.lat;
            if (typeof lon !== "number" || typeof lat !== "number")
                return false;
            const pt = turf.point([lon, lat]);
            return !turfPolys.some((poly) =>
                turf.booleanPointInPolygon(pt, poly as any),
            );
        });
    }
    return data;
};

export const findPlacesSpecificInZone = async (
    location: `${QuestionSpecificLocation}`,
) => {
    const locations = (
        await findPlacesInZone(
            location,
            `Finding ${
                location === '["brand:wikidata"="Q38076"]'
                    ? "McDonald's"
                    : "7-Elevens"
            }...`,
        )
    ).elements;
    return turf.featureCollection(
        locations.map((x: any) =>
            turf.point([
                x.center ? x.center.lon : x.lon,
                x.center ? x.center.lat : x.lat,
            ]),
        ),
    );
};

export const nearestToQuestion = async (
    question: HomeGameMatchingQuestions | HomeGameMeasuringQuestions,
) => {
    let radius = 30;
    let instances: any = { features: [] };
    // Grow the search radius until we find a reference, but CAP it. Without
    // a bound this loops forever when the reference type is genuinely absent
    // in-area OR (worse) Overpass is congested and keeps returning an empty
    // `{elements:[]}` — the exact soft-timeout condition this codebase fights
    // — hammering the mirrors with ever-larger `around:` queries. ~1000 mi is
    // far past any real play area, so hitting the cap means "none found".
    const MAX_RADIUS_MILES = 1000;
    while (instances.features.length === 0 && radius <= MAX_RADIUS_MILES) {
        instances = await findTentacleLocations(
            {
                lat: question.lat,
                lng: question.lng,
                radius: radius,
                unit: "miles",
                location: false,
                locationType: question.type,
                drag: false,
                color: "black",
                collapsed: false,
            },
            // No loadingText — picker has its own progress UI.
            undefined,
        );
        radius += 30;
    }
    if (instances.features.length === 0) return null;
    const questionPoint = turf.point([question.lng, question.lat]);
    return turf.nearestPoint(questionPoint, instances as any);
};

/**
 * Max parallel Overpass boundary fetches inside
 * `determineMapBoundaries`. Set to 4 so we stay well below the
 * browser's ~6-per-origin connection limit AND the public
 * Overpass mirrors' rate-limit threshold (the cause of the
 * cascade of "failed" rows on multi-area games observed in the
 * wild). The primary boundary is first in the queue, so it
 * always grabs a slot immediately; the rest stream in 3 at a
 * time alongside it.
 */
const BOUNDARY_FETCH_CONCURRENCY = 4;

/**
 * Tiny promise pool — runs `worker` over `items` with at most
 * `limit` in flight at any one time, preserving result order.
 * No dependency required; we spawn N runner loops that each
 * pull the next index off a shared counter.
 */
async function mapWithConcurrency<T, R>(
    items: T[],
    limit: number,
    worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    const workers = new Array(Math.min(limit, items.length))
        .fill(0)
        .map(async () => {
            while (true) {
                const i = next++;
                if (i >= items.length) return;
                results[i] = await worker(items[i], i);
            }
        });
    await Promise.all(workers);
    return results;
}

export const determineMapBoundaries = async () => {
    const primary = mapGeoLocation.get();
    const extras = additionalMapGeoLocations.get();
    const totalPieces = 1 + extras.length;
    // Shared helper — strips a few common admin-area suffixes that
    // read as noise on the loading card. We keep the rest of the
    // name verbatim — "Stockholm Municipality" → "Stockholm", but
    // "Île-de-France" is left untouched.
    const stripAdminSuffix = (s: string) =>
        s.replace(
            /\s+(kommun|län|municipality|county|district|prefecture|province)$/i,
            "",
        );
    // Prefer the wizard's friendly displayName (which already
    // strips admin suffixes like "kommun" / "län" / "Municipality")
    // over the raw OSM `name` field. Falls back to the OSM name,
    // then a generic label if neither is set.
    const friendlyName =
        playArea.get()?.displayName?.split(",")[0]?.trim() ||
        (primary?.properties as { name?: string })?.name ||
        "play area";
    const areaName = stripAdminSuffix(friendlyName);

    // Per-piece labels so each adjacent area gets its own row in
    // the loading overlay. The primary piece keeps the friendlier
    // wizard displayName; adjacents fall back to their raw OSM name
    // (which is the only thing we have at this point).
    const labelFor = (loc: typeof primary, isPrimary: boolean): string => {
        if (isPrimary) return areaName;
        const raw = (loc?.properties as { name?: string })?.name;
        return raw ? stripAdminSuffix(raw) : "Adjacent area";
    };

    // Open the global loading overlay. The LoadingOverlay component
    // renders bytes-downloaded, current phase, and elapsed time.
    // Caller of determineMapBoundaries doesn't need to manage this —
    // we open + close around the full pipeline.
    //
    // Concurrency cap below: we don't fan all 14 areas out at once,
    // we run BOUNDARY_FETCH_CONCURRENCY in flight at a time. That
    // matches the phase text — "4 at a time" — to what the user
    // actually sees in the per-piece list (most rows queue, four
    // stream).
    startLoading(
        `Loading ${areaName}`,
        totalPieces > 1
            ? `Fetching ${totalPieces} areas (${Math.min(
                  totalPieces,
                  BOUNDARY_FETCH_CONCURRENCY,
              )} at a time)…`
            : "Fetching boundary…",
    );

    try {
        // Fan-out fetch all play-area component polygons in parallel.
        // `silent: true` suppresses toast.promise spam (we have the
        // global overlay instead). Each piece now reports its OWN
        // byte progress AND its own labeled row in the loading
        // overlay — the loadingPieces atom holds one entry per URL
        // so the user sees a list like:
        //   • Stockholm — 2.1 / ~9 MB
        //   • Solna     — done
        //   • Sundbyberg — waiting…
        // even while one big primary is still server-computing.
        //
        // We cap concurrency at BOUNDARY_FETCH_CONCURRENCY (4) rather
        // than letting every adjacent fan out at once. Browsers limit
        // HTTP/1.1 connections to ~6 per origin, and Overpass mirrors
        // are a single origin each, so 14+ simultaneous fetches just
        // queue up at the network layer AND trigger the public
        // mirror's rate limit (the cause of the cascade of "failed"
        // rows users were seeing on multi-area games like Manchester +
        // 13 adjacents). 4 keeps us under the rate limit AND leaves
        // browser connection slots free for the rest of the app.
        const entries = [
            { location: primary, added: true, base: true },
            ...extras.map((e) => ({ ...e, base: false })),
        ];
        const fetchEntry = async (entry: (typeof entries)[number]) => ({
            added: entry.added,
            data: await determineGeoJSON(
                entry.location.properties.osm_id.toString(),
                entry.location.properties.osm_type,
                /* silent */ true,
                /* reportProgress */ true,
                labelFor(entry.location, entry.base),
            ),
        });
        const mapGeoDatum = await mapWithConcurrency(
            entries,
            BOUNDARY_FETCH_CONCURRENCY,
            fetchEntry,
        );

        // Retry pass for empty-result pieces. The user-visible
        // symptom this fixes: occasionally a multi-area load
        // completes "successfully" but with one or more adjacent
        // areas silently missing — usually because the Overpass
        // public mirror rate-limited that one fetch and getOverpassData
        // returned `{ elements: [] }` rather than throwing. The fix
        // is to detect any feature-empty entries after the initial
        // pass and re-fetch JUST those after a small delay, giving
        // the rate-limit window time to relax.
        for (let attempt = 1; attempt <= 2; attempt++) {
            const failedIdx: number[] = [];
            mapGeoDatum.forEach((result, i) => {
                if (
                    !result?.data?.features ||
                    result.data.features.length === 0
                ) {
                    failedIdx.push(i);
                }
            });
            if (failedIdx.length === 0) break;
            // Don't burn retries on a totally-broken initial pass
            // (every piece empty) — that's a hard failure, not a
            // rate-limit blip. Let the outer flow surface it.
            if (failedIdx.length === entries.length) break;
            setPhase(
                `Retrying ${failedIdx.length} area${failedIdx.length === 1 ? "" : "s"}…`,
            );
            await new Promise((r) => setTimeout(r, attempt * 3000));
            const retried = await mapWithConcurrency(
                failedIdx.map((i) => entries[i]),
                BOUNDARY_FETCH_CONCURRENCY,
                fetchEntry,
            );
            retried.forEach((result, j) => {
                const i = failedIdx[j];
                // Only replace if the retry actually returned features —
                // a second empty result is worse than no replacement.
                if (
                    result?.data?.features &&
                    result.data.features.length > 0
                ) {
                    mapGeoDatum[i] = result;
                }
            });
        }

        // Parse phase. osmtogeojson already ran inside
        // determineGeoJSON; what's expensive next is the union /
        // difference / simplify steps over the combined polygon. Those
        // turf ops run in the geometry Web Worker (off the main thread)
        // so even a pathologically large boundary — the "Tokyo
        // Metropolis" relation legally spans ~1000 km to the Ogasawara
        // Islands — can no longer FREEZE the UI. `combineBoundary`
        // falls back to the synchronous main-thread core if the worker
        // is unavailable. The worker reports its own phase labels
        // ("Subtracting excluded areas…", "Simplifying geometry…") via
        // the onPhase callback so the loading overlay stays live.
        setPhase("Combining boundary polygons…");
        await new Promise((r) => requestAnimationFrame(r));

        // `combineBoundary` filters out anything that isn't a closed
        // polygon/multipolygon before the union (a stray unclosed way on
        // an OSM relation would otherwise crash turf) and throws if no
        // usable added feature survives.
        const addedFeatures = mapGeoDatum
            .filter((x) => x.added)
            .flatMap((x) => x.data.features) as any;
        const subtractFeatures = mapGeoDatum
            .filter((x) => !x.added)
            .flatMap((x) => x.data.features) as any;

        const combined = await combineBoundary(
            addedFeatures,
            subtractFeatures,
            setPhase,
        );

        setPhase("Rendering…");
        await new Promise((r) => requestAnimationFrame(r));
        return combined as FeatureCollection<MultiPolygon>;
    } finally {
        finishLoading();
    }
};
