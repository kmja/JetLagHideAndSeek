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

import { hidingZoneFiltersFor, type TransitMode } from "@/lib/gameSetup";
import { haversineMeters } from "@/lib/geo";
import { findPlacesInZone, getOverpassData } from "@/maps/api/overpass";

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

/**
 * Resolve a map tap to the nearest transit station within `radiusM`,
 * or null if none is in range. Tiny single-shot Overpass query (no
 * mode-filtering, no caching of the result set itself — the worker's
 * R2/edge cache deduplicates the byte-identical query for nearby taps).
 * Used by the hider map's "tap basemap" fallback so the hider can
 * still open a station card when the reach overlay is off.
 */
export async function findNearestStation(
    lat: number,
    lng: number,
    radiusM = 300,
): Promise<{ lat: number; lng: number; name?: string } | null> {
    const query = `
[out:json][timeout:10];
(
  node["railway"~"^(station|halt|tram_stop)$"](around:${radiusM},${lat},${lng});
  node["public_transport"="station"](around:${radiusM},${lat},${lng});
  node["highway"="bus_stop"](around:${radiusM},${lat},${lng});
);
out;
`;
    let data: { elements?: OverpassElement[] } | null = null;
    try {
        data = (await getOverpassData(query, undefined)) as {
            elements?: OverpassElement[];
        };
    } catch {
        return null;
    }
    const elements = data?.elements ?? [];
    let best: { lat: number; lng: number; name?: string; d: number } | null =
        null;
    for (const el of elements) {
        if (typeof el.lat !== "number" || typeof el.lon !== "number") continue;
        const d = haversineMeters(lat, lng, el.lat, el.lon);
        if (best && d >= best.d) continue;
        const name = el.tags?.["name:en"] ?? el.tags?.name;
        best = { lat: el.lat, lng: el.lon, name, d };
    }
    return best ? { lat: best.lat, lng: best.lng, name: best.name } : null;
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
    const filters = hidingZoneFiltersFor(allowed);
    if (filters.length === 0) return [];

    // Byte-identical to the seeker's ZoneSidebar call (filters[0] primary
    // + rest as alternatives, nwr / out center, no timeout header) so both
    // roles share one cached Overpass entry. `silent` — the overlay has
    // its own loading/error affordances.
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
    const stations: AreaStation[] = [];
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
        stations.push({
            id: el.id,
            name,
            lat,
            lng,
            mode,
            distanceMeters: haversineMeters(centerLat, centerLng, lat, lng),
        });
    }

    // Sort by distance, dedupe by (normalised name + 150 m proximity).
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
