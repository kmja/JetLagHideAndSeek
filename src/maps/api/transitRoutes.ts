import * as turf from "@turf/turf";

import {
    additionalMapGeoLocations,
    mapGeoJSON,
    mapGeoLocation,
    polyGeoJSON,
} from "@/lib/context";
import { getOverpassData } from "@/maps/api/overpass";
import { CacheType } from "@/maps/api/types";

/**
 * Library-agnostic transit-route fetcher. Issues the same
 * Overpass query the Leaflet TransitRoutesOverlay does for the
 * given `route=*` mode, parses the response into deduplicated
 * member ways, decimates very-long ways for canvas draw cost,
 * filters out anything whose bounding box doesn't intersect
 * the current play area, and emits a GeoJSON FeatureCollection
 * of LineStrings ready to drop into a MapLibre `<Source
 * type="geojson">`.
 *
 * (The old Leaflet TransitRoutesOverlay that kept a duplicate inline
 * query was deleted with the Leaflet renderer; this is now the only
 * transit-route query path.)
 */

export type TransitMode = "subway" | "bus" | "ferry";

const MAX_VERTICES = 50;

function decimateCoords(
    geom: Array<{ lat: number; lon: number }>,
): Array<[number, number]> {
    const n = geom.length;
    if (n <= MAX_VERTICES) {
        const out: Array<[number, number]> = new Array(n);
        for (let i = 0; i < n; i++) out[i] = [geom[i].lon, geom[i].lat];
        return out;
    }
    const stride = Math.ceil(n / MAX_VERTICES);
    const out: Array<[number, number]> = [];
    for (let i = 0; i < n; i += stride) {
        out.push([geom[i].lon, geom[i].lat]);
    }
    const last = geom[n - 1];
    const tail = out[out.length - 1];
    if (tail[0] !== last.lon || tail[1] !== last.lat) {
        out.push([last.lon, last.lat]);
    }
    return out;
}

/** Soft buffer around the play-area extent for the transit-route
 *  query. Small (we want routes *in* the city, not a neighbouring
 *  metro's network); the returned ways are clipped to the play bbox
 *  client-side anyway. Mirrored in laptop-prewarm.mjs. */
const TRANSIT_BBOX_PAD_KM = 5;

/**
 * Build the Overpass `(south,west,north,east)` bbox tuple for the
 * transit-route query, from the play area's Photon extent(s).
 *
 * Why bbox + Photon extent (v249, replacing the old poly: / map_to_area
 * branches):
 *   - `map_to_area` silently yields an EMPTY area for some city
 *     boundary relations (Overpass only has a generated area for
 *     relations meeting its area-build criteria), so route queries
 *     returned 0 for cities that obviously have transit — Cleveland's
 *     buses being the smoking gun.
 *   - The old `poly:` branch worked but keyed the cache on the exact
 *     land-clipped boundary polygon — a string no offline prewarmer
 *     can reproduce — so the laptop prewarm could never warm what the
 *     client reads.
 *   - Keying off `mapGeoLocation.properties.extent` (Photon's raw OSM
 *     relation bbox) with `[bbox]`-style 3-decimal coords is exactly
 *     the contract the reference-family prefetch already uses
 *     (`buildPaddedBboxFilter`), so the laptop prewarm
 *     (overpass-cache/scripts/laptop-prewarm.mjs `transitRouteQuery`)
 *     produces a byte-identical query string → same SHA-256 R2 key →
 *     a real cache hit. KEEP THE TWO IN LOCKSTEP.
 *
 * Unions the primary + any adjacent-municipality extents. The
 * single-area case (no adjacencies) is the one the prewarm mirrors;
 * the unioned multi-area case is a client-only customisation that
 * falls through to an on-demand fetch.
 */
function buildTransitBboxTuple(): string | null {
    const primary = mapGeoLocation.get();
    const extents: number[][] = [];
    const pe = (primary?.properties as { extent?: number[] })?.extent;
    if (pe && pe.length === 4) extents.push(pe);
    for (const entry of additionalMapGeoLocations.get()) {
        if (!entry.added) continue;
        const ex = (entry.location?.properties as { extent?: number[] })
            ?.extent;
        if (ex && ex.length === 4) extents.push(ex);
    }
    if (extents.length === 0) return null;
    // extent is [maxLat, minLng, minLat, maxLng] post-normalize.
    let south = Infinity;
    let west = Infinity;
    let north = -Infinity;
    let east = -Infinity;
    for (const [mxLat, mnLng, mnLat, mxLng] of extents) {
        south = Math.min(south, mnLat);
        west = Math.min(west, mnLng);
        north = Math.max(north, mxLat);
        east = Math.max(east, mxLng);
    }
    if (![south, west, north, east].every((v) => Number.isFinite(v))) {
        return null;
    }
    const latPad = TRANSIT_BBOX_PAD_KM / 111;
    const midLat = (south + north) / 2;
    const lngPad =
        TRANSIT_BBOX_PAD_KM / (111 * Math.cos((midLat * Math.PI) / 180));
    // 3-decimal precision matches the prewarm mirror exactly.
    const s = (south - latPad).toFixed(3);
    const w = (west - lngPad).toFixed(3);
    const n = (north + latPad).toFixed(3);
    const e = (east + lngPad).toFixed(3);
    return `${s},${w},${n},${e}`;
}

async function fetchTransitRelations(routeType: string): Promise<unknown> {
    const tuple = buildTransitBboxTuple();
    if (!tuple) return { elements: [] };
    // Byte-identical to laptop-prewarm.mjs transitRouteQuery — the R2
    // cache key is a SHA-256 of this exact string. Keep in lockstep.
    const query = `\n[out:json][timeout:180];\nrelation["route"="${routeType}"](${tuple});\nout skel geom;\n`;
    // No loadingText: the toggle button in MapDisplayControls
    // already renders a spinner for the in-flight mode (driven
    // by transitRoutesLoading). A toast on top of that just
    // double-counts the loading state and competes for the
    // notification area.
    return await getOverpassData(
        query,
        undefined,
        CacheType.ZONE_CACHE,
        190_000,
    );
}

/**
 * Fetch + parse + decimate a transit mode's routes for the
 * current play area. Returns a GeoJSON FeatureCollection
 * suitable for a MapLibre geojson source.
 */
export async function fetchTransitRoutesFeatures(
    mode: TransitMode,
): Promise<GeoJSON.FeatureCollection> {
    const data = await fetchTransitRelations(mode);
    const elements = (
        ((data as { elements?: unknown }).elements ?? []) as Array<{
            type: string;
            members?: Array<{
                type?: string;
                ref?: number;
                geometry?: Array<{ lat: number; lon: number }>;
            }>;
        }>
    ).filter((el) => el.type === "relation");

    // Pre-compute the play-area bounding box once so we can
    // quick-reject ways that lie entirely outside it. Match the
    // Leaflet TransitRoutesOverlay's behaviour: prefer the
    // user-drawn polygon over the OSM boundary; fall back to
    // "no bbox filter" if neither is available.
    const polyArea = polyGeoJSON.get();
    const boundary = mapGeoJSON.get();
    let playBbox:
        | { minLat: number; maxLat: number; minLon: number; maxLon: number }
        | null = null;
    try {
        const src = polyArea ?? boundary;
        if (src) {
            const [minLon, minLat, maxLon, maxLat] = turf.bbox(src as never);
            if (
                Number.isFinite(minLat) &&
                Number.isFinite(maxLat) &&
                Number.isFinite(minLon) &&
                Number.isFinite(maxLon) &&
                maxLat > minLat &&
                maxLon > minLon
            ) {
                playBbox = { minLat, maxLat, minLon, maxLon };
            }
        }
    } catch {
        playBbox = null;
    }

    const seenWayIds = new Set<number>();
    const features: Array<GeoJSON.Feature<GeoJSON.LineString>> = [];

    for (const rel of elements) {
        const members = rel.members ?? [];
        for (const member of members) {
            if (member.type !== "way") continue;
            const geom = member.geometry;
            if (!geom || geom.length < 2) continue;
            if (member.ref !== undefined) {
                if (seenWayIds.has(member.ref)) continue;
                seenWayIds.add(member.ref);
            }

            let minLat = Infinity;
            let maxLat = -Infinity;
            let minLon = Infinity;
            let maxLon = -Infinity;
            for (const pt of geom) {
                if (pt.lat < minLat) minLat = pt.lat;
                if (pt.lat > maxLat) maxLat = pt.lat;
                if (pt.lon < minLon) minLon = pt.lon;
                if (pt.lon > maxLon) maxLon = pt.lon;
            }
            if (
                playBbox &&
                (maxLat < playBbox.minLat ||
                    minLat > playBbox.maxLat ||
                    maxLon < playBbox.minLon ||
                    minLon > playBbox.maxLon)
            ) {
                continue;
            }

            features.push({
                type: "Feature",
                geometry: {
                    type: "LineString",
                    coordinates: decimateCoords(geom),
                },
                properties: {},
            });
        }
    }

    return { type: "FeatureCollection", features };
}
