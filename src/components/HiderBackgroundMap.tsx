import "maplibre-gl/dist/maplibre-gl.css";

import { useStore } from "@nanostores/react";
import { circle as turfCircle } from "@turf/turf";
import { MapPin, Search } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import Map, { Layer, type MapRef, Marker, Source } from "react-map-gl/maplibre";

import { lastKnownPosition, mapGeoLocation } from "@/lib/context";
import { satelliteView } from "@/lib/gameSetup";
import { hidingSpot, hidingZone, scoutedSpots } from "@/lib/hiderRole";
import {
    handleMapLibreError,
    pmtilesUrl,
    protomapsMapLibreStyle,
} from "@/lib/protomapsStyle";

/**
 * Persistent backdrop map for the hider shell. Read-only — no taps,
 * no drags. Renders the hider's spatial state: the committed hiding
 * zone circle, the locked hiding spot, all scouted spots, and the
 * GPS dot.
 *
 * Purposefully simpler than the seeker's `Map.tsx`:
 *
 *   • No question polygons / elimination masks (the hider doesn't
 *     compute them, and showing them would reveal the *seeker's*
 *     deductions).
 *   • No draggable markers, no PolygonDraw, no GuessPolygon,
 *     no ZoneSidebar overlay, no MapDisplayControls.
 *   • No SeekerLivePositions yet — that lives in the Settings sheet
 *     for now; will surface here in a follow-up.
 *
 * Mounted by HiderShell at `absolute inset-0 z-0` so it fills the
 * viewport behind the header / nav / hand-fan.
 */
export function HiderBackgroundMap() {
    const mapRef = useRef<MapRef | null>(null);
    const $playArea = useStore(mapGeoLocation);
    const $pmtilesUrl = useStore(pmtilesUrl);
    const $satellite = useStore(satelliteView);
    const $zone = useStore(hidingZone);
    const $spot = useStore(hidingSpot);
    const $scouted = useStore(scoutedSpots);
    const $gps = useStore(lastKnownPosition);

    // Rebuild when pmtilesUrl flips to fallback bucket on probe failure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const mapStyle = useMemo(() => protomapsMapLibreStyle("dark"), [$pmtilesUrl]);

    // Initial center: prefer GPS, fall back to committed zone, then
    // play-area centroid, then null-island.
    const initialCenter = useMemo(() => {
        if ($gps) return { lat: $gps.lat, lng: $gps.lng };
        if ($zone) return { lat: $zone.stationLat, lng: $zone.stationLng };
        const coords = $playArea?.geometry?.coordinates;
        if (
            coords &&
            Number.isFinite(coords[0]) &&
            Number.isFinite(coords[1])
        ) {
            return { lat: coords[0] as number, lng: coords[1] as number };
        }
        return { lat: 0, lng: 0 };
    }, []);

    // Re-center on the zone whenever it gets committed (one-shot).
    const lastZoneKey = useRef<string>("");
    useEffect(() => {
        if (!$zone) return;
        const key = `${$zone.stationLat},${$zone.stationLng}`;
        if (lastZoneKey.current === key) return;
        lastZoneKey.current = key;
        const map = mapRef.current?.getMap();
        if (!map) return;
        map.flyTo({
            center: [$zone.stationLng, $zone.stationLat],
            zoom: 14,
            duration: 600,
        });
    }, [$zone]);

    // Re-center on the spot the moment it's locked (one-shot).
    const lastSpotKey = useRef<string>("");
    useEffect(() => {
        if (!$spot) return;
        const key = `${$spot.lat},${$spot.lng}`;
        if (lastSpotKey.current === key) return;
        lastSpotKey.current = key;
        const map = mapRef.current?.getMap();
        if (!map) return;
        map.flyTo({
            center: [$spot.lng, $spot.lat],
            zoom: 17,
            duration: 600,
        });
    }, [$spot]);

    // Zone circle — primary brand color, semi-transparent fill so the
    // hider can see the streets inside it.
    const zoneCircle = useMemo(() => {
        if (!$zone) return null;
        return turfCircle(
            [$zone.stationLng, $zone.stationLat],
            $zone.radiusMeters / 1000,
            { steps: 64, units: "kilometers" },
        );
    }, [$zone?.stationLat, $zone?.stationLng, $zone?.radiusMeters]);

    return (
        <div className="absolute inset-0 z-0">
            <Map
                ref={mapRef}
                initialViewState={{
                    longitude: initialCenter.lng,
                    latitude: initialCenter.lat,
                    zoom: 12,
                }}
                style={{ width: "100%", height: "100%" }}
                attributionControl={false}
                mapStyle={mapStyle}
                interactive={true}
                dragRotate={false}
                touchPitch={false}
                onError={handleMapLibreError}
            >
                {$satellite && (
                    <Source
                        id="satellite"
                        type="raster"
                        tiles={[
                            "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
                        ]}
                        tileSize={256}
                    >
                        <Layer
                            id="satellite-layer"
                            type="raster"
                            paint={{ "raster-opacity": 1 }}
                        />
                    </Source>
                )}

                {zoneCircle && (
                    <Source
                        id="hider-zone"
                        type="geojson"
                        data={zoneCircle as GeoJSON.Feature}
                    >
                        <Layer
                            id="hider-zone-fill"
                            type="fill"
                            paint={{
                                "fill-color": "hsl(2, 70%, 54%)",
                                "fill-opacity": 0.12,
                            }}
                        />
                        <Layer
                            id="hider-zone-line"
                            type="line"
                            paint={{
                                "line-color": "hsl(2, 70%, 54%)",
                                "line-width": 2,
                            }}
                        />
                    </Source>
                )}

                {$gps && (
                    <Marker latitude={$gps.lat} longitude={$gps.lng}>
                        <div
                            className="w-3 h-3 rounded-full bg-blue-500 border-2 border-white shadow-md"
                            title="Your GPS position"
                        />
                    </Marker>
                )}

                {$scouted.map((s) => (
                    <Marker key={s.id} latitude={s.lat} longitude={s.lng}>
                        <div
                            title={s.label || "Scouted spot"}
                            className="flex items-center justify-center w-6 h-6 rounded-full bg-secondary/95 border-2 border-yellow-400 shadow"
                        >
                            <Search className="w-3 h-3 text-yellow-400" />
                        </div>
                    </Marker>
                ))}

                {$spot && (
                    <Marker latitude={$spot.lat} longitude={$spot.lng}>
                        <div
                            title="Locked hiding spot"
                            className="flex items-center justify-center w-7 h-7 rounded-full bg-yellow-400 border-2 border-background shadow-lg"
                        >
                            <MapPin className="w-4 h-4 text-background" />
                        </div>
                    </Marker>
                )}
            </Map>
        </div>
    );
}

export default HiderBackgroundMap;
