import "maplibre-gl/dist/maplibre-gl.css";

import { useStore } from "@nanostores/react";
import * as turf from "@turf/turf";
import maplibregl from "maplibre-gl";
import { useEffect, useMemo, useRef, useState } from "react";
import Map, {
    AttributionControl,
    Layer,
    NavigationControl,
    ScaleControl,
    Source,
    type MapRef,
    type ViewStateChangeEvent,
} from "react-map-gl/maplibre";

import {
    baseTileLayer,
    mapGeoJSON,
    mapGeoLocation,
    planningModeEnabled,
    polyGeoJSON,
    questions,
    triggerLocalRefresh,
} from "@/lib/context";
import {
    mapLibreContext,
    mapLibreViewport,
} from "@/lib/featureFlags";
import { CATEGORIES, type CategoryId } from "@/lib/categories";
import { satelliteView } from "@/lib/gameSetup";
import { cn } from "@/lib/utils";
import { applyQuestionsToMapGeoData, holedMask } from "@/maps";

/**
 * MapLibre GL parallel implementation of Map.tsx. Gated behind
 * the `useMapLibre` feature flag in `lib/featureFlags.ts`.
 *
 * Port checklist (work through these in order):
 *   [x] Base raster tile layer with style switching
 *   [x] Satellite overlay
 *   [x] Play-area boundary polygon
 *   [x] Elimination mask (world − play area)
 *   [x] mapLibreContext atom (mirror of leafletMapContext)
 *   [x] Persist viewport in nanostores so reload restores
 *   [x] flyTo equivalent when mapGeoLocation changes
 *   [x] Question-finished elimination polygons
 *   [x] Pending-question dashed outlines (category-colored)
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
 * package.json. Until then, keep the toggle via localStorage
 * 'jlhs:useMapLibre' = 'true' in the console.
 */

interface MapV2Props {
    className?: string;
}

const RASTER_SOURCES: Record<
    string,
    { tiles: string[]; attribution: string }
> = {
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

function buildStyle(
    baseKey: string,
    withSatellite: boolean,
): maplibregl.StyleSpecification {
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
    const $questions = useStore(questions);
    useStore(triggerLocalRefresh); // subscribe to manual re-render kicks
    const $savedViewport = useStore(mapLibreViewport);

    const mapRef = useRef<MapRef | null>(null);

    const style = useMemo(
        () => buildStyle($tileKey, $satellite),
        [$tileKey, $satellite],
    );

    // Initial view priority: persisted viewport > OSM extent of
    // selected play area > global default. Persisted wins so a
    // reload doesn't snap the user away from where they were
    // looking; if they had no prior viewport (fresh install) we
    // derive from the play area; if neither, world.
    const initialView = useMemo(() => {
        if ($savedViewport) return $savedViewport;
        const props = $mapGeoLocation?.properties as
            | { extent?: [number, number, number, number] }
            | undefined;
        const extent = props?.extent;
        if (extent) {
            const [maxLat, minLng, minLat, maxLng] = extent;
            return {
                latitude: (maxLat + minLat) / 2,
                longitude: (minLng + maxLng) / 2,
                zoom: 10,
            };
        }
        return { latitude: 30, longitude: 0, zoom: 2 };
        // Intentionally compute ONCE on mount — subsequent
        // mapGeoLocation changes are handled by the flyTo
        // effect below.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Publish the map ref to the global atom so other
    // components can flyTo / fitBounds when useMapLibre is on.
    // Clean up on unmount so a stale ref doesn't outlive the
    // map (e.g. when the user flips the flag back off).
    const handleLoad = () => {
        if (mapRef.current) mapLibreContext.set(mapRef.current);
    };
    useEffect(() => {
        return () => mapLibreContext.set(null);
    }, []);

    // Persist viewport on move end. Debounced via MapLibre's
    // own `moveend` (fires once per gesture, not per frame).
    const handleMoveEnd = (e: ViewStateChangeEvent) => {
        const { latitude, longitude, zoom } = e.viewState;
        mapLibreViewport.set({ latitude, longitude, zoom });
    };

    // When mapGeoLocation changes (user picked a new play
    // area), fly to its extent. Equivalent of Leaflet's
    // map.flyTo([lat, lng], 11, {duration: 0.6}) call inside
    // the wizard's handleFinish.
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;
        const props = $mapGeoLocation?.properties as
            | { extent?: [number, number, number, number] }
            | undefined;
        const extent = props?.extent;
        if (!extent) return;
        const [maxLat, minLng, minLat, maxLng] = extent;
        try {
            map.fitBounds(
                [
                    [minLng, minLat],
                    [maxLng, maxLat],
                ],
                { padding: 24, duration: 600 },
            );
        } catch (e) {
            console.warn("MapV2 fitBounds failed:", e);
        }
    }, [$mapGeoLocation?.properties]);

    // Pending-question dashed outlines + post-elimination mask.
    // applyQuestionsToMapGeoData walks each question and either
    // (a) eliminates a region from the working polygon when
    // answered, or (b) emits a "still-pending" geoJSON via the
    // callback. We collect those callbacks into a per-category
    // FeatureCollection so MapLibre can render one batched
    // layer per category color (cheaper than one per question
    // in GL terms; Leaflet adds one DOM layer per question).
    //
    // The function is async (the turf pipeline runs in
    // microtasks for memory pressure), so we drive it from a
    // useEffect and write into local state. Stale-result guard
    // via a closure-captured generation counter — if the
    // questions atom updates while a prior pass is still
    // running, we drop the older result.
    const [eliminationResult, setEliminationResult] = useState<{
        mask: GeoJSON.Feature | null;
        pendingByCategory: Record<string, GeoJSON.Feature[]>;
    }>({ mask: null, pendingByCategory: {} });
    const eliminationGenRef = useRef(0);
    useEffect(() => {
        const inner = $mapGeoJSON || $polyGeoJSON;
        if (!inner) {
            setEliminationResult({ mask: null, pendingByCategory: {} });
            return;
        }
        const myGen = ++eliminationGenRef.current;
        const pendingByCategory: Record<string, GeoJSON.Feature[]> = {};
        (async () => {
            let working: typeof inner = inner;
            try {
                working = (await applyQuestionsToMapGeoData(
                    $questions,
                    working,
                    planningModeEnabled.get(),
                    (geoJSONObj, question) => {
                        if (question.id === "radius") return;
                        const cat =
                            CATEGORIES[question.id as CategoryId] ??
                            CATEGORIES.matching;
                        if (!pendingByCategory[cat.color]) {
                            pendingByCategory[cat.color] = [];
                        }
                        if (geoJSONObj && typeof geoJSONObj === "object") {
                            if ("type" in geoJSONObj) {
                                if (
                                    geoJSONObj.type === "FeatureCollection"
                                ) {
                                    for (const f of (
                                        geoJSONObj as GeoJSON.FeatureCollection
                                    ).features) {
                                        pendingByCategory[cat.color].push(
                                            f,
                                        );
                                    }
                                } else if (geoJSONObj.type === "Feature") {
                                    pendingByCategory[cat.color].push(
                                        geoJSONObj as GeoJSON.Feature,
                                    );
                                } else {
                                    pendingByCategory[cat.color].push(
                                        turf.feature(
                                            geoJSONObj as GeoJSON.Geometry,
                                        ) as GeoJSON.Feature,
                                    );
                                }
                            }
                        }
                    },
                )) as typeof working;
            } catch (e) {
                console.warn("MapV2 applyQuestions failed:", e);
            }
            let mask: GeoJSON.Feature | null = null;
            try {
                mask = holedMask(
                    working as never,
                ) as GeoJSON.Feature | null;
            } catch (e) {
                console.warn("MapV2 holedMask failed:", e);
            }
            if (myGen !== eliminationGenRef.current) return; // stale
            setEliminationResult({ mask, pendingByCategory });
        })();
    }, [$mapGeoJSON, $polyGeoJSON, $questions]);

    return (
        <div className={cn("relative w-full h-screen", className)}>
            <Map
                ref={mapRef}
                initialViewState={initialView}
                mapStyle={style}
                attributionControl={false}
                style={{ width: "100%", height: "100%" }}
                dragRotate={false}
                pitchWithRotate={false}
                touchPitch={false}
                onLoad={handleLoad}
                onMoveEnd={handleMoveEnd}
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

                {/* Elimination mask — everything OUTSIDE the
                    in-play polygon (which is the play area
                    minus eliminated regions) gets darkened.
                    Same visual cue Leaflet's Map.tsx draws. */}
                {eliminationResult.mask && (
                    <Source
                        id="elimination"
                        type="geojson"
                        data={eliminationResult.mask}
                    >
                        <Layer
                            id="elimination-fill"
                            type="fill"
                            paint={{
                                "fill-color": "#0f172a",
                                "fill-opacity": 0.45,
                            }}
                        />
                        <Layer
                            id="elimination-outline"
                            type="line"
                            paint={{
                                "line-color": "#0f172a",
                                "line-width": 1,
                                "line-opacity": 0.55,
                            }}
                        />
                    </Source>
                )}

                {/* Pending-question dashed outlines, one
                    Source+Layer pair per category color. The
                    Leaflet path does one layer per question
                    (cheap in DOM); for WebGL it's faster to
                    batch by color so each style change
                    becomes a single GL draw call. */}
                {Object.entries(eliminationResult.pendingByCategory).map(
                    ([color, features]) => {
                        if (features.length === 0) return null;
                        const fc: GeoJSON.FeatureCollection = {
                            type: "FeatureCollection",
                            features,
                        };
                        const id = `pending-${color.replace(/[^a-z0-9]/gi, "-")}`;
                        return (
                            <Source key={id} id={id} type="geojson" data={fc}>
                                <Layer
                                    id={`${id}-fill`}
                                    type="fill"
                                    paint={{
                                        "fill-color": color,
                                        "fill-opacity": 0.08,
                                    }}
                                />
                                <Layer
                                    id={`${id}-line`}
                                    type="line"
                                    paint={{
                                        "line-color": color,
                                        "line-width": 2,
                                        "line-opacity": 0.85,
                                        "line-dasharray": [3, 2],
                                    }}
                                />
                            </Source>
                        );
                    },
                )}
            </Map>
        </div>
    );
}

export default MapV2;
