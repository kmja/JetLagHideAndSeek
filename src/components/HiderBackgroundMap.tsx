import "maplibre-gl/dist/maplibre-gl.css";

import { useStore } from "@nanostores/react";
import { circle as turfCircle } from "@turf/turf";
import { Footprints, MapPin, Plus, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import Map, { Layer, type MapRef, Marker, Source } from "react-map-gl/maplibre";
import { toast } from "react-toastify";

import { HiderMapDisplayControls } from "@/components/HiderMapDisplayControls";
import { lastKnownPosition, mapGeoLocation } from "@/lib/context";
import { satelliteView } from "@/lib/gameSetup";
import {
    addScoutedSpot,
    hidingSpot,
    hidingZone,
    scoutedSpots,
} from "@/lib/hiderRole";
import {
    participants,
    seekerLocations,
} from "@/lib/multiplayer/session";
import {
    handleMapLibreError,
    pmtilesUrl,
    protomapsMapLibreStyle,
} from "@/lib/protomapsStyle";
import { cn } from "@/lib/utils";

/**
 * Persistent backdrop map for the hider shell. Renders the hider's
 * spatial state — committed hiding zone circle, locked hiding spot,
 * scouted spots, GPS dot — plus the seeker pins broadcast over the
 * multiplayer transport so the hider always sees where the seekers
 * are without opening a sheet.
 *
 * Simpler than the seeker's `Map.tsx`:
 *
 *   • No question polygons / elimination masks (the hider doesn't
 *     compute them, and showing them would reveal the *seeker's*
 *     deductions).
 *   • No draggable markers, no PolygonDraw, no GuessPolygon.
 *
 * Overlays mounted ON the map: HiderMapDisplayControls (basemap +
 * transit toggles) at top-right, and a "Drop scout pin" FAB
 * bottom-right that captures the hider's current GPS into the
 * scouted-spots list.
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
    const $seekerLocations = useStore(seekerLocations);
    const $participants = useStore(participants);
    const [pinningSpot, setPinningSpot] = useState(false);

    const seekerPins = useMemo(
        () =>
            Object.entries($seekerLocations).map(([id, loc]) => {
                const p = $participants.find((q) => q.id === id);
                return {
                    id,
                    name: p?.displayName?.trim() || "Seeker",
                    lat: loc.lat,
                    lng: loc.lng,
                };
            }),
        [$seekerLocations, $participants],
    );

    const handleDropPin = () => {
        if (typeof navigator === "undefined" || !navigator.geolocation) {
            toast.error("GPS unavailable on this device.");
            return;
        }
        setPinningSpot(true);
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                addScoutedSpot({
                    lat: pos.coords.latitude,
                    lng: pos.coords.longitude,
                });
                setPinningSpot(false);
                toast.success("Spot saved at your GPS.", { autoClose: 1500 });
            },
            (err) => {
                setPinningSpot(false);
                toast.error(
                    err.code === err.PERMISSION_DENIED
                        ? "Allow location to drop spots."
                        : "Couldn't read your GPS — try again.",
                );
            },
            { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 },
        );
    };

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

                {/* Live seeker pins. Always visible — broadcast over
                    the multiplayer transport when seekers opt in to
                    GPS sharing (rulebook p5). The hider should never
                    have to open a sheet to see where the seekers are. */}
                {seekerPins.map((s) => (
                    <Marker key={s.id} latitude={s.lat} longitude={s.lng}>
                        <div
                            title={s.name}
                            className={cn(
                                "flex items-center justify-center w-7 h-7 rounded-full",
                                "bg-destructive border-2 border-background shadow-lg",
                            )}
                        >
                            <Footprints className="w-4 h-4 text-background" />
                        </div>
                    </Marker>
                ))}
            </Map>

            {/* Top-right cluster — basemap + transit toggles. Sits
                below the HiderTimeHeader (which ends near 9rem). */}
            <div className="absolute top-[calc(9rem+env(safe-area-inset-top))] right-2 z-[1030]">
                <HiderMapDisplayControls />
            </div>

            {/* Bottom-right FAB — quick "drop a scouted pin at my
                current GPS" button. Captures the hider's live
                position into the scoutedSpots list with no naming
                step; the hider can rename later from the Zone
                drawer's scouting list. */}
            <button
                type="button"
                onClick={handleDropPin}
                disabled={pinningSpot}
                aria-label="Drop a scouted spot at your current location"
                title="Drop a scouted spot at your current location"
                className={cn(
                    "absolute right-2 z-[1030]",
                    // Sit above the bottom nav: nav is at 68px (when
                    // cards) or safe-area (otherwise), plus its own
                    // ~64px height. 144px clears both states.
                    "bottom-[calc(144px+env(safe-area-inset-bottom))]",
                    "flex items-center gap-2 h-11 px-4 rounded-full",
                    "bg-yellow-400 text-background font-poppins font-bold text-sm",
                    "shadow-lg border-2 border-background",
                    "hover:bg-yellow-300 active:bg-yellow-500 transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    "disabled:opacity-60 disabled:cursor-wait",
                )}
            >
                <Plus className="w-4 h-4" strokeWidth={3} />
                {pinningSpot ? "GPS…" : "Drop pin"}
            </button>
        </div>
    );
}

export default HiderBackgroundMap;
