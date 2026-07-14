import "maplibre-gl/dist/maplibre-gl.css";

import { useStore } from "@nanostores/react";
import {
    circle as turfCircle,
    convertLength as turfConvertLength,
    featureCollection as turfFeatureCollection,
    point as turfPoint,
    simplify as turfSimplify,
} from "@turf/turf";
import { Footprints, HelpCircle, MapPin } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import Map, {
    AttributionControl,
    Layer,
    type MapRef,
    Marker,
    Source,
} from "react-map-gl/maplibre";

import { FadeOverlay } from "@/components/FadeOverlay";
import { HiderMapTimer } from "@/components/HiderMapTimer";
import { HiderZoneHint } from "@/components/HiderZoneHint";
import { MapNavControls } from "@/components/MapNavControls";
import { MapOverlayLoadingToasts } from "@/components/MapOverlayLoadingToasts";
import { TransitRouteLayers } from "@/components/TransitRouteLayers";
import { usePlayAreaBoundary } from "@/hooks/usePlayAreaBoundary";
import { useSelfPositionWatch } from "@/hooks/useSelfPositionWatch";
import { useTransitRouteOverlays } from "@/hooks/useTransitRouteOverlays";
import {
    followMe,
    hidingRadius,
    hidingRadiusUnits,
    lastKnownPosition,
    mapGeoLocation,
    polyGeoJSON,
} from "@/lib/context";
import { stationLabelMaxChars } from "@/lib/debugState";
import {
    allowedTransit,
    hidingPeriodEndsAt,
    satelliteView,
} from "@/lib/gameSetup";
import { hidingSpot, hidingZone, scoutedSpots } from "@/lib/hiderRole";
import { shortenStationLabel } from "@/lib/stationLabel";
import {
    hiderReachFC,
    selectedMapStation,
    showHiderReach,
    stationCardInsetPx,
    tripRouteFC,
} from "@/lib/journey/state";
import { toast } from "react-toastify";

import { spoofPickMode } from "@/lib/debugGpsSpoof";
import { setSpoofAtPoint } from "@/lib/debugSpoofArea";
import { findZoneAtPoint } from "@/lib/journey/stations";
import { holedMask } from "@/maps";
import { SAT_TILE_BASE } from "@/maps/api/constants";
import { fadePaint } from "@/lib/mapPaint";
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
 * Overlays mounted ON the map: MapNavControls (follow-me + reset) at
 * bottom-right, and a "Mark potential hiding spot" button that opens a
 * tiny popover for an optional description before saving the current GPS
 * to the scouted-spots list. Map display options moved OFF the map into
 * the bottom-nav "Map" slot (HiderMapOptionsDrawer) in v632.
 *
 * Mounted by HiderShell at `absolute inset-0 z-0` so it fills the
 * viewport behind the header / nav / hand-fan.
 */
/** Overlay layers the hider can tap to open the StationTransitCard.
 *  The invisible `hider-reach-hit` circle is a large tap target around
 *  each tiny dot (mirrors the seeker's `hiding-zones-hit`). */
const HIDER_TAP_LAYERS = [
    "hider-reach-hit",
    "hider-reach-dots",
    "hider-reach-labels",
];

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
    const $followMe = useStore(followMe);
    const $reach = useStore(hiderReachFC);
    const $labelMaxChars = useStore(stationLabelMaxChars);
    // v835: display copy of the reach FC with a shortened `shortName` per
    // point (abbreviated + truncated to the debug max-chars). Full `name`
    // stays for taps; this only feeds the labels.
    const reachDisplay = useMemo(() => {
        if (!$reach) return $reach;
        return {
            ...$reach,
            features: $reach.features.map((f) => {
                const name = (f.properties as { name?: unknown } | null)?.name;
                if (typeof name !== "string" || !name) return f;
                return {
                    ...f,
                    properties: {
                        ...f.properties,
                        shortName: shortenStationLabel(name, $labelMaxChars),
                    },
                };
            }),
        } as typeof $reach;
    }, [$reach, $labelMaxChars]);
    const $trip = useStore(tripRouteFC);
    // Station-card drawer height, bucketed so the route refit below only
    // re-runs on real open/expand/collapse transitions (not 1px jitters).
    const $cardInset = useStore(stationCardInsetPx);
    // v784: bucket at 10px (was 60px). The card grows AFTER the first fit —
    // the reachability banner appears once the journey resolves, the expander
    // opens — and a 60px bucket swallowed those increments, so the fit never
    // re-ran and the route/zone tucked under the drawer. A 10px bucket still
    // damps 1px jitter but tracks the real drawer height so the fit re-frames.
    const cardInsetBucket = Math.round($cardInset / 10);
    const $selectedStation = useStore(selectedMapStation);
    const $hidingRadius = useStore(hidingRadius);
    const $hidingRadiusUnits = useStore(hidingRadiusUnits);
    const $seekerLocations = useStore(seekerLocations);
    const $participants = useStore(participants);
    // Basemap brightness — satellite or dark theme both mean a dark base,
    // so overlay labels need white text; the light Protomaps base needs
    // dark text (v634, parity with the seeker map's label-contrast rule).
    const darkBasemap = $satellite || $theme === "dark";
    const $hidingEndsAt = useStore(hidingPeriodEndsAt);
    // Whether the hiding period has elapsed (seeking underway). Drives
    // which corner the floating HiderMapTimer sits in — and, opposite it,
    // where MapNavControls dodges — so the two never overlap. One-shot
    // timeout (no per-second tick) flips it exactly when the clock ends,
    // mirroring the seeker map's Map.tsx approach.
    const [seekingStarted, setSeekingStarted] = useState(
        () => $hidingEndsAt !== null && Date.now() >= $hidingEndsAt,
    );
    useEffect(() => {
        if ($hidingEndsAt === null) {
            setSeekingStarted(false);
            return;
        }
        const delta = $hidingEndsAt - Date.now();
        if (delta <= 0) {
            setSeekingStarted(true);
            return;
        }
        setSeekingStarted(false);
        const t = setTimeout(() => setSeekingStarted(true), delta);
        return () => clearTimeout(t);
    }, [$hidingEndsAt]);
    // Transit-route overlays — same hook the seeker map uses, so the
    // hider's identical mode toggles actually fetch + render routes
    // (previously they were dead on the hider map).
    const transitFC = useTransitRouteOverlays();

    // Live "you are here" fix for the hider. Shared watch (with the seeker
    // map) writes lastKnownPosition; the blue GPS dot below reads it via
    // $gps, and the hider's trip-plan / reach features read it too.
    useSelfPositionWatch();

    // Follow Me: recenter on each new GPS fix while enabled. MapNavControls
    // (rendered below) toggles the `followMe` atom, but nothing on the hider
    // map reacted to it, so the button did nothing — this wires the same
    // auto-centering the seeker map (Map.tsx) already has. Off by default so
    // it doesn't fight manual panning.
    useEffect(() => {
        if (!$followMe || !$gps) return;
        const map = mapRef.current?.getMap();
        if (!map) return;
        map.easeTo({ center: [$gps.lng, $gps.lat], duration: 600 });
    }, [$followMe, $gps]);

    // Play-area boundary fetch — shared with the seeker map via
    // usePlayAreaBoundary (was a thinner single-attempt copy here,
    // v394; now identical 2-attempt + clip + toast behaviour).
    usePlayAreaBoundary();

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

    // The "Mark spot" affordance lives on the floating HiderMapTimer
    // (v633; was HiderTimeHeader before): it sits above the live timer
    // card and only renders when the hider is inside their committed
    // zone. The popover + handler moved there with it.

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

    // Tapped-zone highlight — parity with the seeker map's `selected-zone-*`
    // layers: the hiding-radius circle of the station the hider tapped,
    // drawn as a prominent white ring + fill + dot. Recomputed only when
    // the selection or radius changes.
    const selectedZoneFC = useMemo(() => {
        if (!$selectedStation) return null;
        try {
            // Mixed Polygon+Point FC — cast around turf's homogeneous-array
            // typing (the layers filter by geometry-type).
            return turfFeatureCollection([
                turfCircle(
                    [$selectedStation.lng, $selectedStation.lat],
                    $hidingRadius,
                    { steps: 128, units: $hidingRadiusUnits },
                ),
                turfPoint([$selectedStation.lng, $selectedStation.lat]),
            ] as never) as GeoJSON.FeatureCollection;
        } catch {
            return null;
        }
    }, [
        $selectedStation?.lat,
        $selectedStation?.lng,
        $hidingRadius,
        $hidingRadiusUnits,
    ]);

    // Dim the map OUTSIDE the play area (v752), matching the seeker map +
    // wizard preview. `holedMask` returns the world with a hole where the
    // play area is, painted as a dark fill below the boundary line + dots so
    // the playable region stays bright and everything else recedes. (The
    // hider has no question eliminations, so this is a pure play-area mask.)
    //
    // v758: computed in a DEFERRED effect, NOT a synchronous `useMemo`.
    // `holedMask` is a turf `union` + world-scale `difference` that, for a
    // large multipolygon (NYC), blocks the main thread for hundreds of ms.
    // Running it synchronously as the map MOUNTS froze the tab the instant the
    // hider view opened (the polygon is already in memory after the wizard, so
    // there was no async grace like the old hard-reload path gave). Defer it
    // off the mount/render path (rIC / macrotask) with a cancellation guard so
    // the map paints first and the mask drops in a beat later — same net
    // behaviour as the seeker map, which computes its mask inside an async pass.
    const [playAreaMask, setPlayAreaMask] =
        useState<GeoJSON.Feature | null>(null);
    useEffect(() => {
        if (!$polyGeoJSON?.features?.length) {
            setPlayAreaMask(null);
            return;
        }
        let cancelled = false;
        const compute = () => {
            if (cancelled) return;
            try {
                // Simplify the boundary before the world-scale difference —
                // the mask is a faint dimming fill and the crisp play-area
                // outline is drawn SEPARATELY on top, so a coarser mask edge
                // is invisible while the vertex cut makes `turf.difference`
                // dramatically cheaper on a dense multipolygon (NYC).
                const simplified = turfSimplify($polyGeoJSON as never, {
                    tolerance: 0.001,
                    highQuality: false,
                });
                const mask = holedMask(
                    simplified as never,
                ) as GeoJSON.Feature | null;
                if (!cancelled) setPlayAreaMask(mask);
            } catch (e) {
                console.warn("HiderBackgroundMap holedMask failed:", e);
                if (!cancelled) setPlayAreaMask(null);
            }
        };
        const ric = (
            globalThis as {
                requestIdleCallback?: (cb: () => void) => number;
            }
        ).requestIdleCallback;
        const handle = ric
            ? ric(compute)
            : (setTimeout(compute, 0) as unknown as number);
        return () => {
            cancelled = true;
            const cic = (
                globalThis as {
                    cancelIdleCallback?: (h: number) => void;
                }
            ).cancelIdleCallback;
            if (ric && cic) cic(handle);
            else clearTimeout(handle);
        };
    }, [$polyGeoJSON]);

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

    // Frame the map to the planned trip route (v650, reworked v666): the
    // straight-line route from live GPS to the tapped station can
    // otherwise sit off-screen or fully behind the bottom-anchored
    // StationTransitCard. The BOTTOM padding follows the card's live
    // measured height (`stationCardInsetPx`), so the fit re-runs when the
    // card opens/expands/collapses and keeps the GPS dot + zone in the
    // VISIBLE strip above the drawer. Signature-guarded per
    // (route, inset-bucket) so pan/zoom by the user isn't fought.
    const lastTripFitRef = useRef<string>("");
    useEffect(() => {
        const feats = $trip?.features ?? [];
        if (feats.length === 0) {
            lastTripFitRef.current = "";
            return;
        }
        let minLng = Infinity,
            minLat = Infinity,
            maxLng = -Infinity,
            maxLat = -Infinity;
        const extend = (lng: number, lat: number) => {
            if (lng < minLng) minLng = lng;
            if (lat < minLat) minLat = lat;
            if (lng > maxLng) maxLng = lng;
            if (lat > maxLat) maxLat = lat;
        };
        const walk = (arr: any) => {
            if (
                typeof arr?.[0] === "number" &&
                typeof arr?.[1] === "number"
            ) {
                extend(arr[0], arr[1]);
            } else if (Array.isArray(arr)) {
                for (const s of arr) walk(s);
            }
        };
        for (const f of feats) walk((f.geometry as any)?.coordinates);
        // Keep the hider's CURRENT position in frame too — the route's
        // origin was the GPS at plan time; the dot may have drifted.
        const gps = lastKnownPosition.get();
        if (gps) extend(gps.lng, gps.lat);
        if (!Number.isFinite(minLng) || !Number.isFinite(maxLat)) return;
        const sig =
            [minLng, minLat, maxLng, maxLat]
                .map((n) => n.toFixed(4))
                .join(",") + `|${cardInsetBucket}`;
        if (lastTripFitRef.current === sig) return;
        lastTripFitRef.current = sig;
        const map = mapRef.current?.getMap();
        if (!map) return;
        try {
            // Bottom inset = the card's height, clamped so the padding
            // always leaves a usable strip of map (fitBounds THROWS when
            // padding exceeds the viewport).
            const mapH = map.getContainer()?.clientHeight ?? 800;
            const bottom = Math.max(
                140,
                Math.min($cardInset + 40, Math.floor(mapH * 0.75)),
            );
            map.fitBounds(
                [
                    [minLng, minLat],
                    [maxLng, maxLat],
                ],
                {
                    padding: { top: 80, left: 50, right: 50, bottom },
                    maxZoom: 15,
                    duration: 600,
                },
            );
        } catch (e) {
            console.warn("[HiderBackgroundMap] trip fit failed:", e);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [$trip, cardInsetBucket]);

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
                    // Debug: "set spoof by tapping the map" — consume this
                    // tap to place the spoofed GPS at the exact point.
                    if (spoofPickMode.get()) {
                        if (setSpoofAtPoint(e.lngLat.lat, e.lngLat.lng)) {
                            toast.success("Spoofed location set.", {
                                autoClose: 1600,
                            });
                        } else {
                            toast.error(
                                "Tap inside the play area to set the spoof.",
                                { autoClose: 2200 },
                            );
                        }
                        return;
                    }
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
                    // Tier 2: no overlay feature under the tap. Resolve the
                    // tap against the game's OWN candidate-zone set (v665 —
                    // same shared play-area fetch as the overlay): the nearest
                    // station whose hiding-radius circle CONTAINS the tap.
                    // v753: GATED on the overlay being ON (`showHiderReach`),
                    // parity with the seeker map's `nearestZoneStation` (gated
                    // on `displayHidingZones`). With the overlay OFF there are
                    // no zones drawn, so a tap must NOT silently open a hidden
                    // zone's card — that was the "clickable when toggled off"
                    // bug. No-op outside the hiding period too (the hider
                    // doesn't travel after committing).
                    if (
                        !showHiderReach.get() ||
                        !hiderReachFC.get()?.features?.length
                    )
                        return;
                    const endsAt = hidingPeriodEndsAt.get();
                    if (endsAt == null || endsAt <= Date.now()) return;
                    const { lat: tapLat, lng: tapLng } = e.lngLat;
                    const radiusMeters = turfConvertLength(
                        $hidingRadius,
                        $hidingRadiusUnits,
                        "meters",
                    );
                    void (async () => {
                        const station = await findZoneAtPoint(tapLat, tapLng, {
                            allowed: allowedTransit.get(),
                            radiusMeters,
                        }).catch(() => null);
                        if (station) {
                            selectedMapStation.set({
                                lat: station.lat,
                                lng: station.lng,
                                name: station.name,
                                modes: [station.mode],
                            });
                        }
                    })();
                }}
            >
                {/* Attribution — parity with the seeker map (v633): the
                    base OSM/Protomaps credits sit top-left, out of the way
                    of the bottom timer/nav controls. License-clean: the
                    credits only need to be present + legible. */}
                <AttributionControl compact position="top-left" />
                {$satellite && (
                    <Source
                        id="satellite"
                        type="raster"
                        tiles={[`${SAT_TILE_BASE}/{z}/{y}/{x}`]}
                        tileSize={256}
                    >
                        <Layer
                            id="satellite-layer"
                            type="raster"
                            paint={{ "raster-opacity": 1 }}
                        />
                    </Source>
                )}

                {/* Dim everything OUTSIDE the play area (v752) — the same
                    treatment as the seeker map + wizard preview, so the
                    playable region reads as bright and the surroundings
                    recede. Below the boundary line + dots. */}
                {playAreaMask && (
                    <Source
                        id="hider-playarea-mask"
                        type="geojson"
                        data={playAreaMask as GeoJSON.Feature}
                    >
                        <Layer
                            id="hider-playarea-mask-fill"
                            type="fill"
                            paint={{
                                "fill-color": darkBasemap
                                    ? "#000000"
                                    : "#0f172a",
                                "fill-opacity": 0.5,
                            }}
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

                {/* Hiding-zones overlay — every candidate hiding-zone
                    station in the play area, painted as name-labeled
                    dots. v643: styled identically to the seeker's
                    `hiding-zones-*` layers (single brand-red dot + name
                    label, zoom-scaled). Reachability was dropped — it's
                    now an on-demand, per-zone check in the trip-plan card
                    that opens on tap. */}
                <FadeOverlay
                    active={Boolean($reach && $reach.features.length > 0)}
                    data={
                        reachDisplay && reachDisplay.features.length > 0
                            ? reachDisplay
                            : null
                    }
                >
                    {(data, shown) => (
                        <Source id="hider-reach" type="geojson" data={data}>
                            {/* Single UNIONED extent fill (parity with the
                                seeker's hiding-zones-fill) — the union of
                                every candidate zone's hiding-radius circle,
                                painted once at a faint uniform opacity so
                                overlapping zones don't compound into a wash. */}
                            <Layer
                                id="hider-reach-fill"
                                type="fill"
                                filter={[
                                    "any",
                                    ["==", ["geometry-type"], "Polygon"],
                                    ["==", ["geometry-type"], "MultiPolygon"],
                                ]}
                                paint={fadePaint({
                                    // Light basemap: NEUTRAL grey wash (the red
                                    // tint was too prominent). Dark/satellite:
                                    // brightening near-white wash. Matches the
                                    // seeker's hiding-zones-fill.
                                    "fill-color": !darkBasemap
                                        ? "hsl(0, 0%, 42%)"
                                        : "#f5e7e3",
                                    "fill-opacity": shown
                                        ? darkBasemap
                                            ? 0.16
                                            : 0.15
                                        : 0,
                                    "fill-opacity-transition": {
                                        duration: 280,
                                    },
                                })}
                            />
                            <Layer
                                id="hider-reach-line"
                                type="line"
                                filter={[
                                    "any",
                                    ["==", ["geometry-type"], "Polygon"],
                                    ["==", ["geometry-type"], "MultiPolygon"],
                                    ["==", ["geometry-type"], "LineString"],
                                    [
                                        "==",
                                        ["geometry-type"],
                                        "MultiLineString",
                                    ],
                                ]}
                                paint={fadePaint({
                                    "line-color": "hsl(2, 70%, 54%)",
                                    "line-width": 1.5,
                                    // v783: red dashed extent border removed on
                                    // every basemap (matches hiding-zones-line).
                                    "line-opacity": 0,
                                    "line-opacity-transition": {
                                        duration: 280,
                                    },
                                    "line-dasharray": [6, 5],
                                })}
                            />
                            <Layer
                                id="hider-reach-dots"
                                type="circle"
                                filter={["==", ["geometry-type"], "Point"]}
                                paint={fadePaint({
                                    // Zoom-scaled station dots, matching the
                                    // seeker's hiding-zones-points so a dense
                                    // network reads as a tidy field of points.
                                    "circle-radius": [
                                        "interpolate",
                                        ["linear"],
                                        ["zoom"],
                                        8,
                                        1.5,
                                        13,
                                        2.8,
                                        16,
                                        4,
                                    ],
                                    // Light-grey dots on dark/satellite,
                                    // neutral very-dark-grey on the light
                                    // basemap — byte-for-byte the seeker's
                                    // hiding-zones-points (v833: the hider's
                                    // used to be brand red, which read as a
                                    // loud field; grey matches the seeker).
                                    "circle-color": darkBasemap
                                        ? "hsl(0, 0%, 80%)"
                                        : "hsl(0, 0%, 20%)",
                                    // No stroke — the white outline read as a
                                    // halo on the light basemap.
                                    "circle-stroke-width": 0,
                                    "circle-opacity": shown ? 1 : 0,
                                    "circle-stroke-opacity": shown ? 1 : 0,
                                    "circle-opacity-transition": {
                                        duration: 280,
                                    },
                                    "circle-stroke-opacity-transition": {
                                        duration: 280,
                                    },
                                })}
                            />
                            {/* Invisible larger hit target so a tap near the
                                tiny dot opens the transit card. */}
                            <Layer
                                id="hider-reach-hit"
                                type="circle"
                                filter={["==", ["geometry-type"], "Point"]}
                                paint={{
                                    "circle-radius": 16,
                                    "circle-color": "#000000",
                                    "circle-opacity": 0,
                                }}
                            />
                            <Layer
                                id="hider-reach-labels"
                                type="symbol"
                                minzoom={11}
                                filter={["==", ["geometry-type"], "Point"]}
                                layout={{
                                    // v835: shortened label (abbreviated +
                                    // truncated) from `reachDisplay`.
                                    "text-field": [
                                        "coalesce",
                                        ["get", "shortName"],
                                        ["get", "name"],
                                        "",
                                    ],
                                    "text-size": 11,
                                    // Must be a fontstack the glyph proxy
                                    // actually serves (Protomaps = Noto Sans);
                                    // "Open Sans" 404s → no text.
                                    "text-font": ["Noto Sans Regular"],
                                    "text-anchor": "top",
                                    "text-offset": [0, 0.7],
                                    "text-allow-overlap": false,
                                    "text-optional": true,
                                }}
                                paint={fadePaint({
                                    // Follow the BASEMAP brightness (parity
                                    // with the seeker map) — white washes out
                                    // on the light basemap, so use dark text +
                                    // light halo there.
                                    "text-color": darkBasemap
                                        ? "white"
                                        : "#1F2F3F",
                                    "text-halo-color": darkBasemap
                                        ? "rgba(0,0,0,0.85)"
                                        : "rgba(255,255,255,0.9)",
                                    "text-halo-width": 1.4,
                                    "text-opacity": shown ? 1 : 0,
                                    "text-opacity-transition": {
                                        duration: 280,
                                    },
                                })}
                            />
                        </Source>
                    )}
                </FadeOverlay>

                {/* Tapped-zone highlight — parity with the seeker map's
                    `selected-zone-*` layers: a prominent white ring + fill +
                    dot on the station the hider tapped, drawn above the
                    hiding-zones overlay. */}
                {selectedZoneFC && (
                    <Source
                        id="hider-selected-zone"
                        type="geojson"
                        data={selectedZoneFC as GeoJSON.FeatureCollection}
                    >
                        <Layer
                            id="hider-selected-zone-fill"
                            type="fill"
                            filter={[
                                "any",
                                ["==", ["geometry-type"], "Polygon"],
                                ["==", ["geometry-type"], "MultiPolygon"],
                            ]}
                            paint={{
                                "fill-color": "#ffffff",
                                "fill-opacity": 0.16,
                            }}
                        />
                        <Layer
                            id="hider-selected-zone-line"
                            type="line"
                            filter={[
                                "any",
                                ["==", ["geometry-type"], "Polygon"],
                                ["==", ["geometry-type"], "MultiPolygon"],
                            ]}
                            paint={{
                                "line-color": "#ffffff",
                                "line-width": 3,
                            }}
                        />
                        <Layer
                            id="hider-selected-zone-dot"
                            type="circle"
                            filter={["==", ["geometry-type"], "Point"]}
                            paint={{
                                "circle-radius": 7,
                                "circle-color": "#ffffff",
                                "circle-stroke-color": "#1F2F3F",
                                "circle-stroke-width": 2.5,
                            }}
                        />
                    </Source>
                )}

                {/* Transit-route overlays — shared with the seeker map.
                    Above the zone/boundary fills, below the point markers
                    (GPS, seeker pins) added after this. */}
                <TransitRouteLayers transitFC={transitFC} />

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
                rotation/tilt. Dodges to the corner OPPOSITE the floating
                HiderMapTimer: bottom-right while setting up / hiding (timer
                bottom-left), bottom-left once seeking (timer bottom-right).
                Mirrors the seeker map's swap so the two never overlap. */}
            <MapNavControls
                mapRef={mapRef}
                className={cn(
                    "bottom-3",
                    seekingStarted ? "left-3" : "right-3",
                )}
            />

            {/* Top-of-map "Loading …" pills for async overlays (hiding
                zones, transit lines). Mirrors the map-options toggle
                spinners so loading is visible with the panel closed. */}
            <MapOverlayLoadingToasts />

            {/* Floating timer card — the hider's parity counterpart to the
                seeker's HiderTimer (golden hiding box / white hidden box +
                gold time-to-beat), self-positioning bottom-left/right.
                v633: replaced the old HiderTimeHeader flow-row so the hider
                map matches the seeker map. */}
            <HiderMapTimer />

            {/* v787: on-map zone-picker hint — mirrors the Zone drawer's
                "zones you're in" list + Select buttons at the top of the map
                during the hiding period, so the hider doesn't have to open the
                drawer. Self-gates (hiding period + no committed zone). */}
            <HiderZoneHint />

            {/* v632: the floating top-right map-options popover was removed.
                Map display options now live in the hider bottom-nav "Map"
                slot (HiderMapOptionsDrawer), matching the seeker surface —
                the hider nav shows on every viewport, so one entry point
                covers all sizes. */}
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
