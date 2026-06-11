import "maplibre-gl/dist/maplibre-gl.css";

import * as turf from "@turf/turf";
import { useEffect, useMemo, useRef, useState } from "react";
import MapGL, { Layer, type MapRef, Source } from "react-map-gl/maplibre";

import { fetchRawBoundaryPolygon } from "@/maps/api/polygonsOsmFr";
import type { OpenStreetMap } from "@/maps/api/types";

/**
 * In-memory cache so swapping back to a previously-previewed result
 * snaps to its real polygon instantly (and doesn't refetch). Keyed by
 * OSM relation id. (Aliased the react-map-gl `Map` import to `MapGL`
 * so the built-in `Map<K, V>` type stays in scope here.)
 */
const polygonCache = new Map<
    number,
    GeoJSON.Polygon | GeoJSON.MultiPolygon | null
>();

/**
 * Tiny map preview for the wizard's PlayAreaStep — shows the
 * selected Photon result. Renders the bbox rectangle instantly as a
 * cheap first paint, then upgrades to the real boundary polygon as
 * soon as polygons.openstreetmap.fr responds (~1-5 s) — fully async,
 * no perceived delay vs the rectangle-only version. If polygons.osm.fr
 * 404s or times out, the rectangle stays.
 *
 * Renders as `client:only`-safe — MapLibre's window deps are
 * imported lazily at this leaf, so a static import in the wizard
 * doesn't pull leaflet/maplibre into the SSR graph.
 */
export function PlayAreaPreviewMap({
    value,
    height = "h-[160px]",
}: {
    value: OpenStreetMap;
    height?: string;
}) {
    const mapRef = useRef<MapRef | null>(null);

    // Photon's extent we normalised to [maxLat, minLng, minLat, maxLng].
    // Fall back to the centroid + a small box if extent is missing
    // (rare — usually only Point-shaped entries without a polygon).
    const bbox = useMemo(() => {
        const extent = (value.properties as { extent?: number[] }).extent;
        if (extent && extent.length === 4) {
            const [maxLat, minLng, minLat, maxLng] = extent;
            return { minLng, minLat, maxLng, maxLat };
        }
        const coords = value.geometry.coordinates as unknown as [
            number,
            number,
        ];
        const [lat, lng] = coords;
        if (typeof lat !== "number" || typeof lng !== "number") return null;
        return {
            minLng: lng - 0.1,
            minLat: lat - 0.1,
            maxLng: lng + 0.1,
            maxLat: lat + 0.1,
        };
    }, [value]);

    // Rectangle polygon for the bbox outline. Closed loop so the
    // line layer renders all four sides. This is the instant first
    // paint; the real boundary polygon swaps in below when
    // polygons.osm.fr returns.
    const bboxPolygon = useMemo<GeoJSON.Feature<GeoJSON.Polygon> | null>(() => {
        if (!bbox) return null;
        const { minLng, minLat, maxLng, maxLat } = bbox;
        return {
            type: "Feature",
            properties: {},
            geometry: {
                type: "Polygon",
                coordinates: [
                    [
                        [minLng, minLat],
                        [maxLng, minLat],
                        [maxLng, maxLat],
                        [minLng, maxLat],
                        [minLng, minLat],
                    ],
                ],
            },
        };
    }, [bbox]);

    // Async upgrade to the real OSM relation boundary via
    // polygons.openstreetmap.fr. Only fires when Photon's result is a
    // Relation (osm_type === "R") — Way / Node results don't have a
    // pre-computed polygon to fetch. Cached in-module so repeated
    // previews of the same result are instant. Stale-request guard via
    // an AbortController so the fast Stockholm preview doesn't get
    // clobbered by a slow Tokyo preview that landed after.
    const osmId = value.properties.osm_id;
    const osmType = value.properties.osm_type;
    const [realPolygon, setRealPolygon] = useState<
        GeoJSON.Polygon | GeoJSON.MultiPolygon | null
    >(() => (osmId ? polygonCache.get(osmId) ?? null : null));

    useEffect(() => {
        if (osmType !== "R" || !osmId) {
            setRealPolygon(null);
            return;
        }
        const cached = polygonCache.get(osmId);
        if (cached !== undefined) {
            setRealPolygon(cached);
            return;
        }
        const ctrl = new AbortController();
        fetchRawBoundaryPolygon(osmId, ctrl.signal)
            .then((geom) => {
                if (ctrl.signal.aborted) return;
                polygonCache.set(osmId, geom);
                setRealPolygon(geom);
            })
            .catch(() => {
                /* swallowed — rectangle is the fallback */
            });
        return () => ctrl.abort();
    }, [osmId, osmType]);

    // Render the real polygon when we have it; otherwise the bbox.
    const polygon = useMemo<
        | GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>
        | null
    >(() => {
        if (realPolygon) {
            return {
                type: "Feature",
                properties: {},
                geometry: realPolygon,
            };
        }
        return bboxPolygon;
    }, [realPolygon, bboxPolygon]);

    // Once the real polygon lands, re-fit the camera to its actual
    // extent (the bbox extent was an over-approximation for irregular
    // shapes — Dalarna's bbox included parts of Norway and Uppsala).
    useEffect(() => {
        if (!realPolygon) return;
        try {
            const [minX, minY, maxX, maxY] = turf.bbox({
                type: "Feature",
                properties: {},
                geometry: realPolygon,
            } as GeoJSON.Feature);
            const map = mapRef.current?.getMap();
            if (!map) return;
            map.fitBounds(
                [
                    [minX, minY],
                    [maxX, maxY],
                ],
                { padding: 16, duration: 500, maxZoom: 12 },
            );
        } catch {
            /* ignore */
        }
    }, [realPolygon]);

    // Fit the map to the bbox. Called both from the bbox-change effect
    // (parent swaps `value` without unmounting) AND from the map's
    // onLoad — on first mount the effect runs before MapLibre has
    // initialised, so its fitBounds was being silently swallowed,
    // leaving the preview stuck at the hardcoded initial zoom (way too
    // tight for a large region like a whole county). onLoad guarantees
    // the fit lands once the map is actually ready.
    const fitToBbox = (animate: boolean) => {
        const map = mapRef.current?.getMap();
        if (!map || !bbox) return;
        try {
            map.fitBounds(
                [
                    [bbox.minLng, bbox.minLat],
                    [bbox.maxLng, bbox.maxLat],
                ],
                { padding: 16, duration: animate ? 400 : 0, maxZoom: 12 },
            );
        } catch {
            /* ignore — the map may not be ready yet */
        }
    };

    useEffect(() => {
        fitToBbox(true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [bbox]);

    // Rough initial zoom from the bbox span so the very first paint is
    // already close to framed (before onLoad's exact fit). Larger spans
    // → lower zoom. Keeps a big county from flashing in over-zoomed.
    const initialZoom = useMemo(() => {
        if (!bbox) return 9;
        const span = Math.max(
            bbox.maxLat - bbox.minLat,
            bbox.maxLng - bbox.minLng,
        );
        if (span > 4) return 5;
        if (span > 2) return 6;
        if (span > 1) return 7;
        if (span > 0.5) return 8;
        if (span > 0.25) return 9;
        return 10;
    }, [bbox]);

    const mapStyle = useMemo(
        () => ({
            version: 8 as const,
            sources: {
                carto: {
                    type: "raster" as const,
                    tiles: [
                        "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
                        "https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
                        "https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
                        "https://d.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
                    ],
                    tileSize: 256,
                    attribution: "© OSM © CARTO",
                },
            },
            layers: [
                {
                    id: "carto-base",
                    type: "raster" as const,
                    source: "carto",
                },
            ],
        }),
        [],
    );

    if (!bbox) return null;

    return (
        <div
            className={`w-full ${height} rounded-md overflow-hidden border border-border`}
        >
            <MapGL
                ref={mapRef}
                initialViewState={{
                    longitude: (bbox.minLng + bbox.maxLng) / 2,
                    latitude: (bbox.minLat + bbox.maxLat) / 2,
                    zoom: initialZoom,
                }}
                style={{ width: "100%", height: "100%" }}
                mapStyle={mapStyle}
                attributionControl={false}
                interactive={false}
                onLoad={() => fitToBbox(false)}
            >
                {polygon && (
                    <Source id="bbox" type="geojson" data={polygon}>
                        <Layer
                            id="bbox-fill"
                            type="fill"
                            paint={{
                                "fill-color": "hsl(2, 70%, 54%)",
                                "fill-opacity": 0.15,
                            }}
                        />
                        <Layer
                            id="bbox-line"
                            type="line"
                            paint={{
                                "line-color": "hsl(2, 70%, 54%)",
                                "line-width": 2,
                            }}
                        />
                    </Source>
                )}
            </MapGL>
        </div>
    );
}

export default PlayAreaPreviewMap;
