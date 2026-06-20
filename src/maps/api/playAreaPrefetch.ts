import * as turf from "@turf/turf";
import { atom } from "nanostores";

import {
    additionalMapGeoLocations,
    mapGeoLocation,
    polyGeoJSON,
} from "@/lib/context";
import { LOCATION_FIRST_TAG, REFS_BY_RELATION_BASE } from "@/maps/api/constants";
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
    /** Full OSM tag dict from the source element. Preserved so the
     *  Overpass-shape adapter (`findCachedPlaces`) can hand callers
     *  the same `{ tags: {...} }` they'd read off a raw response —
     *  matching/measuring's `uniqBy(... f.tags.iata)` relies on this. */
    tags?: Record<string, string>;
}

const cache = new Map<string, PrefetchedFeature[]>();
const inFlight = new Map<string, Promise<PrefetchedFeature[]>>();

/** Single-flight gate + recent-failure backoff for the master
 *  prefetchFamiliesInOneQuery — what tries to warm every reference
 *  family in one combined Overpass call. Keyed on the play-area
 *  signature so a play-area change resets both.
 *
 *  v355: the Frankfurt-with-spoofed-GPS HAR showed 41 attempts at
 *  the same master query firing in bursts of 2-3 simultaneous calls
 *  over 9 minutes — every subtype hover/click triggered a fresh
 *  `prefetchCategory("…")` whose per-family inFlight gate doesn't
 *  cover the SHARED master query underneath. Every burst got
 *  rate-limited by Overpass (`429 rate_limited`), which left the
 *  whole reference cache empty and made the per-question `around:`
 *  lookups also rate-limited. Net effect: matching/measuring
 *  "couldn't find a reference" for the whole session.
 *
 *  - `masterInFlight` coalesces concurrent callers to ONE underlying
 *    request, so a burst of clicks fires one query, not N.
 *  - `masterRecentFailureAt` records the wall-clock of the last
 *    failed attempt. While we're inside the backoff window, callers
 *    return immediately without re-issuing — the lazy per-tap
 *    radius-walk path still runs for the specific family the user
 *    actually wants, and the master can be re-attempted after the
 *    window expires (or on a play-area change). */
const masterInFlight = new Map<string, Promise<void>>();
const masterRecentFailureAt = new Map<string, number>();
const MASTER_FAILURE_BACKOFF_MS = 60_000;

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

/**
 * Canonical list of reference families both client and cron must use
 * to produce identical R2 cache keys. Sorted alphabetically because
 * `runBboxOverpassFetch` also sorts before serialising — the body
 * must come out the same on both sides or the SHA-256 cache key
 * differs and the cron's pre-warmed entry silently misses.
 *
 * The list is INTENTIONALLY game-size-agnostic. A large game can't
 * ask a `-full` matching question, but warming those families anyway
 * costs almost nothing (a few extra features in one combined Overpass
 * response) and means every game size lands on the same R2 entry.
 *
 * Mirrored byte-for-byte in `REFERENCE_FAMILY_FILTERS` in
 * `overpass-cache/src/index.ts` — keep them in lockstep.
 */
export const STANDARD_REFERENCE_FAMILIES: FamilyKey[] = [
    "airport",
    "api:aquarium" as FamilyKey,
    "api:cinema" as FamilyKey,
    "api:consulate" as FamilyKey,
    "api:golf_course" as FamilyKey,
    "api:hospital" as FamilyKey,
    "api:library" as FamilyKey,
    "api:museum" as FamilyKey,
    "api:park" as FamilyKey,
    "api:peak" as FamilyKey,
    "api:theme_park" as FamilyKey,
    "api:zoo" as FamilyKey,
    "brand:Q259340" as FamilyKey, // 7-Eleven
    "brand:Q38076" as FamilyKey, // McDonald's
    "rail-station",
];

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
        stripped === "rail-measure-ordinary" ||
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
    // v339: rulebook-completion types that need bespoke data sources
    // (admin polygons, coastlines, borders, altitude) — they're handled
    // by their own data paths, not the family cache.
    return null;
}

/**
 * The CANONICAL reference-prefetch extent for the current play area,
 * as `[maxLat, minLng, minLat, maxLng]` (Photon shape) — or null when
 * no boundary/extent is available.
 *
 * v356: this is the single source of truth that the client, the laptop
 * prewarm, and the worker cron MUST all agree on, because the R2 cache
 * key is a SHA-256 of the exact query string (bbox to 3 decimals). For
 * a long time the three diverged:
 *
 *   - laptop  → min/max of the boundary polygon (`relation(N);out geom;`)
 *   - client  → Photon's `extent` field
 *   - cron    → polygons.osm.fr bbox OR Photon, depending on path
 *
 * Photon's extent and the polygon's true min/max are independent numbers
 * that routinely differ in the 3rd decimal, so the client looked up a
 * different key than the prewarms wrote — every reference query missed
 * R2 and went live to Overpass (the Frankfurt cascade). We standardise
 * on the BOUNDARY-GEOMETRY min/max because it's deterministic from the
 * boundary everyone already fetches, and it's what the laptop already
 * used — so existing warmed entries become hittable with no re-warming.
 *
 * Prefers `polyGeoJSON` (the assembled boundary, byte-equal source data
 * to the laptop's `extentFromBoundaryResponse` walk — interior member
 * nodes can't push the bbox outward, so the min/max agree). Falls back
 * to Photon's extent only when the boundary hasn't loaded yet, so a
 * race on first paint can't break the lookup permanently (the next
 * lookup, once the boundary is in, uses the canonical value).
 */
export function referenceExtent(): [number, number, number, number] | null {
    const poly = polyGeoJSON.get();
    if (poly && poly.features.length > 0) {
        // turf.bbox → [minLng, minLat, maxLng, maxLat]. Same min/max
        // doubles as the laptop's coordinate walk; reshape to Photon
        // order [maxLat, minLng, minLat, maxLng].
        const [minLng, minLat, maxLng, maxLat] = turf.bbox(poly);
        if (
            [minLng, minLat, maxLng, maxLat].every((v) => Number.isFinite(v))
        ) {
            return [maxLat, minLng, minLat, maxLng];
        }
    }
    const extent = (mapGeoLocation.get()?.properties as { extent?: number[] })
        ?.extent;
    if (extent && extent.length === 4) {
        return extent as [number, number, number, number];
    }
    return null;
}

/**
 * Build an Overpass `[bbox:south,west,north,east]` filter string for
 * the current play area, padded by `padKm`, off the canonical
 * `referenceExtent()` (see that function for the byte-match contract).
 * Returns null when no play area is set or no extent is available.
 */
function buildPaddedBboxFilter(padKm: number): string | null {
    const extent = referenceExtent();
    if (!extent) return null;
    // extent is [maxLat, minLng, minLat, maxLng].
    const [maxLat, minLng, minLat, maxLng] = extent;
    const south = minLat;
    const west = minLng;
    const north = maxLat;
    const east = maxLng;
    if (![south, west, north, east].every((v) => Number.isFinite(v))) {
        return null;
    }
    // Pad: ~111 km per degree of latitude; longitude shrinks with
    // cos(latitude). The pad is a soft buffer — exact precision
    // doesn't matter, only that it adds tens of km on every side.
    const latPad = padKm / 111;
    const midLat = (south + north) / 2;
    const lngPad = padKm / (111 * Math.cos((midLat * Math.PI) / 180));
    // 3-decimal precision matches the cron's prewarm format exactly
    // — see `buildReferenceBboxQuery` in overpass-cache/src/index.ts.
    const s = (south - latPad).toFixed(3);
    const w = (west - lngPad).toFixed(3);
    const n = (north + latPad).toFixed(3);
    const e = (east + lngPad).toFixed(3);
    return `[bbox:${s},${w},${n},${e}]`;
}

/** Pad applied to the play-area extent when we fetch references. The
 *  cache is guaranteed to hold every standard family within
 *  `extent + REF_CACHE_PAD_KM` — but features beyond that are missing.
 *  Callers who anchor "nearest X" on a SEEKER GPS that sits outside
 *  this area must NOT trust the cache, since the nearest cached feature
 *  is the nearest IN the cache, not globally nearest. See
 *  `pointInsideCacheCoverage`. Matches the constant passed to
 *  `buildPaddedBboxFilter` in `runBboxOverpassFetch`. */
const REF_CACHE_PAD_KM = 50;

/**
 * Whether a (lat, lng) point sits inside the play-area cache's
 * coverage area. The cache holds every standard reference family within
 * the play area's Photon extent + REF_CACHE_PAD_KM; anything beyond is
 * not in the cache.
 *
 * Anchors that need the truly-nearest reference (e.g.
 * `NearestReferencePreview`, where the seeker's GPS is the anchor) use
 * this to decide whether the cache result is trustworthy. Inside →
 * trust the cache. Outside → bypass it and issue a GPS-anchored
 * Overpass query, because a stale cached "nearest" (the only feature
 * in the cache, which happens to be 300 km away) would be visibly
 * wrong — the Umeå-game-from-Falun case from the bug report.
 *
 * Returns false when no play area / extent is set; the caller treats
 * that the same as out-of-area.
 */
export function pointInsideCacheCoverage(
    lat: number,
    lng: number,
): boolean {
    // v356: use the SAME canonical extent the cache was keyed under, so
    // "is this point covered" agrees with what was actually fetched.
    const extent = referenceExtent();
    if (!extent) return false;
    // Photon extent shape: [maxLat, minLng, minLat, maxLng].
    const [maxLat, minLng, minLat, maxLng] = extent;
    if (![maxLat, minLng, minLat, maxLng].every((v) => Number.isFinite(v))) {
        return false;
    }
    // Same pad arithmetic as buildPaddedBboxFilter — keep in lockstep.
    const latPad = REF_CACHE_PAD_KM / 111;
    const midLat = (minLat + maxLat) / 2;
    const lngPad =
        REF_CACHE_PAD_KM / (111 * Math.cos((midLat * Math.PI) / 180));
    return (
        lat >= minLat - latPad &&
        lat <= maxLat + latPad &&
        lng >= minLng - lngPad &&
        lng <= maxLng + lngPad
    );
}

/** Turn a raw Overpass element into a cache feature, or null when it
 *  lacks usable coordinates or a name. Preserves the original tag
 *  dict so the `findCachedPlaces` Overpass-shape adapter can hand
 *  callers the same `.tags.iata` / `.tags.name` they'd read off a
 *  raw response. */
function featureFromElement(el: any): PrefetchedFeature | null {
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const tags = (el.tags ?? {}) as Record<string, string>;
    const name = tags["name:en"] ?? tags["name"] ?? tags["iata"];
    if (!name) return null;
    return { lat, lng: lon, name, tags };
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

    // Route the lazy single-family fetch through the SAME combined
    // query the preload uses, so we hit the R2 entry the cron warmed.
    // `prefetchFamiliesInOneQuery` owns the status bumps + per-family
    // cache writes for everything it touches; we just await it and
    // read whatever it put in the cache for our specific family.
    const promise = (async () => {
        try {
            await prefetchFamiliesInOneQuery(STANDARD_REFERENCE_FAMILIES);
            return cache.get(key) ?? [];
        } finally {
            inFlight.delete(key);
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
/** Every OSM relation id in the current play area: the primary, plus any
 *  added adjacent areas (v359). Each is a stable key the worker can serve
 *  references for. Non-relation / custom-drawn entries are skipped. */
function playAreaRelationIds(): { primary: number | null; all: number[] } {
    const all: number[] = [];
    let primary: number | null = null;
    const p = mapGeoLocation.get()?.properties as
        | { osm_id?: number; osm_type?: string }
        | undefined;
    if (p?.osm_type === "R" && typeof p.osm_id === "number" && p.osm_id > 0) {
        primary = p.osm_id;
        all.push(p.osm_id);
    }
    for (const e of additionalMapGeoLocations.get()) {
        if (!e.added) continue;
        const ep = e.location?.properties as
            | { osm_id?: number; osm_type?: string }
            | undefined;
        if (
            ep?.osm_type === "R" &&
            typeof ep.osm_id === "number" &&
            ep.osm_id > 0 &&
            !all.includes(ep.osm_id)
        ) {
            all.push(ep.osm_id);
        }
    }
    return { primary, all };
}

/** Relation ids we've already asked the worker to warm this session, so
 *  warm-on-add fires once per adjacent area, not on every prefetch pass. */
const warmRequested = new Set<number>();

/** Fire a background warm of a relation's references (boundary + refs)
 *  on the worker. Fire-and-forget; deduped per session. */
function requestWarm(relationId: number): void {
    if (warmRequested.has(relationId)) return;
    warmRequested.add(relationId);
    void fetch(`${REFS_BY_RELATION_BASE}/${relationId}?warm=1`).catch(() => {
        // Network blip — allow a retry on a later pass.
        warmRequested.delete(relationId);
    });
}

// v359: warm-on-add. Kick off a background warm the moment an adjacent
// area is added, rather than waiting for the first question to probe it.
// nanostores fires subscribe synchronously with the current value, so a
// reload with areas already added warms them too. Deduped via requestWarm.
if (typeof window !== "undefined") {
    additionalMapGeoLocations.subscribe((extras) => {
        for (const e of extras) {
            if (!e.added) continue;
            const ep = e.location?.properties as
                | { osm_id?: number; osm_type?: string }
                | undefined;
            if (
                ep?.osm_type === "R" &&
                typeof ep.osm_id === "number" &&
                ep.osm_id > 0
            ) {
                requestWarm(ep.osm_id);
            }
        }
    });
}

async function runBboxOverpassFetch(filters: string[]): Promise<any[]> {
    if (filters.length === 0) return [];

    // v359: fan out over EVERY play-area relation (primary + added
    // adjacent areas) via the STABLE relation-id-keyed endpoint. The
    // worker derives each one's reference bbox server-side from the
    // boundary it already has, so a prewarmed area is hit regardless of
    // how (or whether) we derive a bbox locally — no Photon-vs-boundary
    // drift, no hydration race. We UNION the hits so a question near an
    // added adjacent area resolves its nearest reference from cache too,
    // not just the primary's. Each endpoint returns the FULL family set;
    // the caller partitions by the families it asked for.
    const { primary, all } = playAreaRelationIds();
    if (all.length > 0) {
        const unioned: any[] = [];
        let primaryHit = false;
        await Promise.all(
            all.map(async (id) => {
                try {
                    const resp = await fetch(`${REFS_BY_RELATION_BASE}/${id}`);
                    if (!resp.ok) {
                        requestWarm(id);
                        return;
                    }
                    const data = (await resp.json()) as { elements?: any[] };
                    const els = data?.elements ?? [];
                    if (els.length > 0) {
                        unioned.push(...els);
                        if (id === primary) primaryHit = true;
                    } else {
                        // miss / no-boundary → warm it for next time
                        requestWarm(id);
                    }
                } catch {
                    requestWarm(id);
                }
            }),
        );
        // If anything hit, use the union. The only case we still fall
        // through to a live bbox query is a cold PRIMARY (so a brand-new
        // play area the laptop hasn't warmed yet still works on first
        // use); adjacent misses ride the background warm + on-tap path.
        if (unioned.length > 0 && (primaryHit || primary === null)) {
            return unioned;
        }
        if (unioned.length > 0 && !primaryHit) {
            // Primary cold but an adjacent hit — keep the adjacent data
            // and still warm the primary via the bbox query below, then
            // merge.
            const bboxData = await runPrimaryBboxFetch(filters);
            return [...unioned, ...bboxData];
        }
    }

    return runPrimaryBboxFetch(filters);
}

/** The legacy primary-only bbox reference query — the fallback when the
 *  relation-keyed endpoint misses (cold/un-warmed primary or a
 *  custom-drawn play area with no relation id). */
async function runPrimaryBboxFetch(filters: string[]): Promise<any[]> {
    const bboxFilter = buildPaddedBboxFilter(50);
    if (!bboxFilter) return [];
    // Sort lexically so the body string is order-independent w.r.t.
    // the caller's family iteration order. The cron's
    // REFERENCE_FAMILY_FILTERS list is alphabetically sorted for the
    // exact same reason — both sides MUST produce the same body, or
    // the R2 key (hash of the full query string) won't match.
    const orderedFilters = [...filters].sort();
    const body = orderedFilters.map((f) => `nwr${f};`).join("\n");
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

/** Pad for the high-speed-rail bbox query. Bigger than the 50 km
 *  reference pad because the HSR network is sparse — the nearest
 *  line to a city often sits 50-100 km out. Beyond this the client's
 *  `fetchNearestHighspeedRail` falls back to its radius walk. The
 *  cron uses the SAME pad so the cached entry's key matches.
 *
 *  NOTE: only used by the legacy per-city bbox HSR query, which
 *  v214 replaced with the per-country query below. Retained because
 *  the radius-walk fallback comment in NearestReferencePreview still
 *  refers to "the play-area pad" conceptually; the constant itself
 *  is no longer wired into a live query. */
export const HSR_PAD_KM = 100;

/**
 * Countries whose national HSR network we prewarm as a single
 * `area["ISO3166-1"="XX"]` query. MUST stay byte-identical (same
 * set, same uppercase ISO 3166-1 alpha-2 codes) to `HSR_COUNTRIES`
 * in overpass-cache/src/index.ts and scripts/laptop-prewarm.mjs —
 * the client only issues the country query when its play area's
 * country is in this set, so a code we prewarm but the client
 * doesn't recognise (or vice versa) is a wasted cache entry.
 *
 * Inclusive on purpose: a country with little or no `highspeed=yes`
 * track (NO, FI, PT) still gets a cheap empty cached result, which
 * the client treats as "no HSR here" and falls through to the
 * radius walk — same outcome as not listing it, but without a slow
 * live country query at game time.
 */
export const HSR_COUNTRIES = new Set<string>([
    "JP",
    "CN",
    "FR",
    "DE",
    "ES",
    "IT",
    "GB",
    "BE",
    "NL",
    "CH",
    "AT",
    "KR",
    "TW",
    "TR",
    "SA",
    "MA",
    "SE",
    // US omitted — see HSR_COUNTRIES in overpass-cache/src/index.ts:
    // the country-wide area query times out upstream, so we never
    // prewarm it; issuing it from the client would just be a slow
    // miss. The radius-walk fallback covers any US play area.
    "RU",
    "PL",
    "DK",
    "PT",
    "UZ",
    "NO",
    "FI",
]);

/**
 * Rough geographic centroids of every country in `HSR_COUNTRIES`,
 * used by the nearest-HSR cross-border fallback in
 * `NearestReferencePreview`. When the seeker's own country isn't a
 * prewarmed HSR country, we sort these by distance to the seeker
 * and try the cached HSR query for the closest few — so a Latvian
 * seeker gets Polish HSR from the cache instead of a 1500 km radius
 * walk hitting public Overpass mirrors.
 *
 * Precision is country-scale on purpose: we only need a stable
 * ordering of "which HSR country is closest", not pinpoint accuracy.
 * Keep in lockstep with `HSR_COUNTRIES`.
 */
export const HSR_COUNTRY_CENTROIDS: Record<
    string,
    { lat: number; lng: number }
> = {
    JP: { lat: 36, lng: 138 },
    CN: { lat: 35, lng: 105 },
    FR: { lat: 47, lng: 2 },
    DE: { lat: 51, lng: 10 },
    ES: { lat: 40, lng: -4 },
    IT: { lat: 42, lng: 12 },
    GB: { lat: 54, lng: -2 },
    BE: { lat: 50, lng: 4.5 },
    NL: { lat: 52, lng: 5 },
    CH: { lat: 47, lng: 8 },
    AT: { lat: 47, lng: 14 },
    KR: { lat: 36, lng: 128 },
    TW: { lat: 24, lng: 121 },
    TR: { lat: 39, lng: 35 },
    SA: { lat: 24, lng: 45 },
    MA: { lat: 32, lng: -6 },
    SE: { lat: 62, lng: 16 },
    RU: { lat: 56, lng: 38 }, // Moscow-centric; nearly all HSR is in the west
    PL: { lat: 52, lng: 19 },
    DK: { lat: 56, lng: 10 },
    PT: { lat: 39, lng: -8 },
    UZ: { lat: 41, lng: 64 },
    NO: { lat: 60, lng: 9 },
    FI: { lat: 64, lng: 26 },
};

/**
 * The per-country high-speed-rail query string. Resolves all
 * `highspeed=yes` railway lines inside the country's admin-level-2
 * boundary area, `out geom` for the line geometry (we need the
 * nearest POINT ON the line, not a centroid).
 *
 * Replaces the old per-city bbox query (v214): the HSR network is
 * fundamentally inter-city, so per-city bboxes both overlapped
 * (Tokyo/Osaka) and left gaps (lines between cities). One query per
 * country is complete, gap-free, and — since there are only ~25 HSR
 * countries — far fewer upstream hits than hundreds of city bboxes.
 *
 * MUST stay byte-identical to `buildHsrCountryQuery` in
 * overpass-cache/src/index.ts and scripts/laptop-prewarm.mjs. The
 * R2 cache key is a hash of this exact string.
 */
export function buildHsrCountryQuery(iso: string): string {
    return `
[out:json][timeout:180];
area["ISO3166-1"="${iso}"]["admin_level"="2"]->.hsrArea;
way["railway"="rail"]["highspeed"="yes"](area.hsrArea);
out geom;
`;
}

/**
 * The HSR query for the CURRENT play area: look up the play area's
 * ISO country, and — if it's a country we prewarm — return that
 * country's HSR query (an R2 cache hit). Returns null when the play
 * area has no country, or its country isn't in `HSR_COUNTRIES` (so
 * the caller falls back to the uncached radius walk rather than
 * firing a slow live country query that nothing warmed).
 *
 * Photon hands us a lowercase alpha-2 `countrycode`; OSM's
 * `ISO3166-1` tag is uppercase, so we normalise before matching and
 * building the query.
 */
export function buildHsrQuery(): string | null {
    const cc = mapGeoLocation.get()?.properties?.countrycode;
    if (!cc) return null;
    const iso = cc.toUpperCase();
    if (!HSR_COUNTRIES.has(iso)) return null;
    return buildHsrCountryQuery(iso);
}

/** Synchronous cache lookup. Returns null if nothing has been
 *  prefetched for this (play-area, family) pair yet. */
export function getCachedCategory(
    family: FamilyKey,
): PrefetchedFeature[] | null {
    return cache.get(cacheKey(family)) ?? null;
}

/* ───────── Filter → family lookup (for findPlacesInZone fast path) ──── *
 *
 * `findPlacesInZone` (overpass.ts) historically issued a `poly:` query
 * that constrained results to the play-area polygon. The cache uses a
 * `[bbox:...]` query unioning every standard family. Different shape,
 * different R2 key — every per-question matching/measuring call cold-
 * missed the worker cache.
 *
 * Two problems with that, both fixed by the fast path below:
 *
 *   1. Cache miss → upstream Overpass on every question answer.
 *   2. CORRECTNESS — references outside the play area were dropped.
 *      The user's rule is "reference points don't need to be inside
 *      the play area unless otherwise stated", so a hospital just
 *      outside the polygon should count for "nearest hospital".
 *
 * Both go away if we recognise when a `findPlacesInZone` filter
 * matches a family in `STANDARD_REFERENCE_FAMILIES` and serve the
 * cached features (which sit on the padded bbox, not the polygon).
 */

/** Normalise an Overpass `[k=v][...]` filter string for byte-stable
 *  comparison. Strips whitespace and the optional `"` around tag keys
 *  and values, so `["amenity"="hospital"]` and `[amenity=hospital]`
 *  hash to the same key. */
function normaliseFilter(s: string): string {
    return s.replace(/[\s"]/g, "");
}

/** Pre-computed inverse of `filterForFamily`, keyed on the normalised
 *  filter form. Built once at module load. Used by `familyForFilter`. */
const familyByNormalisedFilter: Map<string, FamilyKey> = new Map(
    STANDARD_REFERENCE_FAMILIES.map((f) => [
        normaliseFilter(filterForFamily(f)),
        f,
    ]),
);

/** Inverse of `filterForFamily`: given a raw filter string the way
 *  callers pass it into `findPlacesInZone` (`["amenity"="hospital"]`
 *  or `[amenity=hospital]` — both forms are accepted), return the
 *  matching `FamilyKey`, or null if it doesn't correspond to any
 *  standard family. Dynamic filters (regex on `name:en`, `admin_level`
 *  variants, the `[highspeed=yes]` HSR shape) intentionally return null
 *  so the caller falls through to the original poly/area path. */
export function familyForFilter(filter: string): FamilyKey | null {
    return familyByNormalisedFilter.get(normaliseFilter(filter)) ?? null;
}

/** Adapter that returns prefetched references in the Overpass response
 *  shape `findPlacesInZone` callers consume: `{ elements: [...] }` of
 *  `{ type, lat, lon, tags }` records. Reads the in-memory cache when
 *  warm; awaits `prefetchCategory` (which goes through the same R2-
 *  backed combined-bbox query the cron prewarms) when cold. Returns
 *  the SAME shape on empty (no features matched) so callers can read
 *  `data.elements.length === 0` without branching.
 *
 *  The `outType` parameter mirrors the Overpass setting. We only
 *  support `center` here because the cron prewarm uses `out center`,
 *  so we can't serve `geom` requests from cache. `geom`-needing
 *  callers (letter-zone admin polygons, the `[highspeed=yes]` shape)
 *  don't pass a standard family anyway — they fall through. */
export async function findCachedPlaces(
    family: FamilyKey,
): Promise<{ elements: Array<Record<string, unknown>> }> {
    const features = await prefetchCategory(family);
    const elements = features.map((f) => ({
        type: "node",
        lat: f.lat,
        lon: f.lng,
        tags: f.tags ?? { name: f.name },
    }));
    return { elements };
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

    // v356: key the master gates on the play-area signature AND the
    // actual bbox. The bbox can transiently fall back to Photon's extent
    // before the boundary polygon loads, then switch to the canonical
    // boundary extent (see referenceExtent). Keying on the bbox keeps a
    // Photon-fallback failure from blocking the real boundary-extent
    // attempt under the 60 s backoff — they're tracked as distinct keys.
    const sig = `${playAreaSignature()}|${buildPaddedBboxFilter(50) ?? "?"}`;

    // v355: backoff after a recent failure — see masterRecentFailureAt
    // comment above for the cascade this prevents.
    const lastFail = masterRecentFailureAt.get(sig);
    if (lastFail && Date.now() - lastFail < MASTER_FAILURE_BACKOFF_MS) {
        // Surface "failed" on the status pill so the cache-status UI is
        // honest about what just happened (no quiet no-op).
        todo.forEach((f) => bumpStatus({ failedKey: cacheKey(f) }));
        return;
    }
    // v355: single-flight coalescing — a burst of subtype clicks fires
    // ONE master query, not N. Subsequent callers await the same promise.
    const racing = masterInFlight.get(sig);
    if (racing) return racing;

    const promise = runPrefetchFamiliesInOneQuery(sig, todo);
    masterInFlight.set(sig, promise);
    try {
        return await promise;
    } finally {
        masterInFlight.delete(sig);
    }
}

async function runPrefetchFamiliesInOneQuery(
    sig: string,
    todo: FamilyKey[],
): Promise<void> {
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
        // v351: only re-fetch individually on a PARTIAL result — i.e.
        // SOME families had data and others were empty (the truncation
        // case). When EVERY family is empty the combined query didn't
        // succeed at all (worker 500/timeout → getOverpassData returns
        // {elements:[]}); re-issuing 15 single-family queries would just
        // fail again AND hammer an already-struggling worker — that's
        // the amplification cascade seen in the LA-large-game HAR. In
        // that case we bail and leave the families uncached; the lazy
        // on-tap prefetch + the per-question radius-walk fallback cover
        // each one on demand, one at a time, when actually needed.
        const allEmpty = emptyFamilies.length === todo.length;
        if (emptyFamilies.length > 0 && !allEmpty) {
            console.debug(
                `[preload] ${emptyFamilies.length}/${todo.length} families empty in combined query — re-fetching just those`,
            );
            for (const f of emptyFamilies) {
                prefetchCategory(f).catch(() => {
                    bumpStatus({ failedKey: cacheKey(f) });
                });
            }
            // Partial success still counts: at least one family landed,
            // clear any stale failure mark so a *useful* retry isn't
            // blocked behind the backoff.
            masterRecentFailureAt.delete(sig);
        } else if (allEmpty) {
            // Combined query yielded nothing for anyone — treat as a
            // failure (no amplification). Mark each family failed so
            // the status pill is honest; the lazy on-tap path retries
            // on demand.
            console.debug(
                `[preload] combined query returned no references (likely worker/mirror failure) — not amplifying`,
            );
            todo.forEach((f) => bumpStatus({ failedKey: cacheKey(f) }));
            masterRecentFailureAt.set(sig, Date.now());
        } else {
            // Every requested family had a non-zero count and was
            // cached. Clean run — clear any stale failure mark.
            masterRecentFailureAt.delete(sig);
        }
    } catch {
        // Whole-batch failure: mark each family failed so the status
        // pill is honest, then let the lazy per-tap path retry them
        // one at a time when actually needed.
        todo.forEach((f) => bumpStatus({ failedKey: cacheKey(f) }));
        masterRecentFailureAt.set(sig, Date.now());
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
    // Diagnostic (v220): the cache pill drops from "0/30" → "0/225"
    // → "0/0" mid-game. Hypothesis is that this signature flips
    // during the game (e.g. multiplayer sync rehydrating the play
    // area with a slightly-different feature object), causing every
    // bumpStatus call to start over. Log every reset so we can
    // confirm and see exactly what changed.
    if (current.signature && current.signature !== sig) {
        const lost = Object.keys(current.perFamily).length;
        console.warn(
            `[cache-pill] signature changed — perFamily reset (lost ${lost} entries)`,
            { from: current.signature, to: sig, args },
        );
    }
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
