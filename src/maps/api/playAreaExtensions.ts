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

    // Topological-adjacency query — every admin relation that shares
    // at least one member way with the primary. Sharing a member way
    // is OSM's representation of "shares a boundary segment", so this
    // gives us the primary plus every neighbour, regardless of
    // admin_level. The old same-level-with-fallback heuristic was
    // brittle for consolidated cities and missed legitimate
    // neighbours at a different level.
    const adjacencyQuery = buildTopologicalAdjacencyQuery(primaryOsmId);
    const adjacencyData = await getOverpassData(
        adjacencyQuery,
        undefined,
        CacheType.ZONE_CACHE,
        90_000,
    );
    const adjacencyElements = ((adjacencyData as { elements?: unknown[] })
        .elements ?? []) as OverpassRelationStub[];

    // Pull all stations once; we then bbox-test each candidate
    // against this set. v268: query is now stable per (lat, lng,
    // radiusKm) — the user's allowed-transit selection is filtered
    // CLIENT-SIDE — so the cache key doesn't fan out across 2^5
    // mode subsets and the overpass-cache cron can usefully prewarm
    // every curated city's adjacent-search response.
    const allStations =
        allowedTransit.length > 0
            ? await fetchTransitStations(primaryLat, primaryLng, radiusKm)
            : [];
    const stations = allStations.filter((s) => allowedTransit.includes(s.mode));

    const candidates: AdjacentAreaCandidate[] = [];
    const seen = new Set<number>();
    for (const el of adjacencyElements) {
        if (!isAdministrativeBoundary(el)) continue;
        const c = relationStubToCandidate(
            el,
            primaryOsmId,
            primaryLat,
            primaryLng,
            stations,
        );
        if (c && !seen.has(el.id)) {
            seen.add(el.id);
            candidates.push(c);
        }
    }

    candidates.sort((a, b) => a.distanceKm - b.distanceKm);
    return candidates.slice(0, limit);
}

/** Filter: only offer admin-boundary relations as candidates. Skips
 *  national parks, postal codes, ceremonial areas etc. that share
 *  ways with the primary but aren't useful play-area extensions. */
function isAdministrativeBoundary(el: OverpassRelationStub): boolean {
    const tags = el.tags ?? {};
    if (tags.type !== "boundary") return false;
    return tags.boundary === "administrative";
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
 * @deprecated v427 — the same-admin_level proximity heuristic missed
 * legitimate neighbours at a different level (consolidated cities, the
 * county/municipality bands, etc.). `findExtensionCandidates` now uses
 * topological adjacency via `buildTopologicalAdjacencyQuery`. This
 * function is retained as an export so the overpass-cache cron + any
 * curated-city prewarm path keeps building; do NOT use it for fresh
 * lookups.
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
 * @deprecated v427 — see `buildAdjacentAdminQuery`.
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
