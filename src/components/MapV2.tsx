import "maplibre-gl/dist/maplibre-gl.css";

import { useStore } from "@nanostores/react";
import maplibregl from "maplibre-gl";
import { useEffect, useMemo, useRef } from "react";
import Map, {
    AttributionControl,
    Layer,
    NavigationControl,
    ScaleControl,
    Source,
    type MapRef,
} from "react-map-gl/maplibre";

import {
    baseTileLayer,
    mapGeoJSON,
    mapGeoLocation,
    polyGeoJSON,
} from "@/lib/context";
import { satelliteView } from "@/lib/gameSetup";
import { cn } from "@/lib/utils";
import { holedMask } from "@/maps";

/**
 * MapLibre GL parallel implementation of Map.tsx. Gated behind
 * the `useMapLibre` feature flag in `lib/featureFlags.ts`.
 *
 * This is a scaffolding deliverable — it renders the base
 * tiles + the play-area boundary polygon + the elimination
 * mask, enough to validate the framework choice and the
 * raster-tile fallback works. The rest of the feature surface
 * (DraggableMarkers, PolygonDraw, MapPrint, all the overlays,
 * the question-finished elimination layers, etc.) gets ported
 * incrementally in follow-up commits. Each ported feature
 * should be flipped on here AND removed from Map.tsx, but only
 * after parity is confirmed in the live app.
 *
 * Port checklist (work through these in order):
 *   [x] Base raster tile layer with style switching
 *   [x] Satellite overlay
 *   [x] Play-area boundary polygon
 *   [x] Elimination mask (world − play area)
 *   [ ] Persist viewport in nanostores so reload restores
 *   [ ] flyTo / setView equivalent via mapRef.current.flyTo
 *   [ ] Question-finished elimination polygons
 *   [ ] Question markers (DraggableMarkers equivalent)
 *   [ ] PolygonDraw (free-draw region elimination)
 *   [ ] ZoneSidebar hiding-zone overlay
 *   [ ] Transit lines overlay (raster)
 *   [ ] OpenRailwayMap overlay (raster)
 *   [ ] Thunderforest custom tiles
 *   [ ] Coastline GeoJSON overlay
 *   [ ] Map print / screenshot equivalent
 *   [ ] Context menu (right-click to add radius)
 *   [ ] Hider position pin
 *   [ ] Thermometer overlay
 *   [ ] Pending answer overlay
 *   [ ] Radar scan overlay
 *
 * Once everything is ticked: remove Map.tsx and leaflet from
 * package.json. Until then, keep the toggle in
 * MapDisplayControls (or set localStorage 'jlhs:useMapLibre'
 * = 'true' in the console) to test.
 */

interface MapV2Props {
    className?: string;
}

const RASTER_SOURCES: Record<string, { tiles: string[]; attribution: string }> = {
    light: {
        tiles: [
            "https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
            "https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
            "https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
            "https://d.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
        ],
        attribution:
            '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    },
    dark: {
        tiles: [
            "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
            "https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
            "https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
            "https://d.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
        ],
        attribution:
            '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    },
    osm: {
        tiles: [
            "https://a.tile.openstreetmap.org/{z}/{x}/{y}.png",
            "https://b.tile.openstreetmap.org/{z}/{x}/{y}.png",
            "https://c.tile.openstreetmap.org/{z}/{x}/{y}.png",
        ],
        attribution:
            '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    },
    voyager: {
        tiles: [
            "https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
            "https://b.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
            "https://c.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
            "https://d.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png",
        ],
        attribution:
            '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    },
};

const SATELLITE_SOURCE = {
    tiles: [
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    ],
    attribution: "Imagery &copy; Esri",
};

function buildStyle(baseKey: string, withSatellite: boolean): maplibregl.StyleSpecification {
    const base = RASTER_SOURCES[baseKey] ?? RASTER_SOURCES.dark;
    const style: maplibregl.StyleSpecification = {
        version: 8,
        sources: {
            base: {
                type: "raster",
                tiles: base.tiles,
                tileSize: 256,
                attribution: base.attribution,
            },
            ...(withSatellite
                ? {
                      satellite: {
                          type: "raster",
                          tiles: SATELLITE_SOURCE.tiles,
                          tileSize: 256,
                          attribution: SATELLITE_SOURCE.attribution,
                      },
                  }
                : {}),
        },
        layers: [
            { id: "base", type: "raster", source: "base" },
            ...(withSatellite
                ? [
                      {
                          id: "satellite",
                          type: "raster" as const,
                          source: "satellite",
                          paint: { "raster-opacity": 0.7 },
                      },
                  ]
                : []),
        ],
        glyphs: undefined,
    };
    return style;
}

export function MapV2({ className }: MapV2Props) {
    const $tileKey = useStore(baseTileLayer);
    const $satellite = useStore(satelliteView);
    const $polyGeoJSON = useStore(polyGeoJSON);
    const $mapGeoJSON = useStore(mapGeoJSON);
    const $mapGeoLocation = useStore(mapGeoLocation);

    const mapRef = useRef<MapRef | null>(null);

    const style = useMemo(
        () => buildStyle($tileKey, $satellite),
        [$tileKey, $satellite],
    );

    // Initial centering — derive from the OSM relation's bbox
    // when we have one, else default to a global view. For
    // production parity we'll later persist viewport in nanostores
    // so the Astro/Leaflet flyTo behaviour is preserved.
    const initialView = useMemo(() => {
        const props = $mapGeoLocation?.properties as
            | { extent?: [number, number, number, number] }
            | undefined;
        const extent = props?.extent;
        if (extent) {
            // extent = [maxLat, minLng, minLat, maxLng]
            const [maxLat, minLng, minLat, maxLng] = extent;
            const centerLat = (maxLat + minLat) / 2;
            const centerLng = (minLng + maxLng) / 2;
            return { latitude: centerLat, longitude: centerLng, zoom: 10 };
        }
        return { latitude: 30, longitude: 0, zoom: 2 };
    }, [$mapGeoLocation]);

    // Elimination mask — same as Leaflet path. The play area
    // polygon is rendered as a "hole" cut into a world-spanning
    // rectangle so everything OUTSIDE the play area appears
    // darkened on the map. Once questions land we extend this
    // to also subtract finished-question polygons.
    const eliminationGeoJSON = useMemo(() => {
        const inner = $mapGeoJSON || $polyGeoJSON;
        if (!inner) return null;
        try {
            const mask = holedMask(inner);
            if (!mask) return null;
            // holedMask returns a single Feature; MapLibre's
            // <Source type="geojson"> expects either a Feature
            // or a FeatureCollection — pass it directly.
            return mask as GeoJSON.Feature;
        } catch (e) {
            console.warn("MapV2 holedMask failed:", e);
            return null;
        }
    }, [$mapGeoJSON, $polyGeoJSON]);

    // Expose the underlying maplibre instance via a context atom
    // that mirrors Leaflet's `leafletMapContext`. Other components
    // can read it to call .flyTo(), addLayer, etc. — we'll wire
    // that as the first follow-up port.
    useEffect(() => {
        // TODO: introduce maplibreMapContext atom and publish
        // mapRef.current here so existing call sites that read
        // leafletMapContext can be ported one-by-one.
    }, []);

    return (
        <div className={cn("relative w-full h-screen", className)}>
            <Map
                ref={mapRef}
                initialViewState={initialView}
                mapStyle={style}
                attributionControl={false}
                // MapLibre's default canvas style covers the
                // container; let it fill the parent.
                style={{ width: "100%", height: "100%" }}
                // Faster zoom/pan animations for the touch-driven
                // game UX. The defaults feel sluggish on mobile.
                dragRotate={false}
                pitchWithRotate={false}
                touchPitch={false}
            >
                <AttributionControl compact />
                <NavigationControl position="top-right" showCompass={false} />
                <ScaleControl />

                {/* Play-area boundary stroke. */}
                {(() => {
                    const data = $mapGeoJSON || $polyGeoJSON;
                    if (!data) return null;
                    return (
                        <Source id="play-area" type="geojson" data={data}>
                            <Layer
                                id="play-area-outline"
                                type="line"
                                paint={{
                                    "line-color": "hsl(5, 69%, 55%)",
                                    "line-width": 2,
                                    "line-opacity": 0.9,
                                }}
                            />
                        </Source>
                    );
                })()}

                {/* Elimination mask — covers the WORLD outside
                    the play area in a translucent dark layer.
                    This is the "everything else is excluded"
                    visual cue. */}
                {eliminationGeoJSON && (
                    <Source
                        id="elimination"
                        type="geojson"
                        data={eliminationGeoJSON}
                    >
                        <Layer
                            id="elimination-fill"
                            type="fill"
                            paint={{
                                "fill-color": "#000000",
                                "fill-opacity": 0.55,
                            }}
                        />
                    </Source>
                )}
            </Map>
        </div>
    );
}

export default MapV2;
