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

import {
    area,
    booleanIntersects,
    booleanPointInPolygon,
    intersect,
} from "@turf/turf";

import { RELATION_EXTENT_BASE } from "./constants";
import { getOverpassData } from "./overpass";
import {
    buildAdjacentAdminQuery,
    buildLocalAdminBandQuery,
} from "./playAreaExtensions";
import { fetchRawBoundaryPolygon } from "./polygonsOsmFr";
import type { OpenStreetMap } from "./types";
import { CacheType } from "./types";

/** The transit modes the reach can follow — ALL the game's allowed modes,
 *  not just rail. Bus + ferry matter: Amsterdam's north-of-IJ areas are
 *  ferry/bus-served, so a rail-only reach left them as gaps. "commuter" is
 *  `route=train` (local/suburban), kept separate from long-distance. */
export type RailRouteKind =
    | "subway"
    | "light_rail"
    | "commuter"
    | "tram"
    | "bus"
    | "ferry";

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
    /** Stops per km² over the candidate's REAL polygon area — the
     *  transit-density signal. A single line grazing a big rural county
     *  (Seoul's Gapyeong: 8 stops / 900 km²) scores near 0; an integrated
     *  suburb (Seongnam: 350 / 129) scores high. Low density = a bad hiding
     *  region (one line into no man's land), so it's a drop signal. */
    stopsPerKm2: number;
    /** OSM admin_level of this candidate (coarser = larger unit). */
    adminLevel: string | null;
    /** [maxLat, minLng, minLat, maxLng] — Photon order, for framing. */
    extent: [number, number, number, number];
    /** Real boundary polygon (fetched for the point-in-polygon test) — for
     *  the debug map. Null when the boundary fetch missed (bbox was used). */
    polygon: GeoJSON.Polygon | GeoJSON.MultiPolygon | null;
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
    if (kinds.includes("ferry"))
        routeSelectors.push(`relation["route"="ferry"]${around};`);
    if (kinds.includes("bus"))
        // Bus is the heavy one — a metro has hundreds of routes and their
        // stops number in the thousands — but it's the mode that fills the
        // ferry/rail gaps (rural neighbours a player can still reach by bus).
        routeSelectors.push(`relation["route"="bus"]${around};`);
    if (kinds.includes("commuter"))
        // v706: match `route=train` EXCLUDING only long-distance / high-speed
        // / night services, instead of REQUIRING service=commuter|suburban.
        // The strict form missed local rail that's tagged differently or not
        // at all — Stockholm's Roslagsbanan (narrow-gauge SL rail to Täby)
        // wasn't `service=commuter`, so Täby dropped out. `!~` also matches
        // routes with NO `service` tag (untagged local lines). Over-reach from
        // an intercity line that merely passes through is bounded by the
        // admin-candidate radius (its far stops match no nearby municipality).
        routeSelectors.push(
            `relation["route"="train"]["service"!~"^(long_distance|high_speed|night|car|car_shuttle)$"]${around};`,
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
    if (tags.amenity === "ferry_terminal" || tags.ferry === "yes")
        return "ferry";
    if (tags.highway === "bus_stop" || tags.bus === "yes") return "bus";
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

/** [maxLat, minLng, minLat, maxLng] bbox of a (Multi)Polygon's coordinates. */
function polygonExtent(
    geom: GeoJSON.Polygon | GeoJSON.MultiPolygon,
): [number, number, number, number] {
    let minLat = Infinity,
        maxLat = -Infinity,
        minLng = Infinity,
        maxLng = -Infinity;
    const rings =
        geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
    for (const poly of rings) {
        for (const [lng, lat] of poly[0] ?? []) {
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
            if (lng < minLng) minLng = lng;
            if (lng > maxLng) maxLng = lng;
        }
    }
    return [maxLat, minLng, minLat, maxLng];
}

function extentAreaKm2(ext: [number, number, number, number]): number {
    const [maxLat, minLng, minLat, maxLng] = ext;
    const midLat = (minLat + maxLat) / 2;
    const latKm = Math.abs(maxLat - minLat) * 111;
    const lngKm =
        Math.abs(maxLng - minLng) * 111 * Math.cos((midLat * Math.PI) / 180);
    return latKm * lngKm * 0.55;
}

/**
 * Drop offshore islands / far exclaves from a boundary (v713, tightened v715).
 * Two cases:
 *   - Hamburg legally owns Neuwerk (tiny island ~100 km out in the North Sea).
 *   - LA County's boundary includes the Channel Islands (Catalina ~35 km off,
 *     San Clemente ~100 km, San Nicolas …) — no one hides on San Clemente.
 * Both inflate the bbox (breaking the relative area cap) and are impractical
 * play-area members. Keeps the LARGEST component plus any that's either
 * SUBSTANTIAL (≥15% of the largest — a real second land mass, not an island)
 * or NEAR it (bboxes within ~5 km — a neighbourhood across a thin strait/
 * river). Drops the small, separated bits (islands). No-op for a single
 * Polygon or a compact MultiPolygon. Distance-agnostic: a big offshore island
 * 35 km out is still dropped because it's small relative to the mainland.
 */
export function dropFarExclaves(
    geom: GeoJSON.Polygon | GeoJSON.MultiPolygon,
): GeoJSON.Polygon | GeoJSON.MultiPolygon {
    if (geom.type !== "MultiPolygon" || geom.coordinates.length <= 1)
        return geom;
    const parts = geom.coordinates.map((poly) => {
        const ext = polygonExtent({ type: "Polygon", coordinates: poly });
        return { poly, ext, area: extentAreaKm2(ext) };
    });
    const largest = parts.reduce((a, b) => (b.area > a.area ? b : a));
    const MIN_FRACTION = 0.15;
    const kept = parts.filter(
        (p) =>
            p === largest ||
            p.area >= MIN_FRACTION * largest.area ||
            bboxesNear(p.ext, largest.ext, 0.05),
    );
    if (kept.length === geom.coordinates.length) return geom;
    return { type: "MultiPolygon", coordinates: kept.map((k) => k.poly) };
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
        /** Keep only the reached areas connected to the primary (drops
         *  isolated far districts a through-line pulls in). Default true. */
        contiguousOnly?: boolean;
        /** Drop candidates whose area is more than this multiple of the
         *  primary's — a country-agnostic "not a whole province" cap. A
         *  neighbouring municipality/county is a few × the city; a province
         *  is 15-40×. Default 10. Applied BEFORE the containment dedup so a
         *  province doesn't swallow the municipalities inside it. */
        maxAreaRatio?: number;
        /** Drop candidates below this stops-per-km² density — a single line
         *  grazing a big rural county makes a bad hiding region. Default 0
         *  (off). */
        minStopsPerKm2?: number;
    } = {},
): Promise<TransitReachResult> {
    const radiusKm = options.radiusKm ?? 40;
    const kinds = options.kinds ?? ["subway", "light_rail", "commuter"];
    const primaryName = primary.properties.name ?? "Primary";
    const primaryOsmId = primary.properties.osm_id;

    // Fetch + clean the primary boundary FIRST. Tokyo Metropolis (東京都) owns
    // the Izu + Ogasawara Islands ~1000 km south in the Pacific, so its raw
    // bbox centre lands in the OCEAN — the `around:centre` stop/candidate
    // queries then search empty sea (0 stops, island subprefectures as
    // "adjacents"). Drop the far exclaves, then derive the centre from the
    // MAINLAND so the queries hit the real city. (Also used to DROP candidates
    // inside the primary + seed contiguity + size the area cap.)
    const rawPrimaryPolygon = await fetchRawBoundaryPolygon(primaryOsmId).catch(
        () => null,
    );
    const primaryPolygon = rawPrimaryPolygon
        ? dropFarExclaves(rawPrimaryPolygon)
        : null;

    const { lat, lng } = primaryPolygon
        ? (() => {
              const [maxLat, minLng, minLat, maxLng] =
                  polygonExtent(primaryPolygon);
              return { lat: (maxLat + minLat) / 2, lng: (minLng + maxLng) / 2 };
          })()
        : await resolvePrimaryCentroid(primary);

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
    const primaryFeature = primaryPolygon
        ? ({
              type: "Feature",
              properties: {},
              geometry: primaryPolygon,
          } as GeoJSON.Feature)
        : null;
    const primaryAreaKm2 = primaryPolygon
        ? extentAreaKm2(polygonExtent(primaryPolygon))
        : null;
    const maxAreaRatio = options.maxAreaRatio ?? 10;
    const mostlyInsidePrimary = (
        candPoly: GeoJSON.Polygon | GeoJSON.MultiPolygon,
    ): boolean => {
        if (!primaryFeature) return false;
        try {
            const cand = {
                type: "Feature",
                properties: {},
                geometry: candPoly,
            } as GeoJSON.Feature;
            const inter = intersect(
                // turf's FeatureCollection-of-two-polygons signature (as used
                // elsewhere in the repo, e.g. measuring.ts).
                {
                    type: "FeatureCollection",
                    features: [primaryFeature, cand],
                } as never,
            );
            if (!inter) return false;
            const candArea = area(cand as never);
            if (candArea <= 0) return false;
            return area(inter as never) / candArea > 0.9;
        } catch {
            return false;
        }
    };

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
            // Drop offshore islands from the candidate too (LA County's
            // Channel Islands) — for the map, the stop test, and eventually
            // the cached play-area shape.
            if (poly) poly = dropFarExclaves(poly);
            // Drop candidates already inside the primary play area (a real
            // polygon-overlap test — robust to donut districts like Munich's
            // Landkreis). Needs the candidate polygon; a null poly (fetch
            // miss) is kept rather than risk wrongly culling.
            if (poly && mostlyInsidePrimary(poly)) continue;
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
            // Recompute extent + area from the island-FREE polygon so the map
            // fit-bounds doesn't zoom out to the ocean and the relative area
            // cap isn't inflated by offshore islands. Fall back to the
            // Overpass bbox when there's no polygon.
            const cleanExt = poly ? polygonExtent(poly) : cand.extent;
            // Density uses the REAL polygon area (turf.area), not the bbox —
            // a bbox over-measures an elongated/coastal shape and would
            // under-report its density.
            let realAreaKm2 = poly ? extentAreaKm2(cleanExt) : cand.areaKm2;
            if (poly) {
                try {
                    const a =
                        area({
                            type: "Feature",
                            properties: {},
                            geometry: poly,
                        } as never) / 1_000_000;
                    if (a > 0) realAreaKm2 = a;
                } catch {
                    /* keep bbox estimate */
                }
            }
            candidates.push({
                relationId: cand.id,
                name: cand.name,
                stopCount: inside.length,
                distanceKm: haversineKm(lat, lng, cand.lat, cand.lng),
                kinds: [...kindSet],
                areaKm2: poly ? extentAreaKm2(cleanExt) : cand.areaKm2,
                stopsPerKm2:
                    realAreaKm2 > 0 ? inside.length / realAreaKm2 : 0,
                adminLevel: cand.adminLevel,
                extent: cleanExt,
                polygon: poly,
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

    // Relative area cap FIRST — drop whole provinces (Madrid's Guadalajara/
    // Toledo, reached by Cercanías) that are vastly larger than the city, so
    // the containment dedup then keeps the municipalities inside them instead
    // of collapsing to the province. Skipped when we couldn't size the primary.
    const minStopsPerKm2 = options.minStopsPerKm2 ?? 0;
    let sized = candidates.filter((c) => c.stopsPerKm2 >= minStopsPerKm2);
    if (primaryAreaKm2 && primaryAreaKm2 > 0) {
        sized = sized.filter((c) => c.areaKm2 <= maxAreaRatio * primaryAreaKm2);
    }
    let finalCandidates = dedupeNested(sized);
    if (options.contiguousOnly !== false && primaryFeature) {
        finalCandidates = filterContiguous(finalCandidates, primaryFeature);
    }

    return {
        primaryOsmId,
        primaryName,
        stops,
        candidates: finalCandidates,
        unreached,
    };
}

/** Two Photon extents [maxLat, minLng, minLat, maxLng] are "near" (share a
 *  border or sit within `gapDeg`) — the cheap adjacency proxy for contiguity.
 *  Adjacent admin areas share a boundary so their bboxes overlap; a far
 *  isolated district's bbox is separated by the un-reached areas between. */
function bboxesNear(
    a: [number, number, number, number],
    b: [number, number, number, number],
    gapDeg = 0.03,
): boolean {
    const [aN, aW, aS, aE] = a;
    const [bN, bW, bS, bE] = b;
    const lngOk = !(bW > aE + gapDeg || aW > bE + gapDeg);
    const latOk = !(bS > aN + gapDeg || aS > bN + gapDeg);
    return lngOk && latOk;
}

/**
 * Keep only the reached areas that form a CONNECTED blob touching the primary
 * — drops the isolated far districts a through-running regional line pulls in
 * (Hamburg's Lüneburg/Stade problem). SEEDS off polygon-touch with the primary
 * (exclave-safe — Hamburg's Neuwerk island doesn't inflate a primary bbox),
 * then grows the component through candidate-to-candidate bbox adjacency. If
 * nothing touches the primary (missing polys), keeps everything rather than
 * nuking the set.
 */
function filterContiguous(
    cands: TransitReachCandidate[],
    primaryFeature: GeoJSON.Feature,
): TransitReachCandidate[] {
    if (cands.length === 0) return cands;
    const n = cands.length;
    const seed = cands.map((c) => {
        if (!c.polygon) return false;
        try {
            return booleanIntersects(primaryFeature, {
                type: "Feature",
                properties: {},
                geometry: c.polygon,
            } as never);
        } catch {
            return false;
        }
    });
    const adj: number[][] = Array.from({ length: n }, () => []);
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            if (bboxesNear(cands[i].extent, cands[j].extent)) {
                adj[i].push(j);
                adj[j].push(i);
            }
        }
    }
    const seen = new Set<number>();
    const queue: number[] = [];
    for (let i = 0; i < n; i++) {
        if (seed[i]) {
            seen.add(i);
            queue.push(i);
        }
    }
    if (seen.size === 0) return cands; // no touch info — don't nuke the set
    while (queue.length) {
        const u = queue.shift()!;
        for (const v of adj[u]) {
            if (!seen.has(v)) {
                seen.add(v);
                queue.push(v);
            }
        }
    }
    return cands.filter((_, i) => seen.has(i));
}

/** Bounding-box intersection-over-union of two Photon extents
 *  [maxLat, minLng, minLat, maxLng]. ~1.0 = the two rectangles coincide. */
function bboxIoU(
    a: [number, number, number, number],
    b: [number, number, number, number],
): number {
    const aN = a[0],
        aW = a[1],
        aS = a[2],
        aE = a[3];
    const bN = b[0],
        bW = b[1],
        bS = b[2],
        bE = b[3];
    const iS = Math.max(aS, bS);
    const iN = Math.min(aN, bN);
    const iW = Math.max(aW, bW);
    const iE = Math.min(aE, bE);
    if (iN <= iS || iE <= iW) return 0;
    const inter = (iN - iS) * (iE - iW);
    const areaA = (aN - aS) * (aE - aW);
    const areaB = (bN - bS) * (bE - bW);
    const union = areaA + areaB - inter;
    return union > 0 ? inter / union : 0;
}

const CANDIDATE_SUFFIX_RE =
    /\b(county|kommun|comune|gemeinde|municipality|parish|borough)\b/i;

/** Is candidate `c`'s centre inside candidate `k`? Uses `k`'s real polygon
 *  when we have it (fetched for the point-in-polygon stop test), else `k`'s
 *  bbox. The "prefer the bigger container" test (Bronxville inside Westchester
 *  County). */
function centreInside(
    c: TransitReachCandidate,
    k: TransitReachCandidate,
): boolean {
    const [maxLat, minLng, minLat, maxLng] = c.extent;
    const pt: [number, number] = [(minLng + maxLng) / 2, (minLat + maxLat) / 2];
    if (k.polygon) {
        try {
            return booleanPointInPolygon(pt, {
                type: "Feature",
                properties: {},
                geometry: k.polygon,
            } as never);
        } catch {
            /* fall through to bbox */
        }
    }
    const [kMaxLat, kMinLng, kMinLat, kMaxLng] = k.extent;
    return (
        pt[0] >= kMinLng &&
        pt[0] <= kMaxLng &&
        pt[1] >= kMinLat &&
        pt[1] <= kMaxLat
    );
}

/**
 * Collapse NESTED + COTERMINOUS candidates so the set is "few large, no
 * overlaps":
 *
 *   - CONTAINMENT — one candidate sits INSIDE a bigger one (Bronxville village
 *     L8 inside Westchester County L6). The auto levels-6–8 sweep returns both;
 *     offering both is wrong (the small one is already inside the big one). Keep
 *     only the container. Detected by "smaller candidate's centre falls inside a
 *     kept larger candidate's polygon" (+ a real size gap so it's not just a
 *     shared border).
 *   - COTERMINOUS — two relations covering the SAME ground at different
 *     admin_levels (NYC borough "Queens" L7 vs "Queens County" L6; city-and-
 *     county pairs; a `place=` relation shadowing its admin twin). Same area,
 *     so containment's size gap doesn't fire — caught by bbox IoU ≥ 0.75, and
 *     we keep the plainer name ("Queens" over "Queens County").
 *
 * Processed LARGEST-area first so a container is always kept before the parts
 * it swallows. Result re-sorted to the stop-count default afterwards.
 */
function dedupeNested(
    candidates: TransitReachCandidate[],
): TransitReachCandidate[] {
    const bySizeDesc = [...candidates].sort((a, b) => b.areaKm2 - a.areaKm2);
    const suffixed = (n: string) => CANDIDATE_SUFFIX_RE.test(n);
    const kept: TransitReachCandidate[] = [];
    for (const c of bySizeDesc) {
        // Containment: dropped if a kept (larger) candidate swallows it. The
        // 1.25× size gate keeps this from firing on coterminous twins (equal
        // area) — those go to the IoU branch below.
        const container = kept.find(
            (k) => k.areaKm2 > c.areaKm2 * 1.25 && centreInside(c, k),
        );
        if (container) continue;
        // Coterminous: near-identical bbox → same place twice. Prefer plainer.
        const dupeIdx = kept.findIndex(
            (k) => bboxIoU(k.extent, c.extent) >= 0.75,
        );
        if (dupeIdx !== -1) {
            const incumbent = kept[dupeIdx];
            if (suffixed(incumbent.name) && !suffixed(c.name)) {
                kept[dupeIdx] = { ...c, stopCount: incumbent.stopCount };
            }
            continue;
        }
        kept.push(c);
    }
    kept.sort((a, b) => b.stopCount - a.stopCount || a.distanceKm - b.distanceKm);
    return kept;
}
