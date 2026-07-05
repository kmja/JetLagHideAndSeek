/**
 * Area-wide transit-station scan for the hider's hiding-zones overlay.
 *
 * v661: the scan is keyed to the PLAY AREA, not the hider's GPS. The
 * old implementation built `around:lat,lng` Overpass clauses from the
 * live GPS fix — which made every player/position a byte-unique query
 * string, so the worker's R2 cache could never hit and every load went
 * to live Overpass (the "rate-limited even though the city is starred"
 * bug). Same anti-pattern the v640 adjacency fix killed: two producers
 * of the same query must be ONE producer.
 *
 * It now reuses the SEEKER's hiding-zones fetch path verbatim:
 * `hidingZoneFiltersFor(allowedTransit)` → `findPlacesInZone(...)`,
 * with the exact argument shape `ZoneSidebar` uses — so the hider's
 * query string is byte-identical to the seeker's default hiding-zones
 * query. One shared R2 entry per (play area, allowed modes): warm for
 * prewarmed cities, and warmed for the whole lobby the moment any
 * player loads hiding zones.
 *
 * The hider's GPS is still used CLIENT-SIDE only — to distance-sort and
 * trim the result to the cap (closest stations are the strategically
 * relevant ones) — never in the query string.
 */

import { booleanPointInPolygon } from "@turf/turf";

import {
    additionalMapGeoLocations,
    mapGeoLocation,
    polyGeoJSON,
} from "@/lib/context";
import {
    HIDING_ZONE_FILTERS_BY_MODE,
    hidingZoneFiltersFor,
    type TransitMode,
} from "@/lib/gameSetup";
import { haversineMeters } from "@/lib/geo";
import { AREA_STATIONS_BY_RELATION_BASE } from "@/maps/api/constants";
import { findPlacesInZone, overpassFailureCount } from "@/maps/api/overpass";

/** Total stops cap — keeps a dense metro's station field (and the
 *  union-fill worker's input) tractable. */
export const MAX_AREA_STATIONS = 180;

export interface AreaStation {
    /** OSM element id. Stable identifier for downstream keys. */
    id: number;
    name: string;
    lat: number;
    lng: number;
    mode: TransitMode;
    distanceMeters: number;
}

/** Mode priority — higher = surfaces first when we trim to the cap.
 *  Subway/train stations matter vastly more to the hiding-zone survey
 *  than individual bus stops, so they're kept under pressure. */
const MODE_PRIORITY: Record<TransitMode, number> = {
    subway: 5,
    train: 4,
    ferry: 3,
    tram: 2,
    bus: 1,
};

export interface AreaStationOptions {
    /** Which transit modes the game allows; defaults to all. */
    allowed: TransitMode[];
}

/** A fetched station before any anchor-relative distance is attached. */
type RawStation = Omit<AreaStation, "distanceMeters">;

/**
 * Single-entry memo for the raw play-area station set. The set is a pure
 * function of (filter list, play area), and both are fixed for a whole
 * game — so every consumer (hiding-zones overlay, zone picker, map-tap
 * resolution) shares ONE fetch per game instead of each firing its own.
 * Identity-checked against the `polyGeoJSON` atom value so a play-area
 * change invalidates it. In-flight coalescing so concurrent callers
 * share the same request.
 */
let rawStationsCache: {
    filtersKey: string;
    polyRef: unknown;
    stations: RawStation[];
} | null = null;
let rawStationsInFlight: {
    filtersKey: string;
    polyRef: unknown;
    promise: Promise<RawStation[]>;
} | null = null;

async function fetchRawAreaStations(
    allowed: TransitMode[],
): Promise<RawStation[]> {
    const filters = hidingZoneFiltersFor(allowed);
    if (filters.length === 0) return [];
    const filtersKey = filters.join("|");
    const polyRef = polyGeoJSON.get();

    if (
        rawStationsCache &&
        rawStationsCache.filtersKey === filtersKey &&
        rawStationsCache.polyRef === polyRef
    ) {
        return rawStationsCache.stations;
    }
    if (
        rawStationsInFlight &&
        rawStationsInFlight.filtersKey === filtersKey &&
        rawStationsInFlight.polyRef === polyRef
    ) {
        return rawStationsInFlight.promise;
    }

    const promise = (async () => {
        // v668: try the PREWARMED station field first —
        // `/api/area-stations/<relationId>` serves the combined all-mode
        // stop set for a starred city straight from R2 (zero live
        // Overpass), the same relation-ID-keyed pattern as `/api/refs`.
        // The worker derives the bbox from the boundary it already has,
        // so the client never builds a byte-fragile query. On any miss
        // (uncurated area / cold cache) `elements` is empty and we fall
        // through to the live poly query below.
        // The endpoint serves a 2 km-PADDED bbox superset of the PRIMARY
        // relation, whereas the live poly query is play-area-clipped — so
        // the result is culled to the play-area polygon to match those
        // semantics exactly (a station outside the play area is not a
        // legal zone, v665). `prewarmEndpointRelationId` also declines
        // when adjacent areas were added/subtracted (the endpoint only
        // covers the primary) or the polygon isn't loaded (can't cull).
        const endpointRelId = prewarmEndpointRelationId();
        if (endpointRelId !== null) {
            const warmElements = await fetchPrewarmedStations(endpointRelId);
            if (warmElements && warmElements.length > 0) {
                const culled = cullElementsToPlayArea(warmElements);
                const stations = parseStations(culled, allowed);
                if (stations.length > 0) {
                    // Kick a background warm so the next TTL is covered
                    // even if this was a stale-but-present hit.
                    rawStationsCache = { filtersKey, polyRef, stations };
                    return stations;
                }
            }
        }

        // Byte-identical to the seeker's ZoneSidebar call (filters[0]
        // primary + rest as alternatives, nwr / out center, no timeout
        // header) so both roles share one cached Overpass entry. `silent`
        // — every consumer has its own loading/error affordances.
        //
        // v667: `getOverpassData` returns `{elements: []}` BOTH on a
        // genuinely-empty result and on total mirror failure (rate limit
        // / soft-timeout storm). An empty caused by failure must THROW —
        // not be cached and returned — or every consumer renders
        // "loaded, zero zones" (the Chicago empty-overlay bug).
        // `overpassFailureCount` is the designed tell-them-apart signal.
        const failuresBefore = overpassFailureCount();
        const data = (await findPlacesInZone(
            filters[0],
            undefined,
            "nwr",
            "center",
            filters.slice(1),
            0,
            true,
        )) as { elements?: OverpassElement[] };
        const elements = data?.elements ?? [];
        if (
            elements.length === 0 &&
            overpassFailureCount() > failuresBefore
        ) {
            // Ask the worker to warm this relation's station field so the
            // next load is served from R2 instead of re-hitting a
            // timing-out live query. Fire-and-forget.
            const warmRelId = primaryRelationId();
            if (warmRelId !== null) requestStationWarm(warmRelId);
            throw new Error(
                "Station scan failed — all Overpass mirrors timed out or rate-limited",
            );
        }

        const stations = parseStations(elements, allowed);
        rawStationsCache = { filtersKey, polyRef, stations };
        // Warm the prewarm entry for next time (a live poly fetch means
        // the relation endpoint missed). Fire-and-forget, deduped.
        const warmRelId = primaryRelationId();
        if (warmRelId !== null) requestStationWarm(warmRelId);
        return stations;
    })();
    rawStationsInFlight = { filtersKey, polyRef, promise };
    try {
        return await promise;
    } finally {
        if (rawStationsInFlight?.promise === promise) {
            rawStationsInFlight = null;
        }
    }
}

/** Parse a `out center` element list into RawStations, filtered to the
 *  allowed modes. Shared by the prewarmed-endpoint and live-poly paths. */
function parseStations(
    elements: OverpassElement[],
    allowed: TransitMode[],
): RawStation[] {
    const seenIds = new Set<number>();
    const stations: RawStation[] = [];
    for (const el of elements) {
        // `out center` puts way/relation coords under `center`.
        const lat = typeof el.lat === "number" ? el.lat : el.center?.lat;
        const lng = typeof el.lon === "number" ? el.lon : el.center?.lon;
        if (typeof lat !== "number" || typeof lng !== "number") continue;
        if (seenIds.has(el.id)) continue;
        seenIds.add(el.id);
        const name = el.tags?.["name:en"] ?? el.tags?.name;
        if (!name) continue;
        const mode = inferMode(el.tags ?? {});
        if (!mode || !allowed.includes(mode)) continue;
        stations.push({ id: el.id, name, lat, lng, mode });
    }
    return stations;
}

/** Cull `out center` elements to the play-area polygon, matching the
 *  clipping the live poly query does server-side. No-op when the polygon
 *  isn't loaded (caller gates on that). */
function cullElementsToPlayArea(
    elements: OverpassElement[],
): OverpassElement[] {
    const poly = polyGeoJSON.get();
    if (!poly) return elements;
    return elements.filter((el) => {
        const lat = typeof el.lat === "number" ? el.lat : el.center?.lat;
        const lng = typeof el.lon === "number" ? el.lon : el.center?.lon;
        if (typeof lat !== "number" || typeof lng !== "number") return false;
        try {
            return booleanPointInPolygon([lng, lat], poly as never);
        } catch {
            return true;
        }
    });
}

/** The primary play-area OSM relation id, or null for a custom-drawn /
 *  non-relation play area (which has no prewarm entry to hit). */
function primaryRelationId(): number | null {
    const p = mapGeoLocation.get()?.properties as
        | { osm_id?: number; osm_type?: string }
        | undefined;
    if (p?.osm_type === "R" && typeof p.osm_id === "number" && p.osm_id > 0) {
        return p.osm_id;
    }
    return null;
}

/**
 * The relation id the prewarm endpoint may be READ for, or null if it
 * can't be used for this play area. The `/api/area-stations/<id>` entry
 * covers the PRIMARY relation's 2 km-padded bbox only, so it's valid
 * ONLY when:
 *   - the play area is a single relation (no added/subtracted adjacent
 *     areas — those extend the play area beyond the primary bbox), and
 *   - its polygon is loaded (needed to cull the padded bbox back to the
 *     exact play area, matching the poly query's clipping).
 * Otherwise callers use the live poly query, which handles the combined
 * polygon + subtractions correctly.
 */
function prewarmEndpointRelationId(): number | null {
    if (!polyGeoJSON.get()) return null;
    if (additionalMapGeoLocations.get().length > 0) return null;
    return primaryRelationId();
}

/** Fetch the prewarmed all-mode station field for a relation, or null on
 *  miss / error (caller falls back to the live poly query). Read-only —
 *  the worker never goes upstream on this path. */
async function fetchPrewarmedStations(
    relationId: number,
): Promise<OverpassElement[] | null> {
    try {
        const resp = await fetch(
            `${AREA_STATIONS_BY_RELATION_BASE}/${relationId}`,
        );
        if (!resp.ok) return null;
        const data = (await resp.json()) as { elements?: OverpassElement[] };
        return data?.elements ?? null;
    } catch {
        return null;
    }
}

/** Relation ids we've asked the worker to warm this session, so a warm
 *  fires once per relation, not on every fetch. */
const stationWarmRequested = new Set<number>();

/** Fire a background warm of a relation's station field on the worker.
 *  Fire-and-forget; deduped per session. */
function requestStationWarm(relationId: number): void {
    if (stationWarmRequested.has(relationId)) return;
    stationWarmRequested.add(relationId);
    void fetch(`${AREA_STATIONS_BY_RELATION_BASE}/${relationId}?warm=1`).catch(
        () => {
            stationWarmRequested.delete(relationId);
        },
    );
}

/** Distance-sort + same-name/nearby dedupe, shared by every consumer. */
function sortAndDedupe(stations: AreaStation[]): AreaStation[] {
    stations.sort((a, b) => a.distanceMeters - b.distanceMeters);
    const deduped: AreaStation[] = [];
    for (const s of stations) {
        const norm = normaliseName(s.name);
        const dup = deduped.find(
            (d) =>
                normaliseName(d.name) === norm &&
                haversineMeters(d.lat, d.lng, s.lat, s.lng) < 150,
        );
        if (dup) continue;
        deduped.push(s);
    }
    return deduped;
}

/**
 * Derive the transit-mode set a seeker's `displayHidingZonesOptions`
 * list represents — but ONLY when the list is EXACTLY the station
 * filters for a whole-mode subset (nothing partial, nothing custom).
 * Returns null otherwise, so a custom/partial selection cleanly declines
 * the prewarm endpoint and uses the live poly query instead.
 *
 * Exactness matters: the prewarm endpoint serves all modes and we filter
 * its elements by `inferMode ∈ modes` — which reproduces the poly query
 * only when the options are precisely those modes' filters. A partial
 * mode (e.g. `[railway=halt]` without its sibling) or a non-mode custom
 * pick would make the mode-level filter diverge, so we bail.
 */
function modesForExactOptions(options: string[]): TransitMode[] | null {
    const selected: TransitMode[] = [];
    for (const m of ALL_MODES) {
        const fs = HIDING_ZONE_FILTERS_BY_MODE[m] ?? [];
        const anyPresent = fs.some((f) => options.includes(f));
        const allPresent = fs.every((f) => options.includes(f));
        if (anyPresent && !allPresent) return null; // partial mode
        if (allPresent) selected.push(m);
    }
    if (selected.length === 0) return null;
    // The options must be EXACTLY the union of the selected modes'
    // filters — no extra (custom / non-mode) entries.
    const reconstructed = hidingZoneFiltersFor(selected);
    if (reconstructed.length !== options.length) return null;
    for (const o of options) if (!reconstructed.includes(o)) return null;
    return selected;
}

/**
 * Seeker `ZoneSidebar` entry point (v668): serve the DEFAULT hiding-zone
 * station set from the prewarmed `/api/area-stations/<id>` endpoint when
 * the seeker's `displayHidingZonesOptions` map cleanly to transit modes
 * (the common auto-tracking case) — zero live Overpass on a warm city.
 * Returns an Overpass-shaped `{ elements }` (all requested modes,
 * culled to the play area) so the caller can feed it straight to
 * `osmtogeojson`, exactly like the poly query's result. Returns null —
 * caller falls back to its live poly query — for a custom/partial-mode
 * selection, a non-relation play area, a play area with no loaded
 * polygon (can't cull), or a cold endpoint miss (also fires a warm).
 */
export async function fetchPrewarmedHidingZoneStations(
    options: string[],
): Promise<{ elements: OverpassElement[] } | null> {
    const modes = modesForExactOptions(options);
    if (!modes) return null;
    const relId = prewarmEndpointRelationId();
    if (relId === null) return null;
    const elements = await fetchPrewarmedStations(relId);
    if (!elements || elements.length === 0) {
        requestStationWarm(relId);
        return null;
    }
    const culled = cullElementsToPlayArea(elements).filter((el) => {
        const mode = inferMode(el.tags ?? {});
        return mode !== null && modes.includes(mode);
    });
    return { elements: culled };
}

/**
 * Pull every candidate hiding-zone station in the play area. The
 * (centerLat, centerLng) anchor is used only for the client-side
 * distance sort + cap trim — it never reaches the query, so the query
 * stays byte-stable per (play area, allowed modes).
 */
export async function fetchAreaStations(
    centerLat: number,
    centerLng: number,
    opts: AreaStationOptions,
): Promise<AreaStation[]> {
    const allowed = opts.allowed.length > 0 ? opts.allowed : ALL_MODES;
    const raw = await fetchRawAreaStations(allowed);
    const deduped = sortAndDedupe(
        raw.map((s) => ({
            ...s,
            distanceMeters: haversineMeters(
                centerLat,
                centerLng,
                s.lat,
                s.lng,
            ),
        })),
    );
    if (deduped.length <= MAX_AREA_STATIONS) return deduped;

    // Trim to cap, keeping a balanced mix of modes. Sort by a
    // composite key (priority desc, distance asc) so the highest-
    // priority + closest stations win.
    deduped.sort((a, b) => {
        const dp = MODE_PRIORITY[b.mode] - MODE_PRIORITY[a.mode];
        if (dp !== 0) return dp;
        return a.distanceMeters - b.distanceMeters;
    });
    return deduped.slice(0, MAX_AREA_STATIONS);
}

/**
 * Every candidate hiding zone CONTAINING the given point — the stations
 * of the game's own candidate set (same shared fetch as the overlay)
 * whose hiding-radius circle covers (lat, lng), nearest first.
 *
 * This is "which zones am I standing in?" — the zone picker's question
 * and the hider map-tap fallback's question. It replaced the last two
 * position-keyed live `around:GPS` Overpass queries (v665): resolving
 * against the game's own station set is both self-hosted (one shared
 * play-area-keyed query) and CORRECT — a station of a disallowed mode,
 * or outside the play area, is not a legal zone and no longer matches.
 */
export async function findZonesNearPoint(
    lat: number,
    lng: number,
    opts: { allowed: TransitMode[]; radiusMeters: number },
): Promise<AreaStation[]> {
    const allowed = opts.allowed.length > 0 ? opts.allowed : ALL_MODES;
    const raw = await fetchRawAreaStations(allowed);
    const within = raw
        .map((s) => ({
            ...s,
            distanceMeters: haversineMeters(lat, lng, s.lat, s.lng),
        }))
        .filter((s) => s.distanceMeters <= opts.radiusMeters);
    return sortAndDedupe(within);
}

/** The single nearest candidate zone containing the point, or null. */
export async function findZoneAtPoint(
    lat: number,
    lng: number,
    opts: { allowed: TransitMode[]; radiusMeters: number },
): Promise<AreaStation | null> {
    const zones = await findZonesNearPoint(lat, lng, opts);
    return zones[0] ?? null;
}

const ALL_MODES: TransitMode[] = ["subway", "train", "tram", "bus", "ferry"];

interface OverpassElement {
    id: number;
    lat?: number;
    lon?: number;
    center?: { lat?: number; lon?: number };
    tags?: Record<string, string>;
}

/** Classify an element returned by the HIDING_ZONE_FILTERS_BY_MODE
 *  selectors into our mode enum. Order matters: subway/light-rail flags
 *  override the generic railway=station/halt classification. */
function inferMode(tags: Record<string, string>): TransitMode | null {
    if (tags.subway === "yes" || tags.station === "subway") return "subway";
    if (tags.railway === "tram_stop" || tags.light_rail === "yes")
        return "tram";
    if (tags.railway === "station" || tags.railway === "halt") return "train";
    if (tags.amenity === "ferry_terminal" || tags.platform === "ferry")
        return "ferry";
    if (tags.highway === "bus_stop" || tags.bus === "yes") return "bus";
    return null;
}

function normaliseName(name: string): string {
    return name
        .toLocaleLowerCase()
        .replace(/\s+/g, " ")
        .replace(/[.,()/-]/g, "")
        .replace(/\bstation\b|\bstn\b|\bstop\b/g, "")
        .trim();
}
