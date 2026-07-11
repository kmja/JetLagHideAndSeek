import "maplibre-gl/dist/maplibre-gl.css";

import { useStore } from "@nanostores/react";
import {
    bbox as turfBbox,
    booleanIntersects,
    booleanPointInPolygon,
    circle as turfCircle,
    featureCollection,
    point as turfPoint,
    voronoi,
} from "@turf/turf";
import type maplibregl from "maplibre-gl";
import { Circle as CircleIcon, LocateOff } from "lucide-react";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import Map, {
    Layer,
    type MapLayerMouseEvent,
    type MapRef,
    Marker,
    Popup,
    Source,
} from "react-map-gl/maplibre";

import { useMapTilesReady } from "@/hooks/useMapTilesReady";
import {
    lastKnownPosition,
    mapGeoLocation,
    questionFinishedMapData,
} from "@/lib/context";
import { satelliteView } from "@/lib/gameSetup";
import { SAT_TILE_BASE } from "@/maps/api/constants";
import {
    installMissingImageHandler,
    pmtilesUrl,
    protomapsMapLibreStyle,
} from "@/lib/protomapsStyle";
import { type ImpactMode, useQuestionImpact } from "@/lib/questionImpact";
import { findSubtypeMeta } from "@/lib/subtypes";
import { resolvedTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { holedMask } from "@/maps";

import { ConfigureDialogContext } from "./configureDialogContext";
import { MapNavControls } from "./MapNavControls";
import { MapTilesVeil } from "./MapTilesVeil";
import { SelfPositionMarker } from "./SelfPositionMarker";

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
    disabled = false,
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
    /**
     * Read-only / immutable mode. When true the picker never moves the
     * pin: the on-mount GPS auto-seed is skipped, map taps are ignored
     * and the pin is non-draggable. Set by the question cards once a
     * question is committed (`!isQuestionEditable(data)`) so a sent
     * question's location can never be re-derived from live (possibly
     * spoofed) GPS on a later re-mount. This was the v390 bug: an
     * answered radar question's coordinates were being overwritten by
     * the seeker's current position every time its card re-mounted,
     * silently relocating the eliminated area after reload.
     */
    disabled?: boolean;
}) {
    const mapRef = useRef<MapRef | null>(null);
    const $maskData = useStore(questionFinishedMapData);
    const $playArea = useStore(mapGeoLocation);
    const $satellite = useStore(satelliteView);
    // v317: switched from raster tiles via `baseTileLayer` to the
    // Protomaps vector flavor + `resolvedTheme` so this picker
    // follows the same light/dark setting the rest of the maps do.
    const $pmtilesUrl = useStore(pmtilesUrl);
    const $theme = useStore(resolvedTheme);

    // Question-impact overlay (v239). Only computed when the caller
    // opts in (matching/measuring/tentacles configure dialogs).
    const impact = useQuestionImpact(
        latitude,
        longitude,
        impactType ?? "",
        impactMode ?? "matching",
        tentacleRadiusKm,
    );
    // v371: the candidate icon for this question's subtype (e.g.
    // museum → Landmark). Falls back to the matching-category neutral
    // Equal icon if the subtype isn't tabled — same default the
    // SubtypeTile uses when a meta is missing.
    const candidateIcon = useMemo(() => {
        const meta = impactType ? findSubtypeMeta(impactType) : null;
        return meta?.icon ?? null;
    }, [impactType]);
    const candidatePoints = impact?.candidates ?? null;

    // Which reference dots to PLOT. The baseline is "references whose
    // point falls inside the remaining possible hiding area" ($maskData =
    // play area minus every already-eliminated region) — as questions
    // narrow the map this drops the marker (and DOM-node) count sharply
    // and focuses the seeker on references that can still matter. The
    // impact MATH in useQuestionImpact deliberately keeps the FULL
    // play-area candidate set (nearest reference, voronoi cell and
    // measuring buffer all depend on neighbours that may sit in
    // already-eliminated land), so this is display-only.
    //
    // v475: matching also surfaces references whose VORONOI CELL overlaps
    // the remaining area even when the reference point itself sits just
    // outside it. Those are exactly the references that flip the =/≠
    // shading near the area's edge (the "park just outside the right edge
    // owns part of the remaining area" case) — leaving them unmarked made
    // the shading look like it changed for no visible reason. We build the
    // Voronoi over the full candidate set and keep any cell that
    // intersects the remaining-area polygons.
    //
    // Graceful-degrades to the full set while the remaining-area polygon
    // is still resolving, or if it can't be reduced to polygons.
    const visibleCandidates = useMemo(() => {
        if (!candidatePoints || candidatePoints.length === 0)
            return candidatePoints;
        if (!$maskData) return candidatePoints;
        const polys: GeoJSON.Feature[] = [];
        const collect = (g: GeoJSON.GeoJSON | null | undefined) => {
            if (!g) return;
            if (g.type === "FeatureCollection") g.features.forEach(collect);
            else if (g.type === "Feature") {
                const t = g.geometry?.type;
                if (t === "Polygon" || t === "MultiPolygon") polys.push(g);
            }
        };
        collect($maskData as GeoJSON.GeoJSON);
        if (polys.length === 0) return candidatePoints;

        const keep = new Set<number>();
        candidatePoints.forEach((c, i) => {
            const pt: [number, number] = [c.lng, c.lat];
            if (
                polys.some((p) => {
                    try {
                        return booleanPointInPolygon(pt, p as never);
                    } catch {
                        return false;
                    }
                })
            ) {
                keep.add(i);
            }
        });

        // Voronoi-influence pass (matching only). A cell that intersects
        // the remaining area but whose site is OUTSIDE it means that
        // outside reference is the nearest one for part of the area — mark
        // it. Matched by point-in-cell rather than array index so it's
        // robust to turf's cell ordering.
        if (impactMode === "matching" && candidatePoints.length >= 2) {
            try {
                const fc = featureCollection(
                    candidatePoints.map((c) => turfPoint([c.lng, c.lat])),
                );
                const bb = turfBbox(fc);
                const padX = (bb[2] - bb[0]) * 0.5 + 0.02;
                const padY = (bb[3] - bb[1]) * 0.5 + 0.02;
                const cells =
                    voronoi(fc, {
                        bbox: [
                            bb[0] - padX,
                            bb[1] - padY,
                            bb[2] + padX,
                            bb[3] + padY,
                        ],
                    })?.features ?? [];
                for (const cell of cells) {
                    if (!cell?.geometry) continue;
                    const hits = polys.some((p) => {
                        try {
                            return booleanIntersects(cell, p as never);
                        } catch {
                            return false;
                        }
                    });
                    if (!hits) continue;
                    for (let i = 0; i < candidatePoints.length; i++) {
                        if (keep.has(i)) continue;
                        const c = candidatePoints[i];
                        try {
                            if (
                                booleanPointInPolygon(
                                    [c.lng, c.lat],
                                    cell as never,
                                )
                            ) {
                                keep.add(i);
                                break;
                            }
                        } catch {
                            /* skip */
                        }
                    }
                }
            } catch (e) {
                console.warn("[impact] voronoi visibility pass failed:", e);
            }
        }

        return candidatePoints.filter((_, i) => keep.has(i));
    }, [candidatePoints, $maskData, impactMode]);

    const [gpsState, setGpsState] = useState<"unknown" | "granted" | "denied">(
        "unknown",
    );

    const didGpsRef = useRef(false);
    useEffect(() => {
        // Immutable/committed question: never auto-move the pin. We
        // return WITHOUT latching didGpsRef so that if `disabled` later
        // flips false (an editable question that mounted while a global
        // fetch was in flight), the seed can still run exactly once.
        if (disabled) return;
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
    }, [disabled]);

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
            // When a reference point exists (matching / measuring), the
            // reference-fit effect below frames the pin + reference
            // TOGETHER — don't fight it by zooming to the pin alone. For
            // radar, zoom to fit the whole radius circle, not a fixed 13.
            if (map && !referencePoint) {
                map.flyTo({
                    center: [safeLng, safeLat],
                    zoom: radiusMeters
                        ? zoomForRadius(radiusMeters)
                        : Math.max(map.getZoom(), 13),
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

    // Radar: reframe to fit the whole radius circle whenever the RADIUS
    // changes — i.e. the seeker picked a different preset size. Guarded on
    // the radius value so dragging the pin (which also moves safeLat/Lng)
    // doesn't yank the camera; only a genuine size change reframes. The
    // very first radius is already framed by initialViewState's
    // zoomForRadius, so we skip that and only animate later changes.
    const lastRadiusRef = useRef<number | undefined>(undefined);
    useEffect(() => {
        if (radiusMeters == null || radiusMeters <= 0) {
            lastRadiusRef.current = radiusMeters ?? undefined;
            return;
        }
        if (lastRadiusRef.current === radiusMeters) return;
        const isFirst = lastRadiusRef.current === undefined;
        lastRadiusRef.current = radiusMeters;
        if (isFirst) return;
        const map = mapRef.current?.getMap();
        if (!map) return;
        try {
            const circle = turfCircle([safeLng, safeLat], radiusMeters / 1000, {
                steps: 64,
                units: "kilometers",
            });
            const [minX, minY, maxX, maxY] = turfBbox(circle);
            map.fitBounds(
                [
                    [minX, minY],
                    [maxX, maxY],
                ],
                { padding: 32, duration: 400 },
            );
        } catch {
            /* ignore — map may not be ready */
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [radiusMeters, safeLat, safeLng]);

    // v370: invert `$maskData` (the in-scope WORKING polygon — play area
    // minus eliminations) into the dark cover the layer actually wants
    // to draw. Without this, the fill paints ON the play area itself
    // rather than around it — visibly inverted on a radar question,
    // where there's no impact overlay on top to hide the mistake. Same
    // pattern + same helper Map.tsx uses (line 829), just done here
    // because the picker reads a different atom. Memo'd so a steady
    // play area doesn't recompute every render.
    const maskInverted = useMemo(() => {
        if (!$maskData) return null;
        try {
            return holedMask($maskData as never) as GeoJSON.Feature | null;
        } catch (e) {
            console.warn("InlineLocationPicker holedMask failed:", e);
            return null;
        }
    }, [$maskData]);

    // Smoothly grow/shrink the radius circle when the size changes (v747),
    // so the overlay animates in step with the camera's animated fitBounds
    // above instead of snapping. Tween the RENDERED radius over ~420 ms with
    // an ease-out cubic; a fresh mount / null radius / pin drag snaps (the
    // effect only runs on a real radius change). MapLibre GeoJSON sources
    // don't tween geometry natively, so we drive it via requestAnimationFrame.
    const [animatedRadius, setAnimatedRadius] = useState<number>(
        radiusMeters && radiusMeters > 0 ? radiusMeters : 0,
    );
    const radiusAnimRef = useRef<number | undefined>(undefined);
    useEffect(() => {
        const target = radiusMeters && radiusMeters > 0 ? radiusMeters : 0;
        const from = radiusAnimRef.current;
        radiusAnimRef.current = target;
        // Snap on first value, no change, or when clearing to 0 (radar off).
        if (from === undefined || from === target || target === 0) {
            setAnimatedRadius(target);
            return;
        }
        const DURATION = 420;
        const ease = (t: number) => 1 - Math.pow(1 - t, 3);
        let raf = 0;
        let startTs: number | null = null;
        const step = (ts: number) => {
            if (startTs === null) startTs = ts;
            const t = Math.min(1, (ts - startTs) / DURATION);
            setAnimatedRadius(from + (target - from) * ease(t));
            if (t < 1) raf = requestAnimationFrame(step);
        };
        raf = requestAnimationFrame(step);
        return () => cancelAnimationFrame(raf);
    }, [radiusMeters]);

    // Pre-compute the radius circle as a turf polygon from the ANIMATED
    // radius; cheaper than re-running on every render.
    const radiusCircle = useMemo(() => {
        if (animatedRadius == null || animatedRadius <= 0) return null;
        return turfCircle([safeLng, safeLat], animatedRadius / 1000, {
            steps: 64,
            units: "kilometers",
        });
    }, [safeLat, safeLng, animatedRadius]);

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
    const interactionsAllowed =
        !disabled && (!lockToGps || gpsState !== "granted");

    const handleClick = (e: MapLayerMouseEvent) => {
        if (!interactionsAllowed) return;
        onChange(e.lngLat.lat, e.lngLat.lng);
    };

    // v317: register the matching-impact pattern tiles (= for the
    // same-as region, ≠ for the different region) on map load.
    // Earlier this was a green/red colour wash, which read as a
    // success/fail diff rather than "two equally valid regions
    // with different consequences". Neutral grey backgrounds
    // carry the equals / not-equals glyph in a contrasting tone.
    //
    // v392: same neutral treatment for measuring — < (closer) and >
    // (further), comparing distance-to-nearest-X. Was red/green, which
    // again read as success/fail. Lighter grey for the "yes" region
    // (closer / same nearest), darker for "no" (further / different).
    const registerImpactPatterns = (map: maplibregl.Map) => {
        if (!map.hasImage("match-yes-pattern")) {
            map.addImage("match-yes-pattern", makePatternImage("="), {
                pixelRatio: 2,
            });
        }
        if (!map.hasImage("match-no-pattern")) {
            map.addImage("match-no-pattern", makePatternImage("≠"), {
                pixelRatio: 2,
            });
        }
        if (!map.hasImage("measure-yes-pattern")) {
            map.addImage("measure-yes-pattern", makePatternImage("<"), {
                pixelRatio: 2,
            });
        }
        if (!map.hasImage("measure-no-pattern")) {
            map.addImage("measure-no-pattern", makePatternImage(">"), {
                pixelRatio: 2,
            });
        }
    };

    // Reveal gate (v260): hold a veil until tiles paint AND any
    // reference / impact markers this preview is meant to show are in.
    // A reference point is a prop (sync); the impact candidates resolve
    // from the prefetched cache, so we wait on those when an impact
    // overlay was requested. Timeout-guarded so a missing reference
    // never strands the picker.
    const referenceReady =
        !referencePoint ||
        (Number.isFinite(referencePoint.lat) &&
            Number.isFinite(referencePoint.lng));
    const impactReady = !impactMode || impact !== null;
    const { showVeil, timedOut, onLoad, onIdle } = useMapTilesReady({
        dataReady: referenceReady && impactReady,
        resetKey: `${referencePoint?.lat ?? ""},${referencePoint?.lng ?? ""},${impactMode ?? ""}`,
    });

    // v371: emit combined readiness to AddQuestionDialog via Context so
    // its Send button can wait on the same gate the loading veil watches.
    // `showVeil` flips false once the data is ready AND tiles have
    // painted (or `timedOut` ran out — let the user proceed rather than
    // strand them). `pinReady` ensures we don't claim "ready" before a
    // finite coordinate exists; without it a configure dialog opened with
    // the 0,0 sentinel would enable Send before GPS / place-search had
    // landed. Pickers mounted OUTSIDE the configure dialog (in-list
    // display cards, hider preview) see no context and emit nothing.
    const pinReady =
        Number.isFinite(latitude) &&
        Number.isFinite(longitude) &&
        !(latitude === 0 && longitude === 0);
    const ready = pinReady && (!showVeil || timedOut);
    const cfgCtx = useContext(ConfigureDialogContext);
    useEffect(() => {
        cfgCtx?.onPickerReady(ready);
    }, [ready, cfgCtx]);

    // v747: report WHICH load steps are still pending, so the dialog can show
    // a labelled loading state ("Loading map…", "Getting your location…")
    // instead of a blank skeleton. Keyed on a stable joined string so we only
    // emit on a real change (avoids a per-render context write loop).
    const loadingLabels = useMemo(() => {
        const labels: string[] = [];
        if (!pinReady) labels.push("Getting your location…");
        if (referencePoint && !referenceReady)
            labels.push("Finding your nearest reference…");
        if (impactMode && !impactReady)
            labels.push("Calculating question impact…");
        if (
            pinReady &&
            referenceReady &&
            impactReady &&
            showVeil &&
            !timedOut
        )
            labels.push("Loading map…");
        return labels;
    }, [
        pinReady,
        referencePoint,
        referenceReady,
        impactMode,
        impactReady,
        showVeil,
        timedOut,
    ]);
    const loadingKey = loadingLabels.join("|");
    useEffect(() => {
        cfgCtx?.onLoadingStatus?.(loadingKey ? loadingKey.split("|") : []);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loadingKey, cfgCtx]);

    // Memoise the MapLibre style so an inline `mapStyle={{...}}`
    // doesn't get rebuilt on every parent re-render. Without this,
    // the 1 Hz countdown tick in the hider's `HiderHome` re-renders
    // this component once a second, hands MapLibre a new style
    // object reference, and triggers a setStyle() pass that tears
    // down and re-creates every Source/Layer — including the
    // radius circle, which is what the hider saw as a once-a-
    // second flicker on the hiding-zone preview.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const mapStyle = useMemo(
        () =>
            protomapsMapLibreStyle($theme === "dark" ? "dark" : "light"),
        [$pmtilesUrl, $theme],
    );

    return (
        <div className="space-y-2">
            <div
                className={cn(
                    "relative w-full rounded-md overflow-hidden border border-border",
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
                    onLoad={(e) => {
                        installMissingImageHandler(e.target);
                        onLoad();
                        registerImpactPatterns(e.target);
                    }}
                    onIdle={onIdle}
                    mapStyle={mapStyle}
                >
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
                    {/* Elimination mask. Same dark cover as the
                        Leaflet version (#0f172a, ~55% opacity). v370:
                        feeds the INVERTED (holed) polygon so we shade
                        the WORLD around the play area, not the play
                        area itself. */}
                    {maskInverted && (
                        <Source
                            id="mask"
                            type="geojson"
                            data={maskInverted as GeoJSON.Feature}
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
                        mini-map). v392: matching uses =/≠ tile patterns,
                        measuring uses </> tile patterns (closer/further),
                        both on neutral grey. Tentacles still uses a
                        red/green wash because its semantics are a hard
                        reach/no-reach cut (no "two valid sides" framing
                        to preserve). Order: "no" region first so the
                        "yes" sits on top. */}
                    {impactMode && impact?.no && (
                        <Source
                            id="impact-no"
                            type="geojson"
                            data={impact.no as GeoJSON.Feature}
                        >
                            <Layer
                                id="impact-no-fill"
                                type="fill"
                                paint={
                                    impactMode === "matching"
                                        ? {
                                              "fill-pattern":
                                                  "match-no-pattern",
                                              "fill-opacity": 0.4,
                                          }
                                        : impactMode === "measuring"
                                          ? {
                                                "fill-pattern":
                                                    "measure-no-pattern",
                                                "fill-opacity": 0.4,
                                            }
                                          : {
                                                "fill-color":
                                                    "hsl(0, 75%, 50%)",
                                                "fill-opacity": 0.18,
                                            }
                                }
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
                                paint={
                                    impactMode === "matching"
                                        ? {
                                              "fill-pattern":
                                                  "match-yes-pattern",
                                              "fill-opacity": 0.55,
                                          }
                                        : impactMode === "measuring"
                                          ? {
                                                "fill-pattern":
                                                    "measure-yes-pattern",
                                                "fill-opacity": 0.55,
                                            }
                                          : {
                                                "fill-color":
                                                    "hsl(140, 65%, 48%)",
                                                "fill-opacity": 0.25,
                                            }
                                }
                            />
                            <Layer
                                id="impact-yes-line"
                                type="line"
                                paint={{
                                    // Lighter fills now → lean on a crisp
                                    // boundary line so the closer/further
                                    // (same/different) divide stays legible.
                                    "line-color":
                                        impactMode === "matching" ||
                                        impactMode === "measuring"
                                            ? "hsl(220, 10%, 92%)"
                                            : "hsl(140, 65%, 32%)",
                                    "line-width": 2.5,
                                    "line-opacity": 0.95,
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
                    {/* v371: candidate dots are now subtype-icon markers
                        (museum→Landmark, etc.) drawn as HTML overlays,
                        clipped to the play area by the v371 filter in
                        useQuestionImpact. Smaller candidate count after
                        the polygon clip + simple icons keep this cheap.
                        Falls through to nothing when we have no icon for
                        the subtype (radius/tentacles don't render points
                        anyway). */}
                    {impactMode && candidateIcon && visibleCandidates &&
                        visibleCandidates.map((c, i) => {
                            const Icon = candidateIcon;
                            return (
                                <Marker
                                    key={`cand-${i}-${c.lat.toFixed(5)}-${c.lng.toFixed(5)}`}
                                    longitude={c.lng}
                                    latitude={c.lat}
                                    anchor="center"
                                >
                                    <div
                                        title={c.name}
                                        className={cn(
                                            "flex items-center justify-center",
                                            "w-5 h-5 rounded-full",
                                            "bg-background/85 border border-foreground/40",
                                            "shadow-sm",
                                        )}
                                    >
                                        <Icon
                                            size={12}
                                            strokeWidth={2.4}
                                            className="text-foreground/85"
                                        />
                                    </div>
                                </Marker>
                            );
                        })}
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
                            // v347: when the pin represents the user's
                            // own LIVE GPS position (lock-to-GPS mode +
                            // a real fix), render it as the canonical
                            // SelfPositionMarker — anchored center —
                            // for visual consistency with every other
                            // "my position" rendering. When the pin is
                            // a freely-pickable location (free mode, or
                            // locked-mode fallback before GPS arrives),
                            // keep the teardrop — that's "the point
                            // you're placing", not "you are here".
                            anchor={
                                lockToGps && !interactionsAllowed
                                    ? "center"
                                    : "bottom"
                            }
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
                            {lockToGps && !interactionsAllowed ? (
                                <SelfPositionMarker />
                            ) : (
                                <div
                                    className="jl-picker-pin"
                                    style={{
                                        width: 28,
                                        height: 38,
                                        cursor: interactionsAllowed
                                            ? "grab"
                                            : "default",
                                    }}
                                    dangerouslySetInnerHTML={{
                                        __html: PIN_SVG,
                                    }}
                                />
                            )}
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
                                    anchor="bottom"
                                >
                                    <div
                                        className="jl-ref-marker"
                                        style={{ width: 22, height: 28 }}
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
                {/* Reset-rotation-and-tilt only — there's no live GPS
                    track on the inline picker, so a follow-me toggle
                    would just confuse. */}
                <MapNavControls
                    mapRef={mapRef}
                    showFollowMe={false}
                    className="right-2 bottom-2"
                />
                <MapTilesVeil visible={showVeil} rounded timedOut={timedOut} />
            </div>
            {/* v317: dropped the coords + Use GPS row that used to sit
                here. The picker's lockToGps mode (configure-dialog
                path) already auto-grabs the fix on mount; the raw
                lat/lng readout was noise and the "Use GPS" button
                was redundant with that. */}
            {gpsState === "denied" && !coordsAreSet && (
                <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground italic">
                    <LocateOff className="w-3 h-3 shrink-0" />
                    <span>
                        GPS unavailable — tap the map to drop a pin.
                    </span>
                </div>
            )}
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

// v317: the reference marker matches the MapPin icon used in the
// "Your nearest reference" header pill — concentric-circles target
// glyph used to leave the seeker comparing two visually different
// markers for the same concept. Drop-shaped pin in brand red.
const REF_SVG = `
<svg width="22" height="28" viewBox="0 0 22 28" xmlns="http://www.w3.org/2000/svg">
  <path d="M11 0C4.92 0 0 4.92 0 11c0 8.25 11 17 11 17s11-8.75 11-17C22 4.92 17.08 0 11 0z" fill="hsl(2, 70%, 54%)" stroke="white" stroke-width="2"/>
  <circle cx="11" cy="11" r="4" fill="white"/>
</svg>
`.trim();

/**
 * v317: build a small canvas tile carrying the equality or
 * inequality glyph on a neutral grey backdrop. MapLibre's
 * `addImage` accepts ImageData with width/height/data; the
 * pixelRatio:2 we pass at the call-site keeps the glyph crisp on
 * high-DPI screens. Two shades of grey distinguish the regions
 * without leaning on green/red success/fail semantics.
 */
function makePatternImage(
    symbol: "=" | "≠" | "<" | ">",
): maplibregl.StyleImageInterface {
    const size = 28;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
        return {
            width: size,
            height: size,
            data: new Uint8ClampedArray(size * size * 4),
        };
    }
    // Backdrop colour shades the two regions differently so the
    // border between the "yes" and "no" sides reads at a glance even
    // before the glyph is parsed. Yes (= / <) → lighter, no (≠ / >) →
    // darker, both neutral. Glyph colour flips to keep contrast.
    const isYes = symbol === "=" || symbol === "<";
    ctx.fillStyle = isYes
        ? "rgba(148, 163, 184, 0.55)"
        : "rgba(71, 85, 105, 0.6)";
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = isYes
        ? "rgba(15, 23, 42, 0.85)"
        : "rgba(241, 245, 249, 0.9)";
    ctx.font = "bold 18px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(symbol, size / 2, size / 2 + 1);
    return ctx.getImageData(0, 0, size, size);
}

export default InlineLocationPicker;
