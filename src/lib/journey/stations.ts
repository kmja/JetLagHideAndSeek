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

import { booleanPointInPolygon, convertLength, type Units } from "@turf/turf";

import { polyGeoJSON } from "@/lib/context";
import {
    HIDING_ZONE_FILTERS_BY_MODE,
    hidingZoneFiltersFor,
    type TransitMode,
} from "@/lib/gameSetup";
import { playAreaRelationIdsAll as playAreaRelationIdsAllShared } from "@/lib/playAreaRelations";
import { haversineMeters } from "@/lib/geo";
import type { StationPlace } from "@/maps/api";
import { safeJsonFromCachedResponse } from "@/maps/api/cache";
import { AREA_STATIONS_BY_RELATION_BASE } from "@/maps/api/constants";
import {
    inferStationMode,
    mergeDuplicateStation,
} from "@/maps/geo-utils/stationManipulations";
import { findPlacesInZone, overpassFailureCount } from "@/maps/api/overpass";


export interface AreaStation {
    /** OSM element id. Stable identifier for downstream keys. */
    id: number;
    name: string;
    lat: number;
    lng: number;
    /** Primary transit mode (= `modes[0]`), kept for back-compat. */
    mode: TransitMode;
    /** Every transit mode at this (merged) stop — a hub can be several. */
    modes: TransitMode[];
    distanceMeters: number;
}

export interface AreaStationOptions {
    /** Which transit modes the game allows; defaults to all. */
    allowed: TransitMode[];
    /** Hiding-zone radius + units — drives the same-name dedup distance so
     *  the hider matches the seeker (`max(radius, 800 m)`). Defaults to the
     *  0.5 km hiding radius (→ the 800 m floor) when omitted. */
    radius?: number;
    units?: Units;
}

/**
 * Single-entry memo for the raw play-area station set. The set is a pure
 * function of (filter list, play area), and both are fixed for a whole
 * game — so every consumer (hiding-zones overlay, zone picker, map-tap
 * resolution) shares ONE fetch per game instead of each firing its own.
 * Identity-checked against the `polyGeoJSON` atom value so a play-area
 * change invalidates it. In-flight coalescing so concurrent callers
 * share the same request.
 */
let stationElementsCache: {
    filtersKey: string;
    polyRef: unknown;
    elements: OverpassElement[];
} | null = null;
let stationElementsInFlight: {
    filtersKey: string;
    polyRef: unknown;
    promise: Promise<OverpassElement[]>;
} | null = null;

/**
 * THE shared station FETCH (v1115) — used by BOTH the hider producer
 * (`produceAreaStations`) and the seeker `ZoneSidebar`, so the query is a
 * SINGLE producer, not two functions building the same string. Prewarmed
 * `/api/area-stations` union → live poly fallback, memoised per (filters,
 * play area), keeping the raw OSM elements (unnamed nodes + tags) for the
 * shared dedup. `filters` are the hiding-zone selector strings (the seeker's
 * `displayHidingZonesOptions`; the hider passes `hidingZoneFiltersFor(allowed)`).
 */
export async function fetchStationElements(
    filters: string[],
): Promise<OverpassElement[]> {
    if (filters.length === 0) return [];
    const filtersKey = filters.join("|");
    const polyRef = polyGeoJSON.get();

    if (
        stationElementsCache &&
        stationElementsCache.filtersKey === filtersKey &&
        stationElementsCache.polyRef === polyRef
    ) {
        return stationElementsCache.elements;
    }
    if (
        stationElementsInFlight &&
        stationElementsInFlight.filtersKey === filtersKey &&
        stationElementsInFlight.polyRef === polyRef
    ) {
        return stationElementsInFlight.promise;
    }

    const promise = (async () => {
        // v668/v669: try the PREWARMED station field first —
        // `/api/area-stations/<relationId>` serves the combined all-mode
        // stop set for a warm city straight from R2 (zero live Overpass),
        // fanned over every play-area relation, unioned, culled to the
        // combined polygon, and mode-filtered to `allowed` by
        // `fetchPrewarmedHidingZoneStations` (the SAME call the seeker
        // ZoneSidebar makes — one shared entry). Returns null on any cold
        // area → the live poly query below.
        // TRUST a warm result — even an EMPTY one (all areas warm + genuinely
        // no allowed-mode stations). This matches the seeker (which trusted
        // `if (prewarmed)`) and avoids a needless live re-query on a
        // warm-but-empty area. A wrongly-empty warm result is a prewarm bug to
        // fix at the source, not paper over with a live query (v640 lesson).
        const prewarmed = await fetchPrewarmedHidingZoneStations(filters);
        if (prewarmed) {
            stationElementsCache = {
                filtersKey,
                polyRef,
                elements: prewarmed.elements,
            };
            return prewarmed.elements;
        }

        // Byte-identical to the seeker's ZoneSidebar call (filters[0]
        // primary + rest as alternatives, nwr / out center, no timeout
        // header) so both roles share one cached Overpass entry.
        //
        // v667: `getOverpassData` returns `{elements: []}` BOTH on a
        // genuinely-empty result and on total mirror failure (rate limit
        // / soft-timeout storm). An empty caused by failure must THROW —
        // not be cached and returned — or every consumer renders
        // "loaded, zero zones" (the Chicago empty-overlay bug).
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
        if (elements.length === 0 && overpassFailureCount() > failuresBefore) {
            requestStationWarmAll();
            throw new Error(
                "Station scan failed — all Overpass mirrors timed out or rate-limited",
            );
        }

        stationElementsCache = { filtersKey, polyRef, elements };
        requestStationWarmAll();
        return elements;
    })();
    stationElementsInFlight = { filtersKey, polyRef, promise };
    try {
        return await promise;
    } finally {
        if (stationElementsInFlight?.promise === promise) {
            stationElementsInFlight = null;
        }
    }
}

/** One raw `out center` element → a StationPlace point feature, KEEPING
 *  unnamed nodes + all tags (so `mergeDuplicateStation`'s `inferStationMode`
 *  + nameless-absorption see the same data the seeker does). Null when the
 *  element has no usable coordinate. */
function elementToStationPlace(el: OverpassElement): StationPlace | null {
    const lat = typeof el.lat === "number" ? el.lat : el.center?.lat;
    const lng = typeof el.lon === "number" ? el.lon : el.center?.lon;
    if (typeof lat !== "number" || typeof lng !== "number") return null;
    const tags = el.tags ?? {};
    const name = tags["name:en"] ?? tags.name;
    return {
        type: "Feature",
        properties: { ...tags, id: String(el.id), ...(name ? { name } : {}) },
        geometry: { type: "Point", coordinates: [lng, lat] },
    } as unknown as StationPlace;
}

/** Fold `inferStationMode`'s output (which distinguishes `light_rail`) into
 *  our 5-mode `TransitMode` enum. */
function foldToTransitMode(m: string): TransitMode | null {
    if (m === "light_rail") return "tram";
    if (
        m === "subway" ||
        m === "train" ||
        m === "tram" ||
        m === "bus" ||
        m === "ferry"
    )
        return m;
    return null;
}

/**
 * THE single station producer (hider side). Fetches the shared play-area
 * station elements, runs the SHARED `mergeDuplicateStation` dedup (the
 * exact same union-find / coordinate-average / mode-union / nameless-
 * absorption / bus-90m-collapse the SEEKER uses — so the two roles can no
 * longer drift), and emits `AreaStation`s (nearest-first) with the full
 * `modes` set. Unnamed standalone stops are KEPT (matching the seeker; a
 * lone unnamed stop is a valid hiding zone). A merged stop with no allowed
 * mode is dropped (not a legal zone).
 */
async function produceAreaStations(
    allowed: TransitMode[],
    radius: number,
    units: Units,
    anchorLat: number,
    anchorLng: number,
): Promise<AreaStation[]> {
    const elements = await fetchStationElements(hidingZoneFiltersFor(allowed));
    const seen = new Set<number>();
    const places: StationPlace[] = [];
    for (const el of elements) {
        if (seen.has(el.id)) continue;
        seen.add(el.id);
        const p = elementToStationPlace(el);
        if (p) places.push(p);
    }

    const merged = mergeDuplicateStation(places, radius, units);
    const allowedSet = new Set(allowed);
    const out: AreaStation[] = [];
    for (const m of merged) {
        const props = m.properties as Record<string, unknown>;
        const rawModes = Array.isArray(props.modes)
            ? (props.modes as string[])
            : [];
        const modes = Array.from(
            new Set(
                rawModes
                    .map(foldToTransitMode)
                    .filter(
                        (x): x is TransitMode =>
                            x !== null && allowedSet.has(x),
                    ),
            ),
        );
        if (modes.length === 0) continue; // no allowed mode → not a legal zone
        const coords = m.geometry.coordinates;
        const idNum = Number(String(props.id).split("/").pop());
        out.push({
            id: Number.isFinite(idNum) ? idNum : 0,
            name: typeof props.name === "string" ? props.name : "",
            lat: coords[1],
            lng: coords[0],
            mode: modes[0],
            modes,
            distanceMeters: haversineMeters(
                anchorLat,
                anchorLng,
                coords[1],
                coords[0],
            ),
        });
    }
    out.sort((a, b) => a.distanceMeters - b.distanceMeters);
    return out;
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

/**
 * Every play-area OSM relation id — the primary PLUS each ADDED adjacent area.
 * v1126: single source (`@/lib/playAreaRelations`) — this used to be a private
 * copy here (with its own `primaryRelationId`), a twin in `overpass.ts`, and a
 * third in `playAreaPrefetch.ts`; a multi-region play area diverging between
 * two of them is exactly the class of bug the fan-over-relations fixes address.
 */
const playAreaRelationIdsAll = playAreaRelationIdsAllShared;

/** Fetch one relation's prewarmed all-mode station field. Returns null on
 *  a MISS (the endpoint's `cache` marker — not warmed yet — or an
 *  error/!ok) so callers can distinguish "cold" from a genuinely-empty
 *  warmed area (`[]`, no marker). Read-only — the worker never goes
 *  upstream on this path. */
async function fetchPrewarmedStations(
    relationId: number,
): Promise<OverpassElement[] | null> {
    try {
        const resp = await fetch(
            `${AREA_STATIONS_BY_RELATION_BASE}/${relationId}`,
        );
        if (!resp.ok) return null;
        const data = (await safeJsonFromCachedResponse(resp)) as {
            elements?: OverpassElement[];
            cache?: string;
        };
        // A `cache` marker ("miss"/"no-boundary") means this relation
        // isn't warmed yet — distinct from a warmed-but-empty area.
        if (data?.cache) return null;
        return data?.elements ?? [];
    } catch {
        return null;
    }
}

/**
 * Count the prewarmed candidate stations PER transit mode across a set of
 * play-area OSM relations (v1098). The setup wizard uses this to DEFAULT
 * the allowed-transit set to what the area ACTUALLY has, instead of
 * guessing from game size. Reads the same prewarmed all-mode station
 * endpoint the hiding-zones overlay uses, so it's Overpass-free for a
 * starred city.
 *
 * `relationIds[0]` is treated as the primary: we return null (→ the caller
 * falls back to the size heuristic) when the primary isn't warmed yet, or
 * no relation ids were given. Cold ids are background-warmed so a later
 * attempt succeeds. Not culled to the polygon — a rough per-mode count
 * needs no exactness, and the wizard hasn't committed a polygon yet.
 */
export async function detectAreaTransitCounts(
    relationIds: number[],
): Promise<Record<TransitMode, number> | null> {
    if (relationIds.length === 0) return null;
    const results = await Promise.all(
        relationIds.map((id) => fetchPrewarmedStations(id)),
    );
    // Background-warm any cold area so a later attempt is complete.
    relationIds.forEach((id, i) => {
        if (results[i] === null) requestStationWarm(id);
    });
    // Need the PRIMARY warm to trust the counts at all.
    if (results[0] === null) return null;
    const counts: Record<TransitMode, number> = {
        subway: 0,
        train: 0,
        tram: 0,
        bus: 0,
        ferry: 0,
    };
    for (const els of results) {
        if (!els) continue;
        for (const el of els) {
            const mode = inferMode(el.tags ?? {});
            if (mode) counts[mode]++;
        }
    }
    return counts;
}

/**
 * Fan the prewarmed station endpoint over EVERY play-area relation
 * (primary + each added adjacent area) and return the unioned,
 * play-area-culled elements — but ONLY when every area is warm. If ANY
 * area is cold (or the polygon isn't loaded, so we can't cull), returns
 * null: the caller background-warms the cold ids and uses the live poly
 * query, which covers the whole union. This is what makes an added
 * adjacent area first-class on the fast path — it's prewarmed and
 * unioned just like the primary, not dropped.
 */
async function fetchPrewarmedStationsUnion(): Promise<
    OverpassElement[] | null
> {
    if (!polyGeoJSON.get()) return null; // need the polygon to cull
    const ids = playAreaRelationIdsAll();
    if (ids.length === 0) return null;
    const results = await Promise.all(ids.map((id) => fetchPrewarmedStations(id)));
    if (results.some((r) => r === null)) {
        // Some area is cold → warm every cold id and decline (caller uses
        // the live poly query, which covers the whole union).
        ids.forEach((id, i) => {
            if (results[i] === null) requestStationWarm(id);
        });
        return null;
    }
    const merged = results.flatMap((r) => r as OverpassElement[]);
    return cullElementsToPlayArea(merged);
}

/**
 * v970 (rulebook audit B): the RAIL-STATION reference set for the measuring
 * "Rail Station" question — "Includes light and heavy rail; metros/subways
 * count" (rulebook p206). Served from the prewarmed all-mode area-stations
 * union filtered to the rail modes (train / subway / tram), so it covers
 * `railway=halt`, tram stops, and PTv2-only light rail that the bare
 * `["railway"="station"]` reference filter misses — Overpass-free for a
 * warm city. Returns null (caller falls back to its live query) when any
 * play-area relation is cold or the area isn't relation-backed.
 */
export async function fetchPrewarmedRailStationElements(): Promise<
    | {
          id: number;
          lat?: number;
          lon?: number;
          center?: { lat?: number; lon?: number };
          tags?: Record<string, string>;
      }[]
    | null
> {
    const union = await fetchPrewarmedStationsUnion();
    if (!union) return null;
    const rail: TransitMode[] = ["train", "subway", "tram"];
    return union.filter((el) => {
        const mode = inferMode(el.tags ?? {});
        return mode !== null && rail.includes(mode);
    });
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

/** Warm the station field for EVERY play-area relation (primary + added
 *  adjacent areas). Called after a live poly fetch so the next load of
 *  the whole union is served from R2 — and PROACTIVELY when the hiding
 *  period starts (`GameStartWatcher`), so that a multi-area play area
 *  (whose ADDED areas usually aren't curated/prewarmed) has its whole
 *  station union warm in R2 by the time the hider opens the overlay,
 *  instead of falling to a heavy combined live poly query that soft-times
 *  out on a dense metro like Vancouver. Deduped per session. */
export function requestStationWarmAll(): void {
    for (const id of playAreaRelationIdsAll()) requestStationWarm(id);
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
 * Internal fast-path for `fetchStationElements` (v668, fan-out v669; made
 * private v1120 — the seeker `ZoneSidebar` now goes through
 * `fetchStationElements`, so this is no longer an external entry point):
 * serve the DEFAULT hiding-zone station set from the prewarmed
 * `/api/area-stations/<id>` endpoint — fanned over EVERY play-area relation
 * (primary + added adjacent areas) and unioned — when the given filter
 * `options` map cleanly to transit modes (the common auto-tracking case).
 * Zero live Overpass on a warm city. Returns an Overpass-shaped
 * `{ elements }` (all requested modes, culled to the combined play area) so
 * the caller feeds it straight to `osmtogeojson`, exactly like the poly
 * query's result. Returns null — caller falls back to the live poly query —
 * for a custom/partial-mode selection, a non-relation play area, no loaded
 * polygon, or any cold area (background-warmed by
 * `fetchPrewarmedStationsUnion`).
 */
async function fetchPrewarmedHidingZoneStations(
    options: string[],
): Promise<{ elements: OverpassElement[] } | null> {
    const modes = modesForExactOptions(options);
    if (!modes) return null;
    const union = await fetchPrewarmedStationsUnion();
    if (!union) return null; // custom-warm miss, or a cold area → poly query
    const filtered = union.filter((el) => {
        const mode = inferMode(el.tags ?? {});
        return mode !== null && modes.includes(mode);
    });
    return { elements: filtered };
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
    // v1115: the single station producer — shares the SEEKER's
    // `mergeDuplicateStation` dedup (no more role drift). Default radius 0.5 km
    // → the same-name merge floor of 800 m, matching the seeker.
    // v751: NO cap — the seeker overlay unions EVERY station circle uncapped
    // off-thread, so the hider shows the SAME full field.
    return produceAreaStations(
        allowed,
        opts.radius ?? 0.5,
        opts.units ?? "kilometers",
        centerLat,
        centerLng,
    );
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
    // Same single producer + shared dedup; the radius IS the containment
    // radius, so the same-name merge distance matches the zones being tested.
    const all = await produceAreaStations(
        allowed,
        opts.radiusMeters,
        "meters",
        lat,
        lng,
    );
    return all.filter((s) => s.distanceMeters <= opts.radiusMeters);
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

/** Classify a station element's tags into our 5-mode `TransitMode` enum.
 *  v1120: DELEGATES to the SHARED `inferStationMode` (the exact classifier the
 *  dedup `mergeDuplicateStation` uses), folded via `foldToTransitMode`, so the
 *  prewarm-element filter and the dedup can no longer DISAGREE. They used to:
 *  a `railway=light_rail` node was dropped here but kept (as tram) by the dedup,
 *  and a multi-tag `railway=station`+`bus=yes` node classified train here but
 *  bus there — the exact "two roles classify the same OSM node differently"
 *  drift the v1115 unification set out to kill. */
function inferMode(tags: Record<string, string>): TransitMode | null {
    return foldToTransitMode(inferStationMode(tags) ?? "");
}

