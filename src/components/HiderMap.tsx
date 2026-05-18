import { distance, point } from "@turf/turf";
import { DivIcon, LatLngBounds } from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useMemo, useState } from "react";
import {
    Circle,
    MapContainer,
    Marker,
    Polyline,
    TileLayer,
    useMap,
} from "react-leaflet";

import { buildMarkerHtml, type CategoryId } from "@/lib/categories";
import type { Question } from "@/maps/schema";

/**
 * Hider-facing map. Single-purpose, intentionally separate from the
 * main app's Map.tsx (which assumes the seeker context, sidebars, hider
 * mode toggles, etc.).
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
    const [gpsPos, setGpsPos] = useState<{
        lat: number;
        lng: number;
        accuracy: number;
    } | null>(null);
    const [geoError, setGeoError] = useState<string | null>(null);

    // Watch position throughout the hider's session so the dot follows them.
    // If `overridePos` is provided we still kick off watch in case the user
    // later wants to switch back to GPS — but the displayed pin is whichever
    // source has the most recent value (override takes precedence).
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

    // The effective hider position: override wins over GPS.
    const hiderPos = overridePos
        ? { ...overridePos, accuracy: 0 }
        : gpsPos;

    // Extract the seeker's primary point for centering before bounds are known.
    const initialCenter = useMemo(() => {
        const d = question.data as any;
        if (typeof d.lat === "number" && typeof d.lng === "number") {
            return { lat: d.lat, lng: d.lng };
        }
        if (typeof d.latA === "number" && typeof d.lngA === "number") {
            return { lat: d.latA, lng: d.lngA };
        }
        return { lat: 0, lng: 0 };
    }, [question]);

    return (
        <div className="relative w-full h-[55vh] min-h-[300px] rounded-md overflow-hidden border border-border">
            <MapContainer
                center={[initialCenter.lat, initialCenter.lng]}
                zoom={12}
                scrollWheelZoom={false}
                style={{ height: "100%", width: "100%" }}
            >
                <TileLayer
                    attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
                    url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
                />
                <QuestionOverlay question={question} hiderPos={hiderPos} />
                {hiderPos && (
                    <Marker
                        position={[hiderPos.lat, hiderPos.lng]}
                        icon={hiderPinIcon()}
                    />
                )}
                <FitToContent question={question} hiderPos={hiderPos} />
            </MapContainer>

            {geoError && (
                <div className="absolute top-2 left-2 right-2 z-[1100] bg-destructive/90 text-destructive-foreground text-xs px-3 py-2 rounded-md">
                    {geoError}. Showing seeker's point only.
                </div>
            )}
        </div>
    );
}

/** Renders the question-specific geometry (circle, line, pin) plus a dashed
 *  line from the hider to the relevant seeker point(s). */
function QuestionOverlay({
    question,
    hiderPos,
}: {
    question: Question;
    hiderPos: { lat: number; lng: number } | null;
}) {
    const seekerIcon = useMemo(
        () =>
            new DivIcon({
                html: buildMarkerHtml(question.id as CategoryId),
                className: "jl-marker",
                iconSize: [34, 46],
                iconAnchor: [17, 43],
            }),
        [question.id],
    );

    if (question.id === "radius") {
        const radiusMeters = radiusToMeters(
            question.data.radius,
            question.data.unit,
        );
        return (
            <>
                <Circle
                    center={[question.data.lat, question.data.lng]}
                    radius={radiusMeters}
                    pathOptions={{
                        color: "#f5a888",
                        fillColor: "#f5a888",
                        fillOpacity: 0.15,
                        weight: 2,
                    }}
                />
                <Marker
                    position={[question.data.lat, question.data.lng]}
                    icon={seekerIcon}
                />
                {hiderPos && (
                    <Polyline
                        positions={[
                            [hiderPos.lat, hiderPos.lng],
                            [question.data.lat, question.data.lng],
                        ]}
                        pathOptions={{
                            color: "#cbd5e1",
                            weight: 2,
                            dashArray: "6 6",
                            opacity: 0.85,
                        }}
                    />
                )}
            </>
        );
    }

    if (question.id === "thermometer") {
        const bearing = bearingDeg(
            question.data.latA,
            question.data.lngA,
            question.data.latB,
            question.data.lngB,
        );
        const arrowPos: [number, number] = [
            question.data.latA + 0.5 * (question.data.latB - question.data.latA),
            question.data.lngA + 0.5 * (question.data.lngB - question.data.lngA),
        ];
        return (
            <>
                <Polyline
                    positions={[
                        [question.data.latA, question.data.lngA],
                        [question.data.latB, question.data.lngB],
                    ]}
                    pathOptions={{
                        color: "#f5d268",
                        weight: 3,
                        dashArray: "8 6",
                    }}
                />
                <Marker
                    position={arrowPos}
                    icon={thermometerArrowIcon(bearing)}
                    interactive={false}
                    keyboard={false}
                />
                <Marker
                    position={[question.data.latA, question.data.lngA]}
                    icon={seekerIcon}
                />
                <Marker
                    position={[question.data.latB, question.data.lngB]}
                    icon={seekerIcon}
                />
                {hiderPos && (
                    <>
                        <Polyline
                            positions={[
                                [hiderPos.lat, hiderPos.lng],
                                [question.data.latA, question.data.lngA],
                            ]}
                            pathOptions={{
                                color: "#cbd5e1",
                                weight: 2,
                                dashArray: "6 6",
                                opacity: 0.75,
                            }}
                        />
                        <Polyline
                            positions={[
                                [hiderPos.lat, hiderPos.lng],
                                [question.data.latB, question.data.lngB],
                            ]}
                            pathOptions={{
                                color: "#cbd5e1",
                                weight: 2,
                                dashArray: "6 6",
                                opacity: 0.75,
                            }}
                        />
                    </>
                )}
            </>
        );
    }

    if (
        question.id === "matching" ||
        question.id === "measuring" ||
        question.id === "tentacles"
    ) {
        return (
            <>
                <Marker
                    position={[question.data.lat, question.data.lng]}
                    icon={seekerIcon}
                />
                {hiderPos && (
                    <Polyline
                        positions={[
                            [hiderPos.lat, hiderPos.lng],
                            [question.data.lat, question.data.lng],
                        ]}
                        pathOptions={{
                            color: "#cbd5e1",
                            weight: 2,
                            dashArray: "6 6",
                            opacity: 0.85,
                        }}
                    />
                )}
            </>
        );
    }

    return null;
}

/** Side-effect component that fits the map to contain everything relevant. */
function FitToContent({
    question,
    hiderPos,
}: {
    question: Question;
    hiderPos: { lat: number; lng: number } | null;
}) {
    const map = useMap();

    useEffect(() => {
        const pts: [number, number][] = [];
        const d = question.data as any;

        if (question.id === "radius") {
            const r = radiusToMeters(d.radius, d.unit);
            // Bounding box of the circle: expand from center by r meters.
            // 1 degree latitude ~= 111km; approximate longitude offset by cos(lat).
            const dLat = r / 111000;
            const dLng = r / (111000 * Math.cos((d.lat * Math.PI) / 180));
            pts.push([d.lat - dLat, d.lng - dLng]);
            pts.push([d.lat + dLat, d.lng + dLng]);
        } else if (question.id === "thermometer") {
            pts.push([d.latA, d.lngA]);
            pts.push([d.latB, d.lngB]);
        } else {
            pts.push([d.lat, d.lng]);
        }

        if (hiderPos) pts.push([hiderPos.lat, hiderPos.lng]);

        if (pts.length === 0) return;
        if (pts.length === 1) {
            map.setView(pts[0], 13);
            return;
        }
        const bounds = new LatLngBounds(pts);
        map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
    }, [map, question, hiderPos]);

    return null;
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

/** A clean blue "you are here" pin. */
function hiderPinIcon(): DivIcon {
    const html = `
<div class="jl-hider-marker">
  <svg width="22" height="22" viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg">
    <circle cx="11" cy="11" r="9" fill="#3b82f6" stroke="white" stroke-width="3"/>
  </svg>
</div>
    `.trim();
    return new DivIcon({
        html,
        className: "jl-hider-marker-wrap",
        iconSize: [22, 22],
        iconAnchor: [11, 11],
    });
}

/**
 * Compute the distance in km between the hider and a single seeker point.
 * Useful for the "you are X km from the point" hint in the hider view.
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

/** Directional arrowhead DivIcon for thermometer lines. */
function thermometerArrowIcon(bearing: number): DivIcon {
    const html = `
<div class="jl-thermometer-arrow" style="transform: rotate(${bearing.toFixed(1)}deg);">
  <svg width="20" height="20" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
    <polygon points="10,1 18,17 10,13 2,17" fill="#f5d268" stroke="#3a3a2a" stroke-width="1.2" stroke-linejoin="round"/>
  </svg>
</div>`.trim();
    return new DivIcon({
        html,
        className: "jl-thermometer-arrow-wrap",
        iconSize: [20, 20],
        iconAnchor: [10, 10],
    });
}
