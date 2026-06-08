import "maplibre-gl/dist/maplibre-gl.css";

import { useEffect, useMemo, useRef } from "react";
import Map, { Layer, type MapRef, Source } from "react-map-gl/maplibre";

import type { OpenStreetMap } from "@/maps/api/types";

/**
 * Tiny map preview for the wizard's PlayAreaStep — shows the
 * selected Photon result's bbox as a red outline on a dark
 * basemap so the user can see what they're picking before
 * committing. Cheaper than the full boundary fetch (which only
 * happens after Finish): a 4-coordinate rectangle is enough for
 * an "is this the right city?" check.
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
    // line layer renders all four sides.
    const polygon = useMemo<GeoJSON.Feature<GeoJSON.Polygon> | null>(() => {
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

    // Fit the map to the bbox whenever it changes. We don't rely on
    // initialViewState because the parent might swap `value` without
    // unmounting (user picks a different search result).
    useEffect(() => {
        const map = mapRef.current?.getMap();
        if (!map || !bbox) return;
        try {
            map.fitBounds(
                [
                    [bbox.minLng, bbox.minLat],
                    [bbox.maxLng, bbox.maxLat],
                ],
                { padding: 16, duration: 400, maxZoom: 12 },
            );
        } catch {
            /* ignore — the map may not be ready on first render */
        }
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
            <Map
                ref={mapRef}
                initialViewState={{
                    longitude: (bbox.minLng + bbox.maxLng) / 2,
                    latitude: (bbox.minLat + bbox.maxLat) / 2,
                    zoom: 9,
                }}
                style={{ width: "100%", height: "100%" }}
                mapStyle={mapStyle}
                attributionControl={false}
                interactive={false}
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
            </Map>
        </div>
    );
}

export default PlayAreaPreviewMap;
