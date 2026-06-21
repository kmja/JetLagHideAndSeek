/**
 * Area-wide transit-station scan for the hider's reach overlay.
 *
 * `NearbyStationsPicker` already fetches stations within 500 m for the
 * "improvise on short notice" zone picker. The reach overlay needs a
 * much wider view — the hider's question is "of EVERY candidate
 * hiding zone in this city, which can I get to before the whistle?".
 *
 * The scan is mode-aware in two ways:
 *
 *   1. Per-mode radius caps. Subway/train/ferry can carry the hider
 *      tens of kilometres in a 30-minute hiding period; bus, far less.
 *      Querying every bus stop within an hour-train's reach would
 *      pull in thousands of stops and blow past both the worker's
 *      200-stop proxy cap and any reasonable map-clutter budget.
 *
 *   2. Result tier. When the per-mode results combined still exceed
 *      the cap, we trim from the *least mobile* mode first (bus →
 *      tram → ferry → train → subway), so the user sees the
 *      strategically-relevant stations even in dense networks.
 *
 * Stations from multiple modes are deduped by normalised name +
 * proximity (same logic NearbyStationsPicker uses for the same
 * reason: OSM models a single station as many platform/entrance
 * nodes).
 */

import type { TransitMode } from "@/lib/gameSetup";
import { haversineMeters } from "@/lib/geo";
import { getOverpassData } from "@/maps/api/overpass";

/** Total stops cap. The journey-arrival proxy enforces 200; we
 *  budget a little under so other request bookkeeping (e.g. the
 *  walking pre-filter falling through to a station the caller
 *  added explicitly) has headroom. */
export const MAX_AREA_STATIONS = 180;

export interface AreaStation {
    /** OSM node id. Stable identifier for the journey-arrivals proxy. */
    id: number;
    name: string;
    lat: number;
    lng: number;
    mode: TransitMode;
    distanceMeters: number;
}

/**
 * Per-mode straight-line speed in km/h. Used to derive a "could the
 * hider plausibly reach this station by this mode at all" radius
 * cap. Deliberately generous — the radius is a coarse pre-filter,
 * NOT the live-schedule check (that's the proxy's job).
 */
const MODE_SPEED_KMH: Record<TransitMode, number> = {
    subway: 50,
    train: 70,
    ferry: 25,
    tram: 20,
    bus: 18,
};

/** Hard upper bound on per-mode scan radius, in metres. Past ~40 km
 *  Overpass response sizes balloon (esp. for bus) and we hit the
 *  worker's CPU budget probing them all. The cap is well above any
 *  realistic intra-city move during a hiding period. */
const MAX_MODE_RADIUS_M: Record<TransitMode, number> = {
    subway: 40_000,
    train: 50_000,
    ferry: 30_000,
    tram: 20_000,
    bus: 15_000,
};

/** Mode priority — higher = surfaces first when we trim to the cap.
 *  The "is the seeker checking thermometer near the metro?" decision
 *  cares vastly more about a hider on the subway than one waiting for
 *  a city bus, so subway/train stations are kept under pressure. */
const MODE_PRIORITY: Record<TransitMode, number> = {
    subway: 5,
    train: 4,
    ferry: 3,
    tram: 2,
    bus: 1,
};

export interface AreaStationOptions {
    /** Hiding-period budget in minutes — drives per-mode radius. */
    hidingDurationMin: number;
    /** Which transit modes the game allows; defaults to all. */
    allowed: TransitMode[];
}

/** Pull every plausibly-reachable transit station around a centre. */
export async function fetchAreaStations(
    centerLat: number,
    centerLng: number,
    opts: AreaStationOptions,
): Promise<AreaStation[]> {
    const allowed = opts.allowed.length > 0 ? opts.allowed : ALL_MODES;
    const queries: string[] = [];

    for (const mode of allowed) {
        const r = perModeRadiusM(mode, opts.hidingDurationMin);
        if (r <= 0) continue;
        queries.push(...modeOverpassClauses(mode, centerLat, centerLng, r));
    }
    if (queries.length === 0) return [];

    const query = `
[out:json][timeout:30];
(
${queries.join("\n")}
);
out;
`;
    const data = await getOverpassData(query, undefined);
    const elements = (data as { elements?: OverpassNode[] }).elements ?? [];

    const seenIds = new Set<number>();
    const stations: AreaStation[] = [];
    for (const el of elements) {
        if (typeof el.lat !== "number" || typeof el.lon !== "number") continue;
        if (seenIds.has(el.id)) continue;
        seenIds.add(el.id);
        const name = el.tags?.["name:en"] ?? el.tags?.name;
        if (!name) continue;
        const mode = inferMode(el.tags ?? {});
        if (!mode || !allowed.includes(mode)) continue;
        stations.push({
            id: el.id,
            name,
            lat: el.lat,
            lng: el.lon,
            mode,
            distanceMeters: haversineMeters(
                centerLat,
                centerLng,
                el.lat,
                el.lon,
            ),
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

function perModeRadiusM(mode: TransitMode, hidingMin: number): number {
    const fromSpeed = (MODE_SPEED_KMH[mode] * hidingMin) / 60; // km
    const fromCap = MAX_MODE_RADIUS_M[mode];
    return Math.min(fromSpeed * 1000, fromCap);
}

function modeOverpassClauses(
    mode: TransitMode,
    lat: number,
    lng: number,
    radiusM: number,
): string[] {
    const around = `around:${Math.round(radiusM)},${lat},${lng}`;
    switch (mode) {
        case "subway":
            return [
                `node[station=subway](${around});`,
                `node[railway=station][subway=yes](${around});`,
            ];
        case "train":
            return [`node[railway=station][!"subway"](${around});`];
        case "tram":
            return [`node[railway=tram_stop](${around});`];
        case "bus":
            return [
                `node[highway=bus_stop](${around});`,
                `node[public_transport=stop_position][bus=yes](${around});`,
            ];
        case "ferry":
            return [`node[amenity=ferry_terminal](${around});`];
    }
}

interface OverpassNode {
    id: number;
    lat?: number;
    lon?: number;
    tags?: Record<string, string>;
}

function inferMode(tags: Record<string, string>): TransitMode | null {
    if (tags.subway === "yes" || tags.station === "subway") return "subway";
    if (tags.railway === "station") return "train";
    if (tags.railway === "tram_stop" || tags.tram === "yes") return "tram";
    if (tags.amenity === "ferry_terminal" || tags.ferry === "yes")
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
