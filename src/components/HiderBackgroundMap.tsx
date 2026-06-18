import "maplibre-gl/dist/maplibre-gl.css";

import { useStore } from "@nanostores/react";
import { circle as turfCircle } from "@turf/turf";
import { Footprints, HelpCircle, MapPin } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import Map, { Layer, type MapRef, Marker, Source } from "react-map-gl/maplibre";

import { HiderMapDisplayControls } from "@/components/HiderMapDisplayControls";
import { lastKnownPosition, mapGeoLocation } from "@/lib/context";
import { satelliteView } from "@/lib/gameSetup";
import { hidingSpot, hidingZone, scoutedSpots } from "@/lib/hiderRole";
import {
    participants,
    seekerLocations,
} from "@/lib/multiplayer/session";
import {
    handleMapLibreError,
    pmtilesUrl,
    protomapsMapLibreStyle,
} from "@/lib/protomapsStyle";
import { resolvedTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

/**
 * Persistent backdrop map for the hider shell. Renders the hider's
 * spatial state — committed hiding zone circle, locked hiding spot,
 * scouted spots, the hider's own GPS dot — plus the seeker pins
 * broadcast over the multiplayer transport so the hider always sees
 * where the seekers are without opening a sheet.
 *
 * Simpler than the seeker's `Map.tsx`:
 *
 *   • No question polygons / elimination masks (the hider doesn't
 *     compute them, and showing them would reveal the *seeker's*
 *     deductions).
 *   • No draggable markers, no PolygonDraw, no GuessPolygon.
 *
 * Overlays mounted ON the map: HiderMapDisplayControls (basemap +
 * transit toggles) at top-right, and a "Mark potential hiding
 * spot" button bottom-right that opens a tiny popover for an
 * optional description before saving the current GPS to the
 * scouted-spots list.
 *
 * Mounted by HiderShell at `absolute inset-0 z-0` so it fills the
 * viewport behind the header / nav / hand-fan.
 */
export function HiderBackgroundMap() {
    const mapRef = useRef<MapRef | null>(null);
    const $playArea = useStore(mapGeoLocation);
    const $pmtilesUrl = useStore(pmtilesUrl);
    const $theme = useStore(resolvedTheme);
    const $satellite = useStore(satelliteView);
    const $zone = useStore(hidingZone);
    const $spot = useStore(hidingSpot);
    const $scouted = useStore(scoutedSpots);
    const $gps = useStore(lastKnownPosition);
    const $seekerLocations = useStore(seekerLocations);
    const $participants = useStore(participants);

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

    // v313: the "Mark spot" FAB moved into HiderTimeHeader where it
    // sits next to the live timer and only renders when the hider
    // is actually inside their committed zone. The popover + handler
    // moved with it.

    // v310: hider basemap was hardcoded to "dark", which broke the
    // moment the user flipped the app to light mode (the rest of
    // the UI followed but the map stayed dark). Follows
    // resolvedTheme like Map.tsx does. Rebuild when pmtilesUrl
    // flips to fallback bucket on probe failure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const mapStyle = useMemo(
        () => protomapsMapLibreStyle($theme === "dark" ? "dark" : "light"),
        [$pmtilesUrl, $theme],
    );

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
                /* v326: match Map.tsx / HiderMap.tsx — PMTiles
                   archive caps at z15, so z16 is one level of
                   overzoom freedom and that's all. */
                maxZoom={16}
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

                {/* Hider's own GPS pin — pulsing accuracy ring + a
                    "You" label so it's obvious at a glance which dot
                    is the hider's own position vs the seekers'. */}
                {$gps && (
                    <Marker latitude={$gps.lat} longitude={$gps.lng}>
                        <div className="relative flex flex-col items-center">
                            <span
                                aria-hidden
                                className="absolute -inset-2 rounded-full bg-blue-500/30 animate-ping"
                            />
                            <span
                                title="Your GPS position"
                                className="relative w-4 h-4 rounded-full bg-blue-500 border-2 border-white shadow-md"
                            />
                            <MarkerLabel tone="blue">You</MarkerLabel>
                        </div>
                    </Marker>
                )}

                {/* Scouted spots — question-mark icon (potential spot,
                    not committed). Label rendered beneath the marker
                    so the hider can scan the map without tapping each. */}
                {$scouted.map((s) => (
                    <Marker key={s.id} latitude={s.lat} longitude={s.lng}>
                        <div className="flex flex-col items-center">
                            <div
                                title={s.label || "Potential hiding spot"}
                                className={cn(
                                    "flex items-center justify-center w-7 h-7 rounded-full",
                                    "bg-secondary/95 border-2 border-yellow-400 shadow",
                                )}
                            >
                                <HelpCircle className="w-4 h-4 text-yellow-400" />
                            </div>
                            {s.label && (
                                <MarkerLabel tone="yellow">
                                    {s.label}
                                </MarkerLabel>
                            )}
                        </div>
                    </Marker>
                ))}

                {$spot && (
                    <Marker latitude={$spot.lat} longitude={$spot.lng}>
                        <div className="flex flex-col items-center">
                            <div
                                title="Locked hiding spot"
                                className="flex items-center justify-center w-7 h-7 rounded-full bg-yellow-400 border-2 border-background shadow-lg"
                            >
                                <MapPin className="w-4 h-4 text-background" />
                            </div>
                            <MarkerLabel tone="yellow">Hiding spot</MarkerLabel>
                        </div>
                    </Marker>
                )}

                {/* Live seeker pins. Always visible — broadcast over
                    the multiplayer transport when seekers opt in to
                    GPS sharing (rulebook p5). Each pin shows the
                    seeker's display name beneath the marker. */}
                {seekerPins.map((s) => (
                    <Marker key={s.id} latitude={s.lat} longitude={s.lng}>
                        <div className="flex flex-col items-center">
                            <div
                                title={s.name}
                                className={cn(
                                    "flex items-center justify-center w-7 h-7 rounded-full",
                                    "bg-destructive border-2 border-background shadow-lg",
                                )}
                            >
                                <Footprints className="w-4 h-4 text-background" />
                            </div>
                            <MarkerLabel tone="destructive">
                                {s.name}
                            </MarkerLabel>
                        </div>
                    </Marker>
                ))}
            </Map>

            {/* Top-right cluster — basemap + transit toggles. Sits
                below the HiderTimeHeader (which ends near 8.5rem
                after v292 trimmed the top-bar). */}
            <div className="absolute top-[calc(8.5rem+env(safe-area-inset-top))] right-2 z-[1030]">
                <HiderMapDisplayControls />
            </div>

        </div>
    );
}

/**
 * Pill-shaped label rendered beneath a map marker. Backdrop-blur so
 * it's legible over both basemap and satellite. Tones map to the
 * marker family the label belongs to.
 */
function MarkerLabel({
    children,
    tone,
}: {
    children: React.ReactNode;
    tone: "blue" | "yellow" | "destructive";
}) {
    // v310: in light mode the previous text-blue-100/yellow-100
    // tones rendered light text on the light bg-background pill —
    // illegible. Use Tailwind dark: variants so each mode gets
    // contrast that actually reads.
    const toneCls =
        tone === "blue"
            ? "border-blue-500/60 text-blue-700 dark:text-blue-100"
            : tone === "yellow"
              ? "border-yellow-400/60 text-yellow-700 dark:text-yellow-100"
              : "border-destructive/60 text-destructive dark:text-destructive-foreground";
    return (
        <span
            className={cn(
                "mt-0.5 px-1.5 py-0.5 max-w-[140px] truncate",
                "rounded-sm border bg-background/85 backdrop-blur-sm",
                "text-[10px] font-poppins font-bold leading-tight",
                "shadow-sm pointer-events-none",
                toneCls,
            )}
        >
            {children}
        </span>
    );
}

export default HiderBackgroundMap;
