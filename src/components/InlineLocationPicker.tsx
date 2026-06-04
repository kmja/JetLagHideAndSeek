import "leaflet/dist/leaflet.css";

import { useStore } from "@nanostores/react";
import { Circle as CircleIcon, LocateFixed, LocateOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
    Circle,
    GeoJSON,
    MapContainer,
    Marker,
    Polyline,
    TileLayer,
    Tooltip,
    useMap,
    useMapEvents,
} from "react-leaflet";

import { Button } from "@/components/ui/button";
import {
    baseTileLayer,
    mapGeoLocation,
    questionFinishedMapData,
    thunderforestApiKey,
} from "@/lib/context";
import { satelliteView } from "@/lib/gameSetup";
import { getTileLayerConfig } from "@/lib/mapTiles";
import { cn } from "@/lib/utils";
import type { Units } from "@/maps/schema";

/**
 * Always-visible inline location picker for the question configure flow.
 *
 *   - Mounts a Leaflet map immediately (no "Pick on map" button gate)
 *   - On first mount, tries to grab the user's GPS. If granted, centers
 *     there and updates the parent's coords; if denied/unavailable,
 *     falls back to the play-area center and shows a GPS-unavailable
 *     hint asking the user to tap the map manually.
 *   - Renders the live elimination mask so the user sees their pin
 *     against the remaining play area, not a blank tile view.
 *   - If a `radiusMeters` prop is supplied (radar questions), draws a
 *     primary-colored circle around the pin so the radius preview is
 *     visible while the user is moving things around.
 *
 * Lazy-loaded by `LatLngPicker.tsx` so that leaflet's window-touching
 * module body never enters Astro's SSR import graph.
 */
export function InlineLocationPicker({
    latitude,
    longitude,
    onChange,
    radiusMeters,
    referencePoint,
    height = "h-[40vh]",
}: {
    latitude: number;
    longitude: number;
    onChange: (lat: number, lng: number) => void;
    /** Optional radius (in meters) — when present, draws a preview circle
     *  around the pin. Used by radar questions. */
    radiusMeters?: number;
    /** Optional named reference point — drawn as a smaller secondary
     *  marker with a dashed line back to the primary pin. Used by
     *  matching/measuring configure dialogs to surface the seeker's
     *  actual nearest reference. */
    referencePoint?: {
        lat: number;
        lng: number;
        name?: string;
    };
    /** Tailwind height class for the map canvas. */
    height?: string;
}) {
    const $maskData = useStore(questionFinishedMapData);
    const $playArea = useStore(mapGeoLocation);
    const $baseTileLayer = useStore(baseTileLayer);
    const $thunderforestApiKey = useStore(thunderforestApiKey);
    const $satellite = useStore(satelliteView);

    // Match the main map view: respect the seeker's base-style choice and
    // mirror satellite + transit overlays. Keeps the configure-dialog map
    // visually identical to the page background so the seeker doesn't have
    // to recalibrate when they look at a question's location preview.
    const tile = getTileLayerConfig($baseTileLayer, $thunderforestApiKey);

    // Track GPS permission/availability state for the helper text.
    // `unknown` → still polling on mount.
    // `granted` → got coordinates; pin already moved.
    // `denied`  → user said no, OR the browser doesn't expose geolocation.
    const [gpsState, setGpsState] = useState<"unknown" | "granted" | "denied">(
        "unknown",
    );

    // Try GPS exactly once on mount. We don't watch position — the user
    // can still drag/tap to override. If GPS is unavailable or denied,
    // we fall back to whatever coords were passed in (typically the
    // play-area center).
    const didGpsRef = useRef(false);
    useEffect(() => {
        if (didGpsRef.current) return;
        didGpsRef.current = true;
        if (typeof navigator === "undefined" || !navigator.geolocation) {
            setGpsState("denied");
            return;
        }
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                onChange(pos.coords.latitude, pos.coords.longitude);
                setGpsState("granted");
            },
            () => setGpsState("denied"),
            { enableHighAccuracy: true, timeout: 8000, maximumAge: 30_000 },
        );
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Fall back to the play-area center if no usable coords yet.
    const safeLat =
        Number.isFinite(latitude) && latitude !== 0
            ? latitude
            : ($playArea?.geometry?.coordinates?.[0] as number) ?? 0;
    const safeLng =
        Number.isFinite(longitude) && longitude !== 0
            ? longitude
            : ($playArea?.geometry?.coordinates?.[1] as number) ?? 0;

    return (
        <div className="space-y-2">
            <div
                className={cn(
                    "w-full rounded-md overflow-hidden border border-border",
                    height,
                )}
            >
                <MapContainer
                    center={[safeLat, safeLng]}
                    zoom={radiusMeters ? zoomForRadius(radiusMeters) : 13}
                    scrollWheelZoom
                    style={{ height: "100%", width: "100%" }}
                >
                    <TileLayer
                        url={tile.url}
                        attribution={tile.attribution}
                        subdomains={tile.subdomains}
                        maxZoom={tile.maxZoom}
                        minZoom={tile.minZoom}
                        noWrap={tile.noWrap}
                    />
                    {$satellite && (
                        <TileLayer
                            url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
                            attribution="Esri, Maxar, Earthstar Geographics"
                            maxZoom={19}
                            opacity={1}
                        />
                    )}
                    {/* Intentionally no transit (OpenRailwayMap) layer
                        here — the configure-dialog preview should stay
                        clean. Rail lines on top of the place pin would
                        compete with the dashed reference line we draw
                        between the seeker pin and the nearest-place
                        marker, so they're scoped to the main map only. */}
                    {$maskData && (
                        <GeoJSON
                            key={`mask-${
                                ($maskData as any)?.features?.[0]?.geometry
                                    ?.coordinates?.length ?? 0
                            }`}
                            data={$maskData}
                            interactive={false}
                            style={{
                                color: "#0f172a",
                                weight: 1,
                                opacity: 0.55,
                                fillColor: "#0f172a",
                                fillOpacity: 0.55,
                            }}
                        />
                    )}
                    {radiusMeters !== undefined && radiusMeters > 0 && (
                        <Circle
                            center={[safeLat, safeLng]}
                            radius={radiusMeters}
                            pathOptions={{
                                color: "hsl(var(--primary))",
                                weight: 2,
                                fillColor: "hsl(var(--primary))",
                                fillOpacity: 0.12,
                            }}
                            interactive={false}
                        />
                    )}
                    {referencePoint &&
                        Number.isFinite(referencePoint.lat) &&
                        Number.isFinite(referencePoint.lng) && (
                            <>
                                {/* Dashed line from the seeker's pin to
                                    the resolved nearest reference. Same
                                    primary color but lower opacity so
                                    it reads as auxiliary information. */}
                                <Polyline
                                    positions={[
                                        [safeLat, safeLng],
                                        [referencePoint.lat, referencePoint.lng],
                                    ]}
                                    pathOptions={{
                                        color: "hsl(var(--primary))",
                                        weight: 2,
                                        opacity: 0.7,
                                        dashArray: "6 5",
                                    }}
                                    interactive={false}
                                />
                                <ReferenceMarker
                                    lat={referencePoint.lat}
                                    lng={referencePoint.lng}
                                    name={referencePoint.name}
                                />
                            </>
                        )}
                    <ClickToPlace onPlace={onChange} />
                    <PickedPin lat={safeLat} lng={safeLng} />
                    <RecenterOnGps lat={safeLat} lng={safeLng} gps={gpsState} />
                    {referencePoint &&
                        Number.isFinite(referencePoint.lat) &&
                        Number.isFinite(referencePoint.lng) && (
                            <FitToReference
                                seekerLat={safeLat}
                                seekerLng={safeLng}
                                refLat={referencePoint.lat}
                                refLng={referencePoint.lng}
                            />
                        )}
                </MapContainer>
            </div>
            <div className="flex items-center justify-between gap-2 text-xs">
                <div
                    className={cn(
                        "flex items-center gap-1.5 min-w-0",
                        gpsState === "denied"
                            ? "text-muted-foreground italic"
                            : "text-muted-foreground",
                    )}
                >
                    {gpsState === "denied" ? (
                        <>
                            <LocateOff className="w-3.5 h-3.5 shrink-0" />
                            <span>GPS unavailable — tap the map to set</span>
                        </>
                    ) : gpsState === "granted" ? (
                        <>
                            <LocateFixed className="w-3.5 h-3.5 shrink-0 text-primary" />
                            <span className="tabular-nums">
                                {safeLat.toFixed(5)}, {safeLng.toFixed(5)}
                            </span>
                        </>
                    ) : (
                        <>
                            <span className="inline-block w-3.5 h-3.5 rounded-full border-2 border-muted-foreground/30 border-t-primary animate-spin" />
                            <span>Trying GPS…</span>
                        </>
                    )}
                </div>
                {gpsState !== "unknown" && (
                    <Button
                        variant="outline"
                        size="sm"
                        type="button"
                        className="gap-1.5 shrink-0"
                        onClick={() => {
                            if (
                                typeof navigator === "undefined" ||
                                !navigator.geolocation
                            ) {
                                setGpsState("denied");
                                return;
                            }
                            navigator.geolocation.getCurrentPosition(
                                (pos) => {
                                    onChange(
                                        pos.coords.latitude,
                                        pos.coords.longitude,
                                    );
                                    setGpsState("granted");
                                },
                                () => setGpsState("denied"),
                                {
                                    enableHighAccuracy: true,
                                    timeout: 8000,
                                    maximumAge: 0,
                                },
                            );
                        }}
                    >
                        <LocateFixed className="w-3.5 h-3.5" />
                        {gpsState === "denied" ? "Retry GPS" : "Use GPS"}
                    </Button>
                )}
            </div>
            {radiusMeters !== undefined && (
                <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <CircleIcon className="w-3 h-3 text-primary" />
                    <span>
                        Preview shows the{" "}
                        {formatMeters(radiusMeters)} radius from this point.
                    </span>
                </div>
            )}
        </div>
    );
}

/** Bigger radii deserve a wider zoom so the whole circle fits in view. */
function zoomForRadius(radiusMeters: number): number {
    // Rough heuristic: ~doubling radius → zoom out by 1 step.
    // 500m ≈ 14, 1km ≈ 13, 5km ≈ 11, 10km ≈ 10, 80km ≈ 7, 160km ≈ 6.
    const km = radiusMeters / 1000;
    if (km <= 0.6) return 14;
    if (km <= 1.2) return 13;
    if (km <= 2.5) return 12;
    if (km <= 6) return 11;
    if (km <= 12) return 10;
    if (km <= 25) return 9;
    if (km <= 50) return 8;
    if (km <= 100) return 7;
    if (km <= 200) return 6;
    return 5;
}

function formatMeters(m: number): string {
    if (m < 1000) return `${Math.round(m)} m`;
    return `${(m / 1000).toFixed(m % 1000 === 0 ? 0 : 1)} km`;
}

/** Captures map clicks/taps and bubbles them up as a pick event. */
function ClickToPlace({
    onPlace,
}: {
    onPlace: (lat: number, lng: number) => void;
}) {
    useMapEvents({
        click: (e) => {
            onPlace(e.latlng.lat, e.latlng.lng);
        },
    });
    return null;
}

/** Recenters the map only when the GPS state flips (we just resolved
 *  the user's location) — not when they hand-drag the pin. */
function RecenterOnGps({
    lat,
    lng,
    gps,
}: {
    lat: number;
    lng: number;
    gps: "unknown" | "granted" | "denied";
}) {
    const map = useMap();
    const lastGpsRef = useRef(gps);
    useEffect(() => {
        if (lastGpsRef.current !== gps && gps === "granted") {
            map.flyTo([lat, lng], Math.max(map.getZoom(), 13), {
                duration: 0.4,
            });
        }
        lastGpsRef.current = gps;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [gps]);
    return null;
}

/** Visible pin — same SVG teardrop as MapPickerDialog. */
function PickedPin({ lat, lng }: { lat: number; lng: number }) {
    const [icon, setIcon] = useState<ReturnType<
        typeof buildPinIcon
    > | null>(null);
    useEffect(() => {
        let cancelled = false;
        import("leaflet").then((L) => {
            if (!cancelled) setIcon(buildPinIcon(L));
        });
        return () => {
            cancelled = true;
        };
    }, []);
    if (!icon) return null;
    return <Marker position={[lat, lng]} icon={icon} />;
}

/**
 * Smaller secondary marker for the nearest-reference point on the
 * matching / measuring configure map. Uses a hollow ring + dot in the
 * primary brand color, distinct from the filled teardrop pin used for
 * the seeker's own location. A Tooltip rides the marker showing the
 * resolved name (e.g. "Stockholm Aquarium") so the seeker doesn't have
 * to cross-reference with the text preview above.
 */
function ReferenceMarker({
    lat,
    lng,
    name,
}: {
    lat: number;
    lng: number;
    name?: string;
}) {
    const [icon, setIcon] = useState<ReturnType<
        typeof buildReferenceIcon
    > | null>(null);
    useEffect(() => {
        let cancelled = false;
        import("leaflet").then((L) => {
            if (!cancelled) setIcon(buildReferenceIcon(L));
        });
        return () => {
            cancelled = true;
        };
    }, []);
    if (!icon) return null;
    return (
        <Marker position={[lat, lng]} icon={icon} interactive={Boolean(name)}>
            {name && (
                <Tooltip
                    direction="top"
                    offset={[0, -12]}
                    opacity={1}
                    className="jl-ref-tooltip"
                    permanent
                >
                    {name}
                </Tooltip>
            )}
        </Marker>
    );
}

function buildReferenceIcon(L: typeof import("leaflet")) {
    return new L.DivIcon({
        html: `
<div class="jl-ref-marker">
  <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
    <circle cx="9" cy="9" r="7" fill="white" stroke="hsl(var(--primary))" stroke-width="2.5"/>
    <circle cx="9" cy="9" r="3" fill="hsl(var(--primary))"/>
  </svg>
</div>`.trim(),
        className: "jl-ref-marker-wrap",
        iconSize: [18, 18],
        iconAnchor: [9, 9],
    });
}

/**
 * One-shot fit: when a reference point first appears (or moves to a
 * different location), pan/zoom the map so both the seeker pin and the
 * reference fit comfortably in view. Avoids the case where the
 * reference is just off-screen and the seeker can't see the dashed
 * line at all.
 */
function FitToReference({
    seekerLat,
    seekerLng,
    refLat,
    refLng,
}: {
    seekerLat: number;
    seekerLng: number;
    refLat: number;
    refLng: number;
}) {
    const map = useMap();
    const lastFitRef = useRef<string>("");
    useEffect(() => {
        const key = `${seekerLat.toFixed(4)},${seekerLng.toFixed(4)},${refLat.toFixed(4)},${refLng.toFixed(4)}`;
        if (lastFitRef.current === key) return;
        lastFitRef.current = key;
        import("leaflet").then((L) => {
            const bounds = L.latLngBounds(
                [seekerLat, seekerLng],
                [refLat, refLng],
            );
            map.fitBounds(bounds, {
                padding: [40, 40],
                maxZoom: 14,
                animate: true,
                duration: 0.4,
            });
        });
    }, [seekerLat, seekerLng, refLat, refLng, map]);
    return null;
}

function buildPinIcon(L: typeof import("leaflet")) {
    return new L.DivIcon({
        html: `
<div class="jl-picker-pin">
  <svg width="28" height="38" viewBox="0 0 28 38" xmlns="http://www.w3.org/2000/svg">
    <path d="M14 0C6.27 0 0 6.27 0 14c0 10.5 14 24 14 24s14-13.5 14-24C28 6.27 21.73 0 14 0z" fill="hsl(var(--primary))" stroke="white" stroke-width="2"/>
    <circle cx="14" cy="14" r="5" fill="white"/>
  </svg>
</div>`.trim(),
        className: "jl-picker-pin-wrap",
        iconSize: [28, 38],
        iconAnchor: [14, 36],
    });
}

export default InlineLocationPicker;
