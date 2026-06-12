import * as turf from "@turf/turf";
import { atom } from "nanostores";

import {
    additionalMapGeoLocations,
    mapGeoLocation,
    polyGeoJSON,
} from "@/lib/context";
import { LOCATION_FIRST_TAG } from "@/maps/api/constants";
import { getOverpassData } from "@/maps/api/overpass";
import { CacheType } from "@/maps/api/types";
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

/** Map a matching/measuring subtype string to the cache family that
 *  serves it, or null when it isn't a play-area-cacheable family
 *  (city / coastline / high-speed rail / custom geometry — those use
 *  the bundled dataset or their own path). Shared by the hiding-
 *  period preloader and the on-tap warm-up so there's exactly one
 *  policy for "what does this subtype need". */
export function cacheableFamilyForType(typeRaw: string): FamilyKey | null {
    const stripped = typeRaw.endsWith("-full")
        ? typeRaw.slice(0, -"-full".length)
        : typeRaw;
    if (stripped === "airport") return "airport";
    if (
        stripped === "rail-measure" ||
        stripped === "same-train-line" ||
        stripped === "same-length-station"
    ) {
        return "rail-station";
    }
    if (stripped === "mcdonalds") return "brand:Q38076" as FamilyKey;
    if (stripped === "seven11") return "brand:Q259340" as FamilyKey;
    if (stripped in LOCATION_FIRST_TAG) {
        return `api:${stripped}` as FamilyKey;
    }
    return null;
}

/**
 * Build an Overpass `[bbox:south,west,north,east]` filter string for
 * the current play area, padded by `padKm` so the seeker's nearest
 * reference near the play-area edge can still be just outside the
 * strict boundary.
 *
 * Why bbox and not the proper poly: filter? The nearest-reference
 * lookup doesn't care whether the museum/zoo/airport is inside the
 * play area — only that it's THE NEAREST to the seeker. Using the
 * polygon would make us miss references just outside the play-area
 * edge, and (more importantly) the polygon serialised into the query
 * string is enormous for complex shapes and trips the public mirrors'
 * request-size limit — that was the v190 "8/8 warm but no results"
 * bug. The bbox is two coordinates regardless of polygon complexity.
 * The matching/measuring elimination path STILL uses the polygon
 * (that path cares about "in the play area" for the Voronoi math) —
 * just not this lookup.
 *
 * Returns null when no play area is set (no bbox to derive from).
 */
function buildPaddedBboxFilter(padKm: number): string | null {
    const $polyGeoJSON = polyGeoJSON.get();
    let bbox: [number, number, number, number] | null = null;
    if ($polyGeoJSON) {
        try {
            bbox = turf.bbox($polyGeoJSON as any) as [
                number,
                number,
                number,
                number,
            ];
        } catch {
            bbox = null;
        }
    }
    if (!bbox) {
        // No polygon yet — fall back to the play-area Photon extent
        // (which is roughly a country/region bbox). Better than
        // nothing; the actual fetch will refine on the next round.
        const primary = mapGeoLocation.get();
        const extent = (primary?.properties as { extent?: number[] })
            ?.extent;
        if (extent && extent.length === 4) {
            // extent is [maxLat, minLng, minLat, maxLng] post-normalize.
            const [maxLat, minLng, minLat, maxLng] = extent;
            bbox = [minLng, minLat, maxLng, maxLat];
        }
    }
    if (!bbox) return null;
    const [west, south, east, north] = bbox;
    // Pad: ~111 km per degree of latitude; longitude shrinks with
    // cos(latitude). The pad is a soft buffer — exact precision
    // doesn't matter, only that it adds tens of km on every side.
    const latPad = padKm / 111;
    const midLat = (south + north) / 2;
    const lngPad = padKm / (111 * Math.cos((midLat * Math.PI) / 180));
    return `[bbox:${south - latPad},${west - lngPad},${north + latPad},${east + lngPad}]`;
}

/** Turn a raw Overpass element into a cache feature, or null when it
 *  lacks usable coordinates or a name. */
function featureFromElement(el: any): PrefetchedFeature | null {
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const name = el.tags?.["name:en"] ?? el.tags?.["name"] ?? el.tags?.["iata"];
    if (!name) return null;
    return { lat, lng: lon, name };
}

/** Whether an Overpass element belongs to a given family, by tags.
 *  Used to partition a single combined query's results back into the
 *  per-family caches. */
function elementMatchesFamily(el: any, family: FamilyKey): boolean {
    const tags = el.tags ?? {};
    if (family.startsWith("api:")) {
        const loc = family.slice(4) as APILocations;
        return tags[LOCATION_FIRST_TAG[loc]] === loc;
    }
    if (family.startsWith("brand:")) {
        return tags["brand:wikidata"] === family.slice(6);
    }
    if (family === "airport") {
        return tags["aeroway"] === "aerodrome" && Boolean(tags["iata"]);
    }
    if (family === "rail-station") {
        return tags["railway"] === "station";
    }
    return false;
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

    bumpStatus({ inFlightDelta: 1 });
    const promise = (async () => {
        try {
            const elements = await runBboxOverpassFetch([
                filterForFamily(family),
            ]);
            const features: PrefetchedFeature[] = [];
            for (const el of elements) {
                const feat = featureFromElement(el);
                if (feat) features.push(feat);
            }
            cache.set(key, features);
            bumpStatus({ warmedKey: key, count: features.length });
            return features;
        } catch (e) {
            bumpStatus({ failedKey: key });
            throw e;
        } finally {
            inFlight.delete(key);
            bumpStatus({ inFlightDelta: -1 });
        }
    })();
    inFlight.set(key, promise);
    return promise;
}

/**
 * Issue a single bbox-filtered Overpass query for one-or-more
 * `nwr` filters. The bbox covers the current play area plus a
 * generous pad, so a seeker near the edge can still resolve a
 * nearest reference just outside the strict boundary. Returns the
 * raw `elements` array; partition by tag at the call site.
 *
 * Uses `getOverpassData` directly (not `findPlacesInZone`) because
 * findPlacesInZone always builds a poly: filter from the play-area
 * polygon — which is unnecessary here and was the v190 budget-blowup
 * trigger.
 */
async function runBboxOverpassFetch(filters: string[]): Promise<any[]> {
    if (filters.length === 0) return [];
    const bboxFilter = buildPaddedBboxFilter(50);
    if (!bboxFilter) return [];
    const body = filters.map((f) => `nwr${f};`).join("\n");
    const query = `
[out:json][timeout:120]${bboxFilter};
(
${body}
);
out center;
`;
    const data = await getOverpassData(
        query,
        undefined,
        CacheType.ZONE_CACHE,
        undefined,
        false,
        undefined,
        // silent=true: prefetch failures fall back to the lazy
        // per-tap retry; they should never spawn a user-facing toast.
        true,
    );
    return ((data as { elements?: any[] })?.elements ?? []) as any[];
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

/**
 * Warm a whole set of families in ONE Overpass query.
 *
 * This is the heart of the consolidation: instead of firing N
 * separate `findPlacesInZone` calls (one per category — the thing
 * that produced the cascade of rate-limit failures), we union every
 * `out center` family into a single query, then partition the
 * response back into the per-family caches by tag. One request, one
 * R2 cache entry, one chance to fail — and on failure the lazy
 * per-tap `prefetchCategory` still covers each family individually.
 *
 * Only the `out center` families (amenity/tourism/leisure points,
 * airports, train stations, brands) can share a query — high-speed
 * rail needs `out geom` and the bundled major-city/coastline paths
 * aren't Overpass at all, so those stay separate (handled by the
 * caller).
 *
 * Families already warm under the current play-area signature are
 * skipped, so calling this repeatedly is cheap.
 */
export async function prefetchFamiliesInOneQuery(
    families: FamilyKey[],
): Promise<void> {
    if (!playAreaSignature()) return;
    const todo = families.filter((f) => !cache.get(cacheKey(f)));
    if (todo.length === 0) return;

    todo.forEach(() => bumpStatus({ inFlightDelta: 1 }));
    try {
        // One unioned query keyed on the play-area BBOX (see
        // runBboxOverpassFetch / buildPaddedBboxFilter): a tiny,
        // fixed-size filter regardless of polygon complexity, so a
        // crenellated county boundary can't blow the request-size
        // budget that the v190 poly: path tripped on.
        const filters = todo.map(filterForFamily);
        const elements = await runBboxOverpassFetch(filters);
        const emptyFamilies: FamilyKey[] = [];
        for (const family of todo) {
            const feats: PrefetchedFeature[] = [];
            for (const el of elements) {
                if (!elementMatchesFamily(el, family)) continue;
                const feat = featureFromElement(el);
                if (feat) feats.push(feat);
            }
            if (feats.length === 0) {
                // The combined query came back without anything for
                // this family. Two real reasons this happens:
                //   1. The play area genuinely has no instances (no
                //      aquariums in a forest county, no airports in a
                //      neighborhood — fine, the cache should record 0).
                //   2. The unioned Overpass query was too big for the
                //      mirror and got truncated — symptom is "8 of 8
                //      categories warm, 0 in each except railway"
                //      (railway came first in the union and finished
                //      under the server's budget; the rest fell off).
                // We can't tell the two apart from one response, so we
                // re-issue per-family for any 0-result family. A
                // single-family query is small (sub-second on a
                // healthy mirror) and the existing prefetchCategory
                // path already R2-caches + dedups in-flight + reports
                // status — so falling through to it is the natural
                // fix. Don't pre-emptively write 0 to the cache yet;
                // prefetchCategory will write the authoritative count.
                emptyFamilies.push(family);
            } else {
                cache.set(cacheKey(family), feats);
                bumpStatus({
                    warmedKey: cacheKey(family),
                    count: feats.length,
                });
            }
        }
        if (emptyFamilies.length > 0) {
            console.debug(
                `[preload] ${emptyFamilies.length} families empty in combined query — re-fetching individually`,
            );
            for (const f of emptyFamilies) {
                prefetchCategory(f).catch(() => {
                    bumpStatus({ failedKey: cacheKey(f) });
                });
            }
        }
    } catch {
        // Whole-batch failure: mark each family failed so the status
        // pill is honest, then let the lazy per-tap path retry them
        // one at a time when actually needed.
        todo.forEach((f) => bumpStatus({ failedKey: cacheKey(f) }));
    } finally {
        todo.forEach(() => bumpStatus({ inFlightDelta: -1 }));
    }
}

/* ─────────────────── Live status (for UI) ─────────────────── */

/**
 * Live cache-status snapshot, surfaced to a small floating pill so
 * the player can see at a glance whether the warm-up has actually
 * landed. Reset whenever the play area changes (signature flip).
 *
 *   total       — how many distinct family keys we've ever asked
 *                 for under the current play-area signature
 *   warmed      — keys with a successful cache entry (could be 0
 *                 features — empty play area for that family — but
 *                 still counts as "answered")
 *   failed      — keys whose last attempt threw or returned null
 *                 (the lazy fallback will retry on next use)
 *   inFlight    — fetches currently in flight
 *   features    — total feature count across all warmed keys, so
 *                 the pill can show a meaningful "X amenities"
 *                 number rather than a meaningless "14 categories"
 *   lastUpdate  — Unix ms, refreshed on every transition (drives a
 *                 small "just now / 30s ago" pill subtitle)
 */
export interface PrefetchStatus {
    signature: string;
    total: number;
    warmed: number;
    failed: number;
    inFlight: number;
    features: number;
    lastUpdate: number;
    /** Per-family detail for the expanded panel: family key → result. */
    perFamily: Record<
        string,
        { state: "in-flight" | "warm" | "failed"; count: number }
    >;
}

function emptyStatus(signature: string): PrefetchStatus {
    return {
        signature,
        total: 0,
        warmed: 0,
        failed: 0,
        inFlight: 0,
        features: 0,
        lastUpdate: Date.now(),
        perFamily: {},
    };
}

export const prefetchStatus = atom<PrefetchStatus>(emptyStatus(""));

/** Apply a transition to `prefetchStatus`. Recomputes derived
 *  counts so subscribers always see a self-consistent snapshot.
 *  Drops anything from a previous play-area signature on the floor. */
function bumpStatus(args: {
    warmedKey?: string;
    failedKey?: string;
    count?: number;
    inFlightDelta?: number;
}): void {
    const sig = playAreaSignature();
    const current = prefetchStatus.get();
    const next: PrefetchStatus =
        current.signature === sig
            ? { ...current, perFamily: { ...current.perFamily } }
            : emptyStatus(sig);

    if (args.warmedKey) {
        const familyFromKey = args.warmedKey.split("|")[1] ?? args.warmedKey;
        next.perFamily[familyFromKey] = {
            state: "warm",
            count: args.count ?? 0,
        };
    }
    if (args.failedKey) {
        const familyFromKey = args.failedKey.split("|")[1] ?? args.failedKey;
        // Don't downgrade a previously-warm key on a later failure —
        // the cache still holds the older result, the failure was on
        // a refresh attempt.
        if (next.perFamily[familyFromKey]?.state !== "warm") {
            next.perFamily[familyFromKey] = { state: "failed", count: 0 };
        }
    }
    if (args.inFlightDelta) {
        next.inFlight = Math.max(0, next.inFlight + args.inFlightDelta);
    }

    const entries = Object.values(next.perFamily);
    next.warmed = entries.filter((e) => e.state === "warm").length;
    next.failed = entries.filter((e) => e.state === "failed").length;
    next.features = entries.reduce(
        (acc, e) => acc + (e.state === "warm" ? e.count : 0),
        0,
    );
    // `total` reflects the families this game has actually engaged
    // with (the preloader registers them all up front via the
    // in-flight bump), so the pill reads e.g. "11/12 warm".
    next.total = Object.keys(next.perFamily).length || next.inFlight;
    next.lastUpdate = Date.now();

    prefetchStatus.set(next);
}
