import "maplibre-gl/dist/maplibre-gl.css";

import { useStore } from "@nanostores/react";
import { circle, distance, point } from "@turf/turf";
import { useEffect, useMemo, useRef, useState } from "react";
import Map, {
    Layer,
    type MapRef,
    Marker,
    Source,
} from "react-map-gl/maplibre";

import {
    fetchNearest,
    type NearestRef,
    resolveFamily,
} from "@/components/NearestReferencePreview";
import { buildMarkerHtml, CATEGORIES, type CategoryId } from "@/lib/categories";
import {
    handleMapLibreError,
    installMissingImageHandler,
    pmtilesUrl,
    protomapsMapLibreStyle,
} from "@/lib/protomapsStyle";
import { resolvedTheme } from "@/lib/theme";
import type { Question } from "@/maps/schema";

import { SelfPositionMarker } from "./SelfPositionMarker";

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
    onMapReady,
}: {
    question: Question;
    /** When supplied, used as the hider position instead of GPS. */
    overridePos?: { lat: number; lng: number } | null;
    onHiderLocationChange?: (lat: number, lng: number, accuracy: number) => void;
    onGeoError?: (message: string) => void;
    /** v315: fires once the basemap style is loaded AND the first
     *  idle frame has rendered. The answer dialog uses this to keep
     *  the "Tap to reveal" overlay (and the loading state above it)
     *  in sync with what the user actually sees. */
    onMapReady?: () => void;
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

    // v792: simple seeker-vs-hider REFERENCE comparison for matching /
    // measuring. The hider knows where the seekers are, so instead of the
    // seeker's full-play-area elimination overlay the map just shows the
    // seeker's nearest reference (e.g. coastline / airport) and the hider's
    // own nearest reference, with a line + distance from each. Keyed on a
    // rounded hider position (~11 m) so a stationary GPS jitter doesn't
    // re-run the (sometimes Overpass-backed) nearest lookups.
    const [refs, setRefs] = useState<{
        seeker: NearestRef | null;
        hider: NearestRef | null;
    } | null>(null);
    const hLat4 = hiderPos ? Number(hiderPos.lat.toFixed(4)) : null;
    const hLng4 = hiderPos ? Number(hiderPos.lng.toFixed(4)) : null;
    useEffect(() => {
        const d = question.data as Record<string, unknown>;
        if (
            (question.id !== "matching" && question.id !== "measuring") ||
            typeof d.lat !== "number" ||
            typeof d.lng !== "number" ||
            hLat4 === null ||
            hLng4 === null
        ) {
            setRefs(null);
            return;
        }
        const family = resolveFamily(d.type as string);
        if (!family) {
            // No single named reference for this subtype (zone / landmass /
            // border / custom) — fall back to the plain seeker↔hider view.
            setRefs(null);
            return;
        }
        let cancelled = false;
        Promise.all([
            fetchNearest(family, d.lat as number, d.lng as number).catch(
                () => null,
            ),
            fetchNearest(family, hLat4, hLng4).catch(() => null),
        ]).then(([seeker, hider]) => {
            if (!cancelled) setRefs({ seeker, hider });
        });
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [question, hLat4, hLng4]);

    // The seeker→its-reference and hider→its-reference comparison lines.
    const refLines = useMemo<GeoJSON.FeatureCollection<GeoJSON.LineString> | null>(() => {
        if (!refs) return null;
        const d = question.data as Record<string, unknown>;
        const lines: GeoJSON.Position[][] = [];
        if (refs.seeker && typeof d.lat === "number" && typeof d.lng === "number") {
            lines.push([
                [d.lng, d.lat],
                [refs.seeker.lng, refs.seeker.lat],
            ]);
        }
        if (refs.hider && hiderPos) {
            lines.push([
                [hiderPos.lng, hiderPos.lat],
                [refs.hider.lng, refs.hider.lat],
            ]);
        }
        return lines.length ? lineFc(lines) : null;
    }, [refs, question, hiderPos]);
    // When the reference comparison is shown, drop the plain seeker↔hider
    // connector — the two reference lines ARE the comparison now.
    const showRefComparison = refLines !== null;

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

    // Map readiness — declared before the fit effect so the fit can re-run
    // once the map has settled (the dialog animates open, so the very first
    // fitBounds can run against a mid-transition container size).
    const [styleLoaded, setStyleLoaded] = useState(false);
    const [idledOnce, setIdledOnce] = useState(false);

    // Fit the camera to contain question geometry + hider pin whenever any of
    // those move — AND once the map first settles (so a radar circle + the
    // hider pin are correctly framed even though the dialog was still opening
    // when the initial fit fired). v884.
    useEffect(() => {
        const map = mapRef.current?.getMap();
        if (!map) return;
        const pts = collectFitPoints(question, hiderPos);
        // Frame the reference points too so both comparison lines are visible.
        if (refs?.seeker) pts.push([refs.seeker.lng, refs.seeker.lat]);
        if (refs?.hider) pts.push([refs.hider.lng, refs.hider.lat]);
        if (pts.length === 0) return;
        // The dialog's open animation can leave the canvas sized wrong for the
        // first fit; sync the canvas to its container before framing.
        try {
            map.resize();
        } catch {
            /* ignore */
        }
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
            { padding: 48, maxZoom: 15, duration: 600 },
        );
    }, [question, hiderPos, refs, idledOnce]);

    const catColor =
        CATEGORIES[question.id as CategoryId]?.color ?? "#64748b";

    const seekerMarkerHtml = useMemo(
        () => buildMarkerHtml(question.id as CategoryId),
        [question.id],
    );

    // v228: follow OS / app theme — dark filter only when resolved
    // theme is dark.
    const $theme = useStore(resolvedTheme);
    const darkTiles = $theme === "dark";

    // v241: rebuild style when the resolved PMTiles URL flips (e.g.
    // probe / tile-error fallback to the demo bucket).
    const $pmtilesUrl = useStore(pmtilesUrl);
    const mapStyle = useMemo(
        () => protomapsMapLibreStyle(darkTiles ? "dark" : "light"),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [darkTiles, $pmtilesUrl],
    );

    useEffect(() => {
        if (styleLoaded && idledOnce) onMapReady?.();
    }, [styleLoaded, idledOnce, onMapReady]);

    return (
        <div className="relative w-full h-[36vh] min-h-[220px] max-h-[320px] rounded-md overflow-hidden border border-border">
            <Map
                ref={mapRef}
                initialViewState={{
                    longitude: initialCenter.lng,
                    latitude: initialCenter.lat,
                    zoom: 12,
                }}
                style={{ width: "100%", height: "100%" }}
                mapStyle={mapStyle}
                attributionControl={false}
                scrollZoom={false}
                /* v326: match Map.tsx — PMTiles archive caps at z15,
                   so z16 is one level of overzoom freedom and past
                   that is just magnified vector data with no new
                   detail. */
                maxZoom={16}
                onLoad={(e) => {
                    installMissingImageHandler(e.target);
                    setStyleLoaded(true);
                }}
                onIdle={() => setIdledOnce(true)}
                onError={handleMapLibreError}
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
                                "fill-color": CATEGORIES.radius.color,
                                "fill-opacity": 0.15,
                            }}
                        />
                        <Layer
                            id="hm-radius-line"
                            type="line"
                            paint={{
                                "line-color": CATEGORIES.radius.color,
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
                                "line-color": CATEGORIES.thermometer.color,
                                "line-width": 3,
                                "line-dasharray": [3, 2],
                            }}
                        />
                    </Source>
                )}

                {/* Reference comparison lines (matching/measuring): from the
                    seeker to ITS nearest reference, and from the hider to ITS
                    nearest reference (v792). */}
                {refLines && (
                    <Source id="hm-ref-lines" type="geojson" data={refLines}>
                        <Layer
                            id="hm-ref-lines-line"
                            type="line"
                            paint={{
                                "line-color": catColor,
                                "line-width": 3,
                                "line-opacity": 0.9,
                            }}
                        />
                    </Source>
                )}

                {/* Dashed connection(s) from hider to seeker point(s) — hidden
                    when the reference comparison lines are shown instead. */}
                {overlay.hiderConnections && !showRefComparison && (
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

                {/* Reference points (matching/measuring) — a small dot at the
                    seeker's nearest reference and the hider's, each labelled
                    with its distance so the hider can read both numbers and the
                    verdict at a glance (v792). */}
                {refs?.seeker && (
                    <Marker
                        longitude={refs.seeker.lng}
                        latitude={refs.seeker.lat}
                        anchor="bottom"
                    >
                        <RefPointMarker
                            color={catColor}
                            origin="Seeker"
                            distanceMeters={refs.seeker.distanceMeters}
                            dotEdge="bottom"
                        />
                    </Marker>
                )}
                {refs?.hider && (
                    <Marker
                        longitude={refs.hider.lng}
                        latitude={refs.hider.lat}
                        anchor="top"
                    >
                        <RefPointMarker
                            color="#3b82f6"
                            origin="You"
                            distanceMeters={refs.hider.distanceMeters}
                            dotEdge="top"
                        />
                    </Marker>
                )}

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

                {/* Hider's "you are here" pin — v347: shared
                    SelfPositionMarker so every "my position" view
                    looks identical. */}
                {hiderPos && (
                    <Marker
                        longitude={hiderPos.lng}
                        latitude={hiderPos.lat}
                        anchor="center"
                    >
                        <SelfPositionMarker />
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

/** A reference point (nearest coastline/airport/etc.) for the seeker or the
 *  hider, drawn as a small dot with a distance pill (v792). */
function RefPointMarker({
    color,
    origin,
    distanceMeters,
    dotEdge,
}: {
    color: string;
    origin: string;
    distanceMeters: number;
    dotEdge: "top" | "bottom";
}) {
    const km = distanceMeters / 1000;
    const dist =
        km >= 1 ? `${km.toFixed(1)} km` : `${Math.round(distanceMeters)} m`;
    const dot = (
        <span
            className="w-3 h-3 rounded-full border-2 border-white shadow"
            style={{ backgroundColor: color }}
        />
    );
    const label = (
        <span
            className="rounded-full px-1.5 py-0.5 text-[10px] font-poppins font-bold text-white shadow whitespace-nowrap"
            style={{ backgroundColor: color }}
        >
            {origin} · {dist}
        </span>
    );
    return (
        <div className="flex flex-col items-center gap-0.5">
            {dotEdge === "top" ? (
                <>
                    {dot}
                    {label}
                </>
            ) : (
                <>
                    {label}
                    {dot}
                </>
            )}
        </div>
    );
}

const hiderPinSvg = `
<svg width="22" height="22" viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg">
  <circle cx="11" cy="11" r="9" fill="#3b82f6" stroke="white" stroke-width="3"/>
</svg>
`.trim();

const thermometerArrowSvg = `
<svg width="20" height="20" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
  <polygon points="10,1 18,17 10,13 2,17" fill="${CATEGORIES.thermometer.color}" stroke="#3a3a2a" stroke-width="1.2" stroke-linejoin="round"/>
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
