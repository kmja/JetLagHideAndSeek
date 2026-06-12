import * as turf from "@turf/turf";

import {
    additionalMapGeoLocations,
    mapGeoLocation,
} from "@/lib/context";
import { LOCATION_FIRST_TAG } from "@/maps/api/constants";
import { findPlacesInZone } from "@/maps/api/overpass";
import type { APILocations } from "@/maps/schema";

/**
 * Play-area-wide amenity prefetch.
 *
 * Background: matching / measuring questions used to resolve their
 * "nearest reference" by walking an Overpass radius around the
 * seeker (30 mi → 60 mi → 90 mi → …). Every tap on a different
 * subtype fired a fresh request, and each request burned a slot
 * against the public mirrors' per-IP rate limit. In practice the
 * seeker would see "Could not load data from Overpass (all mirrors
 * timed out or rate-limited)" toasts every few questions — most
 * visibly when playing fast.
 *
 * This module replaces that hot path with a single
 * `findPlacesInZone` call per category per play-area: ONE query
 * returns all hospitals (or zoos, or museums, etc.) inside the
 * play polygon, with `out center` so each feature is a 1-coord
 * point. `turf.nearestPoint` then resolves the seeker's reference
 * locally — zero network, instant.
 *
 * The cache is keyed by `(playAreaSignature, family)`, so picking
 * a new play area silently invalidates everything; the next
 * matching tap re-prefetches. Cache is in-memory only — the
 * per-Overpass-request cacheFetch layer (R2 + IndexedDB) already
 * persists the underlying response, so a reload is cheap even
 * without an explicit localStorage tier here.
 */

/** Family key. `api:<APILocations>` covers the LOCATION_FIRST_TAG
 *  set; `brand:<wikidataId>` covers chain-brand questions; the
 *  bare strings cover the family kinds that don't take a parameter. */
export type FamilyKey =
    | `api:${APILocations}`
    | `brand:${string}`
    | "airport"
    | "rail-station";

export interface PrefetchedFeature {
    lat: number;
    lng: number;
    name: string;
}

const cache = new Map<string, PrefetchedFeature[]>();
const inFlight = new Map<string, Promise<PrefetchedFeature[]>>();

/** Stable string identifying the *current* play area. Built from
 *  the OSM relation IDs of the primary play area plus any added
 *  extras (subtracted polygons don't change the search universe —
 *  they're applied as a post-filter inside findPlacesInZone). */
function playAreaSignature(): string {
    const pa = mapGeoLocation.get();
    const extras = additionalMapGeoLocations.get();
    const ids: Array<string | number> = [];
    if (pa?.properties?.osm_id) ids.push(pa.properties.osm_id);
    for (const e of extras) {
        if (e.added && e.location.properties.osm_id) {
            ids.push(e.location.properties.osm_id);
        }
    }
    ids.sort();
    return ids.join(",");
}

function cacheKey(family: FamilyKey): string {
    return `${playAreaSignature()}|${family}`;
}

/** The Overpass `nwr[…]` filter string for each family. The same
 *  format `findPlacesInZone` expects — it appends `(poly:…)` /
 *  `(area.regionN)` itself. */
function filterForFamily(family: FamilyKey): string {
    if (family.startsWith("api:")) {
        const loc = family.slice(4) as APILocations;
        return `["${LOCATION_FIRST_TAG[loc]}"="${loc}"]`;
    }
    if (family.startsWith("brand:")) {
        return `["brand:wikidata"="${family.slice(6)}"]`;
    }
    if (family === "airport") return '["aeroway"="aerodrome"]["iata"]';
    if (family === "rail-station") return '["railway"="station"]';
    throw new Error(`unknown family ${family}`);
}

/** Search type per family — `nwr` for most amenity tags (some
 *  museums and parks are mapped as ways/relations rather than
 *  nodes), `node` for railway stations (always nodes). */
function searchTypeForFamily(family: FamilyKey): "nwr" | "node" {
    if (family === "rail-station") return "node";
    return "nwr";
}

/**
 * Fetch (or return cached) features for the given family within
 * the current play area. Idempotent and dedups concurrent callers
 * — five simultaneous matching taps for "hospital" share a single
 * Overpass round trip. Throws inherit from `findPlacesInZone`;
 * callers fall back to the radius-based path when this rejects.
 */
export async function prefetchCategory(
    family: FamilyKey,
): Promise<PrefetchedFeature[]> {
    if (!playAreaSignature()) return [];
    const key = cacheKey(family);
    const hit = cache.get(key);
    if (hit) return hit;
    const racing = inFlight.get(key);
    if (racing) return racing;

    const promise = (async () => {
        try {
            const data = await findPlacesInZone(
                filterForFamily(family),
                undefined,
                searchTypeForFamily(family),
                "center",
                [],
                60,
            );
            const elements = (data as { elements?: any[] })?.elements ?? [];
            const features: PrefetchedFeature[] = [];
            for (const el of elements) {
                const lat = el.lat ?? el.center?.lat;
                const lon = el.lon ?? el.center?.lon;
                if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
                const name =
                    el.tags?.["name:en"] ??
                    el.tags?.["name"] ??
                    el.tags?.["iata"];
                if (!name) continue;
                features.push({ lat, lng: lon, name });
            }
            cache.set(key, features);
            return features;
        } finally {
            inFlight.delete(key);
        }
    })();
    inFlight.set(key, promise);
    return promise;
}

/** Synchronous cache lookup. Returns null if nothing has been
 *  prefetched for this (play-area, family) pair yet. */
export function getCachedCategory(
    family: FamilyKey,
): PrefetchedFeature[] | null {
    return cache.get(cacheKey(family)) ?? null;
}

/** Resolve the nearest prefetched feature to a point. Returns
 *  null if the category hasn't been prefetched, or if the play
 *  area is empty of that family. */
export function nearestFromCache(
    family: FamilyKey,
    lat: number,
    lng: number,
): { name: string; lat: number; lng: number; distanceMeters: number } | null {
    const features = getCachedCategory(family);
    if (!features || features.length === 0) return null;
    const target = turf.point([lng, lat]);
    let best: {
        name: string;
        lat: number;
        lng: number;
        distanceMeters: number;
    } | null = null;
    for (const f of features) {
        const d = turf.distance(target, turf.point([f.lng, f.lat]), {
            units: "meters",
        });
        if (!best || d < best.distanceMeters) {
            best = {
                name: f.name,
                lat: f.lat,
                lng: f.lng,
                distanceMeters: d,
            };
        }
    }
    return best;
}

/** The set of categories the seeker's matching / measuring picker
 *  can resolve through the play-area-wide cache. Highspeed-rail
 *  and city/coastline are deliberately excluded — they need wider-
 *  than-play-area searches or already use a non-Overpass path. */
function standardFamilies(): FamilyKey[] {
    const apis = (Object.keys(LOCATION_FIRST_TAG) as APILocations[]).map(
        (loc) => `api:${loc}` as FamilyKey,
    );
    return [
        ...apis,
        "airport",
        "rail-station",
        // The two rulebook brand-quiz subtypes. Cheap to prefetch
        // play-area-wide; outside a brand-heavy country (most of
        // Europe outside the UK lacks 7-Eleven, etc.) the response
        // is empty and the cache key short-circuits forever.
        "brand:Q38076" as FamilyKey, // McDonald's
        "brand:Q259340" as FamilyKey, // 7-Eleven
    ];
}

/**
 * Warm the cache for every standard category in the background.
 * Spaced ~250 ms apart so we don't smash the Overpass mirrors (or
 * our R2-backed cache worker) with a 14-fold concurrent burst the
 * instant the seeker finishes setup. Each prefetch swallows its
 * own errors — a single category failure shouldn't block the
 * others, and the lazy fallback in `fetchNearest` will retry the
 * failed family on first use.
 */
export async function prefetchAllStandardCategories(): Promise<void> {
    if (!playAreaSignature()) return;
    for (const f of standardFamilies()) {
        prefetchCategory(f).catch(() => {
            /* lazy path covers retries */
        });
        await new Promise((r) => setTimeout(r, 250));
    }
}
