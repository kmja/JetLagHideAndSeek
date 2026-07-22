import "maplibre-gl/dist/maplibre-gl.css";

import { useStore } from "@nanostores/react";
import * as turf from "@turf/turf";
import { MapPin } from "lucide-react";
import { useMemo, useRef } from "react";
import MapGL, {
    Layer,
    type MapLayerMouseEvent,
    Marker,
    type MapRef,
    Source,
} from "react-map-gl/maplibre";

import { baseTileLayer, thunderforestApiKey } from "@/lib/context";
import { satelliteView } from "@/lib/gameSetup";
import { buildStyle } from "@/lib/mapStyle";
import { PLAY_AREA_COLOR } from "@/lib/playAreaStyle";
import { installMissingImageHandler } from "@/lib/protomapsStyle";
import { resolvedTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

/** A seeker to mark on the picker. `initials`/`color` come from the roster
 *  (v1107) so the hider sees WHO/where each seeker is, matching the main map. */
export interface DestinationSeeker {
    lat: number;
    lng: number;
    initials?: string;
    color?: string;
}

/**
 * Small interactive map for picking a single POINT — used by the Mediocre
 * Travel Agent curse so the hider chooses the seekers' destination on a map
 * (v1029) instead of typing free text. Tap anywhere (or drag the pin) to move
 * it; the parent gets `onChange(lat, lng)` and reverse-geocodes for a name.
 *
 * v1107: the picker now shows everything the hider needs to pick a LEGAL
 * destination:
 *   - each seeker as their roster avatar (initials + colour), not a generic S;
 *   - the allowed RADIUS around the seekers (the destination must land inside);
 *   - the "closer to you / farther from you" DIVIDER (the destination must be
 *     farther from the hider than the seekers are) — drawn as the local tangent
 *     through the seekers with the forbidden (closer) side shaded;
 *   - the basemap's POIs (`keepPois`) so the hider can spot a good spot.
 *
 * Kept lazy-loaded by `CastCurseDialog` so maplibre-gl stays off the critical
 * path. Uses the SHARED `buildStyle` so the basemap matches the app.
 */
export function DestinationPicker({
    center,
    value,
    onChange,
    seekers = [],
    radiusKm,
    hider,
    className,
}: {
    center: { lat: number; lng: number };
    value: { lat: number; lng: number } | null;
    onChange: (lat: number, lng: number) => void;
    /** The seekers' last known positions (roster avatars). */
    seekers?: DestinationSeeker[];
    /** Allowed radius around the seekers, km (the destination must be inside). */
    radiusKm?: number;
    /** The hider's own position — draws the "farther from you" divider. */
    hider?: { lat: number; lng: number } | null;
    className?: string;
}) {
    const $theme = useStore(resolvedTheme);
    const $tileKey = useStore(baseTileLayer);
    const $satellite = useStore(satelliteView);
    const $tfKey = useStore(thunderforestApiKey);
    const dark = $theme === "dark";
    const mapRef = useRef<MapRef | null>(null);

    const mapStyle = useMemo(
        () =>
            // v1107: keepPois so the hider can see shops/parks/landmarks to
            // pick a good destination near the seekers.
            buildStyle($tileKey, $satellite, $tfKey ?? "", dark ? "dark" : "light", {
                keepPois: true,
            }),
        [$tileKey, $satellite, $tfKey, dark],
    );

    // The single ALLOWED region: within `radiusKm` of the seekers AND on the
    // far side of the "farther from the hider" divider. The two constraints are
    // COMBINED (v1114) — the union of the seeker-radius circles is clipped to
    // the half-plane away from the hider, so what's drawn is the half-circle
    // (or lens) where a legal pin can actually land, not two overlapping hints.
    // Falls back to the full radius zone when the hider position is unknown
    // (can't compute a direction).
    const allowedFC = useMemo<GeoJSON.FeatureCollection | null>(() => {
        if (!radiusKm || radiusKm <= 0) return null;
        const pts = seekers.filter(
            (s) => Number.isFinite(s.lat) && Number.isFinite(s.lng),
        );
        if (!pts.length) return null;
        const circles = pts.map((s) =>
            turf.circle([s.lng, s.lat], radiusKm, {
                steps: 96,
                units: "kilometers",
            }),
        );
        let zone: GeoJSON.Feature<
            GeoJSON.Polygon | GeoJSON.MultiPolygon
        > | null =
            circles.length === 1
                ? circles[0]
                : (turf.union(turf.featureCollection(circles)) as
                      | GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>
                      | null);
        if (!zone) return null;

        // Clip to the "farther from the hider" half-plane. The exact boundary
        // is a circle around the hider through the seekers; at this scale (a
        // sub-km pick zone, the hider km away) its arc is a straight LINE
        // through the seekers' centroid, perpendicular to the hider bearing.
        if (hider && Number.isFinite(hider.lat) && Number.isFinite(hider.lng)) {
            const ref = [
                pts.reduce((a, s) => a + s.lng, 0) / pts.length,
                pts.reduce((a, s) => a + s.lat, 0) / pts.length,
            ] as [number, number];
            const refPt = turf.point(ref);
            const hiderPt = turf.point([hider.lng, hider.lat]);
            const distToHider = turf.distance(refPt, hiderPt, {
                units: "kilometers",
            });
            if (distToHider >= 0.02) {
                const bearingToHider = turf.bearing(refPt, hiderPt);
                const span = Math.max(radiusKm * 8, 3);
                const a = turf.destination(refPt, span, bearingToHider + 90, {
                    units: "kilometers",
                });
                const b = turf.destination(refPt, span, bearingToHider - 90, {
                    units: "kilometers",
                });
                // Far half-plane: extrude the divider endpoints AWAY from the
                // hider, then intersect with the radius zone → the allowed
                // half-circle.
                const farA = turf.destination(a, span * 2, bearingToHider + 180, {
                    units: "kilometers",
                });
                const farB = turf.destination(b, span * 2, bearingToHider + 180, {
                    units: "kilometers",
                });
                const farHalf = turf.polygon([
                    [
                        a.geometry.coordinates,
                        b.geometry.coordinates,
                        farB.geometry.coordinates,
                        farA.geometry.coordinates,
                        a.geometry.coordinates,
                    ],
                ]);
                const clipped = turf.intersect(
                    turf.featureCollection([zone, farHalf]),
                ) as GeoJSON.Feature<
                    GeoJSON.Polygon | GeoJSON.MultiPolygon
                > | null;
                if (clipped) zone = clipped;
            }
        }

        return turf.featureCollection([zone]) as GeoJSON.FeatureCollection;
    }, [seekers, radiusKm, hider]);

    const handleClick = (e: MapLayerMouseEvent) => {
        onChange(e.lngLat.lat, e.lngLat.lng);
    };

    return (
        <div
            className={cn(
                "relative overflow-hidden rounded-lg border",
                className,
            )}
        >
            <MapGL
                ref={mapRef}
                initialViewState={{
                    longitude: value?.lng ?? center.lng,
                    latitude: value?.lat ?? center.lat,
                    zoom: 14,
                }}
                mapStyle={mapStyle}
                attributionControl={false}
                onLoad={(e) => installMissingImageHandler(e.target)}
                onClick={handleClick}
                style={{ width: "100%", height: "100%" }}
            >
                {/* The single ALLOWED region — the half-circle of the seeker
                    radius that lies farther from the hider. */}
                {allowedFC && (
                    <Source id="dest-allowed" type="geojson" data={allowedFC}>
                        <Layer
                            id="dest-allowed-fill"
                            type="fill"
                            paint={{
                                "fill-color": "hsl(145 60% 45%)",
                                "fill-opacity": 0.14,
                            }}
                        />
                        <Layer
                            id="dest-allowed-line"
                            type="line"
                            paint={{
                                "line-color": "hsl(145 60% 40%)",
                                "line-width": 2,
                                "line-dasharray": [2, 2],
                            }}
                        />
                    </Source>
                )}

                {seekers.map((s, i) => (
                    <Marker
                        key={`seeker-${i}`}
                        longitude={s.lng}
                        latitude={s.lat}
                        anchor="center"
                    >
                        <span
                            className="flex items-center justify-center rounded-full border-2 border-white shadow text-[9px] font-bold text-white"
                            style={{
                                width: 24,
                                height: 24,
                                background: s.color ?? "hsl(210 80% 55%)",
                            }}
                            title="Seeker"
                        >
                            {s.initials ?? "S"}
                        </span>
                    </Marker>
                ))}
                {value && (
                    <Marker
                        longitude={value.lng}
                        latitude={value.lat}
                        anchor="bottom"
                        draggable
                        onDragEnd={(e) =>
                            onChange(e.lngLat.lat, e.lngLat.lng)
                        }
                    >
                        <MapPin
                            className="w-8 h-8 drop-shadow"
                            style={{ color: PLAY_AREA_COLOR }}
                            fill={PLAY_AREA_COLOR}
                            strokeWidth={1.5}
                            stroke="white"
                        />
                    </Marker>
                )}
            </MapGL>
            {!value && (
                <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-background/80 px-3 py-1.5 text-[11px] text-center text-muted-foreground">
                    Tap inside the green zone to drop a pin
                </div>
            )}
        </div>
    );
}

export default DestinationPicker;
