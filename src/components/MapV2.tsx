import "maplibre-gl/dist/maplibre-gl.css";
import "@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css";

import { useStore } from "@nanostores/react";
import MapboxDraw from "@mapbox/mapbox-gl-draw";
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
    drawingQuestionKey,
    followMe,
    hiderMode,
    hidingZonesGeoJSON,
    mapGeoJSON,
    mapGeoLocation,
    planningModeEnabled,
    polyGeoJSON,
    questionModified,
    questions,
    thunderforestApiKey,
    triggerLocalRefresh,
} from "@/lib/context";
import { clearCache } from "@/maps/api";
import { CacheType } from "@/maps/api/types";
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
 *   [x] Pending-radius circles + rotating radar sweep
 *   [x] Question markers (display + drag-to-reposition)
 *   [x] OpenRailwayMap overlay (raster)
 *   [x] TransitRoutesOverlay (subway / bus / ferry, vector GeoJSON)
 *   [x] ZoneSidebar hiding-zones overlay (atom shadow + Source/Layer)
 *   [x] Thunderforest custom tiles
 *   [x] Marker click → opens QuestionCard dialog
 *   [x] PolygonDraw (free-draw): hiding zone (key=-1), tentacles
 *       custom locations, matching custom-zone, matching custom-
 *       points, measuring custom-measure — all via mapbox-gl-draw,
 *       seeded from existing feature data so users edit in place.
 *   [ ] Coastline GeoJSON overlay
 *   [x] Follow-me pin (seeker's live position)
 *   [x] Map print / screenshot equivalent (window CustomEvent
 *       `jlhs:save-map-image` → PNG download via
 *       map.getCanvas().toDataURL)
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
    const $drawingQuestionKey = useStore(drawingQuestionKey);
    const $followMe = useStore(followMe);
    const $hiderMode = useStore(hiderMode);
    const $hidingZones = useStore(hidingZonesGeoJSON);
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
    // Build pending-radius circles AND the underlying
    // center/radius list in one pass. The list feeds the radar
    // sweep animation below — same source data, different
    // visual representations.
    const { pendingRadiusFeatures, radarTargets } = useMemo(() => {
        const features: GeoJSON.Feature[] = [];
        const targets: Array<{ lat: number; lng: number; radiusKm: number }> =
            [];
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
                targets.push({
                    lat: data.lat,
                    lng: data.lng,
                    radiusKm,
                });
            } catch (e) {
                console.warn("MapV2 radius circle failed:", e);
            }
        }
        return {
            pendingRadiusFeatures: {
                type: "FeatureCollection",
                features,
            } as GeoJSON.FeatureCollection,
            radarTargets: targets,
        };
    }, [$questions]);

    // Radar sweep animation — rotating wedge over each pending
    // radius question. Builds a turf sector per target every
    // animation frame and feeds the FeatureCollection back to
    // MapLibre via getSource().setData(...) so re-rendering
    // stays GPU-side instead of triggering a React re-render
    // each frame. Loop is gated on having at least one target
    // so an empty pending set burns no CPU.
    const SWEEP_PERIOD_MS = 3500; // ms per full rotation
    const SWEEP_WIDTH_DEG = 60;
    useEffect(() => {
        if (radarTargets.length === 0) return;
        let raf = 0;
        const tick = () => {
            const map = mapRef.current?.getMap();
            const source = map?.getSource("radar-sweep") as
                | maplibregl.GeoJSONSource
                | undefined;
            if (source) {
                const now = performance.now();
                const headDeg =
                    ((now % SWEEP_PERIOD_MS) / SWEEP_PERIOD_MS) * 360;
                const features: GeoJSON.Feature[] = [];
                for (const t of radarTargets) {
                    try {
                        const sector = turf.sector(
                            [t.lng, t.lat],
                            t.radiusKm,
                            headDeg,
                            (headDeg + SWEEP_WIDTH_DEG) % 360,
                            { units: "kilometers", steps: 32 },
                        );
                        features.push(sector as GeoJSON.Feature);
                    } catch {
                        /* turf.sector occasionally fails on
                           degenerate bearings; skip the frame
                           rather than crash. */
                    }
                }
                source.setData({
                    type: "FeatureCollection",
                    features,
                });
            }
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [radarTargets]);

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

    // Map-screenshot trigger. The MapDisplayControls "Save image"
    // button dispatches a `jlhs:save-map-image` CustomEvent on
    // window; we capture the current WebGL canvas as a PNG and
    // trigger a download. Replaces the leaflet-easyprint control
    // that used to live on the Leaflet map.
    useEffect(() => {
        const handler = () => {
            const map = mapRef.current?.getMap();
            if (!map) return;
            try {
                // Force a synchronous repaint so the screenshot
                // reflects the latest state (otherwise we get the
                // previous frame's buffer).
                map.triggerRepaint();
                const dataUrl = map
                    .getCanvas()
                    .toDataURL("image/png");
                const a = document.createElement("a");
                a.href = dataUrl;
                a.download = `jetlag-map-${new Date()
                    .toISOString()
                    .replace(/[:.]/g, "-")}.png`;
                document.body.appendChild(a);
                a.click();
                a.remove();
                toast.success("Map image saved");
            } catch (e) {
                console.error("Map screenshot failed:", e);
                toast.error("Couldn't save map image");
            }
        };
        window.addEventListener("jlhs:save-map-image", handler);
        return () =>
            window.removeEventListener("jlhs:save-map-image", handler);
    }, []);

    // PolygonDraw integration. When drawingQuestionKey flips to
    // a non-null value the user has opened a draw session — for
    // a brand-new custom hiding zone (-1) or to edit an existing
    // custom-typed question (matching custom-zone / custom-
    // points; measuring custom-measure; tentacles custom). We
    // attach a mapbox-gl-draw control configured for the right
    // mode and wire the draw events to the same atom writes the
    // Leaflet PolygonDraw does.
    useEffect(() => {
        if ($drawingQuestionKey === null) return;
        const map = mapRef.current?.getMap();
        if (!map) return;
        const targetQ =
            $drawingQuestionKey === -1
                ? null
                : questions
                      .get()
                      .find((q) => q.key === $drawingQuestionKey);

        // Pick the draw mode + initial features based on what
        // the user is editing. Polygons for zones / hiding
        // zones, points for tentacle locations / matching
        // points / measuring points.
        let mode: "draw_polygon" | "draw_point" = "draw_polygon";
        let initialFeatures: GeoJSON.Feature[] = [];
        if ($drawingQuestionKey === -1) {
            mode = "draw_polygon";
            // Hiding-zone editing reads back the existing
            // polyGeoJSON so the user can refine, not just
            // start over.
            const existing = polyGeoJSON.get();
            if (existing) {
                initialFeatures = existing.features as GeoJSON.Feature[];
            }
        } else if (
            targetQ?.id === "tentacles" &&
            (targetQ.data as { locationType?: string }).locationType ===
                "custom"
        ) {
            mode = "draw_point";
            const places =
                (targetQ.data as { places?: GeoJSON.Feature[] }).places ?? [];
            initialFeatures = places as GeoJSON.Feature[];
        } else if (
            targetQ?.id === "matching" &&
            (targetQ.data as { type?: string }).type === "custom-zone"
        ) {
            mode = "draw_polygon";
            const geo = (targetQ.data as { geo?: GeoJSON.Feature }).geo;
            if (geo) initialFeatures = [geo];
        } else if (
            targetQ?.id === "matching" &&
            (targetQ.data as { type?: string }).type === "custom-points"
        ) {
            mode = "draw_point";
            const geo = (targetQ.data as { geo?: GeoJSON.FeatureCollection })
                .geo;
            if (geo?.features) initialFeatures = geo.features;
        } else if (
            targetQ?.id === "measuring" &&
            (targetQ.data as { type?: string }).type === "custom-measure"
        ) {
            mode = "draw_point";
            const geo = (targetQ.data as { geo?: GeoJSON.FeatureCollection })
                .geo;
            if (geo?.features) initialFeatures = geo.features;
        }

        const draw = new MapboxDraw({
            displayControlsDefault: false,
            controls: {
                polygon: mode === "draw_polygon",
                point: mode === "draw_point",
                trash: true,
            },
            defaultMode: mode,
        });
        map.addControl(
            draw as unknown as maplibregl.IControl,
            "top-right",
        );

        // Load existing features so the user edits in place
        // instead of starting from a blank canvas.
        if (initialFeatures.length > 0) {
            try {
                draw.set({
                    type: "FeatureCollection",
                    features: initialFeatures.filter(
                        (f) => f?.type === "Feature" && f.geometry,
                    ) as GeoJSON.Feature[],
                });
            } catch (e) {
                console.warn("MapV2 draw.set seed failed:", e);
            }
        }

        const onFeatureChange = () => {
            const fc = draw.getAll();
            // Hiding-zone case.
            if ($drawingQuestionKey === -1) {
                const polys = fc.features.filter(
                    (f) =>
                        f.geometry.type === "Polygon" ||
                        f.geometry.type === "MultiPolygon",
                );
                if (polys.length === 0) return;
                const out = turf.featureCollection(polys) as
                    GeoJSON.FeatureCollection<
                        GeoJSON.Polygon | GeoJSON.MultiPolygon
                    >;
                mapGeoJSON.set(out);
                polyGeoJSON.set(out);
                questions.set([]);
                void clearCache(CacheType.ZONE_CACHE);
                return;
            }
            if (!targetQ) return;
            const data = targetQ.data as Record<string, unknown>;
            if (
                targetQ.id === "tentacles" &&
                data.locationType === "custom"
            ) {
                // Points — write to data.places, dedup by coord
                // signature.
                const points = fc.features.filter(
                    (f) => f.geometry.type === "Point",
                );
                const dedup: Record<string, GeoJSON.Feature> = {};
                for (const p of points) {
                    const c = (p.geometry as GeoJSON.Point).coordinates;
                    dedup[`${c[0]},${c[1]}`] = p;
                }
                data.places = Object.values(dedup);
                questionModified();
            } else if (
                targetQ.id === "matching" &&
                data.type === "custom-zone"
            ) {
                const polys = fc.features.filter(
                    (f) =>
                        f.geometry.type === "Polygon" ||
                        f.geometry.type === "MultiPolygon",
                );
                if (polys.length === 0) {
                    data.geo = undefined;
                } else {
                    // Combine into a single feature so the
                    // downstream elimination pipeline sees one
                    // shape.
                    const combined = turf.combine(
                        turf.featureCollection(polys as never),
                    ).features[0];
                    data.geo = combined;
                }
                questionModified();
            } else if (
                targetQ.id === "matching" &&
                data.type === "custom-points"
            ) {
                const points = fc.features.filter(
                    (f) => f.geometry.type === "Point",
                );
                const dedup: Record<string, GeoJSON.Feature> = {};
                for (const p of points) {
                    const c = (p.geometry as GeoJSON.Point).coordinates;
                    dedup[`${c[0]},${c[1]}`] = p;
                }
                data.geo = {
                    type: "FeatureCollection",
                    features: Object.values(dedup),
                };
                questionModified();
            } else if (
                targetQ.id === "measuring" &&
                data.type === "custom-measure"
            ) {
                const points = fc.features.filter(
                    (f) => f.geometry.type === "Point",
                );
                data.geo = {
                    type: "FeatureCollection",
                    features: points,
                };
                questionModified();
            }
        };
        map.on("draw.create", onFeatureChange);
        map.on("draw.update", onFeatureChange);
        map.on("draw.delete", onFeatureChange);

        return () => {
            map.off("draw.create", onFeatureChange);
            map.off("draw.update", onFeatureChange);
            map.off("draw.delete", onFeatureChange);
            try {
                map.removeControl(draw as unknown as maplibregl.IControl);
            } catch {
                /* control was already torn down (e.g. map
                   restyled) — ignore */
            }
        };
    }, [$drawingQuestionKey]);

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
                /* Required so map.getCanvas().toDataURL() works
                   for the Save-image action (otherwise the WebGL
                   buffer is cleared before we can read it). */
                preserveDrawingBuffer
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

                {/* Hiding-zones overlay — mirrored from
                    ZoneSidebar's showGeoJSON via the
                    hidingZonesGeoJSON atom. Renders the same
                    red-dashed polygon outline + low-opacity
                    fill that the Leaflet path uses, plus
                    circle markers for any Point features
                    (stations) so both styles surface on
                    MapV2. */}
                {$hidingZones && $hidingZones.features.length > 0 && (
                    <Source
                        id="hiding-zones"
                        type="geojson"
                        data={$hidingZones}
                    >
                        <Layer
                            id="hiding-zones-fill"
                            type="fill"
                            filter={[
                                "any",
                                ["==", ["geometry-type"], "Polygon"],
                                ["==", ["geometry-type"], "MultiPolygon"],
                            ]}
                            paint={{
                                "fill-color": "hsl(2, 70%, 54%)",
                                "fill-opacity": 0.12,
                            }}
                        />
                        <Layer
                            id="hiding-zones-line"
                            type="line"
                            filter={[
                                "any",
                                ["==", ["geometry-type"], "Polygon"],
                                ["==", ["geometry-type"], "MultiPolygon"],
                                ["==", ["geometry-type"], "LineString"],
                                ["==", ["geometry-type"], "MultiLineString"],
                            ]}
                            paint={{
                                "line-color": "hsl(2, 70%, 54%)",
                                "line-width": 2,
                                "line-opacity": 0.9,
                                "line-dasharray": [6, 5],
                            }}
                        />
                        <Layer
                            id="hiding-zones-points"
                            type="circle"
                            filter={["==", ["geometry-type"], "Point"]}
                            paint={{
                                "circle-radius": 5,
                                "circle-color": "hsl(2, 70%, 54%)",
                                "circle-stroke-color": "white",
                                "circle-stroke-width": 1.5,
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

                {/* Radar sweep — rotating wedge over each
                    pending radius. The Source starts with an
                    empty FeatureCollection; the
                    requestAnimationFrame loop above writes the
                    current rotation directly via
                    getSource().setData(), so this Source
                    declaration is just there to set up the
                    rendering pipeline. Mounted before the
                    static fill so the sweep paints UNDER the
                    circle stroke. */}
                {radarTargets.length > 0 && (
                    <Source
                        id="radar-sweep"
                        type="geojson"
                        data={{ type: "FeatureCollection", features: [] }}
                    >
                        <Layer
                            id="radar-sweep-fill"
                            type="fill"
                            paint={{
                                "fill-color":
                                    CATEGORIES.radius?.color ??
                                    "#f5a888",
                                "fill-opacity": 0.25,
                            }}
                        />
                    </Source>
                )}

                {/* Pending-radius circles — outline + light
                    fill that sits over the rotating sweep so
                    the seeker reads the radius as a clearly
                    bounded zone. */}
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
