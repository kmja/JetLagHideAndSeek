/**
 * PROTOTYPE (v704, Topic 2) — "transit-reach" adjacency.
 *
 * The shipped adjacency (`playAreaExtensions.ts`) starts from ADMIN
 * ADJACENCY: neighbouring municipalities within N km, flagged by whether any
 * transit station happens to fall in their bbox. In Stockholm that both
 * over-collects (municipalities the metro never touches) and under-collects
 * (the point is "everywhere the tunnelbana / pendeltåg runs", which isn't the
 * same as "shares a border").
 *
 * This module inverts the question: start from the primary's RAIL NETWORK
 * (subway + light-rail + commuter/suburban train), take every stop those
 * route relations serve, and return the municipalities those stops land in.
 * That's literally "everywhere the subway or commuter train runs".
 *
 * NOT wired into the wizard yet — it's reachable only from the `/debug/
 * adjacency` comparison page so the candidate sets can be eyeballed on
 * Stockholm + a few test cities before it becomes the default selector.
 */

import { booleanPointInPolygon } from "@turf/turf";

import { RELATION_EXTENT_BASE } from "./constants";
import { getOverpassData } from "./overpass";
import {
    buildAdjacentAdminQuery,
    buildLocalAdminBandQuery,
} from "./playAreaExtensions";
import { fetchRawBoundaryPolygon } from "./polygonsOsmFr";
import type { OpenStreetMap } from "./types";
import { CacheType } from "./types";

export type RailRouteKind = "subway" | "light_rail" | "commuter" | "tram";

export interface TransitReachCandidate {
    /** OSM relation id of the municipality. */
    relationId: number;
    name: string;
    /** How many rail-network stops fall inside this municipality. */
    stopCount: number;
    /** Centroid distance to the primary centroid, km. */
    distanceKm: number;
    /** The route kinds whose stops reach it (subway / commuter / …). */
    kinds: RailRouteKind[];
    /** Estimated bbox area, km² — the "few large over many small" signal. */
    areaKm2: number;
    /** OSM admin_level of this candidate (coarser = larger unit). */
    adminLevel: string | null;
    /** [maxLat, minLng, minLat, maxLng] — Photon order, for framing. */
    extent: [number, number, number, number];
}

export interface TransitReachResult {
    primaryOsmId: number;
    primaryName: string;
    /** All rail-network stops found (for map display). */
    stops: RailStop[];
    /** Municipalities the network reaches, sorted by stop count desc. */
    candidates: TransitReachCandidate[];
    /** Municipalities considered but NOT reached (for the debug page's
     *  "admin-adjacent but no rail" column). */
    unreached: { relationId: number; name: string }[];
}

interface RailStop {
    lat: number;
    lon: number;
    kind: RailRouteKind;
    name?: string;
}

interface AdminStub {
    id: number;
    name: string;
    adminLevel: string | null;
    areaKm2: number;
    extent: [number, number, number, number];
    lat: number;
    lng: number;
}

/**
 * One Overpass query: the rail-network route relations near the centroid and
 * every node member (stop) they serve. `service~commuter|suburban` keeps a
 * `route=train` to LOCAL rail (pendeltåg, S-Bahn) and excludes intercity /
 * high-speed, which would drag the reach to other cities. Subway + light_rail
 * are always local. Tram is optional (off by default — a dense tram net can
 * blanket the whole metro and dominate the set).
 */
export function buildRailNetworkStopsQuery(
    lat: number,
    lng: number,
    radiusKm: number,
    kinds: RailRouteKind[],
): string {
    const r = Math.round(radiusKm * 1000);
    const around = `(around:${r},${lat},${lng})`;
    const routeSelectors: string[] = [];
    if (kinds.includes("subway"))
        routeSelectors.push(`relation["route"="subway"]${around};`);
    if (kinds.includes("light_rail"))
        routeSelectors.push(`relation["route"="light_rail"]${around};`);
    if (kinds.includes("tram"))
        routeSelectors.push(`relation["route"="tram"]${around};`);
    if (kinds.includes("commuter"))
        routeSelectors.push(
            `relation["route"="train"]["service"~"^(commuter|suburban)$"]${around};`,
        );
    return `
[out:json][timeout:90];
(
${routeSelectors.join("\n")}
)->.routes;
node(r.routes);
out;
`;
}

/** Which route kind a stop belongs to — inferred from the route relation's
 *  tags isn't available per-node, so we tag each stop by the STRICTEST route
 *  it was a member of via a second pass. For the prototype we instead tag by
 *  the node's own hints, defaulting to "commuter" (the query already limited
 *  the routes, so any returned node is on one of the selected networks). */
function inferStopKind(tags?: Record<string, string>): RailRouteKind {
    if (!tags) return "commuter";
    if (tags.station === "subway" || tags.subway === "yes") return "subway";
    if (tags.light_rail === "yes" || tags.station === "light_rail")
        return "light_rail";
    if (tags.railway === "tram_stop" || tags.tram === "yes") return "tram";
    return "commuter";
}

async function fetchRailStops(
    lat: number,
    lng: number,
    radiusKm: number,
    kinds: RailRouteKind[],
): Promise<RailStop[]> {
    const query = buildRailNetworkStopsQuery(lat, lng, radiusKm, kinds);
    const data = await getOverpassData(
        query,
        undefined,
        CacheType.ZONE_CACHE,
        90_000,
        false,
        undefined,
        /* silent */ true,
    );
    const els = ((data as { elements?: unknown[] }).elements ?? []) as Array<{
        type?: string;
        lat?: number;
        lon?: number;
        tags?: Record<string, string>;
    }>;
    const stops: RailStop[] = [];
    for (const el of els) {
        if (el.type !== "node") continue;
        if (typeof el.lat !== "number" || typeof el.lon !== "number") continue;
        stops.push({
            lat: el.lat,
            lon: el.lon,
            kind: inferStopKind(el.tags),
            name: el.tags?.name,
        });
    }
    return stops;
}

/** Resolve the canonical centroid the same way `findExtensionCandidates`
 *  does — the shared relation-extent endpoint, falling back to the Photon
 *  geometry point. */
async function resolvePrimaryCentroid(
    primary: OpenStreetMap,
): Promise<{ lat: number; lng: number }> {
    const coords = primary.geometry.coordinates as unknown as [number, number];
    let [lat, lng] = coords;
    try {
        const resp = await fetch(
            `${RELATION_EXTENT_BASE}/${primary.properties.osm_id}`,
        );
        if (resp.ok) {
            const data = (await resp.json()) as { extent?: number[] | null };
            const ext = data.extent;
            if (ext && ext.length === 4 && ext.every((v) => Number.isFinite(v))) {
                const [maxLat, minLng, minLat, maxLng] = ext;
                lat = (maxLat + minLat) / 2;
                lng = (minLng + maxLng) / 2;
            }
        }
    } catch {
        /* keep geometry point */
    }
    return { lat, lng };
}

/** Admin municipalities near the centroid. With `adminLevelOverride` set,
 *  queries THAT level (e.g. "6" = county) instead of the primary's own — the
 *  "few large over many small" lever: a coarser level returns a handful of
 *  counties rather than dozens of tiny suburbs (Chicago's problem). Default
 *  uses the primary's own level, else the broad local-admin sweep. */
async function fetchAdminCandidates(
    primary: OpenStreetMap,
    lat: number,
    lng: number,
    radiusKm: number,
    adminLevelOverride?: string,
): Promise<AdminStub[]> {
    const primaryLevel = adminLevelOverride ?? primary.properties.type;
    const isNumericLevel =
        typeof primaryLevel === "string" && /^\d+$/.test(primaryLevel);
    const query = isNumericLevel
        ? buildAdjacentAdminQuery(primaryLevel, lat, lng, radiusKm)
        : buildLocalAdminBandQuery(lat, lng, radiusKm);
    const data = await getOverpassData(
        query,
        undefined,
        CacheType.ZONE_CACHE,
        90_000,
        false,
        undefined,
        /* silent */ true,
    );
    const els = ((data as { elements?: unknown[] }).elements ?? []) as Array<{
        type?: string;
        id?: number;
        tags?: Record<string, string>;
        bounds?: {
            minlat: number;
            minlon: number;
            maxlat: number;
            maxlon: number;
        };
    }>;
    const out: AdminStub[] = [];
    for (const el of els) {
        if (el.type !== "relation" || typeof el.id !== "number") continue;
        if (el.id === primary.properties.osm_id) continue;
        if (!el.bounds) continue;
        const name =
            el.tags?.name ||
            el.tags?.["name:en"] ||
            el.tags?.official_name ||
            `Relation ${el.id}`;
        out.push({
            id: el.id,
            name,
            adminLevel: el.tags?.admin_level ?? null,
            areaKm2: bboxAreaKm2(el.bounds),
            extent: [
                el.bounds.maxlat,
                el.bounds.minlon,
                el.bounds.minlat,
                el.bounds.maxlon,
            ],
            lat: (el.bounds.minlat + el.bounds.maxlat) / 2,
            lng: (el.bounds.minlon + el.bounds.maxlon) / 2,
        });
    }
    return out;
}

function bboxAreaKm2(b: {
    minlat: number;
    minlon: number;
    maxlat: number;
    maxlon: number;
}): number {
    const midLat = (b.minlat + b.maxlat) / 2;
    const latKm = Math.abs(b.maxlat - b.minlat) * 111;
    const lngKm =
        Math.abs(b.maxlon - b.minlon) * 111 * Math.cos((midLat * Math.PI) / 180);
    return latKm * lngKm * 0.55; // match BBOX_FILL_FACTOR
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

/**
 * Compute the transit-reach candidate set for a primary play area.
 *
 * 1. Fetch the rail network's stops (subway + commuter + …).
 * 2. Fetch admin municipalities near the centroid.
 * 3. For each municipality, count how many stops fall inside its REAL polygon
 *    (bbox first as a cheap gate, then point-in-polygon). Municipalities with
 *    ≥1 stop are "reached".
 */
export async function findTransitReachCandidates(
    primary: OpenStreetMap,
    options: {
        radiusKm?: number;
        kinds?: RailRouteKind[];
        /** Override the candidate admin_level ("6" = county, "7", "8" =
         *  municipality). Coarser = fewer, larger adjacents. */
        adminLevel?: string;
    } = {},
): Promise<TransitReachResult> {
    const radiusKm = options.radiusKm ?? 40;
    const kinds = options.kinds ?? ["subway", "light_rail", "commuter"];
    const primaryName = primary.properties.name ?? "Primary";
    const primaryOsmId = primary.properties.osm_id;

    const { lat, lng } = await resolvePrimaryCentroid(primary);

    const [stops, adminCandidates] = await Promise.all([
        fetchRailStops(lat, lng, radiusKm, kinds).catch((e) => {
            console.warn("[transit-reach] rail stops fetch failed:", e);
            return [] as RailStop[];
        }),
        fetchAdminCandidates(
            primary,
            lat,
            lng,
            radiusKm,
            options.adminLevel,
        ).catch((e) => {
            console.warn("[transit-reach] admin candidates fetch failed:", e);
            return [] as AdminStub[];
        }),
    ]);

    const candidates: TransitReachCandidate[] = [];
    const unreached: { relationId: number; name: string }[] = [];

    // Fetch candidate polygons with limited concurrency (cached/worker-first).
    const CONCURRENCY = 5;
    let idx = 0;
    const runNext = async (): Promise<void> => {
        while (idx < adminCandidates.length) {
            const cand = adminCandidates[idx++];
            // Cheap bbox pre-filter: stops that could possibly be inside.
            const [maxLat, minLng, minLat, maxLng] = cand.extent;
            const bboxStops = stops.filter(
                (s) =>
                    s.lat >= minLat &&
                    s.lat <= maxLat &&
                    s.lon >= minLng &&
                    s.lon <= maxLng,
            );
            if (bboxStops.length === 0) {
                unreached.push({ relationId: cand.id, name: cand.name });
                continue;
            }
            let poly: GeoJSON.Polygon | GeoJSON.MultiPolygon | null = null;
            try {
                poly = await fetchRawBoundaryPolygon(cand.id);
            } catch {
                poly = null;
            }
            let inside = bboxStops;
            if (poly) {
                const feature = {
                    type: "Feature" as const,
                    properties: {},
                    geometry: poly,
                };
                inside = bboxStops.filter((s) => {
                    try {
                        return booleanPointInPolygon(
                            [s.lon, s.lat],
                            feature as never,
                        );
                    } catch {
                        return false;
                    }
                });
            }
            if (inside.length === 0) {
                unreached.push({ relationId: cand.id, name: cand.name });
                continue;
            }
            const kindSet = new Set<RailRouteKind>();
            for (const s of inside) kindSet.add(s.kind);
            candidates.push({
                relationId: cand.id,
                name: cand.name,
                stopCount: inside.length,
                distanceKm: haversineKm(lat, lng, cand.lat, cand.lng),
                kinds: [...kindSet],
                areaKm2: cand.areaKm2,
                adminLevel: cand.adminLevel,
                extent: cand.extent,
            });
        }
    };
    await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, adminCandidates.length) }, () =>
            runNext(),
        ),
    );

    candidates.sort(
        (a, b) => b.stopCount - a.stopCount || a.distanceKm - b.distanceKm,
    );

    return {
        primaryOsmId,
        primaryName,
        stops,
        candidates,
        unreached,
    };
}
