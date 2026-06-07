import "maplibre-gl/dist/maplibre-gl.css";

import { circle, distance, point } from "@turf/turf";
import { useEffect, useMemo, useRef, useState } from "react";
import Map, {
    Layer,
    type MapRef,
    Marker,
    Source,
} from "react-map-gl/maplibre";

import { buildMarkerHtml, type CategoryId } from "@/lib/categories";
import type { Question } from "@/maps/schema";

/**
 * Hider-facing map. Single-purpose, intentionally separate from the
 * main app's Map.tsx/MapV2.tsx (which assume the seeker context,
 * sidebars, hider mode toggles, etc.).
 *
 * MapLibre GL port of the previous Leaflet-based HiderMap. Public
 * API (HiderMap component + distanceKm export) is unchanged.
 *
 * Renders:
 *   - The question's geometry (radius circle, thermometer line, point)
 *   - The hider's live location, via watchPosition
 *   - Auto-fit bounds to show everything at once
 */
export function HiderMap({
    question,
    overridePos,
    onHiderLocationChange,
    onGeoError,
}: {
    question: Question;
    /** When supplied, used as the hider position instead of GPS. */
    overridePos?: { lat: number; lng: number } | null;
    onHiderLocationChange?: (lat: number, lng: number, accuracy: number) => void;
    onGeoError?: (message: string) => void;
}) {
    const mapRef = useRef<MapRef | null>(null);
    const [gpsPos, setGpsPos] = useState<{
        lat: number;
        lng: number;
        accuracy: number;
    } | null>(null);
    const [geoError, setGeoError] = useState<string | null>(null);

    // Watch position throughout the hider's session so the dot follows
    // them. If `overridePos` is supplied we still kick off the watch in
    // case the user later switches back to GPS, but the displayed pin
    // prefers override.
    useEffect(() => {
        if (typeof navigator === "undefined" || !navigator.geolocation) {
            const msg = "Geolocation not supported";
            setGeoError(msg);
            onGeoError?.(msg);
            return;
        }
        const watchId = navigator.geolocation.watchPosition(
            (pos) => {
                const next = {
                    lat: pos.coords.latitude,
                    lng: pos.coords.longitude,
                    accuracy: pos.coords.accuracy,
                };
                setGpsPos(next);
                setGeoError(null);
                if (!overridePos) {
                    onHiderLocationChange?.(next.lat, next.lng, next.accuracy);
                }
            },
            (err) => {
                const msg =
                    err.code === err.PERMISSION_DENIED
                        ? "Location permission denied"
                        : "Could not get your location";
                setGeoError(msg);
                onGeoError?.(msg);
            },
            { enableHighAccuracy: true, maximumAge: 5000 },
        );
        return () => navigator.geolocation.clearWatch(watchId);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Push override into the parent stream so distance calcs use it.
    useEffect(() => {
        if (overridePos) {
            onHiderLocationChange?.(overridePos.lat, overridePos.lng, 0);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [overridePos?.lat, overridePos?.lng]);

    const hiderPos = overridePos
        ? { ...overridePos, accuracy: 0 }
        : gpsPos;

    const initialCenter = useMemo(() => {
        const d = question.data as Record<string, unknown>;
        if (typeof d.lat === "number" && typeof d.lng === "number") {
            return { lat: d.lat, lng: d.lng };
        }
        if (typeof d.latA === "number" && typeof d.lngA === "number") {
            return { lat: d.latA, lng: d.lngA };
        }
        return { lat: 0, lng: 0 };
    }, [question]);

    // Build the GeoJSON for everything that needs to be rendered as
    // a layer (circle fill, polylines). Split into two memos so the
    // question-only pieces (radius circle, thermometer line/arrow,
    // seeker pins) don't recompute on every GPS tick — which was
    // forcing the radius circle's Source/Layer pair to rebuild
    // each watchPosition update, producing a visible flicker on
    // the hider's view even though the polygon was identical. Now
    // only the hider-connection lines (which legitimately follow
    // the hider's pin) re-derive on hiderPos change. Markers are
    // rendered as <Marker> children since react-map-gl handles
    // them outside the GL layer stack.
    const questionGeometry = useMemo(
        () => buildQuestionGeometry(question),
        [question],
    );
    const hiderConnections = useMemo(
        () => buildHiderConnections(question, hiderPos),
        [question, hiderPos],
    );
    const overlay = useMemo<Overlay>(
        () => ({ ...questionGeometry, hiderConnections }),
        [questionGeometry, hiderConnections],
    );

    // Fit the camera to contain question geometry + hider pin whenever
    // any of those move.
    useEffect(() => {
        const map = mapRef.current?.getMap();
        if (!map) return;
        const pts = collectFitPoints(question, hiderPos);
        if (pts.length === 0) return;
        if (pts.length === 1) {
            map.flyTo({ center: pts[0], zoom: 13, duration: 600 });
            return;
        }
        let minLng = Infinity;
        let minLat = Infinity;
        let maxLng = -Infinity;
        let maxLat = -Infinity;
        for (const [lng, lat] of pts) {
            if (lng < minLng) minLng = lng;
            if (lat < minLat) minLat = lat;
            if (lng > maxLng) maxLng = lng;
            if (lat > maxLat) maxLat = lat;
        }
        map.fitBounds(
            [
                [minLng, minLat],
                [maxLng, maxLat],
            ],
            { padding: 40, maxZoom: 15, duration: 600 },
        );
    }, [question, hiderPos]);

    const seekerMarkerHtml = useMemo(
        () => buildMarkerHtml(question.id as CategoryId),
        [question.id],
    );

    return (
        <div className="relative w-full h-[55vh] min-h-[300px] rounded-md overflow-hidden border border-border">
            <Map
                ref={mapRef}
                initialViewState={{
                    longitude: initialCenter.lng,
                    latitude: initialCenter.lat,
                    zoom: 12,
                }}
                style={{ width: "100%", height: "100%" }}
                mapStyle={{
                    version: 8,
                    sources: {
                        carto: {
                            type: "raster",
                            tiles: [
                                "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
                                "https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
                                "https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
                                "https://d.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
                            ],
                            tileSize: 256,
                            attribution:
                                '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
                        },
                    },
                    layers: [
                        {
                            id: "carto-base",
                            type: "raster",
                            source: "carto",
                        },
                    ],
                }}
                attributionControl={false}
                scrollZoom={false}
            >
                {/* Radius fill + outline */}
                {overlay.radiusCircle && (
                    <Source
                        id="hm-radius"
                        type="geojson"
                        data={overlay.radiusCircle}
                    >
                        <Layer
                            id="hm-radius-fill"
                            type="fill"
                            paint={{
                                "fill-color": "#f5a888",
                                "fill-opacity": 0.15,
                            }}
                        />
                        <Layer
                            id="hm-radius-line"
                            type="line"
                            paint={{
                                "line-color": "#f5a888",
                                "line-width": 2,
                            }}
                        />
                    </Source>
                )}

                {/* Thermometer A↔B line */}
                {overlay.thermometerLine && (
                    <Source
                        id="hm-thermometer"
                        type="geojson"
                        data={overlay.thermometerLine}
                    >
                        <Layer
                            id="hm-thermometer-line"
                            type="line"
                            paint={{
                                "line-color": "#f5d268",
                                "line-width": 3,
                                "line-dasharray": [3, 2],
                            }}
                        />
                    </Source>
                )}

                {/* Dashed connection(s) from hider to seeker point(s) */}
                {overlay.hiderConnections && (
                    <Source
                        id="hm-connections"
                        type="geojson"
                        data={overlay.hiderConnections}
                    >
                        <Layer
                            id="hm-connections-line"
                            type="line"
                            paint={{
                                "line-color": "#cbd5e1",
                                "line-width": 2,
                                "line-dasharray": [3, 3],
                                "line-opacity": 0.85,
                            }}
                        />
                    </Source>
                )}

                {/* Seeker pin(s) — category-colored DivIcon-style HTML */}
                {overlay.seekerPins.map((p, i) => (
                    <Marker
                        key={`seeker-${i}`}
                        longitude={p[0]}
                        latitude={p[1]}
                        anchor="bottom"
                    >
                        <div
                            className="jl-marker"
                            style={{ width: 34, height: 46 }}
                            dangerouslySetInnerHTML={{ __html: seekerMarkerHtml }}
                        />
                    </Marker>
                ))}

                {/* Thermometer mid-line directional arrow */}
                {overlay.thermometerArrow && (
                    <Marker
                        longitude={overlay.thermometerArrow.lng}
                        latitude={overlay.thermometerArrow.lat}
                        anchor="center"
                    >
                        <div
                            className="jl-thermometer-arrow"
                            style={{
                                transform: `rotate(${overlay.thermometerArrow.bearing.toFixed(1)}deg)`,
                                width: 20,
                                height: 20,
                            }}
                            dangerouslySetInnerHTML={{
                                __html: thermometerArrowSvg,
                            }}
                        />
                    </Marker>
                )}

                {/* Hider's "you are here" pin */}
                {hiderPos && (
                    <Marker
                        longitude={hiderPos.lng}
                        latitude={hiderPos.lat}
                        anchor="center"
                    >
                        <div
                            className="jl-hider-marker"
                            style={{ width: 22, height: 22 }}
                            dangerouslySetInnerHTML={{ __html: hiderPinSvg }}
                        />
                    </Marker>
                )}
            </Map>

            {geoError && (
                <div className="absolute top-2 left-2 right-2 z-[1100] bg-destructive/90 text-destructive-foreground text-xs px-3 py-2 rounded-md">
                    {geoError}. Showing seeker's point only.
                </div>
            )}
        </div>
    );
}

// Holds every GeoJSON / marker payload the map needs to render for a
// given (question, hiderPos) pair. Lets the rendering JSX stay declarative.
interface Overlay {
    radiusCircle: GeoJSON.Feature<GeoJSON.Polygon> | null;
    thermometerLine: GeoJSON.Feature<GeoJSON.LineString> | null;
    thermometerArrow: { lat: number; lng: number; bearing: number } | null;
    hiderConnections: GeoJSON.FeatureCollection<GeoJSON.LineString> | null;
    seekerPins: [number, number][];
}

/** Question-only geometry — no hider input. Memoised on
 *  `question` alone so GPS ticks (which only change hiderPos)
 *  can't force the radius circle / thermometer line to
 *  recompute and rebuild their GL Source/Layer pair. */
function buildQuestionGeometry(
    question: Question,
): Omit<Overlay, "hiderConnections"> {
    const out: Omit<Overlay, "hiderConnections"> = {
        radiusCircle: null,
        thermometerLine: null,
        thermometerArrow: null,
        seekerPins: [],
    };
    const d = question.data as Record<string, unknown>;

    if (question.id === "radius") {
        const lat = d.lat as number;
        const lng = d.lng as number;
        const radius = d.radius as number;
        const unit = (d.unit as string) ?? "kilometers";
        const radiusMeters = radiusToMeters(radius, unit);
        out.radiusCircle = circle(
            [lng, lat],
            radiusMeters / 1000,
            { steps: 64, units: "kilometers" },
        ) as GeoJSON.Feature<GeoJSON.Polygon>;
        out.seekerPins.push([lng, lat]);
        return out;
    }

    if (question.id === "thermometer") {
        const latA = d.latA as number;
        const lngA = d.lngA as number;
        const latB = d.latB as number;
        const lngB = d.lngB as number;
        out.thermometerLine = {
            type: "Feature",
            properties: {},
            geometry: {
                type: "LineString",
                coordinates: [
                    [lngA, latA],
                    [lngB, latB],
                ],
            },
        };
        out.thermometerArrow = {
            lat: latA + 0.5 * (latB - latA),
            lng: lngA + 0.5 * (lngB - lngA),
            bearing: bearingDeg(latA, lngA, latB, lngB),
        };
        out.seekerPins.push([lngA, latA], [lngB, latB]);
        return out;
    }

    if (
        question.id === "matching" ||
        question.id === "measuring" ||
        question.id === "tentacles"
    ) {
        const lat = d.lat as number;
        const lng = d.lng as number;
        out.seekerPins.push([lng, lat]);
        return out;
    }

    return out;
}

/** Hider-only piece — the dashed lines from the hider's pin to
 *  whichever seeker point(s) the active question references. Re-
 *  derives on hiderPos change, which is exactly what we want
 *  here. */
function buildHiderConnections(
    question: Question,
    hiderPos: { lat: number; lng: number } | null,
): GeoJSON.FeatureCollection<GeoJSON.LineString> | null {
    if (!hiderPos) return null;
    const d = question.data as Record<string, unknown>;

    if (question.id === "radius") {
        const lat = d.lat as number;
        const lng = d.lng as number;
        return lineFc([
            [
                [hiderPos.lng, hiderPos.lat],
                [lng, lat],
            ],
        ]);
    }

    if (question.id === "thermometer") {
        const latA = d.latA as number;
        const lngA = d.lngA as number;
        const latB = d.latB as number;
        const lngB = d.lngB as number;
        return lineFc([
            [
                [hiderPos.lng, hiderPos.lat],
                [lngA, latA],
            ],
            [
                [hiderPos.lng, hiderPos.lat],
                [lngB, latB],
            ],
        ]);
    }

    if (
        question.id === "matching" ||
        question.id === "measuring" ||
        question.id === "tentacles"
    ) {
        const lat = d.lat as number;
        const lng = d.lng as number;
        return lineFc([
            [
                [hiderPos.lng, hiderPos.lat],
                [lng, lat],
            ],
        ]);
    }

    return null;
}

function lineFc(
    lines: GeoJSON.Position[][],
): GeoJSON.FeatureCollection<GeoJSON.LineString> {
    return {
        type: "FeatureCollection",
        features: lines.map((coords) => ({
            type: "Feature",
            properties: {},
            geometry: { type: "LineString", coordinates: coords },
        })),
    };
}

function collectFitPoints(
    question: Question,
    hiderPos: { lat: number; lng: number } | null,
): [number, number][] {
    const pts: [number, number][] = [];
    const d = question.data as Record<string, unknown>;

    if (question.id === "radius") {
        const lat = d.lat as number;
        const lng = d.lng as number;
        const r = radiusToMeters(d.radius as number, d.unit as string);
        const dLat = r / 111000;
        const dLng = r / (111000 * Math.cos((lat * Math.PI) / 180));
        pts.push([lng - dLng, lat - dLat]);
        pts.push([lng + dLng, lat + dLat]);
    } else if (question.id === "thermometer") {
        pts.push([d.lngA as number, d.latA as number]);
        pts.push([d.lngB as number, d.latB as number]);
    } else if (typeof d.lat === "number" && typeof d.lng === "number") {
        pts.push([d.lng, d.lat]);
    }

    if (hiderPos) pts.push([hiderPos.lng, hiderPos.lat]);
    return pts;
}

function radiusToMeters(value: number, unit: string): number {
    switch (unit) {
        case "miles":
            return value * 1609.344;
        case "meters":
            return value;
        case "kilometers":
        default:
            return value * 1000;
    }
}

const hiderPinSvg = `
<svg width="22" height="22" viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg">
  <circle cx="11" cy="11" r="9" fill="#3b82f6" stroke="white" stroke-width="3"/>
</svg>
`.trim();

const thermometerArrowSvg = `
<svg width="20" height="20" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
  <polygon points="10,1 18,17 10,13 2,17" fill="#f5d268" stroke="#3a3a2a" stroke-width="1.2" stroke-linejoin="round"/>
</svg>
`.trim();

/**
 * Compute the distance in km between the hider and a single seeker
 * point. Used for the "you are X km from the point" hint in the hider
 * view.
 */
export function distanceKm(
    fromLat: number,
    fromLng: number,
    toLat: number,
    toLng: number,
): number {
    return distance(point([fromLng, fromLat]), point([toLng, toLat]), {
        units: "kilometers",
    });
}

/** Initial bearing in degrees, 0 = north, clockwise. */
function bearingDeg(
    lat1: number,
    lng1: number,
    lat2: number,
    lng2: number,
): number {
    const phi1 = (lat1 * Math.PI) / 180;
    const phi2 = (lat2 * Math.PI) / 180;
    const dLambda = ((lng2 - lng1) * Math.PI) / 180;
    const y = Math.sin(dLambda) * Math.cos(phi2);
    const x =
        Math.cos(phi1) * Math.sin(phi2) -
        Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
