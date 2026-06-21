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
 * Approach:
 *
 *   1. Look up the primary's `admin_level` directly from OSM
 *      (Photon doesn't expose it).
 *   2. Pull all admin relations at the same level within ~25 km
 *      of the primary's centroid.
 *   3. Pull all transit stations (rail / subway / tram / ferry /
 *      bus) within the same radius.
 *   4. For each candidate, decide whether it's "transit-connected"
 *      by checking if any station of an allowed mode falls inside
 *      the candidate's bbox.
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
    const adminLevel = await fetchAdminLevel(primaryOsmId);
    if (adminLevel === null) return [];

    // Pull nearby admin regions at the same level — tags + bbox
    // only, so we don't ship full polygon geometry for every
    // candidate (which would be slow and memory-heavy).
    const adminQuery = buildAdjacentAdminQuery(
        adminLevel,
        primaryLat,
        primaryLng,
        radiusKm,
    );
    // No loadingText: the wizard's adjacent-areas step has its
    // own inline spinner; a toast on top of that just
    // double-counts the loading state.
    const adminData = await getOverpassData(
        adminQuery,
        undefined,
        CacheType.ZONE_CACHE,
        90_000,
    );
    const adminElements = ((adminData as { elements?: unknown[] }).elements ??
        []) as OverpassRelationStub[];

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
    for (const el of adminElements) {
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

    // Fallback for consolidated cities. Some primaries sit at an
    // admin_level with NO same-level siblings nearby — most notably
    // New York City (admin_level 5; its neighbours Jersey City,
    // Hoboken, Newark, Yonkers are the normal city level 8), and other
    // consolidated city-counties. When the same-level search came up
    // empty, look for nearby admin areas in the city/municipality band
    // (levels 7–8) instead. (We exclude the coarser level 6 so a
    // consolidated city's own county-boroughs — e.g. NYC's 5 boroughs,
    // which are already inside the primary — aren't offered as
    // additions.) This query is NOT cron-prewarmed, so it's a live
    // Overpass call the first time, then cached.
    if (candidates.length === 0 && adminLevel !== "7" && adminLevel !== "8") {
        const bandQuery = buildMunicipalityBandQuery(
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
        const bandElements = ((bandData as { elements?: unknown[] }).elements ??
            []) as OverpassRelationStub[];
        for (const el of bandElements) {
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
    }

    candidates.sort((a, b) => a.distanceKm - b.distanceKm);
    return candidates.slice(0, limit);
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
 * Look up the admin_level tag for an OSM relation. Stable query
 * keyed by relation id — matches buildAdminLevelQuery in the
 * overpass-cache cron.
 */
export function buildAdminLevelQuery(osmId: number): string {
    return `
[out:json][timeout:25];
relation(${osmId});
out tags;
`;
}

/**
 * Pull every admin relation at the same level within `radiusKm` of
 * the primary's centroid. Stable query keyed by (level, lat, lng,
 * radiusKm) — matches buildAdjacentAdminQuery in the overpass-cache
 * cron. Keep the formatting identical to that worker copy or cache
 * hits will silently miss.
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
 * Fallback query for consolidated cities whose primary admin_level has
 * no same-level siblings nearby (e.g. New York City, admin_level 5).
 * Pulls admin relations in the normal city/municipality band — levels
 * 7–8 — within `radiusKm`. Deliberately excludes level 6 (counties /
 * boroughs) so a consolidated city's own constituent counties aren't
 * offered as additions. `out tags bb` for tags + bbox only.
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

async function fetchAdminLevel(osmId: number): Promise<string | null> {
    const query = buildAdminLevelQuery(osmId);
    const data = await getOverpassData(
        query,
        undefined,
        CacheType.ZONE_CACHE,
        30_000,
    );
    const elements = ((data as { elements?: unknown[] }).elements ??
        []) as Array<{ tags?: Record<string, string> }>;
    const level = elements[0]?.tags?.admin_level;
    return level ?? null;
}

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
