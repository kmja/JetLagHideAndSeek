import "maplibre-gl/dist/maplibre-gl.css";

import { useStore } from "@nanostores/react";
import {
    bbox as turfBbox,
    bearing as turfBearing,
    circle as turfCircle,
    destination as turfDestination,
    point as turfPoint,
} from "@turf/turf";
import { useEffect, useMemo, useRef, useState } from "react";
import MapGL, {
    Layer,
    type MapRef,
    Marker,
    type MarkerDragEvent,
    Source,
} from "react-map-gl/maplibre";

import { baseTileLayer, polyGeoJSON, thunderforestApiKey } from "@/lib/context";
import { satelliteView } from "@/lib/gameSetup";
import { buildStyle } from "@/lib/mapStyle";
import { PLAY_AREA_COLOR } from "@/lib/playAreaStyle";
import { installMissingImageHandler } from "@/lib/protomapsStyle";
import { resolvedTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

/**
 * v1005/v1007: thermometer configure preview.
 *
 * A thermometer's answer is DIRECTIONAL: the seeker walks the chosen distance D
 * in some direction, then the hider says "hotter" (closer) or "colder"
 * (further). Geometrically that splits the map along the perpendicular BISECTOR
 * of [start, end] — a line D/2 from the start, perpendicular to travel. So the
 * preview draws an ARROW from the start (length = the chosen distance) whose
 * tip is a DRAG HANDLE — drag it around to aim your travel direction — plus the
 * D/2 cut and the two half-planes tinted WARM (hotter) / COOL (colder). The map
 * pans/zooms normally; only the handle changes the aim (the distance is fixed by
 * the carousel, so the handle orbits at radius D). Direction defaults toward the
 * play-area centre; it's a planning aid, not saved on the question.
 */
export function ThermometerPreviewMap({
    lat,
    lng,
    radiusMeters,
    className,
}: {
    lat: number;
    lng: number;
    radiusMeters: number;
    className?: string;
}) {
    const $theme = useStore(resolvedTheme);
    const $tileKey = useStore(baseTileLayer);
    const $satellite = useStore(satelliteView);
    const $tfKey = useStore(thunderforestApiKey);
    const $poly = useStore(polyGeoJSON);
    const dark = $theme === "dark";
    const mapRef = useRef<MapRef | null>(null);
    const km = radiusMeters / 1000;

    // Default travel direction: toward the play-area centre (a sensible guess
    // for where the hider is), else north. The seeker drags the handle to aim.
    const defaultBearing = useMemo(() => {
        try {
            if (!$poly) return 0;
            const bb = turfBbox($poly);
            const center: [number, number] = [
                (bb[0] + bb[2]) / 2,
                (bb[1] + bb[3]) / 2,
            ];
            return turfBearing(turfPoint([lng, lat]), turfPoint(center));
        } catch {
            return 0;
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [$poly, lat, lng]);
    const [bearing, setBearing] = useState<number>(defaultBearing);
    const aimed = useRef(false);
    useEffect(() => {
        if (!aimed.current) setBearing(defaultBearing);
    }, [defaultBearing]);

    // The arrow tip (drag handle) — always at distance D, only the angle moves.
    const tip = useMemo(() => {
        try {
            return turfDestination(turfPoint([lng, lat]), km, bearing, {
                units: "kilometers",
            }).geometry.coordinates as [number, number];
        } catch {
            return [lng, lat] as [number, number];
        }
    }, [lat, lng, km, bearing]);

    // Bisector cut + the two tinted half-planes for the current bearing.
    const { cutLine, hotterHalf, colderHalf, arrow, hotterAt, colderAt } =
        useMemo(() => {
            try {
                const start = turfPoint([lng, lat]);
                const mid = turfDestination(start, km / 2, bearing, {
                    units: "kilometers",
                });
                const L = km * 20;
                const left = turfDestination(mid, L, bearing - 90, {
                    units: "kilometers",
                });
                const right = turfDestination(mid, L, bearing + 90, {
                    units: "kilometers",
                });
                const lc = left.geometry.coordinates;
                const rc = right.geometry.coordinates;
                const depth = km * 40;
                const hL = turfDestination(left, depth, bearing, {
                    units: "kilometers",
                }).geometry.coordinates;
                const hR = turfDestination(right, depth, bearing, {
                    units: "kilometers",
                }).geometry.coordinates;
                const cL = turfDestination(left, depth, bearing + 180, {
                    units: "kilometers",
                }).geometry.coordinates;
                const cR = turfDestination(right, depth, bearing + 180, {
                    units: "kilometers",
                }).geometry.coordinates;
                return {
                    cutLine: {
                        type: "Feature" as const,
                        properties: {},
                        geometry: {
                            type: "LineString" as const,
                            coordinates: [lc, rc],
                        },
                    },
                    hotterHalf: {
                        type: "Feature" as const,
                        properties: {},
                        geometry: {
                            type: "Polygon" as const,
                            coordinates: [[lc, hL, hR, rc, lc]],
                        },
                    },
                    colderHalf: {
                        type: "Feature" as const,
                        properties: {},
                        geometry: {
                            type: "Polygon" as const,
                            coordinates: [[lc, cL, cR, rc, lc]],
                        },
                    },
                    arrow: {
                        type: "Feature" as const,
                        properties: {},
                        geometry: {
                            type: "LineString" as const,
                            coordinates: [[lng, lat], tip],
                        },
                    },
                    hotterAt: turfDestination(start, km * 0.62, bearing, {
                        units: "kilometers",
                    }).geometry.coordinates as [number, number],
                    colderAt: turfDestination(start, km * 0.62, bearing + 180, {
                        units: "kilometers",
                    }).geometry.coordinates as [number, number],
                };
            } catch {
                return {
                    cutLine: null,
                    hotterHalf: null,
                    colderHalf: null,
                    arrow: null,
                    hotterAt: null,
                    colderAt: null,
                };
            }
        }, [lat, lng, km, bearing, tip]);

    const dot = useMemo(() => turfPoint([lng, lat]), [lat, lng]);
    const mapStyle = useMemo(
        () =>
            buildStyle(
                $tileKey,
                $satellite,
                $tfKey ?? "",
                dark ? "dark" : "light",
            ),
        [$tileKey, $satellite, $tfKey, dark],
    );

    const fit = (animate: boolean) => {
        const map = mapRef.current?.getMap();
        if (!map) return;
        try {
            // Frame a circle of radius D around the start so the whole arrow
            // fits at any aim (don't render the circle — the arrow shows D).
            const frame = turfCircle([lng, lat], km, {
                units: "kilometers",
                steps: 16,
            });
            const bb = turfBbox(frame) as [number, number, number, number];
            map.fitBounds(
                [
                    [bb[0], bb[1]],
                    [bb[2], bb[3]],
                ],
                { padding: 40, animate, duration: animate ? 500 : 0 },
            );
        } catch {
            /* degenerate */
        }
    };

    // Reframe (animated) whenever the distance changes so the arrow always fits.
    useEffect(() => {
        fit(true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [km, lat, lng]);

    const onHandleDrag = (e: MarkerDragEvent) => {
        try {
            const b = turfBearing(
                turfPoint([lng, lat]),
                turfPoint([e.lngLat.lng, e.lngLat.lat]),
            );
            aimed.current = true;
            setBearing(b);
        } catch {
            /* ignore */
        }
    };

    const WARM = "#f97316"; // orange-500
    const COOL = "#38bdf8"; // sky-400

    return (
        <div
            className={cn(
                "relative overflow-hidden rounded-lg border",
                className,
            )}
        >
            <MapGL
                ref={mapRef}
                initialViewState={{ longitude: lng, latitude: lat, zoom: 12 }}
                mapStyle={mapStyle}
                attributionControl={false}
                dragRotate={false}
                touchPitch={false}
                onLoad={(e) => {
                    installMissingImageHandler(e.target);
                    fit(false);
                }}
                style={{ width: "100%", height: "100%" }}
            >
                {colderHalf && (
                    <Source
                        id="thermo-colder-src"
                        type="geojson"
                        data={colderHalf}
                    >
                        <Layer
                            id="thermo-colder-fill"
                            type="fill"
                            paint={{ "fill-color": COOL, "fill-opacity": 0.22 }}
                        />
                    </Source>
                )}
                {hotterHalf && (
                    <Source
                        id="thermo-hotter-src"
                        type="geojson"
                        data={hotterHalf}
                    >
                        <Layer
                            id="thermo-hotter-fill"
                            type="fill"
                            paint={{ "fill-color": WARM, "fill-opacity": 0.28 }}
                        />
                    </Source>
                )}
                {cutLine && (
                    <Source id="thermo-cut-src" type="geojson" data={cutLine}>
                        <Layer
                            id="thermo-cut-line"
                            type="line"
                            paint={{
                                "line-color": dark ? "#ffffff" : "#0f172a",
                                "line-width": 2,
                                "line-dasharray": [2, 2],
                            }}
                        />
                    </Source>
                )}
                {arrow && (
                    <Source id="thermo-arrow-src" type="geojson" data={arrow}>
                        <Layer
                            id="thermo-arrow-line"
                            type="line"
                            layout={{ "line-cap": "round" }}
                            paint={{ "line-color": WARM, "line-width": 4 }}
                        />
                    </Source>
                )}
                <Source id="thermo-dot-src" type="geojson" data={dot}>
                    <Layer
                        id="thermo-dot"
                        type="circle"
                        paint={{
                            "circle-radius": 5,
                            "circle-color": PLAY_AREA_COLOR,
                            "circle-stroke-color": "#ffffff",
                            "circle-stroke-width": 2,
                        }}
                    />
                </Source>
                {hotterAt && (
                    <Marker
                        longitude={hotterAt[0]}
                        latitude={hotterAt[1]}
                        anchor="center"
                    >
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-poppins font-bold uppercase tracking-wide text-white bg-[#ea580c] shadow">
                            Hotter
                        </span>
                    </Marker>
                )}
                {colderAt && (
                    <Marker
                        longitude={colderAt[0]}
                        latitude={colderAt[1]}
                        anchor="center"
                    >
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-poppins font-bold uppercase tracking-wide text-white bg-[#0284c7] shadow">
                            Colder
                        </span>
                    </Marker>
                )}
                {/* Draggable arrow-head handle at the tip. Rotates to the aim;
                    drag it around the start to change direction. */}
                <Marker
                    longitude={tip[0]}
                    latitude={tip[1]}
                    anchor="center"
                    rotationAlignment="map"
                    rotation={bearing}
                    draggable
                    onDrag={onHandleDrag}
                >
                    <div className="flex items-center justify-center w-9 h-9 rounded-full bg-[#ea580c] border-2 border-white shadow-lg cursor-grab active:cursor-grabbing touch-none">
                        {/* Arrow points "up" (north) by default; the Marker's
                            rotation aims it along the travel bearing. */}
                        <svg
                            width="18"
                            height="18"
                            viewBox="0 0 24 24"
                            fill="none"
                            aria-hidden="true"
                        >
                            <path
                                d="M12 4 L12 20 M12 4 L6 11 M12 4 L18 11"
                                stroke="#ffffff"
                                strokeWidth="2.6"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            />
                        </svg>
                    </div>
                </Marker>
            </MapGL>
            <div className="pointer-events-none absolute bottom-1.5 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-full bg-black/55 text-white text-[10px] font-medium">
                Drag the arrow to aim your travel direction
            </div>
        </div>
    );
}

export default ThermometerPreviewMap;
