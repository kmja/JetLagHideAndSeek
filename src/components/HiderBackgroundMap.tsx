import "maplibre-gl/dist/maplibre-gl.css";

import { useStore } from "@nanostores/react";
import { circle as turfCircle } from "@turf/turf";
import { Footprints, HelpCircle, MapPin } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import Map, { Layer, type MapRef, Marker, Source } from "react-map-gl/maplibre";

import { HiderMapDisplayControls } from "@/components/HiderMapDisplayControls";
import { MapNavControls } from "@/components/MapNavControls";
import {
    isLoading,
    lastKnownPosition,
    mapGeoJSON,
    mapGeoLocation,
    polyGeoJSON,
    polyGeoJSONHydrated,
} from "@/lib/context";
import { hidingPeriodEndsAt, satelliteView } from "@/lib/gameSetup";
import { hidingSpot, hidingZone, scoutedSpots } from "@/lib/hiderRole";
import { hiderReachFC, selectedMapStation } from "@/lib/journey/state";
import { findNearestStation } from "@/lib/journey/stations";
import { clipPolygonToLand } from "@/lib/landClip";
import { participants, seekerLocations } from "@/lib/multiplayer/session";
import {
    PLAY_AREA_COLOR,
    PLAY_AREA_LINE_OPACITY,
    PLAY_AREA_LINE_WIDTH,
} from "@/lib/playAreaStyle";
import {
    handleMapLibreError,
    installMissingImageHandler,
    pmtilesUrl,
    protomapsMapLibreStyle,
} from "@/lib/protomapsStyle";
import { resolvedTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { determineMapBoundaries } from "@/maps/api";

import { SelfPositionMarker } from "./SelfPositionMarker";

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
/** Overlay layers the hider can tap to open the StationTransitCard. */
const HIDER_TAP_LAYERS = ["hider-reach-dots", "hider-reach-labels"];

export function HiderBackgroundMap() {
    const mapRef = useRef<MapRef | null>(null);
    // Pointer-cursor affordance while hovering a tappable reach feature.
    const [stationHover, setStationHover] = useState(false);
    const $playArea = useStore(mapGeoLocation);
    const $polyGeoJSON = useStore(polyGeoJSON);
    const $pmtilesUrl = useStore(pmtilesUrl);
    const $theme = useStore(resolvedTheme);
    const $satellite = useStore(satelliteView);
    const $zone = useStore(hidingZone);
    const $spot = useStore(hidingSpot);
    const $scouted = useStore(scoutedSpots);
    const $gps = useStore(lastKnownPosition);
    const $reach = useStore(hiderReachFC);
    const $seekerLocations = useStore(seekerLocations);
    const $participants = useStore(participants);

    // v394: fetch the play-area boundary on the hider side. The seeker's
    // Map.tsx has its own boundary-fetch effect; the hider previously had
    // none, so polyGeoJSON stayed null on a fresh join. Symptoms: no
    // boundary line on the map, AND `spoofRandomInPlayArea` falling back
    // to the Photon bbox (a country-sized rectangle for "Calgary"), so
    // spoofed positions could land well outside the city.
    //
    // We mirror Map.tsx's gates exactly: wait for Cache hydration so we
    // don't re-fetch a polygon we already have on disk; skip when a
    // polygon is already loaded; skip when another fetch is in flight.
    // Single attempt, best-effort — the seeker's path owns the
    // user-facing "couldn't load" toast; the hider just shows no outline
    // if it fails, and we'll retry on the next mapGeoLocation change.
    useEffect(() => {
        const props = $playArea?.properties as { osm_id?: number } | undefined;
        if (!($playArea && (props?.osm_id ?? 0) > 0)) return;
        if (polyGeoJSON.get() || mapGeoJSON.get()) return;
        let cancelled = false;
        (async () => {
            if (!polyGeoJSONHydrated.get()) {
                await Promise.race([
                    new Promise<void>((resolve) => {
                        const unsub = polyGeoJSONHydrated.subscribe((v) => {
                            if (v) {
                                unsub();
                                resolve();
                            }
                        });
                    }),
                    new Promise<void>((resolve) => setTimeout(resolve, 3000)),
                ]);
                if (cancelled) return;
                if (polyGeoJSON.get() || mapGeoJSON.get()) return;
            }
            if (isLoading.get()) return;
            isLoading.set(true);
            try {
                let boundary = await determineMapBoundaries();
                if (cancelled) return;
                if (!boundary?.features?.length) return;
                const f = (boundary.features?.[0] as any) ?? null;
                if (f?.geometry) {
                    try {
                        const c = await clipPolygonToLand(f);
                        if (c) {
                            boundary = {
                                type: "FeatureCollection",
                                features: [c],
                            } as any;
                        }
                    } catch (e) {
                        console.warn(
                            "[HiderBackgroundMap] clipPolygonToLand failed; using raw boundary",
                            e,
                        );
                    }
                }
                if (cancelled) return;
                mapGeoJSON.set(boundary);
                polyGeoJSON.set(boundary);
            } catch (e) {
                console.warn(
                    "[HiderBackgroundMap] determineMapBoundaries failed:",
                    e,
                );
            } finally {
                isLoading.set(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [$playArea]);

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

    // v394: one-shot fit-to-play-area when the polygon first arrives, so
    // the hider sees the city outline framed instead of needing to pan.
    // Skipped if the hider already has a committed zone (the zone-fit
    // effect above wins) or a GPS fix (they'd prefer their own view).
    const polyKey = useMemo(() => {
        if (!$polyGeoJSON?.features?.length) return null;
        const props = ($polyGeoJSON.features[0]?.properties ?? null) as {
            osm_id?: number;
        } | null;
        return props?.osm_id ? String(props.osm_id) : "set";
    }, [$polyGeoJSON]);
    const lastPolyFitRef = useRef<string | null>(null);
    useEffect(() => {
        if (!polyKey || lastPolyFitRef.current === polyKey) return;
        if ($zone || $gps) {
            lastPolyFitRef.current = polyKey;
            return;
        }
        const map = mapRef.current?.getMap();
        if (!map || !$polyGeoJSON) return;
        try {
            const f = $polyGeoJSON.features?.[0];
            if (!f) return;
            const coords: number[][] = [];
            const walk = (arr: any) => {
                if (
                    typeof arr?.[0] === "number" &&
                    typeof arr?.[1] === "number"
                ) {
                    coords.push([arr[0], arr[1]]);
                } else if (Array.isArray(arr)) {
                    for (const sub of arr) walk(sub);
                }
            };
            walk((f.geometry as any)?.coordinates);
            if (coords.length < 2) return;
            let minLng = Infinity,
                minLat = Infinity,
                maxLng = -Infinity,
                maxLat = -Infinity;
            for (const [lng, lat] of coords) {
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
                { padding: 40, maxZoom: 13, duration: 600 },
            );
            lastPolyFitRef.current = polyKey;
        } catch (e) {
            console.warn("[HiderBackgroundMap] poly fit failed:", e);
        }
    }, [polyKey, $polyGeoJSON, $zone, $gps]);

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
                onLoad={(e) => installMissingImageHandler(e.target)}
                onError={handleMapLibreError}
                cursor={stationHover ? "pointer" : undefined}
                onMouseEnter={() => setStationHover(true)}
                onMouseLeave={() => setStationHover(false)}
                onClick={(e) => {
                    // Tier 1: tap landed on a reach-overlay feature
                    // (dot or label). Resolve from feature geometry.
                    const map = e.target;
                    const hit = map.queryRenderedFeatures(e.point, {
                        layers: HIDER_TAP_LAYERS,
                    });
                    if (hit.length > 0) {
                        const f = hit[0];
                        if (f.geometry?.type === "Point") {
                            const [lng, lat] = f.geometry.coordinates as [
                                number,
                                number,
                            ];
                            if (Number.isFinite(lat) && Number.isFinite(lng)) {
                                const props = (f.properties ?? {}) as {
                                    name?: string;
                                };
                                selectedMapStation.set({
                                    lat,
                                    lng,
                                    name: props.name,
                                });
                            }
                        }
                        return;
                    }
                    // Tier 2: no overlay feature under the tap. During
                    // the hiding period, fall back to "find the nearest
                    // transit station within 300 m of the tap" so the
                    // hider can still open a station card without first
                    // turning on the reach overlay (the explicit ask).
                    // No-op outside the hiding period (gameplay invariant
                    // — the hider doesn't travel after committing).
                    const endsAt = hidingPeriodEndsAt.get();
                    if (endsAt == null || endsAt <= Date.now()) return;
                    const { lat: tapLat, lng: tapLng } = e.lngLat;
                    void (async () => {
                        const station = await findNearestStation(
                            tapLat,
                            tapLng,
                        );
                        if (station) selectedMapStation.set(station);
                    })();
                }}
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

                {/* Play-area boundary — outline only (no fill) so the
                    basemap stays legible inside the city. v468: uses the
                    canonical play-area stroke (shared with the seeker map
                    + wizard preview) so the boundary looks identical in
                    every view. The hider's committed zone is a filled
                    circle, so it stays distinct without a dashed line. */}
                {$polyGeoJSON && (
                    <Source
                        id="hider-playarea"
                        type="geojson"
                        data={$polyGeoJSON as GeoJSON.FeatureCollection}
                    >
                        <Layer
                            id="hider-playarea-line"
                            type="line"
                            paint={{
                                "line-color": PLAY_AREA_COLOR,
                                "line-width": PLAY_AREA_LINE_WIDTH,
                                "line-opacity": PLAY_AREA_LINE_OPACITY,
                            }}
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

                {/* Reach overlay — every candidate hiding-zone
                    station the hider could plausibly reach before the
                    whistle, with arrival labels. Painted as a small
                    accent-coloured dot + arrival label so the survey
                    is map-wide; the trip-detail card below the picker
                    handles the *single-zone* trip plan once one is
                    chosen. */}
                {$reach && $reach.features.length > 0 && (
                    <Source id="hider-reach" type="geojson" data={$reach}>
                        <Layer
                            id="hider-reach-dots"
                            type="circle"
                            paint={{
                                "circle-radius": 4,
                                "circle-color": "hsl(180, 70%, 55%)",
                                "circle-opacity": 0.85,
                                "circle-stroke-color": "rgba(0,0,0,0.6)",
                                "circle-stroke-width": 1,
                            }}
                        />
                        <Layer
                            id="hider-reach-labels"
                            type="symbol"
                            layout={{
                                "text-field": ["get", "arrivalLabel"],
                                "text-size": 11,
                                "text-font": ["Open Sans Regular"],
                                "text-anchor": "left",
                                "text-offset": [0.8, 0],
                                "text-allow-overlap": false,
                                "text-ignore-placement": false,
                            }}
                            paint={{
                                "text-color": "white",
                                "text-halo-color": "rgba(0,0,0,0.85)",
                                "text-halo-width": 1.5,
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
                            {/* v347: shared SelfPositionMarker — was
                                a Tailwind blue-500 dot with custom
                                pulse, now the canonical look used by
                                every "my own position" rendering. */}
                            <SelfPositionMarker pulse />
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
            {/* Classic map controls — follow-me toggle + reset
                rotation/tilt. v462: the map is now a flex-1 area between
                the flow header and nav, so this anchors to the map edge
                (bottom-3) instead of dodging the nav/fan (bottom-44). */}
            <MapNavControls mapRef={mapRef} className="right-3 bottom-3" />

            {/* Top-right cluster — basemap + transit toggles. v462:
                anchors to the top of the map area (which now sits below
                the time header), so a plain top-2 is correct. */}
            <div className="absolute top-2 right-2 z-[1030]">
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
