import "leaflet/dist/leaflet.css";
import "leaflet-contextmenu/dist/leaflet.contextmenu.css";
import "leaflet-contextmenu";

import { useStore } from "@nanostores/react";
import * as turf from "@turf/turf";
import * as L from "leaflet";
import { useEffect, useMemo, useState } from "react";
import { MapContainer, ScaleControl, TileLayer } from "react-leaflet";
import { toast } from "react-toastify";

import {
    additionalMapGeoLocations,
    animateMapMovements,
    autoZoom,
    baseTileLayer,
    followMe,
    hiderMode,
    isLoading,
    leafletMapContext,
    mapGeoJSON,
    mapGeoLocation,
    permanentOverlay,
    planningModeEnabled,
    polyGeoJSON,
    questionFinishedMapData,
    questions,
    thunderforestApiKey,
    triggerLocalRefresh,
} from "@/lib/context";
import { seekerAddQuestion as addQuestion } from "@/lib/multiplayer/store";
import { CATEGORIES, type CategoryId } from "@/lib/categories";
import { satelliteView, showTransitLines } from "@/lib/gameSetup";
import { cn } from "@/lib/utils";
import { applyQuestionsToMapGeoData, holedMask } from "@/maps";
import { hiderifyQuestion } from "@/maps";
import { clearCache, determineMapBoundaries } from "@/maps/api";

import { DraggableMarkers } from "./DraggableMarkers";
import { LeafletFullScreenButton } from "./LeafletFullScreenButton";
import { MapPrint } from "./MapPrint";
import { PolygonDraw } from "./PolygonDraw";

const getTileLayer = (tileLayer: string, thunderforestApiKey: string) => {
    switch (tileLayer) {
        case "light":
            return (
                <TileLayer
                    attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors; &copy; <a href="https://carto.com/attributions">CARTO</a>; Powered by Esri and Turf.js'
                    url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
                    subdomains="abcd"
                    maxZoom={20} // This technically should be 6, but once the ratelimiting starts this can take over
                    minZoom={2}
                    noWrap
                />
            );

        case "dark":
            return (
                <TileLayer
                    attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors; &copy; <a href="https://carto.com/attributions">CARTO</a>; Powered by Esri and Turf.js'
                    url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
                    subdomains="abcd"
                    maxZoom={20} // This technically should be 6, but once the ratelimiting starts this can take over
                    minZoom={2}
                    noWrap
                />
            );

        case "transport":
            if (thunderforestApiKey)
                return (
                    <TileLayer
                        url={`https://tile.thunderforest.com/transport/{z}/{x}/{y}.png?apikey=${thunderforestApiKey}`}
                        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors; &copy; <a href="http://www.thunderforest.com/">Thunderforest</a>; Powered by Esri and Turf.js'
                        maxZoom={22}
                        minZoom={2}
                        noWrap
                    />
                );
            break;

        case "neighbourhood":
            if (thunderforestApiKey)
                return (
                    <TileLayer
                        url={`https://tile.thunderforest.com/neighbourhood/{z}/{x}/{y}.png?apikey=${thunderforestApiKey}`}
                        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors; &copy; <a href="http://www.thunderforest.com/">Thunderforest</a>; Powered by Esri and Turf.js'
                        maxZoom={22}
                        minZoom={2}
                        noWrap
                    />
                );
            break;

        case "osmcarto":
            return (
                <TileLayer
                    attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors; Powered by Esri and Turf.js'
                    url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
                    maxZoom={19}
                    minZoom={2}
                    noWrap
                />
            );
    }

    return (
        <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors; &copy; <a href="https://carto.com/attributions">CARTO</a>; Powered by Esri and Turf.js'
            url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"
            subdomains="abcd"
            maxZoom={20} // This technically should be 6, but once the ratelimiting starts this can take over
            minZoom={2}
            noWrap
        />
    );
};

export const Map = ({ className }: { className?: string }) => {
    useStore(additionalMapGeoLocations);
    const $mapGeoLocation = useStore(mapGeoLocation);
    const $questions = useStore(questions);
    const $baseTileLayer = useStore(baseTileLayer);
    const $satelliteView = useStore(satelliteView);
    const $showTransitLines = useStore(showTransitLines);
    const $thunderforestApiKey = useStore(thunderforestApiKey);
    const $hiderMode = useStore(hiderMode);
    const $isLoading = useStore(isLoading);
    const $followMe = useStore(followMe);
    const $permanentOverlay = useStore(permanentOverlay);
    const $mapGeoJSON = useStore(mapGeoJSON);
    const $polyGeoJSON = useStore(polyGeoJSON);
    const map = useStore(leafletMapContext);

    // Custom Leaflet panes:
    //
    //   • `eliminationMask` (z-index 230) — the dim "outside the
    //     play area + eliminated zones" polygon. Sits between the
    //     basemap and the transit overlays so it darkens the basemap
    //     without dimming the transit lines on top of it.
    //
    //   • `transit` (z-index 250) — rail tiles + bus/ferry/subway
    //     polylines. Above the elimination mask so transit stays
    //     fully visible across the entire *original* play area
    //     regardless of how many questions have narrowed the
    //     effective playable region. Below overlayPane (400) so
    //     planning polygons, the radar-sweep overlay, and markers
    //     stay on top.
    //
    // Both panes are created once per map instance.
    const [transitPaneReady, setTransitPaneReady] = useState(false);
    useEffect(() => {
        if (!map) return;
        if (!map.getPane("eliminationMask")) {
            const pane = map.createPane("eliminationMask");
            pane.style.zIndex = "230";
            pane.style.pointerEvents = "none";
        }
        if (!map.getPane("transit")) {
            const pane = map.createPane("transit");
            pane.style.zIndex = "250";
            pane.style.pointerEvents = "none";
        }
        setTransitPaneReady(true);
    }, [map]);

    // Maintain a CSS `clip-path` on the transit pane that follows the
    // play-area polygon as the map pans / zooms. Updates on every
    // `move`/`zoom` event so the clip stays pixel-accurate.
    useEffect(() => {
        if (!map) return;
        const pane = map.getPane("transit");
        if (!pane) return;

        const poly = $polyGeoJSON ?? $mapGeoJSON;
        if (!poly) {
            pane.style.clipPath = "";
            return;
        }

        // Walk the polygon (or first polygon of a MultiPolygon) and
        // project its outer ring to container pixels. We deliberately
        // ignore holes — game play areas don't have meaningful holes
        // for which we'd want to *show* outside content.
        const extractOuterRing = (): Array<[number, number]> | null => {
            const features = (poly as any).features ?? [poly];
            for (const f of features) {
                const g = f?.geometry ?? f;
                if (!g) continue;
                if (g.type === "Polygon") return g.coordinates[0];
                if (g.type === "MultiPolygon") return g.coordinates[0]?.[0];
            }
            return null;
        };

        const updateClipPath = () => {
            const ring = extractOuterRing();
            if (!ring || ring.length < 3) {
                pane.style.clipPath = "";
                return;
            }
            // Simplify aggressively — a 100-vertex clip-path is plenty
            // for visual accuracy, and avoids the perf hit of a
            // 5000-vertex polygon on every map move.
            const stride = Math.max(1, Math.floor(ring.length / 200));
            const pts: string[] = [];
            for (let i = 0; i < ring.length; i += stride) {
                const [lng, lat] = ring[i];
                const p = map.latLngToContainerPoint([lat, lng]);
                pts.push(`${p.x.toFixed(0)}px ${p.y.toFixed(0)}px`);
            }
            pane.style.clipPath = `polygon(${pts.join(",")})`;
        };

        updateClipPath();
        map.on("move zoom moveend zoomend", updateClipPath);
        return () => {
            map.off("move zoom moveend zoomend", updateClipPath);
        };
    }, [map, $polyGeoJSON, $mapGeoJSON, transitPaneReady]);

    const followMeMarkerRef = useMemo(
        () => ({ current: null as L.Marker | null }),
        [],
    );
    const geoWatchIdRef = useMemo(
        () => ({ current: null as number | null }),
        [],
    );

    const refreshQuestions = async (focus: boolean = false) => {
        if (!map) return;

        // Read fresh — closure-captured $isLoading can be stale if state
        // changed between renders and effects.
        if (isLoading.get()) return;

        isLoading.set(true);

        if ($questions.length === 0) {
            await clearCache();
        }

        let mapGeoData = mapGeoJSON.get();

        // If we're about to fetch a new boundary, drop any previously-drawn
        // elimination layer first. Otherwise a failed fetch (e.g. Overpass
        // 504/timeout) leaves the old play area's `world − previousArea`
        // mask on the map — and from a new viewport (Tokyo vs. Copenhagen)
        // every pixel falls inside that polygon, so the whole world looks
        // darkened with no play area visible.
        if (!mapGeoData) {
            map.eachLayer((layer: any) => {
                if (layer.eliminationGeoJSON) {
                    map.removeLayer(layer);
                }
            });

            const polyGeoData = polyGeoJSON.get();
            if (polyGeoData) {
                mapGeoData = polyGeoData;
                mapGeoJSON.set(polyGeoData);
            } else {
                await toast.promise(
                    determineMapBoundaries()
                        .then((x) => {
                            mapGeoJSON.set(x);
                            mapGeoData = x;
                        })
                        .catch((error) => console.log(error)),
                    {
                        error: "Error refreshing map data",
                    },
                );
            }
        }

        if ($hiderMode !== false) {
            for (const question of $questions) {
                await hiderifyQuestion(question);
            }

            triggerLocalRefresh.set(Math.random()); // Refresh the question sidebar with new information but not this map
        }

        map.eachLayer((layer: any) => {
            if (layer.questionKey || layer.questionKey === 0) {
                map.removeLayer(layer);
            }
        });

        try {
            mapGeoData = await applyQuestionsToMapGeoData(
                $questions,
                mapGeoData,
                planningModeEnabled.get(),
                (geoJSONObj, question) => {
                    // Radar gets its own visual treatment via
                    // RadarScanOverlay (rotating sweep + perimeter trail
                    // that traces the circle's edge). Skip drawing the
                    // generic dashed outline here so the two don't fight.
                    if (question.id === "radius") return;

                    // Other categories: provisional "this question
                    // hasn't been answered yet" styling — dashed line
                    // + low fill, painted in the question's category
                    // color (tentacles purple, matching grey, etc.).
                    // Distinct from Leaflet's default solid blue so the
                    // seeker reads it as "still pending, not committed."
                    const catMeta =
                        CATEGORIES[question.id as CategoryId] ??
                        CATEGORIES.matching;
                    const geoJSONPlane = L.geoJSON(geoJSONObj, {
                        style: {
                            color: catMeta.color,
                            weight: 2,
                            opacity: 0.85,
                            dashArray: "6 5",
                            fillColor: catMeta.color,
                            fillOpacity: 0.08,
                        },
                    });
                    // @ts-expect-error This is a check such that only this type of layer is removed
                    geoJSONPlane.questionKey = question.key;
                    geoJSONPlane.addTo(map);
                },
            );

            mapGeoData = {
                type: "FeatureCollection",
                features: [holedMask(mapGeoData!)!],
            };

            map.eachLayer((layer: any) => {
                if (layer.eliminationGeoJSON) {
                    // Hopefully only geoJSON layers
                    map.removeLayer(layer);
                }
            });

            // The elimination layer is the union of "outside the play area"
            // and "eliminated by questions". Render it as a clearly dimmed
            // dark overlay so the in-play area pops on light basemaps —
            // Leaflet's default #3388ff @ 0.2 is invisible on cartodb voyager.
            //
            // Rendered into the `eliminationMask` pane (z-index 230) so it
            // sits *below* the transit overlays (z-index 250). That way
            // transit lines stay at full brightness even over
            // question-eliminated zones — the mask only darkens the
            // basemap underneath, not the transit content above.
            const g = L.geoJSON(mapGeoData, {
                style: {
                    color: "#0f172a",
                    weight: 1,
                    opacity: 0.55,
                    fillColor: "#0f172a",
                    fillOpacity: 0.45,
                },
                pane: "eliminationMask",
            });
            // @ts-expect-error This is a check such that only this type of layer is removed
            g.eliminationGeoJSON = true;
            g.addTo(map);

            questionFinishedMapData.set(mapGeoData);

            if (autoZoom.get() && focus) {
                const bbox = turf.bbox(holedMask(mapGeoData) as any);
                const bounds = [
                    [bbox[1], bbox[0]],
                    [bbox[3], bbox[2]],
                ];

                if (animateMapMovements.get()) {
                    map.flyToBounds(bounds as any);
                } else {
                    map.fitBounds(bounds as any);
                }
            }
        } catch (error) {
            console.log(error);

            isLoading.set(false);
            if (document.querySelectorAll(".Toastify__toast").length === 0) {
                return toast.error("No solutions found / error occurred");
            }
        } finally {
            isLoading.set(false);
        }
    };

    const displayMap = useMemo(
        () => (
            <MapContainer
                center={$mapGeoLocation.geometry.coordinates}
                zoom={5}
                className={cn("w-[500px] h-[500px]", className)}
                ref={leafletMapContext.set}
                // @ts-expect-error Typing doesn't update from react-contextmenu
                contextmenu={true}
                contextmenuWidth={140}
                contextmenuItems={[
                    {
                        text: "Add Radius",
                        callback: (e: any) =>
                            addQuestion({
                                id: "radius",
                                data: {
                                    lat: e.latlng.lat,
                                    lng: e.latlng.lng,
                                },
                            }),
                    },
                    {
                        text: "Add Thermometer",
                        callback: (e: any) => {
                            const destination = turf.destination(
                                [e.latlng.lng, e.latlng.lat],
                                5,
                                90,
                                {
                                    units: "miles",
                                },
                            );

                            addQuestion({
                                id: "thermometer",
                                data: {
                                    latA: e.latlng.lat,
                                    lngA: e.latlng.lng,
                                    latB: destination.geometry.coordinates[1],
                                    lngB: destination.geometry.coordinates[0],
                                },
                            });
                        },
                    },
                    {
                        text: "Add Tentacles",
                        callback: (e: any) => {
                            addQuestion({
                                id: "tentacles",
                                data: {
                                    lat: e.latlng.lat,
                                    lng: e.latlng.lng,
                                },
                            });
                        },
                    },
                    {
                        text: "Add Matching",
                        callback: (e: any) => {
                            addQuestion({
                                id: "matching",
                                data: {
                                    lat: e.latlng.lat,
                                    lng: e.latlng.lng,
                                },
                            });
                        },
                    },
                    {
                        text: "Add Measuring",
                        callback: (e: any) => {
                            addQuestion({
                                id: "measuring",
                                data: {
                                    lat: e.latlng.lat,
                                    lng: e.latlng.lng,
                                },
                            });
                        },
                    },
                    {
                        text: "Exclude Country",
                        callback: (e: any) => {
                            addQuestion({
                                id: "matching",
                                data: {
                                    lat: e.latlng.lat,
                                    lng: e.latlng.lng,
                                    same: false,
                                    cat: {
                                        adminLevel: 2,
                                    },
                                    type: "zone",
                                },
                            });
                        },
                    },
                    {
                        text: "Copy Coordinates",
                        callback: (e: any) => {
                            if (!navigator || !navigator.clipboard) {
                                toast.error(
                                    "Clipboard API not supported in your browser",
                                );
                                return;
                            }

                            const latitude = e.latlng.lat;
                            const longitude = e.latlng.lng;

                            toast.promise(
                                navigator.clipboard.writeText(
                                    `${Math.abs(latitude)}°${latitude > 0 ? "N" : "S"}, ${Math.abs(
                                        longitude,
                                    )}°${longitude > 0 ? "E" : "W"}`,
                                ),
                                {
                                    pending: "Writing to clipboard...",
                                    success: "Coordinates copied!",
                                    error: "An error occurred while copying",
                                },
                                { autoClose: 1000 },
                            );
                        },
                    },
                ]}
            >
                {getTileLayer($baseTileLayer, $thunderforestApiKey)}
                {$satelliteView && (
                    /* Esri World Imagery — free, no API key. Renders on top
                       of the base layer; we set high opacity so it fully
                       covers and reads as the active style. */
                    <TileLayer
                        attribution='Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community'
                        url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
                        maxZoom={19}
                    />
                )}
                {$showTransitLines && transitPaneReady && (
                    /* OpenRailwayMap — semi-transparent overlay showing
                       train/metro/tram lines. Rendered into the custom
                       `transit` pane so its tiles get clipped to the
                       play-area polygon via CSS clip-path. The bare
                       `tiles.openrailwaymap.org` host was flaky for
                       large play areas (often 404'd or never resolved)
                       — the subdomain-rotated `{s}.tiles…` form is
                       what the OpenRailwayMap wiki documents as
                       canonical, and gives us parallel HTTP/2
                       streams. The `bounds` restriction is gone too:
                       it was suppressing tile loads when the polygon
                       loaded after the user toggled the layer (e.g.
                       picking a country and immediately enabling
                       transit while Overpass was still fetching the
                       boundary). */
                    <TileLayer
                        attribution='&copy; <a href="https://www.openrailwaymap.org/">OpenRailwayMap</a>'
                        url="https://{s}.tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png"
                        subdomains={["a", "b", "c"]}
                        maxZoom={19}
                        opacity={0.85}
                        pane="transit"
                    />
                )}
                <DraggableMarkers />
                <div className="leaflet-top leaflet-right">
                    <div className="leaflet-control flex-col flex gap-2">
                        <LeafletFullScreenButton />
                    </div>
                </div>
                <PolygonDraw />
                <ScaleControl position="bottomleft" />
                <MapPrint
                    position="topright"
                    sizeModes={["Current", "A4Portrait", "A4Landscape"]}
                    hideControlContainer={false}
                    hideClasses={[
                        "leaflet-full-screen-specific-name",
                        "leaflet-top",
                        "leaflet-control-easyPrint",
                        "leaflet-draw",
                    ]}
                    title="Print"
                />
            </MapContainer>
        ),
        [map, $baseTileLayer, $thunderforestApiKey, $satelliteView, $showTransitLines],
    );

    useEffect(() => {
        if (!map) return;

        refreshQuestions(true);
    }, [$questions, $mapGeoLocation, map, $hiderMode]);

    // Defensive layer-cleanup watchdog. Used to run at 1 Hz forever
    // — kept the CPU alive in the background even when the user
    // wasn't looking. 5 s is well within the user-visible window for
    // recovering from an occasional duplicate-layer race, and we
    // pause entirely while the tab is hidden so the battery cost is
    // zero when the screen is off.
    useEffect(() => {
        if (!map) return;
        let intervalId: number | null = null;
        const tick = () => {
            if (!map) return;
            let layerCount = 0;
            map.eachLayer((layer: any) => {
                if (layer.eliminationGeoJSON) layerCount++;
            });
            if (layerCount > 1) {
                console.log("Too many layers, refreshing...");
                refreshQuestions(false);
            }
        };
        const start = () => {
            if (intervalId !== null) return;
            intervalId = window.setInterval(tick, 5000);
        };
        const stop = () => {
            if (intervalId === null) return;
            window.clearInterval(intervalId);
            intervalId = null;
        };
        const onVisibility = () => {
            if (document.visibilityState === "visible") start();
            else stop();
        };
        onVisibility();
        document.addEventListener("visibilitychange", onVisibility);
        return () => {
            document.removeEventListener("visibilitychange", onVisibility);
            stop();
        };
    }, [map]);

    useEffect(() => {
        const handleFullscreenChange = () => {
            const mainElement: HTMLElement | null =
                document.querySelector("main");

            if (mainElement) {
                if (document.fullscreenElement) {
                    mainElement.classList.add("fullscreen");
                } else {
                    mainElement.classList.remove("fullscreen");
                }
            }
        };

        document.addEventListener("fullscreenchange", handleFullscreenChange);

        return () => {
            document.removeEventListener(
                "fullscreenchange",
                handleFullscreenChange,
            );
        };
    }, []);

    useEffect(() => {
        if (!map) return;
        if (!$followMe) {
            if (followMeMarkerRef.current) {
                map.removeLayer(followMeMarkerRef.current);
                followMeMarkerRef.current = null;
            }
            if (geoWatchIdRef.current !== null) {
                navigator.geolocation.clearWatch(geoWatchIdRef.current);
                geoWatchIdRef.current = null;
            }
            return;
        }

        geoWatchIdRef.current = navigator.geolocation.watchPosition(
            (pos) => {
                const lat = pos.coords.latitude;
                const lng = pos.coords.longitude;
                if (followMeMarkerRef.current) {
                    followMeMarkerRef.current.setLatLng([lat, lng]);
                } else {
                    const marker = L.marker([lat, lng], {
                        icon: L.divIcon({
                            html: `<div class="text-blue-700 bg-white rounded-full border-2 border-blue-700 shadow w-5 h-5 flex items-center justify-center"><svg width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="#2A81CB" opacity="0.5"/><circle cx="8" cy="8" r="3" fill="#2A81CB"/></svg></div>`,
                            className: "",
                        }),
                        zIndexOffset: 1000,
                    });
                    marker.addTo(map);
                    followMeMarkerRef.current = marker;
                }
            },
            () => {
                toast.error("Unable to access your location.");
                followMe.set(false);
            },
            { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 },
        );
        return () => {
            if (followMeMarkerRef.current) {
                map.removeLayer(followMeMarkerRef.current);
                followMeMarkerRef.current = null;
            }
            if (geoWatchIdRef.current !== null) {
                navigator.geolocation.clearWatch(geoWatchIdRef.current);
                geoWatchIdRef.current = null;
            }
        };
    }, [$followMe, map]);

    useEffect(() => {
        if (!map) return;

        map.eachLayer((layer: any) => {
            if (layer.permanentGeoJSON) map.removeLayer(layer);
        });

        if ($permanentOverlay === null) return;

        try {
            const overlay = L.geoJSON($permanentOverlay, {
                interactive: false,

                // @ts-expect-error Type hints force a Layer to be returned, but Leaflet accepts null as well
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                pointToLayer(geoJsonPoint, latlng) {
                    return null;
                },

                style(feature) {
                    return {
                        color: feature?.properties?.stroke,
                        weight: feature?.properties?.["stroke-width"],
                        opacity: feature?.properties?.["stroke-opacity"],
                        fillColor: feature?.properties?.fill,
                        fillOpacity: feature?.properties?.["fill-opacity"],
                    };
                },
            });
            // @ts-expect-error This is a check such that only this type of layer is removed
            overlay.permanentGeoJSON = true;
            overlay.addTo(map);
            overlay.bringToBack();
        } catch (e) {
            toast.error(`Failed to display GeoJSON overlay: ${e}`);
        }
    }, [$permanentOverlay, map]);

    return displayMap;
};
