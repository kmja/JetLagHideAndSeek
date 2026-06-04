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
    const coords = primary.geometry.coordinates as unknown as [
        number,
        number,
    ];
    const [primaryLat, primaryLng] = coords;
    if (
        typeof primaryLat !== "number" ||
        typeof primaryLng !== "number"
    ) {
        return [];
    }

    const primaryOsmId = primary.properties.osm_id;
    const adminLevel = await fetchAdminLevel(primaryOsmId);
    if (adminLevel === null) return [];

    // Pull nearby admin regions at the same level — tags + bbox
    // only, so we don't ship full polygon geometry for every
    // candidate (which would be slow and memory-heavy).
    const adminQuery = `
[out:json][timeout:60];
relation["admin_level"="${adminLevel}"]["type"="boundary"](around:${radiusKm * 1000},${primaryLat},${primaryLng});
out tags bb;
`;
    const adminData = await getOverpassData(
        adminQuery,
        "Looking for adjacent areas…",
        CacheType.ZONE_CACHE,
        90_000,
    );
    const adminElements = (
        (adminData as { elements?: unknown[] }).elements ?? []
    ) as OverpassRelationStub[];

    // Pull all stations of allowed modes once; we then bbox-test
    // each candidate against this set. Cheaper than per-candidate
    // queries, especially with N≈10-20 candidates.
    const stations: Array<{ lat: number; lon: number; mode: TransitMode }> =
        allowedTransit.length > 0
            ? await fetchTransitStations(
                  primaryLat,
                  primaryLng,
                  radiusKm,
                  allowedTransit,
              )
            : [];

    const candidates: AdjacentAreaCandidate[] = [];
    for (const el of adminElements) {
        if (el.id === primaryOsmId) continue;
        if (!el.bounds) continue;
        const name =
            el.tags?.name ||
            el.tags?.["name:en"] ||
            el.tags?.official_name ||
            `Relation ${el.id}`;

        const midLat = (el.bounds.minlat + el.bounds.maxlat) / 2;
        const midLng = (el.bounds.minlon + el.bounds.maxlon) / 2;
        const distanceKm = haversineKm(
            primaryLat,
            primaryLng,
            midLat,
            midLng,
        );

        const hasMatchingTransit = stations.some(
            (s) =>
                s.lat >= el.bounds!.minlat &&
                s.lat <= el.bounds!.maxlat &&
                s.lon >= el.bounds!.minlon &&
                s.lon <= el.bounds!.maxlon,
        );

        const feature = synthesiseOpenStreetMap(el, name);
        candidates.push({
            feature,
            distanceKm,
            hasMatchingTransit,
            estimatedAreaKm2: bboxAreaKm2(el.bounds),
        });
    }

    candidates.sort((a, b) => a.distanceKm - b.distanceKm);
    return candidates.slice(0, limit);
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

async function fetchAdminLevel(osmId: number): Promise<string | null> {
    const query = `
[out:json][timeout:25];
relation(${osmId});
out tags;
`;
    const data = await getOverpassData(
        query,
        undefined,
        CacheType.ZONE_CACHE,
        30_000,
    );
    const elements = (
        (data as { elements?: unknown[] }).elements ?? []
    ) as Array<{ tags?: Record<string, string> }>;
    const level = elements[0]?.tags?.admin_level;
    return level ?? null;
}

/**
 * Pull every station of an allowed transit mode within `radiusKm`
 * of the primary's centroid. The query is one combined Overpass
 * request rather than one per mode — cheaper on the server and
 * easier to cache.
 */
async function fetchTransitStations(
    lat: number,
    lng: number,
    radiusKm: number,
    allowedTransit: TransitMode[],
): Promise<Array<{ lat: number; lon: number; mode: TransitMode }>> {
    // Map our internal transit-mode enum to the OSM tag selectors
    // that pick up the relevant station nodes.
    const selectors: string[] = [];
    if (allowedTransit.includes("subway")) {
        selectors.push(`node["station"="subway"](around:${radiusKm * 1000},${lat},${lng});`);
    }
    if (allowedTransit.includes("train")) {
        selectors.push(`node["railway"="station"](around:${radiusKm * 1000},${lat},${lng});`);
        selectors.push(`node["railway"="halt"](around:${radiusKm * 1000},${lat},${lng});`);
    }
    if (allowedTransit.includes("tram")) {
        selectors.push(`node["railway"="tram_stop"](around:${radiusKm * 1000},${lat},${lng});`);
    }
    if (allowedTransit.includes("bus")) {
        // Skip bus for adjacency detection — buses cross EVERY admin
        // boundary, so they'd pre-check every candidate. The user
        // can manually check those if they really want bus-extended
        // play areas.
    }
    if (allowedTransit.includes("ferry")) {
        selectors.push(`node["amenity"="ferry_terminal"](around:${radiusKm * 1000},${lat},${lng});`);
    }
    if (selectors.length === 0) return [];

    const query = `
[out:json][timeout:45];
(
  ${selectors.join("\n  ")}
);
out;
`;
    const data = await getOverpassData(
        query,
        undefined,
        CacheType.ZONE_CACHE,
        60_000,
    );
    const elements = (
        (data as { elements?: unknown[] }).elements ?? []
    ) as Array<{ lat: number; lon: number; tags?: Record<string, string> }>;
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
