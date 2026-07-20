import "maplibre-gl/dist/maplibre-gl.css";

import { useStore } from "@nanostores/react";
import { bbox as turfBbox, circle as turfCircle } from "@turf/turf";
import { useMemo, useRef, useState } from "react";
import MapGL, { Layer, type MapRef, Source } from "react-map-gl/maplibre";

import { baseTileLayer, thunderforestApiKey } from "@/lib/context";
import { satelliteView } from "@/lib/gameSetup";
import { buildStyle } from "@/lib/mapStyle";
import { installMissingImageHandler } from "@/lib/protomapsStyle";
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
 *
 * v916: with `snapshot`, the settled view is captured to a PNG
 * (`toDataURL`) and cached, then rendered as a cheap static `<img>` — the
 * same "save the map as an image" behaviour the question-log outcome maps
 * use, so the committed-zone card shows a crisp still instead of a live GL
 * instance re-fitting every time the drawer opens.
 */

// Bounded cache of captured zone snapshots, keyed by the framing inputs.
const snapshotCache = new Map<string, string>();
const SNAPSHOT_CACHE_LIMIT = 24;

export function ZonePreviewMap({
    lat,
    lng,
    radiusMeters,
    className,
    padding = 22,
    snapshot = false,
}: {
    lat: number;
    lng: number;
    radiusMeters: number;
    className?: string;
    /** fitBounds padding in px — smaller = tighter zoom on the zone. */
    padding?: number;
    /** Capture the settled view to a cached PNG and render it as a static
     *  `<img>` (like the question-log outcome maps). */
    snapshot?: boolean;
}) {
    const $theme = useStore(resolvedTheme);
    const $tileKey = useStore(baseTileLayer);
    const $satellite = useStore(satelliteView);
    const $tfKey = useStore(thunderforestApiKey);
    const dark = $theme === "dark";
    const mapRef = useRef<MapRef | null>(null);

    const cacheKey = snapshot
        ? `${lat.toFixed(5)},${lng.toFixed(5)},${radiusMeters},${padding},${dark ? "d" : "l"},${$satellite ? "s" : "m"},${$tileKey}`
        : null;
    const [capturedUrl, setCapturedUrl] = useState<string | null>(null);
    const capturedRef = useRef(false);
    const snapshotTimerRef = useRef<number | null>(null);
    const staticImg = cacheKey ? (snapshotCache.get(cacheKey) ?? capturedUrl) : null;

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
                { padding, animate: false },
            );
        } catch {
            /* degenerate bbox — leave the initial view */
        }
    };

    // Snapshot the settled view once, cache it, and swap to the static PNG.
    const trySnapshot = () => {
        if (!cacheKey || capturedRef.current) return;
        const map = mapRef.current?.getMap();
        if (!map) return;
        try {
            const url = map.getCanvas().toDataURL("image/png");
            if (url && url.length > 2048) {
                snapshotCache.set(cacheKey, url);
                if (snapshotCache.size > SNAPSHOT_CACHE_LIMIT) {
                    const oldest = snapshotCache.keys().next().value;
                    if (oldest !== undefined) snapshotCache.delete(oldest);
                }
                capturedRef.current = true;
                setCapturedUrl(url);
            }
        } catch {
            /* GL toDataURL can throw — just keep the live map */
        }
    };

    if (staticImg) {
        return (
            <div
                className={cn(
                    "relative overflow-hidden rounded-lg border select-none",
                    className,
                )}
            >
                <img
                    src={staticImg}
                    alt="Hiding zone"
                    className="h-full w-full object-cover"
                    draggable={false}
                />
            </div>
        );
    }

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
                interactive={false}
                attributionControl={false}
                // Needed for the canvas snapshot (toDataURL) to return pixels.
                preserveDrawingBuffer={snapshot}
                onLoad={(e) => {
                    installMissingImageHandler(e.target);
                    fit();
                }}
                onIdle={
                    snapshot
                        ? () => {
                              if (snapshotTimerRef.current !== null)
                                  clearTimeout(snapshotTimerRef.current);
                              snapshotTimerRef.current = window.setTimeout(
                                  trySnapshot,
                                  200,
                              );
                          }
                        : undefined
                }
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
            </MapGL>
        </div>
    );
}

export default ZonePreviewMap;
