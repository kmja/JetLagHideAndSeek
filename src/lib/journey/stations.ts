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

import { polyGeoJSON } from "@/lib/context";
import { hidingZoneFiltersFor, type TransitMode } from "@/lib/gameSetup";
import { haversineMeters } from "@/lib/geo";
import { findPlacesInZone } from "@/maps/api/overpass";

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
        // Byte-identical to the seeker's ZoneSidebar call (filters[0]
        // primary + rest as alternatives, nwr / out center, no timeout
        // header) so both roles share one cached Overpass entry. `silent`
        // — every consumer has its own loading/error affordances.
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
        rawStationsCache = { filtersKey, polyRef, stations };
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
