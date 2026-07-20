import "maplibre-gl/dist/maplibre-gl.css";

import { useStore } from "@nanostores/react";
import { MapPin } from "lucide-react";
import { useMemo, useRef } from "react";
import MapGL, {
    type MapLayerMouseEvent,
    Marker,
    type MapRef,
} from "react-map-gl/maplibre";

import { baseTileLayer, thunderforestApiKey } from "@/lib/context";
import { satelliteView } from "@/lib/gameSetup";
import { buildStyle } from "@/lib/mapStyle";
import { PLAY_AREA_COLOR } from "@/lib/playAreaStyle";
import { installMissingImageHandler } from "@/lib/protomapsStyle";
import { resolvedTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

/**
 * Small interactive map for picking a single POINT — used by the Mediocre
 * Travel Agent curse so the hider chooses the seekers' destination on a map
 * (v1029) instead of typing free text. Tap anywhere (or drag the pin) to move
 * it; the parent gets `onChange(lat, lng)` and reverse-geocodes for a name.
 *
 * Kept deliberately light (no impact overlays / reference machinery, unlike
 * `InlineLocationPicker`) and lazy-loaded by `CastCurseDialog` so maplibre-gl
 * stays off the critical path. Uses the SHARED `buildStyle` so the basemap
 * matches the rest of the app (theme + tile layer + satellite).
 */
export function DestinationPicker({
    center,
    value,
    onChange,
    className,
}: {
    center: { lat: number; lng: number };
    value: { lat: number; lng: number } | null;
    onChange: (lat: number, lng: number) => void;
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
            buildStyle(
                $tileKey,
                $satellite,
                $tfKey ?? "",
                dark ? "dark" : "light",
            ),
        [$tileKey, $satellite, $tfKey, dark],
    );

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
                    zoom: 13,
                }}
                mapStyle={mapStyle}
                attributionControl={false}
                onLoad={(e) => installMissingImageHandler(e.target)}
                onClick={handleClick}
                style={{ width: "100%", height: "100%" }}
            >
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
                    Tap the map to drop a pin
                </div>
            )}
        </div>
    );
}

export default DestinationPicker;
