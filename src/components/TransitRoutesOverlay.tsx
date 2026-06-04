import { useStore } from "@nanostores/react";
import * as turf from "@turf/turf";
import { useEffect, useRef } from "react";

import {
    additionalMapGeoLocations,
    leafletMapContext,
    mapGeoJSON,
    mapGeoLocation,
    polyGeoJSON,
} from "@/lib/context";
import {
    allowedTransit,
    showBusRoutes,
    showFerryRoutes,
    showSubwayRoutes,
    transitRoutesLoading,
} from "@/lib/gameSetup";
import { getOverpassData } from "@/maps/api/overpass";
import { CacheType } from "@/maps/api/types";

/**
 * Renders per-mode transit-route overlays as Leaflet GeoJSON layers on
 * top of the main map. Driven by the `showSubwayRoutes` /
 * `showBusRoutes` / `showFerryRoutes` atoms — toggling any of them ON
 * triggers an Overpass fetch for the play area's matching route
 * relations and adds them as a styled polyline layer; OFF removes the
 * layer.
 *
 * Performance design:
 *  • The Overpass query selects relations of the requested route type,
 *    then resolves to the DEDUPLICATED set of way geometries they
 *    reference (`way(r.routes); out geom;`). This is typically an
 *    order of magnitude smaller than `rel ... out geom;`, where every
 *    shared trunk segment is emitted once per route that uses it.
 *  • The Leaflet layer is built in chunks via `addData`, with a
 *    `setTimeout(0)` yield between chunks. Even on a city-sized bus
 *    network the main thread can paint and process input events
 *    between batches, so the toggle never locks the UI.
 *  • A `Point`-filter on `L.geoJSON` ignores any standalone stop
 *    nodes that slip into the response — those would otherwise
 *    render as default-blue markers.
 */

type Mode = "subway" | "bus" | "ferry";

interface ModeConfig {
    /** `route=*` value used in the Overpass relation filter. */
    routeType: string;
    /** Stroke color for the polyline. */
    color: string;
    /** Optional dash pattern (`undefined` = solid). */
    dashArray?: string;
}

const MODE_CONFIG: Record<Mode, ModeConfig> = {
    subway: {
        routeType: "subway",
        color: "hsl(280, 60%, 60%)", // purple — distinct from rail's red
    },
    bus: {
        routeType: "bus",
        color: "hsl(35, 90%, 55%)", // bus orange
    },
    ferry: {
        routeType: "ferry",
        color: "hsl(200, 85%, 55%)", // ferry blue
        dashArray: "4 4",
    },
};

/** Render features in batches of this size, yielding to the event loop
 *  between batches so toggling on a heavy mode (bus) doesn't freeze
 *  the page. Tuned for the bus case — smaller modes complete in one
 *  batch and pay nothing extra. */
const RENDER_CHUNK_SIZE = 80;

export function TransitRoutesOverlay() {
    const $subway = useStore(showSubwayRoutes);
    const $bus = useStore(showBusRoutes);
    const $ferry = useStore(showFerryRoutes);
    const $allowedTransit = useStore(allowedTransit);
    const $playArea = useStore(mapGeoLocation);

    // An overlay must be BOTH toggled on AND allowed in the current
    // game's transit settings. Without the allowedTransit gate a stale
    // persisted toggle (e.g. bus left enabled in a previous game) keeps
    // drawing its overlay even though MapDisplayControls hides the
    // toggle for disallowed modes — leaving the user no way to turn it
    // off.
    const subwayOn = $subway && $allowedTransit.includes("subway");
    const busOn = $bus && $allowedTransit.includes("bus");
    const ferryOn = $ferry && $allowedTransit.includes("ferry");
    const $poly = useStore(polyGeoJSON);
    const map = useStore(leafletMapContext);

    // Stable cache key — bumps whenever play area changes so we re-fetch
    // for the new boundary.
    const areaKey =
        $playArea?.properties?.osm_id ?? ($poly ? "custom-poly" : "none");

    const layersRef = useRef<Record<Mode, L_Layer | null>>({
        subway: null,
        bus: null,
        ferry: null,
    });

    /**
     * Set the per-mode loading flag in the shared atom. Used so the
     * top-right map-control toggles can render a spinner during the
     * Overpass fetch + chunked render — see MapDisplayControls.
     *
     * When a fetch resolves from the Cache API (very common after the
     * first toggle), the entire `setLayer` flow can complete inside a
     * single animation frame, which means React never renders the
     * intermediate `loading=true` state and the spinner flashes
     * imperceptibly (or not at all). To avoid that, we enforce a
     * minimum display time: once `true` is set, the corresponding
     * `false` is deferred until at least MIN_SPINNER_MS have elapsed.
     * Snappy enough not to feel laggy, long enough for the spinner to
     * actually appear and communicate "something is happening."
     */
    const MIN_SPINNER_MS = 250;
    const loadingStartedAt = useRef<Record<Mode, number | null>>({
        subway: null,
        bus: null,
        ferry: null,
    });
    const setLoadingFlag = (mode: Mode, on: boolean) => {
        const curr = transitRoutesLoading.get();
        if (on) {
            if (curr[mode]) return;
            loadingStartedAt.current[mode] = Date.now();
            transitRoutesLoading.set({ ...curr, [mode]: true });
            return;
        }
        // Going false — respect the minimum-display contract.
        const startedAt = loadingStartedAt.current[mode];
        const elapsed = startedAt !== null ? Date.now() - startedAt : Infinity;
        const finish = () => {
            const c = transitRoutesLoading.get();
            if (!c[mode]) return;
            loadingStartedAt.current[mode] = null;
            transitRoutesLoading.set({ ...c, [mode]: false });
        };
        if (elapsed >= MIN_SPINNER_MS) {
            finish();
        } else {
            window.setTimeout(finish, MIN_SPINNER_MS - elapsed);
        }
    };

    useEffect(() => {
        if (!map) return;
        let cancelled = false;

        const setLayer = async (mode: Mode, on: boolean) => {
            const cfg = MODE_CONFIG[mode];
            // Remove existing first — it might belong to the previous
            // play area.
            const existing = layersRef.current[mode];
            if (existing) {
                map.removeLayer(existing as any);
                layersRef.current[mode] = null;
            }
            if (!on) {
                // Make sure a leftover loading flag from a cancelled
                // fetch doesn't get stranded as "true".
                setLoadingFlag(mode, false);
                return;
            }
            setLoadingFlag(mode, true);
            try {
                const data = await fetchTransitRelations(cfg.routeType);
                if (cancelled) return;

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

                await new Promise((r) => requestAnimationFrame(r));
                if (cancelled) return;

                const L = await import("leaflet");
                // Vanilla Leaflet GeoJSON layer — default
                // overlayPane, default SVG renderer. Earlier
                // versions tried a custom `transit` pane with a
                // CSS clip-path, and a Canvas renderer with
                // padding-based clipping; both produced visible
                // bugs (clip mis-projection at low zooms, canvas
                // padding flicker as the viewport edge crossed
                // the bitmap boundary). The simple defaults work
                // reliably — and we already keep the DOM cost
                // down via per-way decimation
                // (MAX_VERTICES = 50) and a bbox-rejection pass
                // for ways that lie entirely outside the play
                // area.
                const layerOpts = {
                    style: {
                        color: cfg.color,
                        weight: 2,
                        opacity: 0.8,
                        dashArray: cfg.dashArray,
                    },
                    interactive: false,
                    filter: (feature: any) => {
                        const t = feature?.geometry?.type;
                        return t === "LineString" || t === "MultiLineString";
                    },
                } as any;
                const layer = L.geoJSON([] as any, layerOpts);
                (layer as any).transitOverlayMode = mode;
                layer.addTo(map);
                layersRef.current[mode] = layer as unknown as L_Layer;

                // Pre-compute the play-area bounding box once so we
                // can quick-reject ways that lie entirely outside it.
                // Overpass returns routes whose *relation* intersects
                // the play area; individual member ways can extend
                // out into the suburbs. Skipping them client-side
                // saves draw cost.
                //
                // CRITICAL: we use `mapGeoJSON` (the loaded boundary
                // polygon) — NOT `mapGeoLocation`, whose geometry
                // is a Point (the OSM centroid). `turf.bbox()` of a
                // Point returns a degenerate zero-area bbox, which
                // would reject every single way and produce an
                // empty overlay. That was why the subway overlay
                // for Stockholm rendered nothing — the symptom
                // looked like "fetch returned nothing" but was
                // actually 100 % client-side bbox rejection.
                //
                // When neither the loaded boundary nor a drawn
                // polygon is available yet, skip the bbox prefilter
                // entirely (`playBbox = null` → no rejection). All
                // ways then render and Leaflet itself culls them
                // off-screen. Slightly slower for huge networks but
                // never wrong.
                const polyArea = polyGeoJSON.get();
                const boundary = mapGeoJSON.get();
                let playBbox:
                    | {
                          minLat: number;
                          maxLat: number;
                          minLon: number;
                          maxLon: number;
                      }
                    | null = null;
                try {
                    const src = polyArea ?? boundary;
                    if (src) {
                        const [minLon, minLat, maxLon, maxLat] = turf.bbox(
                            src as any,
                        );
                        // Sanity-check: a degenerate bbox (zero area
                        // either lat-wise or lng-wise) would still
                        // be useless. Drop to null and let everything
                        // through if that happens.
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

                // Hand-rolled GeoJSON construction. We bypass
                // `osmtogeojson` entirely — for a Berlin-sized bus
                // response (~300 relations × ~30 member ways) its
                // synchronous walk was the dominant freeze. Instead
                // we iterate relations → way members → LineString
                // features in batches of RENDER_CHUNK_SIZE, yielding
                // to the event loop between batches so the UI stays
                // responsive throughout the parse + render.
                //
                // We also dedupe ways across relations (a shared
                // trunk road sits on 10–50 routes); each LineString
                // appears once on the layer.
                const seenWayIds = new Set<number>();
                let buffer: Array<{
                    type: "Feature";
                    geometry: {
                        type: "LineString";
                        coordinates: Array<[number, number]>;
                    };
                    properties: Record<string, never>;
                }> = [];
                const flushBuffer = async () => {
                    if (buffer.length === 0) return;
                    layer.addData({
                        type: "FeatureCollection",
                        features: buffer,
                    } as any);
                    buffer = [];
                    await new Promise((r) => setTimeout(r, 0));
                };

                let skippedByBbox = 0;
                outer: for (const rel of elements) {
                    const members = rel.members ?? [];
                    for (const member of members) {
                        if (member.type !== "way") continue;
                        const geom = member.geometry;
                        if (!geom || geom.length < 2) continue;
                        if (member.ref !== undefined) {
                            if (seenWayIds.has(member.ref)) continue;
                            seenWayIds.add(member.ref);
                        }

                        // Per-way bbox compute. Cheap (one linear pass)
                        // and lets us reject ways that lie entirely
                        // outside the play area's bbox without paying
                        // the polygon-clip cost on the canvas side.
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
                            skippedByBbox++;
                            continue;
                        }

                        buffer.push({
                            type: "Feature",
                            geometry: {
                                type: "LineString",
                                coordinates: decimateCoords(geom),
                            },
                            properties: {},
                        });
                        if (buffer.length >= RENDER_CHUNK_SIZE) {
                            if (cancelled) {
                                map.removeLayer(layer);
                                layersRef.current[mode] = null;
                                break outer;
                            }
                            await flushBuffer();
                            if (cancelled) {
                                map.removeLayer(layer);
                                layersRef.current[mode] = null;
                                break outer;
                            }
                        }
                    }
                }
                if (!cancelled && buffer.length > 0) {
                    await flushBuffer();
                }
                console.debug(
                    `[transit:${mode}] rendered ${seenWayIds.size} unique way segments` +
                        (skippedByBbox > 0
                            ? ` (${skippedByBbox} skipped via bbox)`
                            : ""),
                );
            } catch (e) {
                console.warn(`Transit overlay (${mode}) fetch failed`, e);
            } finally {
                // Always clear the loading flag — even on cancel — so a
                // navigate-away mid-fetch doesn't strand the spinner.
                setLoadingFlag(mode, false);
            }
        };

        setLayer("subway", subwayOn);
        setLayer("bus", busOn);
        setLayer("ferry", ferryOn);

        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [map, subwayOn, busOn, ferryOn, areaKey]);

    // Clean up on unmount.
    useEffect(() => {
        return () => {
            if (!map) return;
            for (const mode of Object.keys(layersRef.current) as Mode[]) {
                const layer = layersRef.current[mode];
                if (layer) map.removeLayer(layer as any);
                layersRef.current[mode] = null;
            }
        };
    }, [map]);

    return null;
}

/**
 * Fetch all relations of the given `route=*` type within the current
 * play area, with member geometries embedded. Returns a raw Overpass
 * JSON blob (`{ elements: [...] }`) the caller can hand to
 * `osmtogeojson`.
 *
 * Implementation note — we used to try a way-only query that did
 * `rel ...; way(r); out geom;` to deduplicate member ways server-side.
 * On big networks (Berlin's 300+ bus relations → ~10 k member ways) the
 * public Overpass mirrors timed out on that recursion step. The
 * straightforward `rel ...; out geom;` is actually *faster on the
 * server* because the geometry is already indexed with the relation —
 * the cost is just shipping a slightly larger response. We mitigate
 * that on the client with chunked rendering + a Point-feature filter.
 *
 * Timeout is set generously (180 s server-side, 190 s client-side)
 * because even the simpler query can take 30–60 s for a city the size
 * of Berlin or Tokyo on a busy mirror.
 */
async function fetchTransitRelations(routeType: string): Promise<unknown> {
    const polyArea = polyGeoJSON.get();
    const primaryLoc = mapGeoLocation.get();

    let query: string;
    if (polyArea) {
        // Custom polygon mode — matches `findPlacesInZone`'s
        // polygon-stringification exactly so the same shapes that work
        // elsewhere work here.
        const polyStr = turf
            .getCoords(polyArea.features as any)
            .flatMap((polygon: any) => polygon.geometry.coordinates)
            .flat()
            .map((coord: number[]) => `${coord[1]} ${coord[0]}`)
            .join(" ");
        query = `
[out:json][timeout:180];
relation["route"="${routeType}"](poly:"${polyStr}");
out skel geom;
`;
    } else {
        // OSM admin-relation mode — resolve all enabled play-area
        // boundaries to areas, then union the matching relations.
        const additional = additionalMapGeoLocations
            .get()
            .filter((e) => e.added)
            .map((e) => e.location);
        const locs = [primaryLoc, ...additional].filter(Boolean);
        if (locs.length === 0) {
            return { elements: [] };
        }
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

    // Match server timeout with a slightly larger client timeout so we
    // don't abort while the response is still streaming.
    const data = await getOverpassData(
        query,
        `Loading ${routeType} routes…`,
        CacheType.ZONE_CACHE,
        190_000,
    );
    const elements = (data as { elements?: unknown[] }).elements ?? [];
    const remark = (data as { remark?: string }).remark;
    if (remark) {
        console.warn(
            `[transit:${routeType}] Overpass remark: ${remark}`,
        );
    }
    console.debug(
        `[transit:${routeType}] Overpass returned ${elements.length} elements`,
    );
    return data;
}

/**
 * Cap a way's vertex count so very long ways (think trunk highways
 * with 150+ shape points) don't blow the canvas draw budget. Most
 * member ways are short and pass through unchanged; only the long
 * ones get sampled at a fixed stride. The first and last point are
 * always retained to preserve route connectivity at endpoints.
 *
 * `MAX_VERTICES = 50` is comfortably more detail than is visible at
 * city zoom levels. Bump it if you ever notice "blocky" route lines
 * at high zoom.
 */
function decimateCoords(
    geom: Array<{ lat: number; lon: number }>,
): Array<[number, number]> {
    const MAX_VERTICES = 50;
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
    // Always include the last point so adjacent ways still join up at
    // their endpoints.
    const last = geom[n - 1];
    const tail = out[out.length - 1];
    if (tail[0] !== last.lon || tail[1] !== last.lat) {
        out.push([last.lon, last.lat]);
    }
    return out;
}

// Tiny structural alias so we don't need to depend on leaflet types here.
type L_Layer = { remove: () => void };

export default TransitRoutesOverlay;
