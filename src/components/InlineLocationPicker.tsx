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
import { Circle as CircleIcon, type LucideIcon, LocateOff } from "lucide-react";
import {
    createElement,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Map, {
    Layer,
    type MapLayerMouseEvent,
    type MapRef,
    Marker,
    Popup,
    Source,
} from "react-map-gl/maplibre";

import { TransitRouteLayers } from "@/components/TransitRouteLayers";
import { useMapTilesReady } from "@/hooks/useMapTilesReady";
import { useTransitRouteOverlays } from "@/hooks/useTransitRouteOverlays";
import {
    displayHidingZones,
    hidingZonesGeoJSON,
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
import { iconForSubtype } from "@/lib/subtypes";
import { resolvedTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { holedMask } from "@/maps";
import { attachBasemapWaterCapture } from "@/maps/api/basemapWater";
import { trainLineForPoint } from "@/maps/questions/matching";

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

/**
 * v864: for a MATCHING question the answer is only "same" (the pin's NEAREST
 * reference — whose Voronoi cell IS the same-region) or "different" (everything
 * else). So plotting the whole field of parks/POIs is noise. Return the indices
 * of just the nearest reference PLUS the references whose Voronoi cells BORDER
 * it — those are exactly the ones that draw the same/different boundary around
 * the answer. Far-away references are all "different" and don't move that
 * border, so they're dropped. Returns null on any failure (caller falls back to
 * the full/remaining-area set).
 */
function matchingBorderIndices(
    candidates: { lat: number; lng: number }[],
    anchor: { lat: number; lng: number },
): number[] | null {
    if (candidates.length < 2) return null;
    try {
        // Nearest candidate to the pin — the "same" reference.
        let nearIdx = 0;
        let nearD = Infinity;
        for (let i = 0; i < candidates.length; i++) {
            const dx = candidates[i].lng - anchor.lng;
            const dy = candidates[i].lat - anchor.lat;
            const d = dx * dx + dy * dy;
            if (d < nearD) {
                nearD = d;
                nearIdx = i;
            }
        }
        const fc = featureCollection(
            candidates.map((c) => turfPoint([c.lng, c.lat])),
        );
        const bb = turfBbox(fc);
        const padX = (bb[2] - bb[0]) * 0.5 + 0.02;
        const padY = (bb[3] - bb[1]) * 0.5 + 0.02;
        const cells =
            voronoi(fc, {
                bbox: [bb[0] - padX, bb[1] - padY, bb[2] + padX, bb[3] + padY],
            })?.features ?? [];
        if (cells.length === 0) return null;
        // turf voronoi USUALLY returns cells in input order, but that isn't
        // guaranteed — verify the fast path, search on a miss.
        const cellForSite = (i: number): GeoJSON.Feature | null => {
            const pt: [number, number] = [candidates[i].lng, candidates[i].lat];
            const fast = cells[i];
            if (fast?.geometry) {
                try {
                    if (booleanPointInPolygon(pt, fast as never)) return fast;
                } catch {
                    /* fall through to search */
                }
            }
            return (
                cells.find((cell) => {
                    if (!cell?.geometry) return false;
                    try {
                        return booleanPointInPolygon(pt, cell as never);
                    } catch {
                        return false;
                    }
                }) ?? null
            );
        };
        const nearCell = cellForSite(nearIdx);
        if (!nearCell) return null;
        const keep = new Set<number>([nearIdx]);
        for (let i = 0; i < candidates.length; i++) {
            if (i === nearIdx) continue;
            const cell = cellForSite(i);
            if (!cell) continue;
            try {
                if (booleanIntersects(cell, nearCell)) keep.add(i);
            } catch {
                /* skip */
            }
        }
        return [...keep];
    } catch (e) {
        console.warn("[impact] matching border pass failed:", e);
        return null;
    }
}

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
    impactAdminLevel,
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
    /** Admin level for the matching zone/letter-zone overlay (v840). */
    impactAdminLevel?: number;
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
    // v997: gate the measuring-icon `addImage` registration on the map actually
    // being loaded — the effect below runs while the map is still initialising,
    // so without this it bailed at `!map` and never re-ran (icons stayed dots).
    const [mapReady, setMapReady] = useState(false);
    const $maskData = useStore(questionFinishedMapData);
    const $playArea = useStore(mapGeoLocation);
    const $satellite = useStore(satelliteView);
    // v767: carry the main map's ACTIVE hiding-zones overlay into the
    // preview too (like satellite + transit lines already do), so the
    // preview matches the real map. Uses the already-computed
    // `hidingZonesGeoJSON` atom — no recompute — gated on the toggle.
    const $showHidingZones = useStore(displayHidingZones);
    const $hidingZones = useStore(hidingZonesGeoJSON);
    // v747: carry the seeker/hider map's ACTIVE transit-line overlays into the
    // configure/preview map too, so the preview matches the real map. The hook
    // only fetches modes toggled ON (already cached by the main map), so it's a
    // no-op when no transit overlay is active.
    const transitFC = useTransitRouteOverlays();
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
        // Only feed a real subtype when the overlay is actually active
        // (impactMode set = configure dialog). Otherwise pass "" so the
        // hook resolves to no family and runs NO geometry work — the
        // v840 region/line families fetch from Overpass on compute, and
        // a locked/display card must never trigger that.
        impactMode ? (impactType ?? "") : "",
        impactMode ?? "matching",
        tentacleRadiusKm,
        impactAdminLevel,
    );
    // v371: the candidate icon for this question's subtype (e.g.
    // museum → Landmark). Falls back to the matching-category neutral
    // Equal icon if the subtype isn't tabled — same default the
    // SubtypeTile uses when a meta is missing.
    const candidateIcon = useMemo(() => {
        return impactType ? iconForSubtype(impactType) : null;
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
        // v981: a dense measuring reference (NYC parks — hundreds/thousands)
        // was plotted as hundreds of React <Marker>s, which FROZE the main
        // thread while the configure dialog opened (the reported park freeze;
        // the elimination buffer itself is already off-thread). The dots are
        // only a density hint, so cap them to the nearest N to the pin — the
        // buffered "closer/further" region (the actual answer) still uses the
        // FULL candidate set in the impact math.
        const MEASURING_MARKER_CAP = 120;
        const capMeasuring = (
            list: typeof candidatePoints,
        ): typeof candidatePoints => {
            if (
                !list ||
                impactMode !== "measuring" ||
                list.length <= MEASURING_MARKER_CAP
            ) {
                return list;
            }
            return [...list]
                .map((c) => {
                    const dLng = c.lng - longitude;
                    const dLat = c.lat - latitude;
                    return { c, d: dLng * dLng + dLat * dLat };
                })
                .sort((a, b) => a.d - b.d)
                .slice(0, MEASURING_MARKER_CAP)
                .map((x) => x.c);
        };
        if (!candidatePoints || candidatePoints.length === 0)
            return candidatePoints;
        // same-train-line: the question is about the nearest LINE, which is
        // drawn on its own (trainLineFC) — plotting the nearest STATION dot
        // reads as "a station on a line" and confuses the answer. Show no
        // candidate dots; the highlighted line IS the reference.
        if (impactType === "same-train-line") return null;
        // v864: matching → show ONLY the pin's nearest reference + the ones
        // whose Voronoi cells border it (the same/different boundary). The
        // whole park/POI field is otherwise plotted for a question whose
        // answer is just "same" or "different". Falls through on any failure.
        if (
            impactMode === "matching" &&
            referencePoint &&
            candidatePoints.length >= 2
        ) {
            const idx = matchingBorderIndices(candidatePoints, referencePoint);
            if (idx && idx.length >= 1) {
                const set = new Set(idx);
                return candidatePoints.filter((_, i) => set.has(i));
            }
        }
        if (!$maskData) return capMeasuring(candidatePoints);
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
        if (polys.length === 0) return capMeasuring(candidatePoints);

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

        return capMeasuring(candidatePoints.filter((_, i) => keep.has(i)));
    }, [
        candidatePoints,
        $maskData,
        impactMode,
        impactType,
        referencePoint,
        latitude,
        longitude,
    ]);

    // v981: a MEASURING reference field can be hundreds/thousands of points
    // (NYC parks). Rendering them as React <Marker>s froze the main thread —
    // so measuring plots them as ONE GPU `circle` layer (like the hiding-zones
    // dots) that handles any count with zero React overhead. The buffered
    // closer/further region (the actual answer) is drawn separately; these
    // dots are just the density hint. Matching/tentacles keep the labelled
    // icon markers (few after the border/reach filter). Uses the FULL
    // candidate set (not the capped `visibleCandidates`) since the GPU doesn't
    // care about count.
    const measuringDotsFC = useMemo(() => {
        if (
            impactMode !== "measuring" ||
            !candidatePoints ||
            candidatePoints.length === 0
        ) {
            return null;
        }
        // v1012: DON'T plot candidate dots for the full-geometry water families
        // (body-of-water / coastline). Their "candidates" are water-body / sea
        // centroids, but the closer/further overlay buffers the actual water
        // GEOMETRY — so a dot on a small pond that the buffer doesn't include
        // reads as a water marker that "doesn't affect the math" (confusing, per
        // the user). The overlay region IS the answer; the dots only add noise.
        if (
            impactType === "body-of-water" ||
            impactType === "coastline" ||
            impactType === "sea-level"
        ) {
            return null;
        }
        return {
            type: "FeatureCollection",
            features: candidatePoints.map((c) => ({
                type: "Feature",
                properties: {},
                geometry: {
                    type: "Point",
                    coordinates: [c.lng, c.lat],
                },
            })),
        } as GeoJSON.FeatureCollection;
    }, [impactMode, impactType, candidatePoints]);

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

    // v877: for the same-train-line question, draw the actual rail LINE the
    // pin's nearest station sits on (the config map otherwise shows only the
    // station dot). Fetched off the elimination path via `trainLineForPoint`;
    // [] / null → nothing drawn.
    const [trainLineFC, setTrainLineFC] =
        useState<GeoJSON.FeatureCollection | null>(null);
    useEffect(() => {
        if (!impactMode || impactType !== "same-train-line" || !coordsAreSet) {
            setTrainLineFC(null);
            return;
        }
        let cancelled = false;
        void trainLineForPoint(safeLat, safeLng).then((features) => {
            if (cancelled) return;
            setTrainLineFC(
                features.length
                    ? { type: "FeatureCollection", features }
                    : null,
            );
        });
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [impactMode, impactType, coordsAreSet, safeLat, safeLng]);

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
    // v392: same neutral treatment for measuring — − (closer) and +
    // (further), comparing distance-to-nearest-X. Was red/green, which
    // again read as success/fail; v1003 swapped the </> arrows for −/+ —
    // minus = LESS distance (closer), plus = MORE distance (further).
    // Lighter grey for the "yes" region (closer / same nearest), darker for
    // "no" (further / different).
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
            map.addImage("measure-yes-pattern", makePatternImage("−"), {
                pixelRatio: 2,
            });
        }
        if (!map.hasImage("measure-no-pattern")) {
            map.addImage("measure-no-pattern", makePatternImage("+"), {
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
    // v1013: hold the veil until the overlay is actually DRAWABLE, not just
    // until `impact` first exists. For the full-geometry families
    // (body-of-water / coastline / measuring-geom / matching-region /
    // sea-level) `impact.loading` stays true while the buffer/region computes,
    // so revealing on `impact !== null` alone showed a bare map for a beat and
    // the overlay "came in after" (the reported bug). Waiting on `!loading`
    // reveals the map WITH its overlay. The 6 s dialog backstop
    // (`AddQuestionDialog`) + the picker's own 12 s tile timeout still prevent a
    // deadlock if a compute stalls.
    const impactReady =
        !impactMode || (impact !== null && !impact.loading);
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

    // Tentacle reach partitioned into per-reference Voronoi cells, each
    // shaded a distinct purple, so the seeker reads which slice of the
    // reach maps to which candidate (v771). Colour is baked onto each
    // feature so one data-driven fill layer paints them all.
    const reachCellsFC = useMemo(() => {
        const cells = impact?.reachCells;
        if (!cells || cells.length === 0) return null;
        return {
            type: "FeatureCollection" as const,
            features: cells.map((rc, i) => ({
                ...(rc.cell as GeoJSON.Feature),
                properties: {
                    ...((rc.cell as GeoJSON.Feature).properties ?? {}),
                    fill: PURPLE_CELL_SHADES[i % PURPLE_CELL_SHADES.length],
                    cellName: rc.name,
                },
            })),
        } as GeoJSON.FeatureCollection;
    }, [impact?.reachCells]);

    // Basemap brightness drives the hiding-zones palette, exactly like the
    // main map (Map.tsx): neutral grey on the light Protomaps basemap,
    // brand red / near-white wash over satellite + dark.
    const darkBasemap = $satellite || $theme === "dark";
    const showHidingZonesOverlay =
        $showHidingZones &&
        !!$hidingZones &&
        $hidingZones.features.length > 0;

    // v988: register the measuring subtype icon as a map image so the reference
    // field renders as a GPU symbol layer (recognisable glyph, any count). The
    // symbol layer only mounts once the key is set; until then the circle-dot
    // fallback shows, so a rasterize/addImage failure degrades to plain dots.
    const [measureIconKey, setMeasureIconKey] = useState<string | null>(null);
    useEffect(() => {
        if (impactMode !== "measuring" || !candidateIcon || !impactType) {
            setMeasureIconKey(null);
            return;
        }
        const map = mapRef.current?.getMap();
        if (!map || !mapReady) return;
        const key = `measure-ref-${impactType}-${darkBasemap ? "d" : "l"}`;
        let cancelled = false;
        const register = async () => {
            if (map.hasImage(key)) {
                if (!cancelled) setMeasureIconKey(key);
                return;
            }
            const data = await rasterizeIconBadge(candidateIcon, darkBasemap);
            if (cancelled || !data) return;
            try {
                if (!map.hasImage(key)) map.addImage(key, data, { pixelRatio: 2 });
                if (!cancelled) setMeasureIconKey(key);
            } catch {
                /* keep the circle-dot fallback */
            }
        };
        void register();
        // A basemap style swap (theme/satellite) wipes addImage images, so
        // re-register on styledata.
        const onStyle = () => void register();
        map.on("styledata", onStyle);
        return () => {
            cancelled = true;
            map.off("styledata", onStyle);
        };
    }, [impactMode, impactType, candidateIcon, darkBasemap, mapReady]);

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
                        setMapReady(true);
                        // v998: read the basemap `water` layer for the sea in
                        // body-of-water (this configure map frames the play
                        // area, so it captures the ocean/lakes for the current
                        // question).
                        attachBasemapWaterCapture(
                            e.target as unknown as import("maplibre-gl").Map,
                        );
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
                    {/* Active transit-line overlays carried over from the main
                        map (v747) — renders nothing unless a mode is toggled on. */}
                    <TransitRouteLayers transitFC={transitFC} />
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
                    {/* Active hiding-zones overlay carried over from the main
                        map (v767). Union fill + centre dots, styled to match
                        Map.tsx's hiding-zones-* layers (neutral grey on the
                        light basemap; brand red / near-white on dark +
                        satellite). Labels + dashed extent are omitted here to
                        keep the small preview uncluttered. */}
                    {showHidingZonesOverlay && (
                        <Source
                            id="preview-hiding-zones"
                            type="geojson"
                            data={$hidingZones as GeoJSON.FeatureCollection}
                        >
                            <Layer
                                id="preview-hiding-zones-fill"
                                type="fill"
                                filter={[
                                    "any",
                                    ["==", ["geometry-type"], "Polygon"],
                                    ["==", ["geometry-type"], "MultiPolygon"],
                                ]}
                                paint={{
                                    "fill-color": !darkBasemap
                                        ? "hsl(0, 0%, 42%)"
                                        : $theme === "dark"
                                          ? "#f5e7e3"
                                          : "hsl(2, 70%, 54%)",
                                    "fill-opacity": !darkBasemap
                                        ? 0.15
                                        : $theme === "dark"
                                          ? 0.16
                                          : 0.08,
                                }}
                            />
                            <Layer
                                id="preview-hiding-zones-points"
                                type="circle"
                                filter={["==", ["geometry-type"], "Point"]}
                                paint={{
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
                                    "circle-color": darkBasemap
                                        ? "hsl(2, 70%, 54%)"
                                        : "hsl(0, 0%, 20%)",
                                    "circle-stroke-width": 0,
                                }}
                            />
                        </Source>
                    )}
                    {/* Question-impact overlay (v239) — drawn on this
                        same map per the design request (no separate
                        mini-map). v392: matching uses =/≠ tile patterns,
                        measuring uses +/− tile patterns (closer/further),
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
                    {/* v877: the rail line the nearest station is on
                        (same-train-line question) — drawn under the pin so the
                        seeker sees the actual line, not just the station dot. */}
                    {trainLineFC && (
                        <Source
                            id="train-line"
                            type="geojson"
                            data={trainLineFC}
                        >
                            <Layer
                                id="train-line-casing"
                                type="line"
                                layout={{
                                    "line-cap": "round",
                                    "line-join": "round",
                                }}
                                paint={{
                                    "line-color": "hsl(0,0%,100%)",
                                    "line-width": 6,
                                    "line-opacity": 0.7,
                                }}
                            />
                            <Layer
                                id="train-line-core"
                                type="line"
                                layout={{
                                    "line-cap": "round",
                                    "line-join": "round",
                                }}
                                paint={{
                                    "line-color": "hsl(266,60%,45%)",
                                    "line-width": 3,
                                    "line-opacity": 0.95,
                                }}
                            />
                        </Source>
                    )}
                    {impactMode === "tentacles" && impact?.reachCircle && (
                        <>
                            {/* Per-reference Voronoi cells, each a distinct
                                purple, so the seeker sees which slice of the
                                reach maps to which candidate. */}
                            {reachCellsFC && (
                                <Source
                                    id="impact-reach-cells"
                                    type="geojson"
                                    data={reachCellsFC}
                                >
                                    <Layer
                                        id="impact-reach-cells-fill"
                                        type="fill"
                                        paint={{
                                            "fill-color": [
                                                "get",
                                                "fill",
                                            ] as any,
                                            "fill-opacity": 0.35,
                                        }}
                                    />
                                    {/* v823: CLEAR LIGHT-purple borders
                                        between cells so adjacent segments stay
                                        easy to tell apart even when two land on
                                        similar shades. */}
                                    <Layer
                                        id="impact-reach-cells-line"
                                        type="line"
                                        paint={{
                                            "line-color": "hsl(266, 80%, 88%)",
                                            "line-width": 2,
                                            "line-opacity": 0.95,
                                        }}
                                    />
                                </Source>
                            )}
                            <Source
                                id="impact-reach"
                                type="geojson"
                                data={impact.reachCircle as GeoJSON.Feature}
                            >
                                {/* Solid fill only when we couldn't partition
                                    (0–1 references) — otherwise the cells own
                                    the fill and this is just the boundary. */}
                                {!reachCellsFC && (
                                    <Layer
                                        id="impact-reach-fill"
                                        type="fill"
                                        paint={{
                                            "fill-color": "hsl(265, 60%, 60%)",
                                            "fill-opacity": 0.16,
                                        }}
                                    />
                                )}
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
                        </>
                    )}
                    {/* v371: candidate dots are now subtype-icon markers
                        (museum→Landmark, etc.) drawn as HTML overlays,
                        clipped to the play area by the v371 filter in
                        useQuestionImpact. Smaller candidate count after
                        the polygon clip + simple icons keep this cheap.
                        Falls through to nothing when we have no icon for
                        the subtype (radius/tentacles don't render points
                        anyway). */}
                    {/* v981: measuring reference field as ONE GPU circle
                        layer (any count, no React-marker freeze). */}
                    {measuringDotsFC && (
                        <Source
                            id="impact-candidate-dots"
                            type="geojson"
                            data={measuringDotsFC}
                        >
                            {measureIconKey ? (
                                // v988: recognisable subtype ICON, GPU symbol
                                // layer. `icon-allow-overlap:false` lets
                                // MapLibre auto-declutter hundreds of refs into
                                // a readable subset at each zoom — no manual cap,
                                // zero React-marker cost.
                                <Layer
                                    key="impact-candidate-icons-layer"
                                    id="impact-candidate-icons-layer"
                                    type="symbol"
                                    layout={{
                                        "icon-image": measureIconKey,
                                        "icon-allow-overlap": false,
                                        "icon-ignore-placement": false,
                                        "icon-padding": 2,
                                        "icon-size": [
                                            "interpolate",
                                            ["linear"],
                                            ["zoom"],
                                            9,
                                            0.4,
                                            13,
                                            0.6,
                                            16,
                                            0.8,
                                        ],
                                    }}
                                />
                            ) : (
                                <Layer
                                    key="impact-candidate-dots-layer"
                                    id="impact-candidate-dots-layer"
                                    type="circle"
                                    paint={{
                                        "circle-radius": [
                                            "interpolate",
                                            ["linear"],
                                            ["zoom"],
                                            9,
                                            1.6,
                                            13,
                                            2.8,
                                            16,
                                            4,
                                        ],
                                        "circle-color": darkBasemap
                                            ? "hsl(0, 0%, 88%)"
                                            : "hsl(0, 0%, 28%)",
                                        "circle-opacity": 0.75,
                                        "circle-stroke-width": 0.6,
                                        "circle-stroke-color": darkBasemap
                                            ? "hsl(0, 0%, 15%)"
                                            : "hsl(0, 0%, 100%)",
                                    }}
                                />
                            )}
                        </Source>
                    )}
                    {impactMode && impactMode !== "measuring" && candidateIcon &&
                        visibleCandidates &&
                        visibleCandidates.map((c, i) => {
                            const Icon = candidateIcon;
                            return (
                                <Marker
                                    key={`cand-${i}-${c.lat.toFixed(5)}-${c.lng.toFixed(5)}`}
                                    longitude={c.lng}
                                    latitude={c.lat}
                                    anchor="center"
                                >
                                    <div className="flex flex-col items-center gap-0.5">
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
                                        {/* Name label — like the "nearest
                                            reference" pill in the matching /
                                            measuring dialogs, but per candidate
                                            so the seeker can tie each reach cell
                                            to its reference. Tentacles only, to
                                            avoid cluttering the dense point sets
                                            of matching / measuring. */}
                                        {impactMode === "tentacles" &&
                                            c.name && (
                                                <span className="max-w-[88px] truncate rounded-sm border border-foreground/20 bg-background/85 px-1 py-0.5 text-[9px] font-semibold leading-none text-foreground/85 shadow-sm">
                                                    {c.name}
                                                </span>
                                            )}
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
                    {/* Reference marker + permanent popup label. Suppressed for
                        same-train-line: the reference is the LINE (drawn above),
                        so a nearest-STATION teardrop reads as the wrong answer.
                        `referencePoint` is still used to frame the map. */}
                    {referencePoint &&
                        impactType !== "same-train-line" &&
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

/** v823: a repeating range of SHADES of the tentacle category purple —
 *  same hue/saturation, only the lightness varies — cycled across the
 *  Voronoi cells. (Was a spread of different HUES, 240–300, which read as
 *  different colours rather than one family.) The light-purple cell borders
 *  (`impact-reach-cells-line`) keep adjacent cells legible even when two
 *  happen to land on similar shades. Hue 266 ≈ the tentacle category
 *  color (#b09cd5). */
const PURPLE_CELL_SHADES = [
    "hsl(266, 50%, 44%)",
    "hsl(266, 48%, 54%)",
    "hsl(266, 46%, 64%)",
    "hsl(266, 50%, 49%)",
    "hsl(266, 47%, 59%)",
    "hsl(266, 45%, 69%)",
];

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
    symbol: "=" | "≠" | "+" | "−",
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
    // before the glyph is parsed. Yes (= / −) → lighter, no (≠ / +) →
    // darker, both neutral. Glyph colour flips to keep contrast.
    const isYes = symbol === "=" || symbol === "−";
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

/**
 * v988: rasterize a Lucide subtype icon into a circular badge `ImageData` for
 * `map.addImage`, so the MEASURING reference field can render as ONE GPU
 * `symbol` layer (icon + `icon-allow-overlap:false` auto-declutter) at any
 * count — bringing back the recognisable per-subtype glyph the v981 "dots"
 * dropped, without the hundreds-of-React-`<Marker>`s freeze. Async because the
 * SVG is loaded through an `<img>`; returns null on any failure so the caller
 * falls back to the plain circle-dot layer (the reliable v981 behaviour).
 */
async function rasterizeIconBadge(
    Icon: LucideIcon,
    dark: boolean,
): Promise<ImageData | null> {
    try {
        if (typeof document === "undefined") return null;
        const px = 44; // device px; addImage pixelRatio 2 → ~22 css px
        const iconPx = 24;
        const svg = renderToStaticMarkup(
            createElement(Icon, {
                size: iconPx,
                strokeWidth: 2.4,
                color: dark ? "hsl(0, 0%, 90%)" : "hsl(0, 0%, 14%)",
            }),
        );
        const img = new Image();
        img.decoding = "async";
        const url =
            "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
        await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () => reject(new Error("icon svg failed to load"));
            img.src = url;
        });
        const canvas = document.createElement("canvas");
        canvas.width = px;
        canvas.height = px;
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        // Circular badge backdrop (matches the old marker: translucent bg +
        // faint ring), so the glyph reads over any basemap.
        ctx.beginPath();
        ctx.arc(px / 2, px / 2, px / 2 - 2, 0, Math.PI * 2);
        ctx.fillStyle = dark ? "rgba(18, 18, 20, 0.85)" : "rgba(255, 255, 255, 0.9)";
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = dark
            ? "rgba(255, 255, 255, 0.4)"
            : "rgba(0, 0, 0, 0.4)";
        ctx.stroke();
        ctx.drawImage(img, (px - iconPx) / 2, (px - iconPx) / 2, iconPx, iconPx);
        return ctx.getImageData(0, 0, px, px);
    } catch {
        return null;
    }
}

export default InlineLocationPicker;
