import * as turf from "@turf/turf";

import { pointInPlayArea } from "@/maps/geo-utils/playAreaIndex";

import {
    additionalMapGeoLocations,
    mapGeoJSON,
    mapGeoLocation,
    polyGeoJSON,
} from "@/lib/context";
import { TRANSIT_BY_RELATION_BASE } from "@/maps/api/constants";
import { getOverpassData } from "@/maps/api/overpass";
import { referenceExtent } from "@/maps/api/playAreaPrefetch";
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

export type TransitMode = "subway" | "bus" | "ferry" | "train" | "tram";

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
    const extents: number[][] = [];
    // v357: the PRIMARY extent goes through `referenceExtent()` (the
    // canonical boundary-geometry min/max) so the cron's/laptop's per-
    // shard and per-city transit prewarms — which key off the same
    // boundary geometry — land on the cache keys the client looks up.
    // Photon's extent and the polygon's true min/max differ in the 3rd
    // decimal; the R2 key embeds the bbox to 3 decimals, so the old
    // Photon-fed primary missed the warmed entries by one digit.
    //
    // Additional play areas (user-added adjacencies) stay on Photon's
    // extent: the prewarm pipeline only mirrors the single-area case, so
    // there's no warmed key to align against — the unioned multi-area
    // query falls through to an on-demand fetch either way.
    const primary = referenceExtent();
    if (primary) extents.push(primary);
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

/** v386: relation-id warm-on-miss dedupe — one ping per (id, mode) per
 *  session, so the burst case (toggle mode → miss → on-tap warm) doesn't
 *  fire N concurrent warm requests for the same key. */
const transitWarmRequested = new Set<string>();
function requestWarmTransit(relationId: number, mode: string): void {
    const key = `${relationId}/${mode}`;
    if (transitWarmRequested.has(key)) return;
    transitWarmRequested.add(key);
    void fetch(
        `${TRANSIT_BY_RELATION_BASE}/${relationId}/${mode}?warm=1`,
    ).catch(() => {
        // Network blip — allow a retry on a later pass.
        transitWarmRequested.delete(key);
    });
}

async function fetchTransitRelations(routeType: string): Promise<unknown> {
    // v386: try the STABLE relation-id-keyed endpoint first when the play
    // area is a single OSM relation (the common case). The worker derives
    // the bbox SERVER-SIDE from the boundary it already has in R2 and
    // builds the same query the laptop stored under, so prewarmed cities
    // hit without the byte-fragile client/laptop bbox-derivation contract.
    // Pre-v386 the client built bbox from polyGeoJSON (which is
    // land-clipped — coastal cities lose vertices and the bbox drifts in
    // the 3rd decimal), so Toronto-bus and similar coastal cases missed.
    //
    // Falls through to the existing bbox-query path on:
    //   - non-relation play area (custom-drawn polygon, no stable id)
    //   - relation endpoint miss (cache: "miss" / "no-boundary" / empty)
    //   - non-empty elements but small dataset (we accept whatever
    //     came back as the answer — see the empty-check below)
    //
    // On a miss the client fires a background warm so the next toggle
    // lands on a cache hit. Custom-drawn / multi-adjacent play areas
    // still go down the bbox path; that's intentional: there's no single
    // relation id to key on, and the cron only prewarms single-relation
    // cities, so the relation path's value space matches the prewarm's.
    const primary = mapGeoLocation.get();
    const props = primary?.properties as
        | { osm_id?: number; osm_type?: string }
        | undefined;
    const extrasAdded = additionalMapGeoLocations
        .get()
        .some((e) => e.added);
    if (
        !extrasAdded &&
        props?.osm_type === "R" &&
        typeof props.osm_id === "number" &&
        props.osm_id > 0
    ) {
        const relId = props.osm_id;
        try {
            const resp = await fetch(
                `${TRANSIT_BY_RELATION_BASE}/${relId}/${routeType}`,
            );
            if (resp.ok) {
                const data = (await resp.json()) as { elements?: unknown[] };
                const els = data?.elements;
                if (Array.isArray(els) && els.length > 0) return data;
                // Empty body = miss / no-boundary marker. Fire a
                // background warm and fall through to the bbox path so
                // the user still gets data this session.
                requestWarmTransit(relId, routeType);
            }
        } catch {
            /* network issue → fall through */
        }
    }

    const tuple = buildTransitBboxTuple();
    if (!tuple) return { elements: [] };
    // Byte-identical to overpass-cache transitRouteQuery (worker AND
    // laptop-prewarm.mjs). v329: bbox moved to the global
    // `[bbox:...]` setting form so the worker's query canonicaliser
    // (querySlicing.ts) strips it during template-fingerprint
    // computation, which is what lets SUBWAY + FERRY queries dispatch
    // into the per-shard slicing path on the worker side. BUS still
    // matches the byte-identical exact R2-key path. Newline framing
    // is load-bearing — the SHA-256 R2 key includes it.
    const query = `\n[out:json][timeout:180][bbox:${tuple}];\nrelation["route"="${routeType}"];\nout skel geom;\n`;
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

    // v383: polygon clip. The bbox prefilter above drops lines entirely
    // outside the play-area's bounding rectangle, but lines that cross
    // the polygon boundary were kept whole — so for a play area whose
    // polygon is much smaller than its bbox (a small city in a sparse
    // province / region) transit lines extended kilometres past the
    // boundary. Visible bug: GTA play area + every southern-Ontario
    // train line painted across half the screen. Clip each line at the
    // polygon edges (turf.lineSplit) and keep only segments whose
    // midpoint lies inside.
    //
    // Fast paths avoid the expensive split where possible: a line whose
    // every test point is inside passes through whole; one whose every
    // test point is outside is dropped. Only boundary-crossing lines pay
    // the split cost.
    const polyForClip = polyArea ?? boundary;
    if (!polyForClip || polyForClip.features.length === 0) {
        return { type: "FeatureCollection", features };
    }
    const clipped: Array<GeoJSON.Feature<GeoJSON.LineString>> = [];
    // v384: yield to the event loop every YIELD_EVERY iterations so big
    // datasets (Toronto bus ≈ thousands of features) don't block the
    // main thread for the duration of the clip.
    const YIELD_EVERY = 250;
    let iter = 0;
    // v388: drop turf.lineSplit and clip vertex-by-vertex. Repeated user
    // reports of train lines extending past the boundary (GTA region rail
    // running 30+ km past the play area boundary) traced to lineSplit
    // returning 0 segments or throwing on Toronto's land-clipped polygon
    // (which has many vertices around Lake Ontario's coast plus inland
    // edges). The v387 fallback then kept the whole line if its midpoint
    // was inside — so a GO Transit line with its midpoint in Toronto
    // stayed whole, water-side excursion and all. Vertex-walk is
    // bulletproof: no library black-box can fail, the output is
    // STRICTLY a subset of the input's vertices, and every output
    // segment's vertices are inside the polygon by construction.
    //
    // Trade-off vs precise geometric clip: the line "snaps" to the last
    // inside vertex at a crossing rather than continuing to the polygon
    // boundary, so there's a few-meters gap at each crossing point.
    // Imperceptible at typical zoom levels; precise-intersection would
    // require Sutherland-Hodgman line-vs-polygon which is overkill for a
    // visual overlay.
    for (const line of features) {
        if (++iter % YIELD_EVERY === 0) {
            await new Promise((r) => setTimeout(r, 0));
        }
        const c = line.geometry.coordinates;
        const n = c.length;
        if (n < 2) continue;
        // Precompute the inside mask once (one bbox-prefiltered test per
        // vertex). At MAX_VERTICES=50 × thousands of lines this is
        // sub-100ms in practice — v376's WeakMap-cached polygon bbox
        // rejects clearly-outside points in ~5 ns.
        const insideMask = new Array<boolean>(n);
        let anyInside = false;
        let allInside = true;
        for (let i = 0; i < n; i++) {
            const inside = pointInPlayArea(polyForClip, c[i][0], c[i][1]);
            insideMask[i] = inside;
            if (inside) anyInside = true;
            else allInside = false;
        }
        if (!anyInside) continue; // entirely outside — drop
        if (allInside) {
            clipped.push(line); // entirely inside — keep whole
            continue;
        }
        // Mixed — emit each maximal run of consecutive-inside vertices
        // as its own LineString.
        let runStart = -1;
        for (let i = 0; i < n; i++) {
            if (insideMask[i]) {
                if (runStart < 0) runStart = i;
            } else if (runStart >= 0) {
                // Flush the run ending at i-1 (inclusive).
                if (i - runStart >= 2) {
                    clipped.push({
                        type: "Feature",
                        geometry: {
                            type: "LineString",
                            coordinates: c.slice(runStart, i),
                        },
                        properties: line.properties ?? {},
                    });
                }
                runStart = -1;
            }
        }
        // Tail run.
        if (runStart >= 0 && n - runStart >= 2) {
            clipped.push({
                type: "Feature",
                geometry: {
                    type: "LineString",
                    coordinates: c.slice(runStart, n),
                },
                properties: line.properties ?? {},
            });
        }
    }
    return { type: "FeatureCollection", features: clipped };
}
