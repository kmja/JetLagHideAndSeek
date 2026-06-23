/**
 * Helpers for auto-suggesting nearby admin regions to extend a
 * play area with.
 *
 * The motivation: in many cities the OSM admin relation the user
 * picks (e.g. Stockholm Municipality) is *narrower* than what
 * locals would consider the city. Stockholm's neighbours Solna,
 * Sundbyberg, Danderyd, Lidingö, Nacka, Huddinge, Järfälla etc.
 * are legally separate municipalities but are tightly integrated
 * via the subway / commuter-rail network — for a Jet Lag game,
 * including them in the play area is usually what you want.
 *
 * Approach (v427-rework): use **true topological adjacency** instead
 * of an admin_level proximity heuristic. Two OSM admin boundary
 * relations are adjacent iff they share at least one member way (OSM
 * always splits boundary edges at jurisdictional borders into shared
 * ways referenced by both sides). One Overpass query gets every
 * relation that references any way the primary references — that's
 * the primary plus all its neighbours, REGARDLESS of admin_level. We
 * filter out the primary itself + any non-administrative-boundary
 * relations and that's the candidate set. Cleaner, correct, and
 * doesn't break on consolidated cities, county/municipality bands,
 * or country-of-the-week edge cases.
 *
 * Granularity gate (generalised, not per-city): topological adjacency
 * over-collects at the extremes — a city's coastline/border ways are
 * shared BOTH with the parent region (its state/country boundary) and
 * with whatever micro-divisions happen to sit on the perimeter (NYC's
 * level-8/9 community districts, ward-level neighbourhoods elsewhere).
 * Neither is a "reasonable expansion". So every candidate, from every
 * pass, is funnelled through `withinLevelWindow`: same-level peers
 * (Solna ↔ Stockholm) are always kept; sub-units (boroughs ↔ NYC) are
 * kept ONLY for consolidated-city / megacity primaries (level ≤ 5).
 * For an ordinary city its own finer sub-areas (Stockholm's level-8
 * districts) are already inside the play area, so they're dropped —
 * which is exactly why same-level-only avoids offering areas that are
 * contained in the selection. No city-specific code.
 *
 * Single user-visible call — `findExtensionCandidates(...)` —
 * returns a list ready to render in a checkable picker.
 */

import type { TransitMode } from "@/lib/gameSetup";

import { getOverpassData } from "./overpass";
import type { OpenStreetMap } from "./types";
import { CacheType } from "./types";

/* ────────────────── Types ────────────────── */

export interface AdjacentAreaCandidate {
    /** Synthetic Photon-shaped feature, ready to push into
     *  `additionalMapGeoLocations`. */
    feature: OpenStreetMap;
    /** Centroid distance to the primary's centroid, in km. */
    distanceKm: number;
    /** True if at least one station of an allowed transit mode falls
     *  inside this candidate's bbox. Drives the pre-check default. */
    hasMatchingTransit: boolean;
    /** Estimated polygon area, in km², for display. */
    estimatedAreaKm2: number;
}

/* ────────────────── Public API ────────────────── */

/**
 * Find admin regions adjacent / nearby to `primary` at the same
 * administrative level, optionally filtered to those served by the
 * allowed transit modes.
 *
 * Returns at most `limit` candidates sorted by ascending distance.
 * Returns an empty array if the primary has no admin_level or no
 * geometry we can use.
 */
export async function findExtensionCandidates(
    primary: OpenStreetMap,
    allowedTransit: TransitMode[],
    options: { radiusKm?: number; limit?: number } = {},
): Promise<AdjacentAreaCandidate[]> {
    const radiusKm = options.radiusKm ?? 25;
    const limit = options.limit ?? 12;

    // Photon stores [lng, lat]; we swapped to [lat, lng] in the
    // geocode normaliser. Use that.
    const coords = primary.geometry.coordinates as unknown as [number, number];
    const [primaryLat, primaryLng] = coords;
    if (typeof primaryLat !== "number" || typeof primaryLng !== "number") {
        return [];
    }

    const primaryOsmId = primary.properties.osm_id;

    // The primary's own admin_level drives the granularity window every
    // candidate is filtered against (see `withinLevelWindow`). Fetched
    // up front because all three passes below feed through it. Stable
    // cached query, so this is usually an R2 hit. Null = the primary has
    // no usable admin_level, in which case the window filter no-ops and
    // we fall back to "any administrative boundary".
    const primaryAdminLevel = await fetchAdminLevel(primaryOsmId);
    const primaryLevel = primaryAdminLevel
        ? parseInt(primaryAdminLevel, 10)
        : null;

    // Topological-adjacency query — every admin relation that shares
    // at least one member way with the primary. Sharing a member way
    // is OSM's representation of "shares a boundary segment", so this
    // gives us the primary plus every neighbour, regardless of
    // admin_level. The old same-level-with-fallback heuristic was
    // brittle for consolidated cities and missed legitimate
    // neighbours at a different level.
    // IMPORTANT: this pass is wrapped in try/catch and treated as
    // best-effort. For a huge boundary (NYC's coastline references
    // thousands of ways, each referenced by many relations) the
    // `way(r); rel(bw)` expansion can blow past the timeout. Before
    // v464 that rejection propagated out of the whole function — so
    // NYC produced ZERO candidates even though the sub-units pass below
    // is exactly what yields its boroughs. Now a topological failure
    // just leaves `adjacencyElements` empty and the band + sub-units
    // passes still run.
    let adjacencyElements: OverpassRelationStub[] = [];
    try {
        const adjacencyData = await getOverpassData(
            buildTopologicalAdjacencyQuery(primaryOsmId),
            undefined,
            CacheType.ZONE_CACHE,
            90_000,
        );
        adjacencyElements = ((adjacencyData as { elements?: unknown[] })
            .elements ?? []) as OverpassRelationStub[];
    } catch (e) {
        console.warn(
            "Topological adjacency failed (continuing with proximity + sub-units):",
            e,
        );
    }

    // Pull all stations once; we then bbox-test each candidate
    // against this set. v268: query is now stable per (lat, lng,
    // radiusKm) — the user's allowed-transit selection is filtered
    // CLIENT-SIDE — so the cache key doesn't fan out across 2^5
    // mode subsets and the overpass-cache cron can usefully prewarm
    // every curated city's adjacent-search response.
    let allStations: Array<{ lat: number; lon: number; mode: TransitMode }> =
        [];
    if (allowedTransit.length > 0) {
        try {
            allStations = await fetchTransitStations(
                primaryLat,
                primaryLng,
                radiusKm,
            );
        } catch (e) {
            // Transit detection is a nice-to-have (drives the green
            // "transit-connected" tint); its failure must not zero out
            // the candidate set.
            console.warn("Transit-station fetch failed (continuing):", e);
        }
    }
    const stations = allStations.filter((s) => allowedTransit.includes(s.mode));

    const candidates: AdjacentAreaCandidate[] = [];
    const seen = new Set<number>();
    // Single funnel every pass feeds through: skip non-admin relations,
    // skip out-of-window granularity (parent regions ABOVE the primary,
    // micro-divisions far BELOW it), dedupe, build the candidate.
    const consider = (el: OverpassRelationStub) => {
        if (!isAdministrativeBoundary(el)) return;
        if (!withinLevelWindow(el, primaryLevel)) return;
        if (seen.has(el.id)) return;
        const c = relationStubToCandidate(
            el,
            primaryOsmId,
            primaryLat,
            primaryLng,
            stations,
        );
        if (c) {
            seen.add(el.id);
            candidates.push(c);
        }
    };
    for (const el of adjacencyElements) consider(el);

    // Proximity fallback. Two real cases this catches that topological
    // misses:
    //   1. Boundary-duplication countries (Sweden in particular): each
    //      municipality draws its own outer ways with no shared ids
    //      between neighbours, so `way(r); rel(bw);` returns no
    //      neighbours at all — Stockholm hits this hard.
    //   2. NEAR-neighbours that aren't directly adjacent but a seeker
    //      can plausibly play in (Järfälla doesn't touch Stockholm
    //      Municipality, but it sits ~15 km away and is plainly a
    //      Stockholm-area extension).
    //
    // To make this useful we run an ADMIN-LEVEL-MATCHED proximity
    // query. Stockholm Municipality is admin_level=7; its internal
    // districts (Södermalm, Norrmalm, …) are admin_level=8, and a
    // wider regex would pull those in as "adjacent areas" even though
    // they're SUB-AREAS of the primary, not peers. Looking up the
    // primary's own admin_level first and then asking only for peers
    // at that level filters those out cleanly while still catching
    // every kommun within range.
    //
    // Always run, then union+dedupe with the topological pass — that
    // way a region where topological DOES work (most of the world)
    // still gets its directly-adjacent peers, plus near-neighbours
    // surfaced by proximity. Limit + sort below picks the closest.
    try {
        if (primaryAdminLevel) {
            const bandQuery = buildAdjacentAdminQuery(
                primaryAdminLevel,
                primaryLat,
                primaryLng,
                radiusKm,
            );
            const bandData = await getOverpassData(
                bandQuery,
                undefined,
                CacheType.ZONE_CACHE,
                90_000,
            );
            const bandElements = ((bandData as { elements?: unknown[] })
                .elements ?? []) as OverpassRelationStub[];
            for (const el of bandElements) consider(el);

            // Sub-units pass — only for CONSOLIDATED-CITY / megacity
            // primaries (admin_level ≤ 5). NYC is the canonical case:
            // it sits at level 5 with no nearby level-5 peers, and the
            // user expects the boroughs as add-able sub-units to mix
            // and match (Manhattan + Brooklyn, etc.). Stockholm
            // Municipality (level 7) deliberately skips this — its
            // level-8 districts are sub-areas, not adjacent peers.
            // For a level-N primary we pull admin boundaries at N+1
            // and N+2 INSIDE the primary's area: that catches both
            // possible OSM tagging conventions for boroughs (some are
            // 6, some 7) without sweeping in fine-grained districts.
            // The `consider` funnel still applies the level window, so
            // anything finer than N+SUB_LEVEL_DEPTH is dropped here too.
            if (
                primaryLevel !== null &&
                Number.isFinite(primaryLevel) &&
                primaryLevel <= 5
            ) {
                try {
                    const subUnits = await fetchSubUnitsInArea(
                        primaryOsmId,
                        primaryLevel,
                    );
                    for (const el of subUnits) consider(el);
                } catch (e) {
                    console.warn(
                        "Sub-units pass failed (continuing without):",
                        e,
                    );
                }
            }
        }
    } catch (e) {
        console.warn(
            "Same-level proximity adjacency failed (continuing with topological only):",
            e,
        );
    }

    candidates.sort((a, b) => a.distanceKm - b.distanceKm);
    return candidates.slice(0, limit);
}

/** Sub-units pass for the consolidated-city case: every admin boundary
 *  at admin_level (N+1) or (N+2) INSIDE the primary's area. Used so
 *  NYC (level 5) returns its boroughs (most commonly level 6 or 7,
 *  varies by mapper) as add-able play-area extensions; never used for
 *  ordinary municipalities, whose own districts are SUB-areas and
 *  shouldn't be offered as adjacents. */
async function fetchSubUnitsInArea(
    primaryOsmId: number,
    primaryLevel: number,
): Promise<OverpassRelationStub[]> {
    // Overpass area-id convention: a relation with id N becomes an
    // `area(id:3600000000 + N)` for use as an area filter.
    const areaId = 3_600_000_000 + primaryOsmId;
    const lower = primaryLevel + 1;
    const upper = primaryLevel + 2;
    // Both digits are single-digit for any sensible primaryLevel ≤ 5,
    // so a character-class regex is safe and the cheapest form Overpass
    // can compile.
    const levelRegex = `^[${lower}${upper}]$`;
    const query = `
[out:json][timeout:60];
area(id:${areaId});
relation["admin_level"~"${levelRegex}"]["type"="boundary"]["boundary"="administrative"](area);
out tags bb;
`;
    const data = await getOverpassData(
        query,
        undefined,
        CacheType.ZONE_CACHE,
        90_000,
    );
    return ((data as { elements?: unknown[] }).elements ??
        []) as OverpassRelationStub[];
}

/** Fetch the `admin_level` tag of an OSM relation. Returns null if
 *  the relation has no `admin_level` tag, the query fails, or the tag
 *  isn't a sensible number string. Used by the proximity-adjacency
 *  fallback so we only surface SAME-LEVEL peers, not the primary's
 *  own sub-areas. */
async function fetchAdminLevel(osmId: number): Promise<string | null> {
    try {
        const data = await getOverpassData(
            buildAdminLevelQuery(osmId),
            undefined,
            CacheType.ZONE_CACHE,
            30_000,
        );
        const els = ((data as { elements?: unknown[] }).elements ??
            []) as Array<{ tags?: Record<string, string> }>;
        const lvl = els[0]?.tags?.admin_level;
        if (lvl && /^\d+$/.test(lvl)) return lvl;
        return null;
    } catch {
        return null;
    }
}

/** Filter: only offer admin-boundary relations as candidates. Skips
 *  national parks, postal codes, ceremonial areas etc. that share
 *  ways with the primary but aren't useful play-area extensions. */
function isAdministrativeBoundary(el: OverpassRelationStub): boolean {
    const tags = el.tags ?? {};
    if (tags.type !== "boundary") return false;
    return tags.boundary === "administrative";
}

/**
 * How many admin_levels BELOW the primary still count as a "reasonable
 * expansion" — but ONLY for consolidated-city / megacity primaries
 * (admin_level ≤ MEGACITY_MAX_LEVEL). NYC is the canonical case: it sits
 * at level 5 with no nearby level-5 peers, so its boroughs (county level
 * 6) are the wanted extensions even though they're CONTAINED in the
 * primary. For an ordinary city the immediate sub-units are its own
 * internal districts (Stockholm's Södermalm / Norrmalm at level 8 inside
 * the level-7 municipality) — those are already part of the play area,
 * never an "extension", so we admit ONLY same-level peers there (depth
 * 0). Same-level admin areas can't nest, which is what guarantees we
 * never offer something already inside the selected area.
 */
const SUB_LEVEL_DEPTH = 2;
const MEGACITY_MAX_LEVEL = 5;

/**
 * Granularity gate, generalised — NOT special-cased per city. A
 * candidate is a "reasonable expansion" only when its admin_level
 * sits in `[primaryLevel, primaryLevel + depth]`, where `depth` is
 * `SUB_LEVEL_DEPTH` for megacity primaries (≤ MEGACITY_MAX_LEVEL) and
 * `0` for everything else:
 *
 *   - BELOW the floor (numerically smaller level) → a parent region
 *     that engulfs the primary. The topological pass returns these
 *     because the primary's coast/border ways are shared with the
 *     state/country boundary (NY State, New Jersey for NYC). Never a
 *     play-area expansion — drop.
 *   - ABOVE the ceiling → for a normal city this is its own internal
 *     sub-areas (Stockholm's districts), which are already inside the
 *     play area; for a megacity it's the next tier finer than the
 *     wanted sub-units (NYC community districts). Drop.
 *   - INSIDE the window → same-level peers (Solna ↔ Stockholm), plus
 *     immediate sub-units for megacities only (boroughs ↔ NYC). Keep.
 *
 * When `primaryLevel` is null (the primary has no usable admin_level)
 * we can't reason about granularity, so the gate is a no-op and we
 * fall back to "any administrative boundary".
 */
export function withinLevelWindow(
    el: OverpassRelationStub,
    primaryLevel: number | null,
): boolean {
    if (primaryLevel === null || !Number.isFinite(primaryLevel)) return true;
    const raw = el.tags?.admin_level;
    const lvl = raw ? parseInt(raw, 10) : NaN;
    if (!Number.isFinite(lvl)) return false;
    const depth = primaryLevel <= MEGACITY_MAX_LEVEL ? SUB_LEVEL_DEPTH : 0;
    return lvl >= primaryLevel && lvl <= primaryLevel + depth;
}

/** Turn one Overpass admin-relation stub into a candidate (or null if
 *  it's the primary itself or lacks a bbox). Shared by the same-level
 *  and city-band passes. */
function relationStubToCandidate(
    el: OverpassRelationStub,
    primaryOsmId: number,
    primaryLat: number,
    primaryLng: number,
    stations: Array<{ lat: number; lon: number; mode: TransitMode }>,
): AdjacentAreaCandidate | null {
    if (el.id === primaryOsmId) return null;
    if (!el.bounds) return null;
    const name =
        el.tags?.name ||
        el.tags?.["name:en"] ||
        el.tags?.official_name ||
        `Relation ${el.id}`;

    const midLat = (el.bounds.minlat + el.bounds.maxlat) / 2;
    const midLng = (el.bounds.minlon + el.bounds.maxlon) / 2;
    const distanceKm = haversineKm(primaryLat, primaryLng, midLat, midLng);

    const hasMatchingTransit = stations.some(
        (s) =>
            s.lat >= el.bounds!.minlat &&
            s.lat <= el.bounds!.maxlat &&
            s.lon >= el.bounds!.minlon &&
            s.lon <= el.bounds!.maxlon,
    );

    return {
        feature: synthesiseOpenStreetMap(el, name),
        distanceKm,
        hasMatchingTransit,
        estimatedAreaKm2: bboxAreaKm2(el.bounds),
    };
}

/* ────────────────── Internals ────────────────── */

interface OverpassRelationStub {
    type: "relation";
    id: number;
    tags?: Record<string, string>;
    bounds?: {
        minlat: number;
        minlon: number;
        maxlat: number;
        maxlon: number;
    };
}

/**
 * Topological-adjacency query. Returns the primary plus every relation
 * that shares at least one member way with it — which, in OSM, is the
 * exact set of jurisdictions that share a boundary segment with the
 * primary.
 *
 * Step-by-step:
 *   - `relation(<id>)` selects the primary into the default set.
 *   - `way(r)` selects every way that's a member of the primary.
 *   - `rel(bw)` selects every relation whose member-way set
 *     intersects the previous way set. That's the primary again, plus
 *     all neighbours.
 *
 * `out tags bb` returns each relation's tags + bounding-box so the
 * downstream candidate construction has what it needs without
 * shipping full geometry. The primary itself is filtered out in
 * `relationStubToCandidate`; non-administrative-boundary relations
 * (national parks, postal areas, etc.) by `isAdministrativeBoundary`.
 *
 * Stable per primary id — `overpass-cache` can cache it freely.
 */
export function buildTopologicalAdjacencyQuery(primaryOsmId: number): string {
    return `
[out:json][timeout:120];
relation(${primaryOsmId});
way(r);
rel(bw);
out tags bb;
`;
}

/**
 * Look up the admin_level tag for an OSM relation. Stable query
 * keyed by relation id — matches buildAdminLevelQuery in the
 * overpass-cache cron. Retained for the worker's curated-city
 * prewarm + any external callers; the v427 adjacency rewrite no
 * longer uses it.
 */
export function buildAdminLevelQuery(osmId: number): string {
    return `
[out:json][timeout:25];
relation(${osmId});
out tags;
`;
}

/**
 * Same-admin_level proximity query: every admin boundary at the given
 * level within `radiusKm` of (lat, lng). `findExtensionCandidates`
 * runs this alongside the topological-adjacency pass and unions the
 * results, so the consumer gets:
 *   - directly-adjacent peers (from topological), AND
 *   - same-level peers within range (from this query) — covering both
 *     Sweden's duplicated-ways case where topological returns 0, and
 *     NEAR-neighbours that don't directly border the primary but a
 *     seeker can plausibly play in (e.g. Järfälla relative to
 *     Stockholm Municipality).
 * The admin_level filter excludes the primary's sub-areas (Sweden
 * districts at level 8 inside a level-7 kommun), which an
 * unrestricted level=7|8 band would noisily include.
 */
export function buildAdjacentAdminQuery(
    adminLevel: string,
    lat: number,
    lng: number,
    radiusKm: number,
): string {
    return `
[out:json][timeout:60];
relation["admin_level"="${adminLevel}"]["type"="boundary"](around:${radiusKm * 1000},${lat},${lng});
out tags bb;
`;
}

/**
 * Proximity-band query: every admin-level 7/8 boundary within
 * `radiusKm * 1000` metres of (lat, lng). Used by
 * `findExtensionCandidates` as the FALLBACK when topological
 * adjacency returns nothing — that happens in countries where each
 * municipality draws its own boundary ways (no shared way ids
 * between neighbours), most notably Sweden.
 */
export function buildMunicipalityBandQuery(
    lat: number,
    lng: number,
    radiusKm: number,
): string {
    return `
[out:json][timeout:60];
relation["admin_level"~"^[78]$"]["type"="boundary"](around:${radiusKm * 1000},${lat},${lng});
out tags bb;
`;
}

export const ADJACENT_SEARCH_DEFAULT_RADIUS_KM = 25;

/**
 * Pull every station of an allowed transit mode within `radiusKm`
 * of the primary's centroid. The query is one combined Overpass
 * request rather than one per mode — cheaper on the server and
 * easier to cache.
 */
/**
 * Build the stable transit-stations query used by adjacent-area
 * detection. v268: takes only (lat, lng, radiusKm) — NOT the user's
 * allowed-transit selection — so the cache key is stable per city.
 *
 * The overpass-cache cron emits the byte-identical query for every
 * curated city's centroid + DEFAULT_RADIUS_KM, so a user picking any
 * prewarmed city as a play area hits R2 instantly. The mode filter
 * lives in the caller (findExtensionCandidates).
 *
 * If you change the selector list / order / whitespace, mirror the
 * exact change in overpass-cache/src/index.ts → buildAdjacentStations
 * Query so the cache keys keep lining up.
 */
export function buildAdjacentStationsQuery(
    lat: number,
    lng: number,
    radiusKm: number,
): string {
    return `
[out:json][timeout:45];
(
  node["station"="subway"](around:${radiusKm * 1000},${lat},${lng});
  node["railway"="station"](around:${radiusKm * 1000},${lat},${lng});
  node["railway"="halt"](around:${radiusKm * 1000},${lat},${lng});
  node["railway"="tram_stop"](around:${radiusKm * 1000},${lat},${lng});
  node["amenity"="ferry_terminal"](around:${radiusKm * 1000},${lat},${lng});
);
out;
`;
}

async function fetchTransitStations(
    lat: number,
    lng: number,
    radiusKm: number,
): Promise<Array<{ lat: number; lon: number; mode: TransitMode }>> {
    const query = buildAdjacentStationsQuery(lat, lng, radiusKm);
    const data = await getOverpassData(
        query,
        undefined,
        CacheType.ZONE_CACHE,
        60_000,
    );
    const elements = ((data as { elements?: unknown[] }).elements ??
        []) as Array<{
        lat: number;
        lon: number;
        tags?: Record<string, string>;
    }>;
    return elements
        .filter((e) => typeof e.lat === "number" && typeof e.lon === "number")
        .map((e) => ({
            lat: e.lat,
            lon: e.lon,
            mode: inferMode(e.tags) ?? "train",
        }));
}

function inferMode(tags?: Record<string, string>): TransitMode | null {
    if (!tags) return null;
    if (tags.station === "subway") return "subway";
    if (tags.railway === "tram_stop") return "tram";
    if (tags.railway === "station" || tags.railway === "halt") return "train";
    if (tags.amenity === "ferry_terminal") return "ferry";
    return null;
}

/**
 * Convert an Overpass relation stub into a Photon-shaped
 * `OpenStreetMap` feature so it slots straight into the
 * `additionalMapGeoLocations` atom and renders in the same UIs as
 * regular Photon results.
 *
 * We synthesise the minimum fields the rest of the app reads:
 *   - `properties.osm_id`, `osm_type`, `name`
 *   - `properties.osm_key` / `osm_value` (admin boundary semantics)
 *   - `properties.extent` in `[maxLat, minLng, minLat, maxLng]` order
 *     (matching geocode.ts's normalisation)
 *   - `geometry.coordinates` = [centroidLat, centroidLng]
 */
function synthesiseOpenStreetMap(
    el: OverpassRelationStub,
    name: string,
): OpenStreetMap {
    const b = el.bounds!;
    const midLat = (b.minlat + b.maxlat) / 2;
    const midLng = (b.minlon + b.maxlon) / 2;
    return {
        type: "Feature",
        geometry: {
            type: "Point",
            coordinates: [midLat, midLng] as unknown as [number, number],
        },
        properties: {
            osm_type: "R",
            osm_id: el.id,
            name,
            type: el.tags?.["admin_level"] ?? "administrative",
            osm_key: "boundary",
            osm_value: "administrative",
            country: el.tags?.["is_in:country"] ?? "",
            state: el.tags?.["is_in:state"] ?? "",
            countrycode: el.tags?.["country_code"]?.toUpperCase() ?? "",
            extent: [b.maxlat, b.minlon, b.minlat, b.maxlon],
        },
    } as OpenStreetMap;
}

function haversineKm(
    lat1: number,
    lng1: number,
    lat2: number,
    lng2: number,
): number {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLng = ((lng2 - lng1) * Math.PI) / 180;
    const la1 = (lat1 * Math.PI) / 180;
    const la2 = (lat2 * Math.PI) / 180;
    const x =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
}

function bboxAreaKm2(bounds: {
    minlat: number;
    minlon: number;
    maxlat: number;
    maxlon: number;
}): number {
    const midLat = (bounds.minlat + bounds.maxlat) / 2;
    const latKm = Math.abs(bounds.maxlat - bounds.minlat) * 111;
    const lngKm =
        Math.abs(bounds.maxlon - bounds.minlon) *
        111 *
        Math.cos((midLat * Math.PI) / 180);
    return latKm * lngKm * 0.55; // match BBOX_FILL_FACTOR in geocode.ts
}
