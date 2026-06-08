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
 * type="geojson">` or hand to `L.geoJSON()`.
 *
 * This is the MapLibre-side import path; the Leaflet path keeps
 * its inline copy in TransitRoutesOverlay.tsx so changes there
 * can't break this consumer (and vice versa) until both are
 * unified after the migration.
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

async function fetchTransitRelations(routeType: string): Promise<unknown> {
    const polyArea = polyGeoJSON.get();
    const primaryLoc = mapGeoLocation.get();
    let query: string;
    if (polyArea) {
        // turf.coordAll handles both Polygon and MultiPolygon features,
        // returning [lon, lat] pairs. Overpass poly: expects "lat lon" pairs.
        const polyStr = turf.coordAll(polyArea)
            .map(([lon, lat]) => `${lat} ${lon}`)
            .join(" ");
        query = `
[out:json][timeout:180];
relation["route"="${routeType}"](poly:"${polyStr}");
out skel geom;
`;
    } else {
        const additional = additionalMapGeoLocations
            .get()
            .filter((e) => e.added)
            .map((e) => e.location);
        const locs = [primaryLoc, ...additional].filter(Boolean);
        if (locs.length === 0) return { elements: [] };
        const relationBlocks = locs
            .map(
                (loc, i) =>
                    `relation(${loc.properties.osm_id});map_to_area->.region${i};`,
            )
            .join("\n");
        const routeSelects = locs
            .map(
                (_, i) =>
                    `relation["route"="${routeType}"](area.region${i});`,
            )
            .join("\n");
        query = `
[out:json][timeout:180];
${relationBlocks}
(${routeSelects});
out skel geom;
`;
    }
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
