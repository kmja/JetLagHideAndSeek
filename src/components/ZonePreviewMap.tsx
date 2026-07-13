import "maplibre-gl/dist/maplibre-gl.css";

import { useStore } from "@nanostores/react";
import { bbox as turfBbox, circle as turfCircle } from "@turf/turf";
import { useMemo, useRef } from "react";
import Map, { Layer, type MapRef, Source } from "react-map-gl/maplibre";

import { baseTileLayer, thunderforestApiKey } from "@/lib/context";
import { satelliteView } from "@/lib/gameSetup";
import { buildStyle } from "@/lib/mapStyle";
import { PLAY_AREA_COLOR } from "@/lib/playAreaStyle";
import { resolvedTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

/**
 * Small non-interactive map preview of a hiding-zone extent: the brand-red
 * radius circle + a centre dot, framed to the circle. Uses the SHARED
 * `buildStyle` so the basemap matches the main map exactly (theme + tile
 * layer + satellite). Lazily mounted by `AppConfirmHost` only when a
 * confirm supplies a `previewZone`, so MapLibre isn't dragged into the
 * generic confirm-dialog bundle.
 */
export function ZonePreviewMap({
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
    const dark = $theme === "dark";
    const mapRef = useRef<MapRef | null>(null);

    const circle = useMemo(
        () =>
            turfCircle([lng, lat], radiusMeters / 1000, {
                units: "kilometers",
                steps: 64,
            }),
        [lat, lng, radiusMeters],
    );
    const dot = useMemo(
        () => ({
            type: "Feature" as const,
            geometry: { type: "Point" as const, coordinates: [lng, lat] },
            properties: {},
        }),
        [lat, lng],
    );
    const mapStyle = useMemo(
        () => buildStyle($tileKey, $satellite, $tfKey ?? "", dark ? "dark" : "light"),
        [$tileKey, $satellite, $tfKey, dark],
    );

    const fit = () => {
        const map = mapRef.current?.getMap();
        if (!map) return;
        const bb = turfBbox(circle) as [number, number, number, number];
        try {
            map.fitBounds(
                [
                    [bb[0], bb[1]],
                    [bb[2], bb[3]],
                ],
                { padding: 22, animate: false },
            );
        } catch {
            /* degenerate bbox — leave the initial view */
        }
    };

    return (
        <div
            className={cn(
                "relative overflow-hidden rounded-lg border",
                className,
            )}
        >
            <Map
                ref={mapRef}
                initialViewState={{ longitude: lng, latitude: lat, zoom: 12 }}
                mapStyle={mapStyle}
                interactive={false}
                attributionControl={false}
                onLoad={fit}
                style={{ width: "100%", height: "100%" }}
            >
                <Source id="zone-preview-fill-src" type="geojson" data={circle}>
                    <Layer
                        id="zone-preview-fill"
                        type="fill"
                        paint={{
                            "fill-color": PLAY_AREA_COLOR,
                            "fill-opacity": 0.16,
                        }}
                    />
                    <Layer
                        id="zone-preview-line"
                        type="line"
                        paint={{
                            "line-color": PLAY_AREA_COLOR,
                            "line-width": 2,
                        }}
                    />
                </Source>
                <Source id="zone-preview-dot-src" type="geojson" data={dot}>
                    <Layer
                        id="zone-preview-dot"
                        type="circle"
                        paint={{
                            "circle-radius": 5,
                            "circle-color": PLAY_AREA_COLOR,
                            "circle-stroke-color": "#ffffff",
                            "circle-stroke-width": 2,
                        }}
                    />
                </Source>
            </Map>
        </div>
    );
}

export default ZonePreviewMap;
