import "maplibre-gl/dist/maplibre-gl.css";

import { useStore } from "@nanostores/react";
import * as turf from "@turf/turf";
import { useEffect, useMemo, useRef, useState } from "react";
import MapGL, { Layer, type MapRef, Source } from "react-map-gl/maplibre";

import { useMapTilesReady } from "@/hooks/useMapTilesReady";
import { clipPolygonToLand } from "@/lib/landClip";
import {
    handleMapLibreError,
    pmtilesUrl,
    protomapsMapLibreStyle,
    recordPmtilesError,
} from "@/lib/protomapsStyle";
import { resolvedTheme } from "@/lib/theme";
import { fetchRawBoundaryPolygon } from "@/maps/api/polygonsOsmFr";
import type { OpenStreetMap } from "@/maps/api/types";

import { MapTilesVeil } from "./MapTilesVeil";

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
 * Tiny map preview for the wizard's PlayAreaStep — shows the selected
 * Photon result. Renders nothing on top of the base tiles until the
 * real polygon lands; we don't draw the bbox rectangle as a
 * placeholder anymore. The bbox over-approximates everywhere (Dalarna
 * County's bbox includes parts of Norway and Uppsala, etc.) so
 * showing it as the actual shape is misleading. Leaving the tiles
 * bare for a beat is better than implying a wrong outline.
 *
 * The map still pans / zooms to fit the bbox so the user sees the
 * right region while the polygon loads; only the polygon overlay
 * itself is gated on real data.
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
    // v228: opt into the dark-tile CSS filter only when the resolved
    // theme is dark — so the preview map follows the OS / app theme
    // setting instead of always being dark.
    const $theme = useStore(resolvedTheme);
    const darkTiles = $theme === "dark";

    // Photon's extent we normalised to [maxLat, minLng, minLat, maxLng].
    // Fall back to the centroid + a small box if extent is missing
    // (rare — usually only Point-shaped entries without a polygon).
    // The bbox is now ONLY used for camera framing, never drawn as an
    // overlay — see the file header for the rationale.
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

    // Async fetch of the real OSM relation boundary via
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
            .then(async (geom) => {
                if (ctrl.signal.aborted) return;
                // Show the raw polygon immediately so the preview isn't
                // blank while we (lazily) load the coastline + lakes
                // masks. Then clip — same `clipPolygonToLand` the main
                // map uses — so the preview matches the real play
                // surface (no ocean/lake bite, e.g. Lausanne's slice of
                // Lac Léman). Cache only the CLIPPED result so repeat
                // previews of the same area skip both the fetch and the
                // clip. If clipping fails or returns null, keep the raw
                // polygon — a preview with a lake is better than none.
                if (!geom) {
                    polygonCache.set(osmId, geom);
                    setRealPolygon(geom);
                    return;
                }
                setRealPolygon(geom);
                try {
                    const clipped = await clipPolygonToLand({
                        type: "Feature",
                        properties: {},
                        geometry: geom,
                    });
                    if (ctrl.signal.aborted) return;
                    const finalGeom = clipped?.geometry ?? geom;
                    polygonCache.set(osmId, finalGeom);
                    setRealPolygon(finalGeom);
                } catch {
                    polygonCache.set(osmId, geom);
                }
            })
            .catch(() => {
                /* swallowed — overlay stays empty */
            });
        return () => ctrl.abort();
    }, [osmId, osmType]);

    // The overlay is the real polygon or nothing. No bbox fallback.
    const polygon = useMemo<
        | GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>
        | null
    >(() => {
        if (!realPolygon) return null;
        return {
            type: "Feature",
            properties: {},
            geometry: realPolygon,
        };
    }, [realPolygon]);

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

    // v230: switched from OSM standard raster (which we couldn't
    // de-clutter) to Protomaps vector tiles. Style is rebuilt when
    // the theme OR the resolved PMTiles URL changes (v241: fallback
    // to demo bucket on worker failure).
    const $pmtilesUrl = useStore(pmtilesUrl);
    const mapStyle = useMemo(
        () => protomapsMapLibreStyle(darkTiles ? "dark" : "light"),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [darkTiles, $pmtilesUrl],
    );

    // Gate the reveal on the boundary polygon landing AND the basemap
    // tiles painting. A relation result is expected to produce a
    // polygon; Way/Node results never do, so they only wait on tiles.
    const boundaryExpected = osmType === "R";
    const { showVeil, timedOut, onLoad, onIdle } = useMapTilesReady({
        dataReady: !boundaryExpected || polygon !== null,
        resetKey: polygon,
    });

    // Same self-heal as the main map: if the basemap tiles never settle
    // (aborted, not errored), flip to the proxied demo bucket so the
    // preview shows a map rather than staying dark.
    useEffect(() => {
        if (timedOut) {
            recordPmtilesError("preview basemap tiles never settled");
        }
    }, [timedOut]);

    if (!bbox) return null;

    return (
        <div
            className={`relative w-full ${height} rounded-md overflow-hidden border border-border`}
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
                onLoad={() => {
                    fitToBbox(false);
                    onLoad();
                }}
                onIdle={onIdle}
                onError={handleMapLibreError}
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
            <MapTilesVeil visible={showVeil} rounded timedOut={timedOut} />
        </div>
    );
}

export default PlayAreaPreviewMap;
