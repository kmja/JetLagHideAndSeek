import "maplibre-gl/dist/maplibre-gl.css";

import { useStore } from "@nanostores/react";
import * as turf from "@turf/turf";
import maplibregl from "maplibre-gl";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "react-toastify";
import Map, {
    AttributionControl,
    Layer,
    Marker,
    NavigationControl,
    ScaleControl,
    Source,
    type MapRef,
    type ViewStateChangeEvent,
} from "react-map-gl/maplibre";

import {
    baseTileLayer,
    followMe,
    hiderMode,
    mapGeoJSON,
    mapGeoLocation,
    planningModeEnabled,
    polyGeoJSON,
    questionModified,
    questions,
    thunderforestApiKey,
    triggerLocalRefresh,
} from "@/lib/context";
import {
    mapLibreContext,
    mapLibreViewport,
} from "@/lib/featureFlags";
import { CATEGORIES, type CategoryId } from "@/lib/categories";
import {
    allowedTransit,
    satelliteView,
    showBusRoutes,
    showFerryRoutes,
    showSubwayRoutes,
    showTransitLines,
    transitRoutesLoading,
} from "@/lib/gameSetup";
import { cn } from "@/lib/utils";
import { seekerAddQuestion } from "@/lib/multiplayer/store";
import { applyQuestionsToMapGeoData, holedMask } from "@/maps";
import {
    fetchTransitRoutesFeatures,
    type TransitMode,
} from "@/maps/api/transitRoutes";

import {
    Dialog,
    DialogContent,
} from "@/components/ui/dialog";
import {
    MatchingQuestionComponent,
    MeasuringQuestionComponent,
    RadiusQuestionComponent,
    TentacleQuestionComponent,
    ThermometerQuestionComponent,
} from "./QuestionCards";

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
 *   [x] Pending-radius static circles (sweep animation deferred)
 *   [x] Question markers (display + drag-to-reposition)
 *   [x] OpenRailwayMap overlay (raster)
 *   [x] TransitRoutesOverlay (subway / bus / ferry, vector GeoJSON)
 *   [x] Thunderforest custom tiles
 *   [x] Marker click → opens QuestionCard dialog
 *   [ ] PolygonDraw (free-draw region elimination)
 *   [ ] ZoneSidebar hiding-zone overlay
 *   [ ] Coastline GeoJSON overlay
 *   [x] Follow-me pin (seeker's live position)
 *   [ ] Map print / screenshot equivalent
 *   [x] Context menu (right-click / long-press to add a question)
 *   [x] Hider-guess pin (seeker's "I think they're here" marker)
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

const RAIL_OVERLAY_SOURCE = {
    tiles: [
        "https://a.tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png",
        "https://b.tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png",
        "https://c.tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png",
    ],
    attribution:
        '&copy; <a href="https://www.openrailwaymap.org/">OpenRailwayMap</a>',
};

function thunderforestSource(
    flavor: "transport" | "neighbourhood",
    key: string,
) {
    return {
        tiles: [
            `https://tile.thunderforest.com/${flavor}/{z}/{x}/{y}.png?apikey=${key}`,
        ],
        attribution:
            '&copy; <a href="http://www.thunderforest.com/">Thunderforest</a>',
    };
}

function buildStyle(
    baseKey: string,
    withSatellite: boolean,
    withRail: boolean,
    thunderforestKey: string,
): maplibregl.StyleSpecification {
    // Resolve the base layer. Thunderforest needs an API key
    // — fall back to dark if the user hasn't entered one yet
    // (matches the Leaflet branch's behaviour).
    let base: { tiles: string[]; attribution: string };
    if (baseKey === "transport" || baseKey === "neighbourhood") {
        if (thunderforestKey) {
            base = thunderforestSource(baseKey, thunderforestKey);
        } else {
            base = RASTER_SOURCES.dark;
        }
    } else {
        base = RASTER_SOURCES[baseKey] ?? RASTER_SOURCES.dark;
    }

    const sources: maplibregl.StyleSpecification["sources"] = {
        base: {
            type: "raster",
            tiles: base.tiles,
            tileSize: 256,
            attribution: base.attribution,
        },
    };
    const layers: maplibregl.LayerSpecification[] = [
        { id: "base", type: "raster", source: "base" },
    ];

    if (withSatellite) {
        sources.satellite = {
            type: "raster",
            tiles: SATELLITE_SOURCE.tiles,
            tileSize: 256,
            attribution: SATELLITE_SOURCE.attribution,
        };
        layers.push({
            id: "satellite",
            type: "raster",
            source: "satellite",
            paint: { "raster-opacity": 0.7 },
        });
    }

    if (withRail) {
        sources.rail = {
            type: "raster",
            tiles: RAIL_OVERLAY_SOURCE.tiles,
            tileSize: 256,
            attribution: RAIL_OVERLAY_SOURCE.attribution,
        };
        layers.push({
            id: "rail",
            type: "raster",
            source: "rail",
            paint: { "raster-opacity": 0.85 },
        });
    }

    return {
        version: 8,
        sources,
        layers,
        glyphs: undefined,
    };
}

export function MapV2({ className }: MapV2Props) {
    const $followMe = useStore(followMe);
    const $hiderMode = useStore(hiderMode);
    const $allowedTransit = useStore(allowedTransit);
    const $subway = useStore(showSubwayRoutes);
    const $bus = useStore(showBusRoutes);
    const $ferry = useStore(showFerryRoutes);
    const $tileKey = useStore(baseTileLayer);
    const $satellite = useStore(satelliteView);
    const $rail = useStore(showTransitLines);
    const $tfKey = useStore(thunderforestApiKey);
    const $polyGeoJSON = useStore(polyGeoJSON);
    const $mapGeoJSON = useStore(mapGeoJSON);
    const $mapGeoLocation = useStore(mapGeoLocation);
    const $questions = useStore(questions);
    useStore(triggerLocalRefresh); // subscribe to manual re-render kicks
    const $savedViewport = useStore(mapLibreViewport);

    const mapRef = useRef<MapRef | null>(null);

    const style = useMemo(
        () => buildStyle($tileKey, $satellite, $rail, $tfKey ?? ""),
        [$tileKey, $satellite, $rail, $tfKey],
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

    // Transit-route overlays per mode. Each toggle (subway /
    // bus / ferry) gates an Overpass fetch via
    // fetchTransitRoutesFeatures. Results live in state as
    // FeatureCollections; the JSX renders one Source+Layer per
    // mode. Re-fetch when the play area changes
    // ($mapGeoLocation) so cached results from a previous area
    // get replaced. Loading flag mirrored into
    // transitRoutesLoading so MapDisplayControls' spinner shows
    // during fetch.
    const subwayOn = $subway && $allowedTransit.includes("subway");
    const busOn = $bus && $allowedTransit.includes("bus");
    const ferryOn = $ferry && $allowedTransit.includes("ferry");
    const [transitFC, setTransitFC] = useState<
        Record<TransitMode, GeoJSON.FeatureCollection | null>
    >({ subway: null, bus: null, ferry: null });
    const areaKey =
        $mapGeoLocation?.properties?.osm_id ??
        ($polyGeoJSON ? "custom-poly" : "none");
    useEffect(() => {
        let cancelled = false;
        const fetchAndSet = async (mode: TransitMode, on: boolean) => {
            if (!on) {
                setTransitFC((curr) => ({ ...curr, [mode]: null }));
                return;
            }
            const curr = transitRoutesLoading.get();
            transitRoutesLoading.set({ ...curr, [mode]: true });
            try {
                const fc = await fetchTransitRoutesFeatures(mode);
                if (cancelled) return;
                setTransitFC((c) => ({ ...c, [mode]: fc }));
            } catch (e) {
                console.warn(`MapV2 transit (${mode}) fetch failed`, e);
            } finally {
                if (cancelled) return;
                const c = transitRoutesLoading.get();
                transitRoutesLoading.set({ ...c, [mode]: false });
            }
        };
        fetchAndSet("subway", subwayOn);
        fetchAndSet("bus", busOn);
        fetchAndSet("ferry", ferryOn);
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [subwayOn, busOn, ferryOn, areaKey]);

    // Pending-radius circles. The "elimination" pipeline above
    // deliberately skips radius questions so the Leaflet
    // RadarScanOverlay can render a rotating sweep instead. We
    // haven't ported that animation yet, so without something
    // here a pending radius question would have no visual on
    // MapV2. Static turf-built circle is a clean placeholder —
    // the seeker still sees the affected area; just no sweep.
    const pendingRadiusFeatures = useMemo(() => {
        const features: GeoJSON.Feature[] = [];
        for (const q of $questions) {
            if (q.id !== "radius") continue;
            if (!q.data?.drag) continue;
            const data = q.data as {
                lat?: number;
                lng?: number;
                radius?: number;
                unit?: "miles" | "kilometers" | "meters";
                color?: string;
            };
            if (
                typeof data.lat !== "number" ||
                typeof data.lng !== "number" ||
                typeof data.radius !== "number"
            ) {
                continue;
            }
            const radiusKm = turf.convertLength(
                data.radius,
                (data.unit as turf.Units | undefined) ?? "kilometers",
                "kilometers",
            );
            try {
                const circle = turf.circle(
                    [data.lng, data.lat],
                    radiusKm,
                    { units: "kilometers", steps: 64 },
                );
                circle.properties = {
                    color:
                        (data.color &&
                            CATEGORIES.radius?.color) ??
                        CATEGORIES.radius?.color ??
                        "#f5a888",
                };
                features.push(circle as GeoJSON.Feature);
            } catch (e) {
                console.warn("MapV2 radius circle failed:", e);
            }
        }
        return { type: "FeatureCollection", features } as GeoJSON.FeatureCollection;
    }, [$questions]);

    // Click-to-edit: tapping a marker opens the relevant
    // QuestionCard in a Dialog. Uses an isDraggingRef gate so
    // an accidental click at the end of a drag doesn't pop the
    // dialog. The dialog itself is rendered below the Map JSX.
    const [selectedMarker, setSelectedMarker] = useState<{
        questionKey: number;
        slot: "primary" | "a" | "b";
    } | null>(null);
    const isDraggingRef = useRef(false);

    // Context menu — right-click on desktop / long-press on
    // mobile opens an "Add radius / thermometer / tentacles"
    // mini menu at the click coordinates. Mirrors the
    // leaflet-contextmenu plugin the Leaflet path uses, just
    // re-rendered as a positioned div.
    const [contextMenu, setContextMenu] = useState<{
        screenX: number;
        screenY: number;
        lat: number;
        lng: number;
    } | null>(null);

    // Follow-me pin: live blue dot at the seeker's current
    // position, updated via watchPosition. Same shape as the
    // Leaflet path — gated on the followMe atom, started on
    // flip-true, cleaned up on flip-false or unmount. The
    // marker is rendered in JSX below; we keep just the
    // position in state here.
    const [selfPosition, setSelfPosition] = useState<
        | {
              lat: number;
              lng: number;
          }
        | null
    >(null);
    useEffect(() => {
        if (!$followMe) {
            setSelfPosition(null);
            return;
        }
        if (
            typeof navigator === "undefined" ||
            !navigator.geolocation
        ) {
            return;
        }
        const id = navigator.geolocation.watchPosition(
            (pos) => {
                setSelfPosition({
                    lat: pos.coords.latitude,
                    lng: pos.coords.longitude,
                });
            },
            () => {
                toast.error("Unable to access your location.");
                followMe.set(false);
            },
            { enableHighAccuracy: true, maximumAge: 10_000, timeout: 20_000 },
        );
        return () => {
            navigator.geolocation.clearWatch(id);
        };
    }, [$followMe]);

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
                onContextMenu={(e) => {
                    setContextMenu({
                        screenX: e.point.x,
                        screenY: e.point.y,
                        lat: e.lngLat.lat,
                        lng: e.lngLat.lng,
                    });
                }}
                onClick={() => setContextMenu(null)}
            >
                <AttributionControl compact />
                <NavigationControl position="top-right" showCompass={false} />
                <ScaleControl />

                {/* Transit-route overlays — one Source+Layer per
                    mode. Colors match the Leaflet
                    TransitRoutesOverlay's MODE_CONFIG (subway
                    purple, bus orange, ferry blue dashed) so
                    operators see consistent visuals across the
                    two map paths. */}
                {transitFC.subway && (
                    <Source
                        id="transit-subway"
                        type="geojson"
                        data={transitFC.subway}
                    >
                        <Layer
                            id="transit-subway-line"
                            type="line"
                            paint={{
                                "line-color": "hsl(280, 60%, 60%)",
                                "line-width": 2,
                                "line-opacity": 0.8,
                            }}
                        />
                    </Source>
                )}
                {transitFC.bus && (
                    <Source
                        id="transit-bus"
                        type="geojson"
                        data={transitFC.bus}
                    >
                        <Layer
                            id="transit-bus-line"
                            type="line"
                            paint={{
                                "line-color": "hsl(35, 90%, 55%)",
                                "line-width": 2,
                                "line-opacity": 0.8,
                            }}
                        />
                    </Source>
                )}
                {transitFC.ferry && (
                    <Source
                        id="transit-ferry"
                        type="geojson"
                        data={transitFC.ferry}
                    >
                        <Layer
                            id="transit-ferry-line"
                            type="line"
                            paint={{
                                "line-color": "hsl(200, 85%, 55%)",
                                "line-width": 2,
                                "line-opacity": 0.8,
                                "line-dasharray": [4, 4],
                            }}
                        />
                    </Source>
                )}

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

                {/* Pending-radius circles — static placeholder
                    for the radar sweep animation that hasn't
                    been ported from the Leaflet
                    RadarScanOverlay. Renders one Source per
                    color (matching the dashed-outline approach
                    for other pending questions) so the GPU
                    batches draws. */}
                {pendingRadiusFeatures.features.length > 0 && (
                    <Source
                        id="pending-radius"
                        type="geojson"
                        data={pendingRadiusFeatures}
                    >
                        <Layer
                            id="pending-radius-fill"
                            type="fill"
                            paint={{
                                "fill-color":
                                    CATEGORIES.radius?.color ??
                                    "#f5a888",
                                "fill-opacity": 0.08,
                            }}
                        />
                        <Layer
                            id="pending-radius-line"
                            type="line"
                            paint={{
                                "line-color":
                                    CATEGORIES.radius?.color ??
                                    "#f5a888",
                                "line-width": 2,
                                "line-opacity": 0.85,
                                "line-dasharray": [3, 2],
                            }}
                        />
                    </Source>
                )}

                {/* Hider-guess pin — the seeker's "I think the
                    hider is here" marker. Green, draggable. Same
                    questionKey=-1 contract as the Leaflet
                    DraggableMarkers path so the rest of the
                    elimination pipeline + autosave bridge see
                    consistent data shape. */}
                {$hiderMode !== false && (
                    <Marker
                        longitude={$hiderMode.longitude}
                        latitude={$hiderMode.latitude}
                        anchor="center"
                        draggable
                        onDragEnd={(e) => {
                            const next = {
                                latitude: e.lngLat.lat,
                                longitude: e.lngLat.lng,
                            };
                            hiderMode.set(next);
                        }}
                    >
                        <div
                            aria-label="Hider guess"
                            style={{
                                width: 16,
                                height: 16,
                                borderRadius: "50%",
                                background: "#2AAD27",
                                border: "2px solid white",
                                boxShadow:
                                    "0 1px 3px rgba(0,0,0,0.55)",
                                cursor: "grab",
                            }}
                        />
                    </Marker>
                )}

                {/* Follow-me pin — seeker's live position. Gated
                    on the followMe atom; the watch-position
                    effect above keeps `selfPosition` current. */}
                {selfPosition && (
                    <Marker
                        longitude={selfPosition.lng}
                        latitude={selfPosition.lat}
                        anchor="center"
                    >
                        <div
                            aria-label="Your position"
                            style={{
                                width: 20,
                                height: 20,
                                borderRadius: "50%",
                                background: "#2A81CB",
                                border: "3px solid white",
                                boxShadow:
                                    "0 0 0 1px #2A81CB, 0 1px 4px rgba(0,0,0,0.5)",
                            }}
                        />
                    </Marker>
                )}

                {/* Per-question markers. Each question type's
                    coord shape is normalized by questionMarkers()
                    into a flat list of (lat, lng, slot) entries
                    where `slot` tells the drag handler which
                    field of the question's data to write back to
                    on drag-end. Matches the Leaflet path's
                    "mutate in place + call questionModified()"
                    pattern so the multiplayer / autosave bridge
                    fires the same way. Click-to-edit dialog is
                    next. */}
                {$questions
                    .flatMap((q) => questionMarkers(q))
                    .map(({ id, questionKey, slot, lat, lng, color, label }) => (
                        <Marker
                            key={id}
                            longitude={lng}
                            latitude={lat}
                            anchor="center"
                            draggable
                            onDragStart={() => {
                                isDraggingRef.current = true;
                            }}
                            onDragEnd={(e) => {
                                const all = questions.get();
                                const target = all.find(
                                    (q) => q.key === questionKey,
                                );
                                if (target) {
                                    const newLat = e.lngLat.lat;
                                    const newLng = e.lngLat.lng;
                                    const data = target.data as Record<
                                        string,
                                        unknown
                                    >;
                                    if (slot === "primary") {
                                        data.lat = newLat;
                                        data.lng = newLng;
                                    } else if (slot === "a") {
                                        data.latA = newLat;
                                        data.lngA = newLng;
                                    } else {
                                        data.latB = newLat;
                                        data.lngB = newLng;
                                    }
                                    questionModified();
                                }
                                // Give the synthesized click event
                                // that fires immediately after
                                // dragend a moment to bounce off the
                                // guard before we reset. Same 100 ms
                                // window the Leaflet path uses.
                                setTimeout(() => {
                                    isDraggingRef.current = false;
                                }, 100);
                            }}
                        >
                            <div
                                aria-label={label}
                                onClick={(e) => {
                                    if (isDraggingRef.current) return;
                                    // Stop the click from also
                                    // counting as a map-canvas click
                                    // (which would fall through to
                                    // any future "tap to add" handler).
                                    e.stopPropagation();
                                    setSelectedMarker({
                                        questionKey,
                                        slot,
                                    });
                                }}
                                style={{
                                    width: 16,
                                    height: 16,
                                    borderRadius: "50%",
                                    background: color,
                                    border: "2px solid white",
                                    boxShadow:
                                        "0 1px 3px rgba(0,0,0,0.55)",
                                    cursor: "grab",
                                }}
                            />
                        </Marker>
                    ))}

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

            {/* Context menu — absolutely-positioned at the
                click point. Mirrors the leaflet-contextmenu
                items: Add Radius / Thermometer / Tentacles at
                the clicked coords. Closes on item-select or
                map-click (handled via onClick on <Map />). */}
            {contextMenu && (
                <div
                    role="menu"
                    style={{
                        position: "absolute",
                        left: contextMenu.screenX,
                        top: contextMenu.screenY,
                        zIndex: 1500,
                    }}
                    className={cn(
                        "min-w-[160px] rounded-md border border-border",
                        "bg-background/95 backdrop-blur-sm shadow-xl",
                        "py-1 text-sm",
                    )}
                    onClick={(e) => e.stopPropagation()}
                >
                    <button
                        type="button"
                        className="w-full text-left px-3 py-1.5 hover:bg-accent"
                        onClick={() => {
                            seekerAddQuestion({
                                id: "radius",
                                data: {
                                    lat: contextMenu.lat,
                                    lng: contextMenu.lng,
                                },
                            });
                            setContextMenu(null);
                        }}
                    >
                        Add Radius
                    </button>
                    <button
                        type="button"
                        className="w-full text-left px-3 py-1.5 hover:bg-accent"
                        onClick={() => {
                            const dest = turf.destination(
                                [contextMenu.lng, contextMenu.lat],
                                5,
                                90,
                                { units: "miles" },
                            );
                            seekerAddQuestion({
                                id: "thermometer",
                                data: {
                                    latA: contextMenu.lat,
                                    lngA: contextMenu.lng,
                                    latB: dest.geometry.coordinates[1],
                                    lngB: dest.geometry.coordinates[0],
                                },
                            });
                            setContextMenu(null);
                        }}
                    >
                        Add Thermometer
                    </button>
                    <button
                        type="button"
                        className="w-full text-left px-3 py-1.5 hover:bg-accent"
                        onClick={() => {
                            seekerAddQuestion({
                                id: "tentacles",
                                data: {
                                    lat: contextMenu.lat,
                                    lng: contextMenu.lng,
                                },
                            });
                            setContextMenu(null);
                        }}
                    >
                        Add Tentacles
                    </button>
                </div>
            )}

            {/* Question-edit dialog. Same QuestionComponent
                dispatch as the Leaflet path's DraggableMarkers
                — radius / tentacles / thermometer / matching /
                measuring each get their full edit UI inline. The
                `sub` prop (Start / End) is set when the user
                tapped a thermometer A/B marker. Dialog portals to
                <body> per shadcn defaults, so it's not trapped
                inside MapLibre's canvas container. */}
            <Dialog
                open={selectedMarker !== null}
                onOpenChange={(o) => {
                    if (!o) setSelectedMarker(null);
                }}
            >
                <DialogContent className="!bg-[hsl(var(--sidebar-background))] !text-white">
                    {selectedMarker &&
                        $questions
                            .filter(
                                (q) =>
                                    q.key === selectedMarker.questionKey,
                            )
                            .map((q) => {
                                const sub =
                                    selectedMarker.slot === "a"
                                        ? "Start"
                                        : selectedMarker.slot === "b"
                                          ? "End"
                                          : "";
                                switch (q.id) {
                                    case "radius":
                                        return (
                                            <RadiusQuestionComponent
                                                key={q.key}
                                                data={q.data}
                                                questionKey={q.key}
                                                sub={sub}
                                            />
                                        );
                                    case "tentacles":
                                        return (
                                            <TentacleQuestionComponent
                                                key={q.key}
                                                data={q.data}
                                                questionKey={q.key}
                                                sub={sub}
                                            />
                                        );
                                    case "thermometer":
                                        return (
                                            <ThermometerQuestionComponent
                                                key={q.key}
                                                data={q.data}
                                                questionKey={q.key}
                                                sub={sub}
                                            />
                                        );
                                    case "matching":
                                        return (
                                            <MatchingQuestionComponent
                                                key={q.key}
                                                data={q.data}
                                                questionKey={q.key}
                                                sub={sub}
                                            />
                                        );
                                    case "measuring":
                                        return (
                                            <MeasuringQuestionComponent
                                                key={q.key}
                                                data={q.data}
                                                questionKey={q.key}
                                                sub={sub}
                                            />
                                        );
                                    default:
                                        return null;
                                }
                            })}
                </DialogContent>
            </Dialog>
        </div>
    );
}

/**
 * Extract render-ready markers from a question. Different
 * question categories store coordinates under different keys
 * (radius / tentacles: data.lat/data.lng; thermometer: a/b
 * pair; matching/measuring: depends on subtype). The `slot`
 * tells the drag handler WHICH coord field of the question's
 * data to update on drag-end.
 */
function questionMarkers(q: {
    key: number;
    id: string;
    data: Record<string, unknown>;
}): Array<{
    id: string;
    questionKey: number;
    slot: "primary" | "a" | "b";
    lat: number;
    lng: number;
    color: string;
    label: string;
}> {
    const cat = CATEGORIES[q.id as CategoryId] ?? CATEGORIES.matching;
    const out: Array<{
        id: string;
        questionKey: number;
        slot: "primary" | "a" | "b";
        lat: number;
        lng: number;
        color: string;
        label: string;
    }> = [];
    const data = q.data;
    if (
        typeof data.lat === "number" &&
        typeof data.lng === "number"
    ) {
        out.push({
            id: `${q.key}-primary`,
            questionKey: q.key,
            slot: "primary",
            lat: data.lat,
            lng: data.lng,
            color: cat.color,
            label: `${cat.label ?? q.id} marker`,
        });
    }
    if (
        typeof data.latA === "number" &&
        typeof data.lngA === "number"
    ) {
        out.push({
            id: `${q.key}-a`,
            questionKey: q.key,
            slot: "a",
            lat: data.latA,
            lng: data.lngA,
            color: cat.color,
            label: `${cat.label ?? q.id} start`,
        });
    }
    if (
        typeof data.latB === "number" &&
        typeof data.lngB === "number" &&
        // Skip if same as A (thermometer "started" state has
        // latB/lngB mirroring latA/lngA).
        (data.latA !== data.latB || data.lngA !== data.lngB)
    ) {
        out.push({
            id: `${q.key}-b`,
            questionKey: q.key,
            slot: "b",
            lat: data.latB,
            lng: data.lngB,
            color: cat.color,
            label: `${cat.label ?? q.id} end`,
        });
    }
    return out;
}

export default MapV2;
