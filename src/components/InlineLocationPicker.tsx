import "maplibre-gl/dist/maplibre-gl.css";

import { useStore } from "@nanostores/react";
import { circle as turfCircle } from "@turf/turf";
import { Circle as CircleIcon, LocateFixed, LocateOff } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import Map, {
    Layer,
    type MapLayerMouseEvent,
    type MapRef,
    Marker,
    Popup,
    Source,
} from "react-map-gl/maplibre";

import { Button } from "@/components/ui/button";
import {
    baseTileLayer,
    lastKnownPosition,
    mapGeoLocation,
    questionFinishedMapData,
    thunderforestApiKey,
} from "@/lib/context";
import { satelliteView } from "@/lib/gameSetup";
import { getTileLayerConfig } from "@/lib/mapTiles";
import { type ImpactMode, useQuestionImpact } from "@/lib/questionImpact";
import { cn } from "@/lib/utils";

/**
 * Always-visible inline location picker for the question configure flow.
 *
 *   - Mounts a MapLibre GL map immediately (no "Pick on map" gate)
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
 * Public API is unchanged from the Leaflet version that lived here
 * through v79 — same props, same behaviour, MapLibre GL underneath.
 */
export function InlineLocationPicker({
    latitude,
    longitude,
    onChange,
    radiusMeters,
    referencePoint,
    height = "h-[40vh]",
    lockToGps = false,
    impactMode,
    impactType,
    tentacleRadiusKm,
}: {
    latitude: number;
    longitude: number;
    onChange: (lat: number, lng: number) => void;
    radiusMeters?: number;
    referencePoint?: {
        lat: number;
        lng: number;
        name?: string;
    };
    height?: string;
    /** Question-impact overlay (v239). When set, the picker draws the
     *  "what would this answer tell us" regions onto this same map:
     *  matching → Voronoi cell (green=same) + rest (red); measuring →
     *  closer/further half-planes; tentacles → reach circle + every
     *  candidate plotted. Computed by useQuestionImpact from the
     *  prefetched feature cache. */
    impactMode?: ImpactMode;
    /** Subtype string (e.g. "hospital") driving the impact overlay. */
    impactType?: string;
    /** Tentacle reach in km (tentacles impactMode only). */
    tentacleRadiusKm?: number;
    /**
     * When true, the picker becomes a display-only map: map clicks don't
     * move the pin, the pin isn't draggable, and the pin only renders
     * once a finite coordinate exists. Used by matching/measuring
     * configure dialogs where the seeker's location must come from GPS
     * (or, if GPS is denied, the manual place-search shown by the
     * caller) — never from a stray map tap. The "Use GPS" button stays
     * active so a denied fix can be retried.
     */
    lockToGps?: boolean;
}) {
    const mapRef = useRef<MapRef | null>(null);
    const $maskData = useStore(questionFinishedMapData);
    const $playArea = useStore(mapGeoLocation);
    const $baseTileLayer = useStore(baseTileLayer);
    const $thunderforestApiKey = useStore(thunderforestApiKey);
    const $satellite = useStore(satelliteView);

    const tile = getTileLayerConfig($baseTileLayer, $thunderforestApiKey);

    // Question-impact overlay (v239). Only computed when the caller
    // opts in (matching/measuring/tentacles configure dialogs).
    const impact = useQuestionImpact(
        latitude,
        longitude,
        impactType ?? "",
        impactMode ?? "matching",
        tentacleRadiusKm,
    );
    const impactCandidatesFC = useMemo<GeoJSON.FeatureCollection | null>(() => {
        if (!impactMode || !impact || impact.candidates.length === 0)
            return null;
        return {
            type: "FeatureCollection",
            features: impact.candidates.map((c) => ({
                type: "Feature" as const,
                geometry: {
                    type: "Point" as const,
                    coordinates: [c.lng, c.lat],
                },
                properties: { name: c.name },
            })),
        };
    }, [impactMode, impact]);

    const [gpsState, setGpsState] = useState<"unknown" | "granted" | "denied">(
        "unknown",
    );

    const didGpsRef = useRef(false);
    useEffect(() => {
        if (didGpsRef.current) return;
        didGpsRef.current = true;
        if (typeof navigator === "undefined" || !navigator.geolocation) {
            setGpsState("denied");
            return;
        }
        // Seed immediately from the main map's last-known fix (the blue
        // dot) so the pin starts at the player's real position rather
        // than the play-area centroid while the fresh fix resolves.
        const known = lastKnownPosition.get();
        if (known) {
            onChange(known.lat, known.lng);
            setGpsState("granted");
        }
        // maximumAge:0 forces a fresh, high-accuracy fix rather than a
        // stale/coarse cached one (the cached fix was landing far from
        // the player).
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                onChange(pos.coords.latitude, pos.coords.longitude);
                lastKnownPosition.set({
                    lat: pos.coords.latitude,
                    lng: pos.coords.longitude,
                });
                setGpsState("granted");
            },
            () => {
                // Only fall to "denied" if we never got a seed fix.
                if (!lastKnownPosition.get()) setGpsState("denied");
            },
            { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 },
        );
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Whether the caller has handed us real, usable coordinates.
    const coordsAreSet =
        Number.isFinite(latitude) &&
        latitude !== 0 &&
        Number.isFinite(longitude) &&
        longitude !== 0;
    // Center the camera somewhere reasonable even when no coord is
    // set yet — falling back to the play-area centroid so the user
    // sees their region instead of a null-island ocean view.
    const safeLat = coordsAreSet
        ? latitude
        : ($playArea?.geometry?.coordinates?.[0] as number) ?? 0;
    const safeLng = coordsAreSet
        ? longitude
        : ($playArea?.geometry?.coordinates?.[1] as number) ?? 0;

    // Recenter only on GPS-flip-to-granted (not on hand-drag).
    const lastGpsRef = useRef(gpsState);
    useEffect(() => {
        if (lastGpsRef.current !== gpsState && gpsState === "granted") {
            const map = mapRef.current?.getMap();
            if (map) {
                map.flyTo({
                    center: [safeLng, safeLat],
                    zoom: Math.max(map.getZoom(), 13),
                    duration: 400,
                });
            }
        }
        lastGpsRef.current = gpsState;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [gpsState]);

    // One-shot fit: when a reference point first appears (or moves to a
    // different location), pan/zoom the map so both the seeker pin and
    // the reference fit comfortably in view.
    const lastFitRef = useRef<string>("");
    useEffect(() => {
        if (!referencePoint) return;
        if (
            !Number.isFinite(referencePoint.lat) ||
            !Number.isFinite(referencePoint.lng)
        )
            return;
        const key = `${safeLat.toFixed(4)},${safeLng.toFixed(4)},${referencePoint.lat.toFixed(4)},${referencePoint.lng.toFixed(4)}`;
        if (lastFitRef.current === key) return;
        lastFitRef.current = key;
        const map = mapRef.current?.getMap();
        if (!map) return;
        const minLng = Math.min(safeLng, referencePoint.lng);
        const maxLng = Math.max(safeLng, referencePoint.lng);
        const minLat = Math.min(safeLat, referencePoint.lat);
        const maxLat = Math.max(safeLat, referencePoint.lat);
        map.fitBounds(
            [
                [minLng, minLat],
                [maxLng, maxLat],
            ],
            { padding: 40, maxZoom: 14, duration: 400 },
        );
    }, [safeLat, safeLng, referencePoint?.lat, referencePoint?.lng]);

    // Pre-compute the radius circle as a turf polygon when the
    // radius prop is set; cheaper than re-running on every render.
    const radiusCircle = useMemo(() => {
        if (radiusMeters == null || radiusMeters <= 0) return null;
        return turfCircle([safeLng, safeLat], radiusMeters / 1000, {
            steps: 64,
            units: "kilometers",
        });
    }, [safeLat, safeLng, radiusMeters]);

    // The dashed reference line from seeker to nearest-reference,
    // shaped as a GeoJSON LineString for the line layer.
    const referenceLine = useMemo(() => {
        if (
            !referencePoint ||
            !Number.isFinite(referencePoint.lat) ||
            !Number.isFinite(referencePoint.lng)
        )
            return null;
        return {
            type: "Feature" as const,
            properties: {},
            geometry: {
                type: "LineString" as const,
                coordinates: [
                    [safeLng, safeLat],
                    [referencePoint.lng, referencePoint.lat],
                ],
            },
        };
    }, [safeLat, safeLng, referencePoint?.lat, referencePoint?.lng]);

    // In lock-to-GPS mode the map is fully interactive only when GPS
    // hasn't (yet) succeeded — the user needs *some* way to set a
    // location while the fix is being retried. The moment a GPS lock
    // arrives, the picker snaps back to display-only and the pin is
    // locked onto GPS coordinates.
    const interactionsAllowed = !lockToGps || gpsState !== "granted";

    const handleClick = (e: MapLayerMouseEvent) => {
        if (!interactionsAllowed) return;
        onChange(e.lngLat.lat, e.lngLat.lng);
    };

    // Memoise the MapLibre style so an inline `mapStyle={{...}}`
    // doesn't get rebuilt on every parent re-render. Without this,
    // the 1 Hz countdown tick in the hider's `HiderHome` re-renders
    // this component once a second, hands MapLibre a new style
    // object reference, and triggers a setStyle() pass that tears
    // down and re-creates every Source/Layer — including the
    // radius circle, which is what the hider saw as a once-a-
    // second flicker on the hiding-zone preview.
    const tileUrls = useMemo(
        () => rasterTilesFromTileConfig(tile),
        [tile.url, tile.subdomains],
    );
    const mapStyle = useMemo(
        () => ({
            version: 8 as const,
            sources: {
                base: {
                    type: "raster" as const,
                    tiles: tileUrls,
                    tileSize: 256,
                    attribution: tile.attribution,
                    maxzoom: tile.maxZoom ?? 19,
                    minzoom: tile.minZoom ?? 0,
                },
            },
            layers: [
                {
                    id: "base-tiles",
                    type: "raster" as const,
                    source: "base",
                },
            ],
        }),
        [tileUrls, tile.attribution, tile.maxZoom, tile.minZoom],
    );

    return (
        <div className="space-y-2">
            <div
                className={cn(
                    "w-full rounded-md overflow-hidden border border-border",
                    height,
                )}
            >
                <Map
                    ref={mapRef}
                    initialViewState={{
                        longitude: safeLng,
                        latitude: safeLat,
                        zoom: radiusMeters ? zoomForRadius(radiusMeters) : 13,
                    }}
                    style={{ width: "100%", height: "100%" }}
                    attributionControl={false}
                    onClick={handleClick}
                    mapStyle={mapStyle}
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
                    {/* Elimination mask. Same dark cover as the
                        Leaflet version (#0f172a, ~55% opacity). */}
                    {$maskData && (
                        <Source
                            id="mask"
                            type="geojson"
                            data={$maskData as GeoJSON.FeatureCollection}
                        >
                            <Layer
                                id="mask-fill"
                                type="fill"
                                paint={{
                                    "fill-color": "#0f172a",
                                    "fill-opacity": 0.55,
                                }}
                            />
                            <Layer
                                id="mask-outline"
                                type="line"
                                paint={{
                                    "line-color": "#0f172a",
                                    "line-width": 1,
                                    "line-opacity": 0.55,
                                }}
                            />
                        </Source>
                    )}
                    {/* Question-impact overlay (v239) — drawn on this
                        same map per the design request (no separate
                        mini-map). Order: red "no" region first so the
                        green "yes" sits on top; candidates + reach
                        circle above both. */}
                    {impactMode && impact?.no && (
                        <Source
                            id="impact-no"
                            type="geojson"
                            data={impact.no as GeoJSON.Feature}
                        >
                            <Layer
                                id="impact-no-fill"
                                type="fill"
                                paint={{
                                    "fill-color": "hsl(0, 75%, 50%)",
                                    "fill-opacity": 0.22,
                                }}
                            />
                        </Source>
                    )}
                    {impactMode && impact?.yes && (
                        <Source
                            id="impact-yes"
                            type="geojson"
                            data={impact.yes as GeoJSON.Feature}
                        >
                            <Layer
                                id="impact-yes-fill"
                                type="fill"
                                paint={{
                                    "fill-color": "hsl(140, 65%, 48%)",
                                    "fill-opacity": 0.3,
                                }}
                            />
                            <Layer
                                id="impact-yes-line"
                                type="line"
                                paint={{
                                    "line-color": "hsl(140, 65%, 32%)",
                                    "line-width": 1.5,
                                    "line-opacity": 0.85,
                                }}
                            />
                        </Source>
                    )}
                    {impactMode === "tentacles" && impact?.reachCircle && (
                        <Source
                            id="impact-reach"
                            type="geojson"
                            data={impact.reachCircle as GeoJSON.Feature}
                        >
                            <Layer
                                id="impact-reach-fill"
                                type="fill"
                                paint={{
                                    "fill-color": "hsl(265, 60%, 60%)",
                                    "fill-opacity": 0.16,
                                }}
                            />
                            <Layer
                                id="impact-reach-line"
                                type="line"
                                paint={{
                                    "line-color": "hsl(265, 60%, 48%)",
                                    "line-width": 1.5,
                                    "line-opacity": 0.9,
                                    "line-dasharray": [3, 3],
                                }}
                            />
                        </Source>
                    )}
                    {impactCandidatesFC && (
                        <Source
                            id="impact-candidates"
                            type="geojson"
                            data={impactCandidatesFC}
                        >
                            <Layer
                                id="impact-candidates-circle"
                                type="circle"
                                paint={{
                                    "circle-radius": 3.5,
                                    "circle-color": "hsl(40, 95%, 55%)",
                                    "circle-stroke-color": "hsl(40, 95%, 22%)",
                                    "circle-stroke-width": 1,
                                    "circle-opacity": 0.95,
                                }}
                            />
                        </Source>
                    )}
                    {/* Radius preview — primary brand color, 12 %
                        opacity fill so the mask underneath stays
                        readable. */}
                    {radiusCircle && (
                        <Source
                            id="radius"
                            type="geojson"
                            data={radiusCircle as GeoJSON.Feature}
                        >
                            <Layer
                                id="radius-fill"
                                type="fill"
                                paint={{
                                    "fill-color": "hsl(2, 70%, 54%)",
                                    "fill-opacity": 0.12,
                                }}
                            />
                            <Layer
                                id="radius-line"
                                type="line"
                                paint={{
                                    "line-color": "hsl(2, 70%, 54%)",
                                    "line-width": 2,
                                }}
                            />
                        </Source>
                    )}
                    {/* Dashed line from seeker pin to nearest-
                        reference. */}
                    {referenceLine && (
                        <Source
                            id="ref-line"
                            type="geojson"
                            data={referenceLine}
                        >
                            <Layer
                                id="ref-line-stroke"
                                type="line"
                                paint={{
                                    "line-color": "hsl(2, 70%, 54%)",
                                    "line-width": 2,
                                    "line-opacity": 0.7,
                                    "line-dasharray": [3, 3],
                                }}
                            />
                        </Source>
                    )}
                    {/* Seeker pin. Hidden in lock-to-GPS mode until
                        coords actually arrive — otherwise the
                        play-area centroid fallback would render a
                        phantom pin at the wrong place and read like a
                        confirmed location. Draggable whenever
                        interactions are allowed (free mode, or locked
                        mode while GPS hasn't returned). */}
                    {(!lockToGps || coordsAreSet) && (
                        <Marker
                            longitude={safeLng}
                            latitude={safeLat}
                            anchor="bottom"
                            draggable={interactionsAllowed}
                            onDragEnd={
                                interactionsAllowed
                                    ? (e) =>
                                          onChange(
                                              e.lngLat.lat,
                                              e.lngLat.lng,
                                          )
                                    : undefined
                            }
                        >
                            <div
                                className="jl-picker-pin"
                                style={{
                                    width: 28,
                                    height: 38,
                                    cursor: interactionsAllowed
                                        ? "grab"
                                        : "default",
                                }}
                                dangerouslySetInnerHTML={{ __html: PIN_SVG }}
                            />
                        </Marker>
                    )}
                    {/* Reference marker + permanent popup label. */}
                    {referencePoint &&
                        Number.isFinite(referencePoint.lat) &&
                        Number.isFinite(referencePoint.lng) && (
                            <>
                                <Marker
                                    longitude={referencePoint.lng}
                                    latitude={referencePoint.lat}
                                    anchor="center"
                                >
                                    <div
                                        className="jl-ref-marker"
                                        style={{ width: 18, height: 18 }}
                                        dangerouslySetInnerHTML={{
                                            __html: REF_SVG,
                                        }}
                                    />
                                </Marker>
                                {referencePoint.name && (
                                    <Popup
                                        longitude={referencePoint.lng}
                                        latitude={referencePoint.lat}
                                        anchor="bottom"
                                        offset={12}
                                        closeButton={false}
                                        closeOnClick={false}
                                        closeOnMove={false}
                                        className="jl-ref-tooltip"
                                    >
                                        {referencePoint.name}
                                    </Popup>
                                )}
                            </>
                        )}
                </Map>
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
                            <span>
                                {coordsAreSet
                                    ? "Drag the pin to adjust, or retry GPS"
                                    : "GPS unavailable — tap the map to drop a pin"}
                            </span>
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
                                    lastKnownPosition.set({
                                        lat: pos.coords.latitude,
                                        lng: pos.coords.longitude,
                                    });
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

/** The TileLayerConfig used by Leaflet expands `{s}` to a subdomain
 *  via Leaflet's TileLayer; MapLibre takes an explicit array. Build
 *  that array here from the subdomains list. */
function rasterTilesFromTileConfig(tile: {
    url: string;
    subdomains?: string | string[];
}): string[] {
    const subs = tile.subdomains
        ? Array.isArray(tile.subdomains)
            ? tile.subdomains
            : tile.subdomains.split("")
        : [""];
    if (!tile.url.includes("{s}")) return [tile.url];
    return subs.map((s) => tile.url.replace("{s}", s));
}

/** Bigger radii deserve a wider zoom so the whole circle fits. */
function zoomForRadius(radiusMeters: number): number {
    // Each level zooms out one extra step vs the v1 table: the picker
    // is 30vh tall (often <250 px on a phone), which at the previous
    // zooms cut the radius circle off at top/bottom for the typical
    // 500m / 1km hiding zones. One level less keeps the whole circle
    // visible with a comfortable margin.
    const km = radiusMeters / 1000;
    if (km <= 0.6) return 13;
    if (km <= 1.2) return 12;
    if (km <= 2.5) return 11;
    if (km <= 6) return 10;
    if (km <= 12) return 9;
    if (km <= 25) return 8;
    if (km <= 50) return 7;
    if (km <= 100) return 6;
    if (km <= 200) return 5;
    return 4;
}

function formatMeters(m: number): string {
    if (m < 1000) return `${Math.round(m)} m`;
    return `${(m / 1000).toFixed(m % 1000 === 0 ? 0 : 1)} km`;
}

const PIN_SVG = `
<svg width="28" height="38" viewBox="0 0 28 38" xmlns="http://www.w3.org/2000/svg">
  <path d="M14 0C6.27 0 0 6.27 0 14c0 10.5 14 24 14 24s14-13.5 14-24C28 6.27 21.73 0 14 0z" fill="hsl(2, 70%, 54%)" stroke="white" stroke-width="2"/>
  <circle cx="14" cy="14" r="5" fill="white"/>
</svg>
`.trim();

const REF_SVG = `
<svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
  <circle cx="9" cy="9" r="7" fill="white" stroke="hsl(2, 70%, 54%)" stroke-width="2.5"/>
  <circle cx="9" cy="9" r="3" fill="hsl(2, 70%, 54%)"/>
</svg>
`.trim();

export default InlineLocationPicker;
