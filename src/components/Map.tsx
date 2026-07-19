import "maplibre-gl/dist/maplibre-gl.css";
import "@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css";

import MapboxDraw from "@mapbox/mapbox-gl-draw";
import { useStore } from "@nanostores/react";
import * as turf from "@turf/turf";
import maplibregl from "maplibre-gl";
import { useEffect, useMemo, useRef, useState } from "react";
import MapGL, {
    AttributionControl,
    Layer,
    type MapRef,
    Marker,
    Source,
    type ViewStateChangeEvent,
} from "react-map-gl/maplibre";
import { toast } from "react-toastify";

import { FadeOverlay } from "@/components/FadeOverlay";
import { MapNavControls } from "@/components/MapNavControls";
import { TransitRouteLayers } from "@/components/TransitRouteLayers";
import {
    Dialog,
    DialogContent,
} from "@/components/ui/dialog";
import { useMapTilesReady } from "@/hooks/useMapTilesReady";
import { usePlayAreaBoundary } from "@/hooks/usePlayAreaBoundary";
import { useSelfPositionWatch } from "@/hooks/useSelfPositionWatch";
import { useTransitRouteOverlays } from "@/hooks/useTransitRouteOverlays";
import { CATEGORIES, type CategoryId } from "@/lib/categories";
import {
    baseTileLayer,
    displayHidingZones,
    drawingQuestionKey,
    followMe,
    hiderMode,
    hidingRadius,
    hidingRadiusUnits,
    hidingZonesGeoJSON,
    mapContext,
    mapGeoJSON,
    mapGeoLocation,
    planningModeEnabled,
    polyGeoJSON,
    questionFinishedMapData,
    questionModified,
    questions,
    thunderforestApiKey,
    triggerLocalRefresh,
} from "@/lib/context";
import {
    mapLibreContext,
    mapLibreViewport,
} from "@/lib/featureFlags";
import {
    endgameZone,
    hidingPeriodEndsAt,
    playArea,
    revealedStation,
} from "@/lib/gameSetup";
import { satelliteView } from "@/lib/gameSetup";
import { stationLabelMaxChars } from "@/lib/debugState";
import { playerRole, roundFoundAt } from "@/lib/hiderRole";
import { selectedMapStation, travelTimesFC } from "@/lib/journey/state";
import { shortenStationLabel } from "@/lib/stationLabel";
import {
    multiplayerEnabled,
    participants,
    seekerLocationSharing,
    seekerLocations,
} from "@/lib/multiplayer/session";
import { playerColor, playerInitials } from "@/lib/playerColor";
import { fadePaint } from "@/lib/mapPaint";
import { createMapShim } from "@/lib/mapShim";
import { buildStyle } from "@/lib/mapStyle";
import { seekerAddQuestion } from "@/lib/multiplayer/store";
import {
    PLAY_AREA_COLOR,
    PLAY_AREA_LINE_OPACITY,
    PLAY_AREA_LINE_WIDTH,
} from "@/lib/playAreaStyle";
import {
    handleMapLibreError,
    installMissingImageHandler,
    pmtilesUrl,
    recordPmtilesError,
} from "@/lib/protomapsStyle";
import { play } from "@/lib/sound";
import { resolvedTheme } from "@/lib/theme";
import { activeTilePackId } from "@/lib/tilePack";
import { cn } from "@/lib/utils";
import { holedMaskViaWorker } from "@/lib/geometry/client";
import { applyQuestionsToMapGeoData } from "@/maps";
import { attachBasemapWaterCapture } from "@/maps/api/basemapWater";
import { clearCache } from "@/maps/api";
import { CacheType } from "@/maps/api/types";
import { spoofPickMode } from "@/lib/debugGpsSpoof";
import { setSpoofAtPoint } from "@/lib/debugSpoofArea";

import { MapTilesVeil } from "./MapTilesVeil";
import {
    MatchingQuestionComponent,
    MeasuringQuestionComponent,
    RadiusQuestionComponent,
    TentacleQuestionComponent,
    ThermometerQuestionComponent,
} from "./QuestionCards";
import { SelfPositionMarker } from "./SelfPositionMarker";

/**
 * The seeker's map. MapLibre GL renderer.
 *
 * History: this lived as `MapV2.tsx` through v79 while the
 * Leaflet renderer (the original `Map.tsx`) was kept around
 * behind a `useMapLibre` feature flag. Leaflet was retired in
 * v80 once MapLibre had full parity (boundary loading,
 * elimination mask, pending/answered question overlays, drag-
 * to-reposition markers, radar sweep, free-draw via
 * mapbox-gl-draw, transit overlays, hider-guess pin, screenshot
 * export, context menu, follow-me GPS pin, ZoneSidebar shadow-
 * atom hiding-zones overlay). v81 renamed `MapV2` → `Map` to
 * reclaim the canonical name.
 *
 * `mapContext` (in lib/context.ts) holds a Leaflet-shaped shim
 * wrapping the maplibregl Map — see lib/mapShim.ts. The shim
 * exists so every question card / dialog / OptionDrawers call
 * site that used to read the old Leaflet map context keeps
 * working without touching its `getCenter / fitBounds / flyTo`
 * call shape.
 */

interface MapProps {
    className?: string;
}

/**
 * Each entry's tiles + attribution feed the maplibre raster source.
 * v225 swapped all cartocdn URLs (light/dark/voyager) for OSM standard
 * tiles after confirming both Firefox ETP and Adblock Plus EasyPrivacy
 * block `basemaps.cartocdn.com` at request time — leaving tiles
 * silently 503'd for any user with either active.
 *
 * v227: the dark-style rebuild via raster-paint properties is gone.
 * "dark" now ships the same OSM tiles as "light" and "voyager" and is
 * inverted at the container level via the `osm-dark-tiles` CSS class
 * (see globals.css) — same approach openstreetmap.org itself uses on
 * its own site (PR #5325). Removes the muted look the paint approach
 * produced and gives true dark navy land + readable light labels.
 *
 * OSM standard tiles aren't on any tracking blocklist and have an
 * explicit usage policy permitting low-volume apps like ours
 * (https://operations.osmfoundation.org/policies/tiles/).
 */
const RASTER_SOURCES: Record<
    string,
    { tiles: string[]; attribution: string }
> = {
    light: {
        tiles: [
            "https://a.tile.openstreetmap.org/{z}/{x}/{y}.png",
            "https://b.tile.openstreetmap.org/{z}/{x}/{y}.png",
            "https://c.tile.openstreetmap.org/{z}/{x}/{y}.png",
        ],
        attribution:
            '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    },
    dark: {
        tiles: [
            "https://a.tile.openstreetmap.org/{z}/{x}/{y}.png",
            "https://b.tile.openstreetmap.org/{z}/{x}/{y}.png",
            "https://c.tile.openstreetmap.org/{z}/{x}/{y}.png",
        ],
        attribution:
            '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    },
    osm: {
        tiles: [
            "https://a.tile.openstreetmap.org/{z}/{x}/{y}.png",
            "https://b.tile.openstreetmap.org/{z}/{x}/{y}.png",
            "https://c.tile.openstreetmap.org/{z}/{x}/{y}.png",
        ],
        attribution:
            '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    },
    voyager: {
        tiles: [
            "https://a.tile.openstreetmap.org/{z}/{x}/{y}.png",
            "https://b.tile.openstreetmap.org/{z}/{x}/{y}.png",
            "https://c.tile.openstreetmap.org/{z}/{x}/{y}.png",
        ],
        attribution:
            '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    },
};

/** Overlay layers a tap can resolve to a station for the station
 *  transit card. We target the per-station POINTS (via an invisible
 *  larger hit-circle for an easy tap target), NOT the zone fill — the
 *  stations overlay's fill is a single UNIONED polygon with no per-station
 *  data, so tapping it used to resolve to the union's centroid (often out
 *  at sea). The travel-time dots/labels are also valid targets. */
const STATION_TAP_LAYERS = [
    "hiding-zones-hit",
    "hiding-zones-points",
    "travel-times-dot",
    "travel-times-labels",
];

/** Resolve the tapped overlay feature to a station `{ lat, lng, name }`.
 *  Point features (station dots, travel-time labels) use their geometry;
 *  hiding-zone circle polygons carry the source station place in their
 *  properties (set by `turf.circle(center, r, { properties: place })`),
 *  so we pull the center + name from there, falling back to the polygon
 *  centroid and the raw click point. */
function stationFromFeature(
    f: maplibregl.MapGeoJSONFeature,
    clickLngLat: maplibregl.LngLat,
): { lat: number; lng: number; name?: string; modes?: string[] } | null {
    const props = (f.properties ?? {}) as Record<string, unknown>;
    // Name: travel-time labels expose `name` directly; hiding-zone
    // circles nest the station under `properties` (a stringified place).
    const nested = parseMaybeJSON(props.properties);
    const name =
        (typeof props.name === "string" && props.name) ||
        (nested && typeof nested.name === "string" && nested.name) ||
        (nested?.properties &&
            typeof nested.properties.name === "string" &&
            nested.properties.name) ||
        undefined;

    // Transit modes (aggregated in the merge). On point features they sit
    // on `properties.modes`; on circle polygons they're under the nested
    // place's properties. MapLibre may stringify the array.
    const rawModes =
        (props.modes as unknown) ??
        (nested?.properties as { modes?: unknown } | undefined)?.modes;
    let modes: string[] | undefined;
    if (Array.isArray(rawModes)) modes = rawModes as string[];
    else if (typeof rawModes === "string") {
        try {
            const p = JSON.parse(rawModes);
            if (Array.isArray(p)) modes = p as string[];
        } catch {
            /* ignore */
        }
    }

    // Coordinates.
    if (f.geometry?.type === "Point") {
        const [lng, lat] = f.geometry.coordinates as [number, number];
        if (Number.isFinite(lat) && Number.isFinite(lng))
            return { lat, lng, name, modes };
    }
    // Circle / polygon — prefer the embedded station center, else
    // centroid, else the click point.
    const center = nested?.geometry?.coordinates as
        | [number, number]
        | undefined;
    if (center && Number.isFinite(center[1]) && Number.isFinite(center[0])) {
        return { lat: center[1], lng: center[0], name, modes };
    }
    try {
        const c = turf.centroid(f as never);
        const [lng, lat] = c.geometry.coordinates as [number, number];
        if (Number.isFinite(lat) && Number.isFinite(lng))
            return { lat, lng, name, modes };
    } catch {
        /* fall through to click point */
    }
    return { lat: clickLngLat.lat, lng: clickLngLat.lng, name, modes };
}

/** MapLibre stringifies nested feature properties; parse defensively. */
function parseMaybeJSON(
    v: unknown,
): { name?: string; geometry?: { coordinates?: unknown }; properties?: { name?: string } } | null {
    if (v && typeof v === "object") return v as never;
    if (typeof v === "string") {
        try {
            return JSON.parse(v);
        } catch {
            return null;
        }
    }
    return null;
}

/**
 * Budget for the cosmetic world-scale dimming mask (v818). Computing
 * `holedMask` (a `turf.difference` of a world rectangle minus the play
 * area) on a pathologically large / dense boundary — a whole COUNTY like
 * Dalarna, a huge metro — blocks the MAIN THREAD for seconds and freezes
 * the tab (the "PC heats up, map stuck on Loading" report). The mask only
 * DIMS everything outside the play area; the crisp play-area outline still
 * renders without it. So past this vertex budget we skip the mask rather
 * than freeze. v759 already skips it pre-game; this caps it in-game too.
 */
const MASK_MAX_VERTICES = 20000;

/**
 * Stable empty FeatureCollection. Used so the elimination `<Source>` /
 * `<Layer>` can stay MOUNTED even when there's no mask — a stable
 * `beforeId` target so transit-route overlays (which load async and would
 * otherwise append ON TOP of a later-created mask) always insert BELOW the
 * dimming mask and therefore get dimmed with everything else outside the
 * remaining play area (v823). A module-level constant (not a per-render
 * literal) so react-map-gl doesn't call `setData` every render.
 */
const EMPTY_FEATURE_COLLECTION: GeoJSON.FeatureCollection = {
    type: "FeatureCollection",
    features: [],
};

/** The elimination mask's fill layer id — transit overlays anchor below it. */
const ELIMINATION_MASK_LAYER_ID = "elimination-fill";

/**
 * Count coordinate positions in a GeoJSON geometry/feature/collection,
 * EARLY-EXITING once `cap` is reached — so the guard itself is O(cap), not
 * O(n), even on a million-vertex county boundary.
 */
function coordCountAtLeast(geom: unknown, cap: number): number {
    let n = 0;
    const walk = (c: unknown): void => {
        if (n >= cap || !Array.isArray(c)) return;
        if (typeof c[0] === "number") {
            n++;
            return;
        }
        for (const x of c) {
            if (n >= cap) return;
            walk(x);
        }
    };
    const g = geom as {
        geometry?: { coordinates?: unknown };
        coordinates?: unknown;
        features?: { geometry?: { coordinates?: unknown } }[];
    };
    if (Array.isArray(g?.features)) {
        for (const f of g.features) {
            if (n >= cap) break;
            walk(f?.geometry?.coordinates);
        }
    } else {
        walk(g?.geometry?.coordinates ?? g?.coordinates);
    }
    return n;
}

export function Map({ className }: MapProps) {
    const $drawingQuestionKey = useStore(drawingQuestionKey);
    const $followMe = useStore(followMe);
    const $hiderMode = useStore(hiderMode);
    const $hidingZones = useStore(hidingZonesGeoJSON);
    const $labelMaxChars = useStore(stationLabelMaxChars);
    const $showHidingZones = useStore(displayHidingZones);
    const $selectedStation = useStore(selectedMapStation);
    const $hidingRadius = useStore(hidingRadius);
    const $hidingRadiusUnits = useStore(hidingRadiusUnits);
    const $travelTimes = useStore(travelTimesFC);
    // GPS-sharing status chip (v834): seeker only, multiplayer, not yet
    // found — moved off the manually-reopened lobby onto the map.
    const $mpEnabled = useStore(multiplayerEnabled);
    const $role = useStore(playerRole);
    const $seekerSharing = useStore(seekerLocationSharing);
    const $foundAt = useStore(roundFoundAt);
    // v946: other seekers' live positions (the server now fans `loc` to
    // seekers too, not just the hide team). Rendered as player-colour avatars
    // like the hider map, so a seeker can see their teammates.
    const $seekerLocations = useStore(seekerLocations);
    const $participants = useStore(participants);
    // Only render OTHER seekers (the server excludes our own fix already, and
    // hiders broadcast via a separate channel — but gate on the seeker role
    // so a stale entry can't render as a hider). Own map already shows the
    // live "You" dot via SelfPositionMarker.
    const otherSeekerPins = useMemo(
        () =>
            Object.entries($seekerLocations)
                .map(([id, loc]) => {
                    const p = $participants.find((q) => q.id === id);
                    if (p && p.role !== "seeker") return null;
                    return {
                        id,
                        name: p?.displayName?.trim() || "Seeker",
                        lat: loc.lat,
                        lng: loc.lng,
                    };
                })
                .filter((v): v is NonNullable<typeof v> => v !== null),
        [$seekerLocations, $participants],
    );
    const showGpsShare =
        $mpEnabled && $role === "seeker" && $foundAt === null;
    // v835: display copy of the hiding-zones FC with a `shortName` on each
    // point (abbreviated + truncated to the debug `stationLabelMaxChars`).
    // The full `name` is kept for taps/selection — this only feeds labels.
    const hidingZonesDisplay = useMemo(() => {
        if (!$hidingZones) return $hidingZones;
        return {
            ...$hidingZones,
            features: $hidingZones.features.map((f) => {
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
        } as typeof $hidingZones;
    }, [$hidingZones, $labelMaxChars]);
    // The selected station's hiding-zone circle, for the prominent
    // "selected" highlight layer. Recomputed only when the selection or
    // radius changes.
    const selectedZoneFC = useMemo(() => {
        if (!$selectedStation) return null;
        try {
            const circle = turf.circle(
                [$selectedStation.lng, $selectedStation.lat],
                $hidingRadius,
                { steps: 128, units: $hidingRadiusUnits },
            );
            const dot = turf.point([
                $selectedStation.lng,
                $selectedStation.lat,
            ]);
            // Mixed Polygon+Point FC — cast around turf's homogeneous-array
            // typing (the layers filter by geometry-type).
            return turf.featureCollection([
                circle,
                dot,
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
    // v959: endgame focus — once the seekers correctly reach the hider's zone,
    // cut the map down to JUST that zone: a dark spotlight mask everywhere
    // except the zone circle, plus a bright gold ring. `endgameZone` is set on
    // a confirmed claim (store.ts).
    const $endgameZone = useStore(endgameZone);
    const endgameFocusFC = useMemo(() => {
        if (!$endgameZone) return null;
        try {
            const circle = turf.circle(
                [$endgameZone.lng, $endgameZone.lat],
                $endgameZone.radiusMeters / 1000,
                { steps: 96, units: "kilometers" },
            );
            const world = turf.polygon([
                [
                    [-180, -85],
                    [180, -85],
                    [180, 85],
                    [-180, 85],
                    [-180, -85],
                ],
            ]);
            const mask = turf.difference(
                turf.featureCollection([world, circle] as never),
            );
            const feats: GeoJSON.Feature[] = [];
            if (mask) {
                mask.properties = { kind: "mask" };
                feats.push(mask as GeoJSON.Feature);
            }
            circle.properties = { kind: "ring" };
            feats.push(circle as GeoJSON.Feature);
            return {
                type: "FeatureCollection",
                features: feats,
            } as GeoJSON.FeatureCollection;
        } catch {
            return null;
        }
    }, [$endgameZone]);
    // Frame the camera on the endgame zone the moment it's set.
    useEffect(() => {
        if (!$endgameZone) return;
        const map = mapRef.current?.getMap();
        if (!map) return;
        try {
            const circle = turf.circle(
                [$endgameZone.lng, $endgameZone.lat],
                $endgameZone.radiusMeters / 1000,
                { steps: 32, units: "kilometers" },
            );
            const [minX, minY, maxX, maxY] = turf.bbox(circle);
            map.fitBounds(
                [
                    [minX, minY],
                    [maxX, maxY],
                ],
                { padding: 64, duration: 1200, maxZoom: 16 },
            );
        } catch (e) {
            console.warn("endgame fitBounds failed:", e);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [$endgameZone?.lat, $endgameZone?.lng, $endgameZone?.radiusMeters]);
    // Transit-route overlays per mode — shared with HiderBackgroundMap via
    // the useTransitRouteOverlays hook (fetch) + TransitRouteLayers
    // (render), so the seeker and hider maps never drift on transit.
    const transitFC = useTransitRouteOverlays();
    const $tileKey = useStore(baseTileLayer);
    const $satellite = useStore(satelliteView);
    const $tfKey = useStore(thunderforestApiKey);
    const $polyGeoJSON = useStore(polyGeoJSON);
    const $mapGeoJSON = useStore(mapGeoJSON);
    const $mapGeoLocation = useStore(mapGeoLocation);
    const $questions = useStore(questions);
    useStore(triggerLocalRefresh); // subscribe to manual re-render kicks
    const $savedViewport = useStore(mapLibreViewport);
    const $playArea = useStore(playArea);

    // v895 perf: memoize the per-question marker list. It was computed inline
    // in JSX (`$questions.flatMap(questionMarkers)`) on EVERY render — including
    // every GPS-fix re-render — allocating a fresh array + reconciling every
    // marker. Now it only rebuilds when the questions change.
    const questionMarkerList = useMemo(
        () => $questions.flatMap((q) => questionMarkers(q)),
        [$questions],
    );

    const mapRef = useRef<MapRef | null>(null);
    // v377: debounce handle for persisting the viewport to localStorage.
    const viewportPersistTimer = useRef<number | null>(null);
    // v445: latches true once any real protomaps tile has painted, so the
    // basemap-health watchdog never flips a working map to the (404-ing)
    // fallback on a later re-arm. See the watchdog effect below.
    const everPaintedTileRef = useRef(false);

    const $theme = useStore(resolvedTheme);
    // v616: during the hiding period the HiderTimer sits bottom-LEFT (and
    // the Map-options chip is pushed up above it), so the nav controls
    // (follow-me / reset) dodge to the bottom-RIGHT, which is free then.
    // Once seeking starts the timer moves bottom-right, so the nav controls
    // come back to the bottom-left. A one-shot timeout flips at the
    // deadline — no 1 Hz tick needed.
    const $hidingEndsAt = useStore(hidingPeriodEndsAt);
    const $revealedStation = useStore(revealedStation);
    const [inHidingPeriod, setInHidingPeriod] = useState(
        () => $hidingEndsAt != null && Date.now() < $hidingEndsAt,
    );
    useEffect(() => {
        if ($hidingEndsAt == null) {
            setInHidingPeriod(false);
            return;
        }
        const ms = $hidingEndsAt - Date.now();
        if (ms <= 0) {
            setInHidingPeriod(false);
            return;
        }
        setInHidingPeriod(true);
        const t = window.setTimeout(() => setInHidingPeriod(false), ms);
        return () => window.clearTimeout(t);
    }, [$hidingEndsAt]);
    // v241: rebuild style when the resolved PMTiles URL flips (e.g.
    // fallback from our worker to the demo bucket on tile error).
    const $pmtilesUrl = useStore(pmtilesUrl);
    // v336: rebuild the style when a city tile pack activates so the
    // basemap source flips to the merge scheme (pack-first rendering).
    const $tilePackId = useStore(activeTilePackId);
    const style = useMemo(
        () => buildStyle($tileKey, $satellite, $tfKey ?? "", $theme),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [$tileKey, $satellite, $tfKey, $theme, $pmtilesUrl, $tilePackId],
    );

    // Initial view priority: persisted viewport > OSM extent of
    // selected play area > global default. Persisted wins so a
    // reload doesn't snap the user away from where they were
    // looking; if they had no prior viewport (fresh install) we
    // derive from the play area; if neither, world.
    const initialView = useMemo(() => {
        if ($savedViewport) return $savedViewport;
        const props = $mapGeoLocation?.properties as
            | { extent?: [number, number, number, number] }
            | undefined;
        const extent = props?.extent;
        if (extent) {
            const [maxLat, minLng, minLat, maxLng] = extent;
            return {
                latitude: (maxLat + minLat) / 2,
                longitude: (minLng + maxLng) / 2,
                zoom: 10,
            };
        }
        return { latitude: 30, longitude: 0, zoom: 2 };
        // Intentionally compute ONCE on mount — subsequent
        // mapGeoLocation changes are handled by the flyTo
        // effect below.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Publish the map ref to two global atoms:
    //   - mapLibreContext: the raw MapRef, for the seeker map's own use.
    //   - mapContext: a Leaflet-shaped shim, for the rest
    //     of the codebase (question cards, dialogs, etc.) which
    //     was originally written against Leaflet's Map API and
    //     calls map.getCenter() / fitBounds() / flyTo(). See
    //     lib/mapShim.ts for the translation layer.
    // Track when MapLibre's style + sources are actually ready.
    // The elimination-mask effect waits for this flip — on PWA cold-
    // start the play-area polygon hydrates from cache and the mask is
    // computed before MapLibre has finished initialising; setting a
    // Source's `data` prop while the style is still loading is
    // silently dropped by maplibre-gl, leaving the mask invisible
    // until the user backgrounds + foregrounds the tab. Tying the
    // effect to `mapLoaded` makes it re-run after onLoad, at which
    // point the data lands correctly.
    const [mapLoaded, setMapLoaded] = useState(false);

    // Reveal gate (v260): hold a loading veil over the canvas until the
    // style + tiles have painted AND — when a play area is committed —
    // its boundary polygon is in. Latched + timeout-guarded so it's a
    // one-time "don't show a half-built map", never a permanent shutter
    // (a slow/failed tile fetch reveals the map after the timeout rather
    // than hiding it forever). Question/pan changes don't re-veil.
    const boundaryLoaded = Boolean($mapGeoJSON || $polyGeoJSON);
    // v381: track whether the elimination effect has settled for the
    // CURRENT boundary, so the reveal gate can wait until the mask
    // + per-category markers are computed before dropping the veil. Was
    // a noticeable two-step on a question-heavy reload: boundary
    // appears, veil drops, then a moment later the mask paints over it.
    // Reset on boundary change so a new play area re-arms the gate. The
    // state lives here (hoisted) so it can feed dataReady directly; the
    // setMaskComputed(true) signal is fired inside the async elimination
    // effect further down where setEliminationResult lands.
    const [maskComputed, setMaskComputed] = useState(false);
    useEffect(() => {
        setMaskComputed(false);
    }, [$mapGeoJSON, $polyGeoJSON]);
    // dataReady covers EVERY async piece this map paints on first
    // reveal — boundary AND the mask/per-category markers — so the veil
    // drops once instead of dropping early and letting the mask paint a
    // moment later. (Transit overlays + GPS position fade in
    // independently: they're user-toggled or permission-gated, not part
    // of "essential first paint".)
    const dataReady =
        $playArea === null || (boundaryLoaded && maskComputed);
    const {
        showVeil,
        timedOut: tilesTimedOut,
        onLoad: onTilesLoad,
        onIdle: onTilesIdle,
    } = useMapTilesReady({
        dataReady,
        resetKey: $mapGeoJSON || $polyGeoJSON,
        revealTimeoutMs: 15_000,
    });

    const handleLoad = () => {
        if (!mapRef.current) return;
        mapLibreContext.set(mapRef.current);
        const inner = mapRef.current.getMap();
        if (inner) {
            mapContext.set(createMapShim(inner));
            installMissingImageHandler(inner);
            // v998: keep the basemap water (ocean/lakes) captured for the
            // body-of-water elimination — this map frames the play area.
            attachBasemapWaterCapture(inner as unknown as maplibregl.Map);
        }
        setMapLoaded(true);
        onTilesLoad();
    };

    // Self-heal for the "dark forever" failure mode (v260). When the
    // basemap tiles are ABORTED rather than errored — the Firefox
    // NS_BINDING_ABORTED storm we saw on the self-hosted z15 file —
    // maplibre fires no `error` event, so `handleMapLibreError` never
    // trips the demo-bucket fallback and the canvas stays black. The
    // reveal gate's timeout is our backstop signal: if tiles never
    // settle, flip the PMTiles source to the (CORS-proxied) demo bucket
    // so the user gets a working map instead of a void. Idempotent —
    // `recordPmtilesError` no-ops once already on the fallback.
    useEffect(() => {
        if (tilesTimedOut) {
            // v363: hard=true — `tilesTimedOut` is the v260 settled
            // verdict (reveal gate's timeout fired without tiles).
            // Bypass the burst gate.
            recordPmtilesError(
                "basemap tiles never settled (likely aborted, not errored)",
                { hard: true },
            );
        }
    }, [tilesTimedOut]);

    // Basemap-health watchdog (v321). The `tilesTimedOut` self-heal
    // above is driven by `useMapTilesReady`, whose reveal LATCHES the
    // moment MapLibre goes idle — and MapLibre goes idle even when the
    // Protomaps PMTiles archive aborts its fetch WITHOUT emitting an
    // `error` event (the silent NS_BINDING_ABORTED case the comment
    // above describes). On a cold load the boundary polygon satisfies
    // `dataReady` and `onLoad` + `onIdle` fire, so the gate reveals a
    // BLANK canvas and clears its 15 s timeout — meaning `tilesTimedOut`
    // never trips and the demo-bucket fallback never runs. Result: only
    // the red boundary outline draws over bare background, forever
    // (the Houston cold-load report).
    //
    // This watchdog is deliberately INDEPENDENT of the reveal latch. It
    // listens for a single real Protomaps tile actually loading; if none
    // arrives within the grace window we flip to the proxied demo
    // bucket. `recordPmtilesError` is idempotent — it no-ops once we're
    // already on the fallback, and a healthy load cancels the timer
    // before it ever fires.
    useEffect(() => {
        const map = mapRef.current?.getMap();
        if (!map) return;
        // Only meaningful when the basemap is Protomaps — a
        // Thunderforest raster style has no "protomaps" source, so the
        // watchdog would false-positive on every load.
        const usingThunderforest =
            ($tileKey === "transport" || $tileKey === "neighbourhood") &&
            Boolean($tfKey);
        if (usingThunderforest) return;

        // v445: once ANY protomaps tile has ever painted this session the
        // basemap is proven alive — never flip to the fallback after that.
        // The effect re-arms on dep changes ($pmtilesUrl / $tileKey / …),
        // and a re-arm AFTER the map has settled (idle, every visible tile
        // already loaded) sees no fresh `sourcedata`+tile events, so the
        // 10 s timer would false-positive and flip to the proxied demo
        // bucket — which currently 404s, blanking a map that had loaded
        // fine ("tiles disappear after a few seconds"). The latch closes
        // that hole: the watchdog only ever fires on a genuine cold load
        // that never painted a single tile (the Houston case it's for).
        let healthy = everPaintedTileRef.current;
         
        const onSourceData = (e: any) => {
            // A `sourcedata` event carrying an actual tile for the
            // protomaps source means the archive responded and at least
            // one tile decoded — the basemap is alive. Metadata-only
            // events (no `e.tile`) don't count: the archive header can
            // load and the tile range-requests still abort.
            if (e?.sourceId === "protomaps" && e?.tile) {
                healthy = true;
                everPaintedTileRef.current = true;
            }
        };
        map.on("sourcedata", onSourceData);
        const t = window.setTimeout(() => {
            if (!healthy && !everPaintedTileRef.current) {
                // v363: hard=true — the 10 s watchdog is a settled
                // verdict (a real tile would have arrived by now), not
                // a transient blip. Bypass the burst gate.
                recordPmtilesError(
                    "protomaps basemap produced no tiles within grace window (likely aborted archive fetch)",
                    { hard: true },
                );
            }
        }, 10_000);
        return () => {
            map.off("sourcedata", onSourceData);
            window.clearTimeout(t);
        };
        // Re-arm once the map finishes loading and on any style/url
        // swap (e.g. after we flip to the fallback bucket).
    }, [mapLoaded, $pmtilesUrl, $tileKey, $tfKey]);

    useEffect(() => {
        return () => {
            mapLibreContext.set(null);
            mapContext.set(null);
        };
    }, []);

    // Persist viewport on move end. v377: debounced. `moveend` fires
    // once per gesture, but momentum/inertia scrolling and rapid
    // pan-zoom can fire it several times in a second, and
    // mapLibreViewport is a persistentAtom — each set is a synchronous
    // localStorage.setItem, which janks the pan on slower devices.
    // Coalesce to one write 400ms after the last move.
    const handleMoveEnd = (e: ViewStateChangeEvent) => {
        const { latitude, longitude, zoom } = e.viewState;
        if (viewportPersistTimer.current !== null) {
            clearTimeout(viewportPersistTimer.current);
        }
        viewportPersistTimer.current = window.setTimeout(() => {
            mapLibreViewport.set({ latitude, longitude, zoom });
            viewportPersistTimer.current = null;
        }, 400);
    };

    // When mapGeoLocation changes (user picked a new play
    // area), fly to its extent. Equivalent of Leaflet's
    // map.flyTo([lat, lng], 11, {duration: 0.6}) call inside
    // the wizard's handleFinish.
    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;
        const props = $mapGeoLocation?.properties as
            | { extent?: [number, number, number, number] }
            | undefined;
        const extent = props?.extent;
        let bounds:
            | [[number, number], [number, number]]
            | null = null;
        // Prefer the loaded boundary's OWN bbox — that's the assembled
        // play area (primary UNIONED with every folded-in adjacent, and
        // clipped to land), so the camera frames the whole region instead
        // of cropping to the primary's extent and cutting neighbours off.
        // Falls back to the primary extent before the boundary lands
        // (immediate framing) and to the centroid flyTo below if neither
        // is available (e.g. a guest who only got playArea coords).
        const fc = ($mapGeoJSON || $polyGeoJSON) as
            | GeoJSON.FeatureCollection
            | null;
        if (fc) {
            try {
                const b = turf.bbox(fc);
                bounds = [
                    [b[0], b[1]],
                    [b[2], b[3]],
                ];
            } catch (e) {
                console.warn("Map boundary bbox failed:", e);
            }
        }
        if (!bounds && extent) {
            const [maxLat, minLng, minLat, maxLng] = extent;
            bounds = [
                [minLng, minLat],
                [maxLng, maxLat],
            ];
        }
        if (!bounds) {
            // No extent, no boundary geometry yet. Last-resort
            // fallback: fly to the play-area centroid at city zoom
            // so the seeker sees their join-target instead of the
            // global ocean view. Applies mainly to guests who only
            // got the host's `playArea` displayName+coords in the
            // SetupState push but haven't received / loaded the
            // boundary yet — without this the map stays uniformly
            // dark blue (the dark cartocdn tile colour at zoom 2),
            // matching the "map not visible" report.
            const pa = $playArea;
            if (pa) {
                try {
                    map.flyTo({
                        center: [pa.lng, pa.lat],
                        zoom: 11,
                        duration: 600,
                    });
                } catch (e) {
                    console.warn("Map play-area flyTo failed:", e);
                }
            }
            return;
        }
        try {
            map.fitBounds(bounds, { padding: 24, duration: 600 });
        } catch (e) {
            console.warn("Map fitBounds failed:", e);
        }
    }, [$mapGeoLocation?.properties, $mapGeoJSON, $polyGeoJSON, $playArea]);

    // Play-area boundary fetch — shared with the hider map via
    // usePlayAreaBoundary (fetch + 2-attempt retry + land-clip +
    // failure toast). Was a large inline effect here.
    usePlayAreaBoundary();

    // Pending-question dashed outlines + post-elimination mask.
    // applyQuestionsToMapGeoData walks each question and either
    // (a) eliminates a region from the working polygon when
    // answered, or (b) emits a "still-pending" geoJSON via the
    // callback. We collect those callbacks into a per-category
    // FeatureCollection so MapLibre can render one batched
    // layer per category color (cheaper than one per question
    // in GL terms; Leaflet adds one DOM layer per question).
    //
    // The function is async (the turf pipeline runs in
    // microtasks for memory pressure), so we drive it from a
    // useEffect and write into local state. Stale-result guard
    // via a closure-captured generation counter — if the
    // questions atom updates while a prior pass is still
    // running, we drop the older result.
    const [eliminationResult, setEliminationResult] = useState<{
        mask: GeoJSON.Feature | null;
        pendingByCategory: Record<string, GeoJSON.Feature[]>;
    }>({ mask: null, pendingByCategory: {} });
    const eliminationGenRef = useRef(0);

    // Newly-eliminated-area flash. When an answer narrows the remaining
    // region, we diff the previous remaining polygon against the new one
    // and briefly wash the slice that was just ruled out in brand red,
    // then fade it into the dark mask — so an answer reads as a
    // deliberate "this is gone" moment instead of a silent redraw.
    const prevWorkingRef = useRef<GeoJSON.Feature | null>(null);
    const prevInnerRef = useRef<unknown>(null);
    const flashTimersRef = useRef<number[]>([]);
    const [eliminationFlash, setEliminationFlash] = useState<{
        feature: GeoJSON.Feature;
        visible: boolean;
        /** Transition duration (ms) for THIS step — short for the crisp
         *  blinks, long for the final fade-out. */
        fadeMs: number;
    } | null>(null);
    useEffect(
        () => () => {
            flashTimersRef.current.forEach((t) => window.clearTimeout(t));
        },
        [],
    );
    // Collapse a remaining-region Feature/FeatureCollection to one
    // polygon feature so turf.difference can diff two of them.
    const asPolygonFeature = (
        x: unknown,
    ): GeoJSON.Feature | null => {
        if (!x || typeof x !== "object") return null;
        const g = x as GeoJSON.Feature | GeoJSON.FeatureCollection;
        if (g.type === "FeatureCollection") {
            const polys = g.features.filter(
                (f) =>
                    f.geometry?.type === "Polygon" ||
                    f.geometry?.type === "MultiPolygon",
            );
            if (polys.length === 0) return null;
            if (polys.length === 1) return polys[0];
            try {
                return turf.union(
                    turf.featureCollection(polys as never),
                ) as GeoJSON.Feature;
            } catch {
                return polys[0];
            }
        }
        return g.type === "Feature" ? g : null;
    };
    // v702: frame the newly-eliminated slice so the flash animation is
    // actually seen — an elimination off the current viewport would blink
    // and fade before the seeker ever looked there. Skip the camera move
    // when the slice is already fully in view (no jerk when it's on-screen),
    // and cap the zoom so a tiny sliver doesn't rocket in and lose context.
    const fitMapToFlash = (delta: GeoJSON.Feature) => {
        const map = mapRef.current?.getMap();
        if (!map) return;
        try {
            const bb = turf.bbox(delta); // [minLng, minLat, maxLng, maxLat]
            if (!bb.every((n) => Number.isFinite(n))) return;
            const view = map.getBounds();
            const fullyInView =
                bb[0] >= view.getWest() &&
                bb[2] <= view.getEast() &&
                bb[1] >= view.getSouth() &&
                bb[3] <= view.getNorth();
            if (fullyInView) return;
            map.fitBounds(
                [
                    [bb[0], bb[1]],
                    [bb[2], bb[3]],
                ],
                { padding: 60, duration: 700, maxZoom: 14 },
            );
        } catch (e) {
            console.warn("Map flash fit failed:", e);
        }
    };

    // v822: after the flash has run, glide the camera to frame the area that
    // REMAINS (the post-elimination region), so the beat reads as "here's the
    // slice we just ruled out → now here's what's left." Unlike the flash fit,
    // this always reframes (no fully-in-view skip) so the seeker ends on the
    // tightened search area. Cap the zoom so a small remaining area doesn't
    // rocket in and lose all context.
    const fitMapToRemaining = (remaining: GeoJSON.Feature) => {
        const map = mapRef.current?.getMap();
        if (!map) return;
        try {
            const bb = turf.bbox(remaining); // [minLng,minLat,maxLng,maxLat]
            if (!bb.every((n) => Number.isFinite(n))) return;
            map.fitBounds(
                [
                    [bb[0], bb[1]],
                    [bb[2], bb[3]],
                ],
                { padding: 48, duration: 900, maxZoom: 14 },
            );
        } catch (e) {
            console.warn("Map remaining-area fit failed:", e);
        }
    };

    const triggerEliminationFlash = (
        delta: GeoJSON.Feature,
        remaining?: GeoJSON.Feature | null,
    ) => {
        // v911: a downward "cut" whoosh as the ruled-out slice flashes —
        // an answer landing reads as deliberate progress.
        play("elimination");
        fitMapToFlash(delta);
        flashTimersRef.current.forEach((t) => window.clearTimeout(t));
        flashTimersRef.current = [];
        // Blink the red wash on-off-on-off (two quick pulses), then leave
        // it on once more and fade it out slowly (~2x the old fade) so the
        // seeker really has time to register the eliminated slice. Each
        // step sets `visible` + the transition duration for that step:
        // snappy for the blinks, long for the final fade.
        const BLINK = 200; // ms between blink toggles
        const BLINK_FADE = 110; // crisp on/off transition
        const FINAL_FADE = 1700; // ~2x the previous 850 ms fade-out
        // [delay, visible, fadeMs]
        const steps: Array<[number, boolean, number]> = [
            [0, true, BLINK_FADE], // on  (pulse 1)
            [BLINK, false, BLINK_FADE], // off
            [BLINK * 2, true, BLINK_FADE], // on  (pulse 2)
            [BLINK * 3, false, BLINK_FADE], // off
            [BLINK * 4, true, BLINK_FADE], // on  (settle before the fade)
            [BLINK * 5, false, FINAL_FADE], // slow fade-out
        ];
        for (const [delay, visible, fadeMs] of steps) {
            flashTimersRef.current.push(
                window.setTimeout(() => {
                    setEliminationFlash((f) =>
                        f ? { ...f, visible, fadeMs } : null,
                    );
                }, delay),
            );
        }
        // v822: as the final fade BEGINS, glide the camera to frame what
        // remains — so the flash of the ruled-out slice resolves into a view
        // of the tightened search area. Runs during the fade so it reads as
        // one continuous beat rather than a hard jump after.
        if (remaining) {
            flashTimersRef.current.push(
                window.setTimeout(
                    () => fitMapToRemaining(remaining),
                    BLINK * 5,
                ),
            );
        }
        // Unmount once the final fade has fully run.
        flashTimersRef.current.push(
            window.setTimeout(
                () => setEliminationFlash(null),
                BLINK * 5 + FINAL_FADE + 100,
            ),
        );
        // Kick off with the first "on" already applied so step 0's
        // setTimeout(0) isn't the very first paint (avoids a 1-frame gap).
        setEliminationFlash({ feature: delta, visible: true, fadeMs: BLINK_FADE });
    };
    // v612: if an answer lands while the app is BACKGROUNDED, the flash
    // would play (and its timers expire) before the seeker ever sees it.
    // So when hidden, we skip the immediate flash and instead snapshot the
    // remaining area; on returning to the foreground we diff that baseline
    // against the now-current remaining area and flash everything that was
    // eliminated while away — the elimination "beat" the seeker missed.
    const hiddenBaselineRef = useRef<GeoJSON.Feature | null>(null);
    useEffect(() => {
        const onVis = () => {
            if (document.visibilityState === "hidden") {
                hiddenBaselineRef.current = prevWorkingRef.current;
                return;
            }
            const baseline = hiddenBaselineRef.current;
            hiddenBaselineRef.current = null;
            if (!baseline) return;
            try {
                const a = asPolygonFeature(baseline);
                const b = asPolygonFeature(prevWorkingRef.current);
                if (a && b) {
                    const delta = turf.difference(
                        turf.featureCollection([a as never, b as never]),
                    ) as GeoJSON.Feature | null;
                    if (delta && turf.area(delta) > 1) {
                        triggerEliminationFlash(delta, b);
                    }
                }
            } catch (e) {
                console.warn("Map foreground elimination-flash failed:", e);
            }
        };
        document.addEventListener("visibilitychange", onVis);
        return () => document.removeEventListener("visibilitychange", onVis);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    // v381: maskComputed is declared+reset higher up (next to the reveal
    // gate). The setMaskComputed(true) signal fires inside the async
    // elimination effect below, when setEliminationResult lands.
    // v376: signature of ONLY the fields that affect elimination, so a
    // color/collapsed/drag-only edit doesn't re-run the buffer/Voronoi
    // pipeline. Draft questions (drag:true) are skipped downstream in
    // applyQuestionsToMapGeoData; we still include them in the signature
    // so promoting a draft (drag:true → false) re-triggers the pipeline.
    const $questionsSig = useMemo(() => {
        return $questions
            .map((q) => {
                const d = q.data as Record<string, unknown>;
                return [
                    q.id,
                    q.key,
                    d.lat,
                    d.lng,
                    d.drag,
                    d.radius,
                    d.within,
                    d.hiderCloser,
                    d.type,
                    d.distance,
                    d.locationType,
                    JSON.stringify(d.cat ?? ""),
                ].join("|");
            })
            .join("¦");
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [$questions]);
    useEffect(() => {
        const inner = $mapGeoJSON || $polyGeoJSON;
        if (!inner) {
            questionFinishedMapData.set(null);
            setEliminationResult({ mask: null, pendingByCategory: {} });
            return;
        }
        const myGen = ++eliminationGenRef.current;
        const pendingByCategory: Record<string, GeoJSON.Feature[]> = {};
        (async () => {
            let working: typeof inner = inner;
            try {
                working = (await applyQuestionsToMapGeoData(
                    $questions,
                    working,
                    planningModeEnabled.get(),
                    (geoJSONObj, question) => {
                        if (question.id === "radius") return;
                        const cat =
                            CATEGORIES[question.id as CategoryId] ??
                            CATEGORIES.matching;
                        if (!pendingByCategory[cat.color]) {
                            pendingByCategory[cat.color] = [];
                        }
                        if (geoJSONObj && typeof geoJSONObj === "object") {
                            if ("type" in geoJSONObj) {
                                if (
                                    geoJSONObj.type === "FeatureCollection"
                                ) {
                                    for (const f of (
                                        geoJSONObj as GeoJSON.FeatureCollection
                                    ).features) {
                                        pendingByCategory[cat.color].push(
                                            f,
                                        );
                                    }
                                } else if (geoJSONObj.type === "Feature") {
                                    pendingByCategory[cat.color].push(
                                        geoJSONObj as GeoJSON.Feature,
                                    );
                                } else {
                                    pendingByCategory[cat.color].push(
                                        turf.feature(
                                            geoJSONObj as GeoJSON.Geometry,
                                        ) as GeoJSON.Feature,
                                    );
                                }
                            }
                        }
                    },
                )) as typeof working;
            } catch (e) {
                console.warn(
                    "Map applyQuestions failed (will retry once):",
                    e,
                );
                // v389: retry once after a 750 ms breather. Reload-after-
                // deploy can leave the @arcgis/core lazy chunk stale just
                // long enough for the first elimination pass to throw; by
                // the next pass the new service worker is active and the
                // chunk resolves cleanly. Stale-generation guard below
                // still drops a retried result if the user has moved on.
                if (myGen === eliminationGenRef.current) {
                    await new Promise((r) => setTimeout(r, 750));
                    try {
                        working = (await applyQuestionsToMapGeoData(
                            $questions,
                            inner,
                            planningModeEnabled.get(),
                        )) as typeof working;
                    } catch (e2) {
                        console.warn(
                            "Map applyQuestions retry also failed:",
                            e2,
                        );
                    }
                }
            }
            // v759: the pre-game seeker Map is pre-mounted purely for
            // network warmup and rendered opacity-0 (SeekerPage's lobby
            // branch), so the dark dimming mask it would produce is
            // invisible — and computing `holedMask` (a world-scale
            // turf.difference over the raw play-area multipolygon) at that
            // point is pure waste AND, on a dense boundary like NYC, blocks
            // the main thread long enough to FREEZE the tab at the role-
            // picker step. This was exposed once v757 soft-nav stopped
            // wiping the volatile polyGeoJSON on the wizard→lobby
            // transition (before, the hard reload left polyGeoJSON null so
            // this pass had no geometry to chew on). Skip the mask until the
            // game has actually started — the visible in-game Map is a
            // separate instance that mounts with `hidingPeriodEndsAt` set.
            let mask: GeoJSON.Feature | null = null;
            // v818: skip the cosmetic dimming mask on a pathologically large
            // boundary. holedMask's world-scale turf.difference over a whole
            // county / huge metro blocks the main thread for seconds and
            // freezes the tab (the Dalarna County "PC heats up" report). The
            // play-area outline still renders; only the outside-dim is lost.
            const boundaryTooBig =
                coordCountAtLeast(working, MASK_MAX_VERTICES) >=
                MASK_MAX_VERTICES;
            if (boundaryTooBig) {
                console.warn(
                    "[map] play-area boundary too large — skipping dimming mask to avoid a main-thread freeze",
                );
            }
            if (hidingPeriodEndsAt.get() !== null && !boundaryTooBig) {
                try {
                    // Simplify the mask input first (mirroring the hider
                    // map, v758): the mask is a faint dimming fill drawn
                    // UNDER the crisp play-area outline + question layers,
                    // so a coarser mask edge is invisible while the vertex
                    // cut makes the world-scale difference dramatically
                    // cheaper on a dense multipolygon. Simplify a CLONE so
                    // the exact `working` geometry stored below
                    // (questionFinishedMapData + pending-clip) is untouched.
                    let maskInput: unknown = working;
                    try {
                        maskInput = turf.simplify(working as never, {
                            tolerance: 0.0006,
                            highQuality: false,
                        });
                    } catch {
                        maskInput = working;
                    }
                    // v899: off the main thread — the world-scale
                    // turf.difference blocked the tab for a beat on a dense
                    // boundary every time an answer shrank the area. Worker
                    // rejects → transparent main-thread fallback inside.
                    mask = (await holedMaskViaWorker(
                        maskInput as never,
                    )) as GeoJSON.Feature | null;
                } catch (e) {
                    console.warn("Map holedMask failed:", e);
                }
            }
            if (myGen !== eliminationGenRef.current) return; // stale

            // Flash the slice this pass just eliminated (only when the
            // SAME play area shrank — a play-area change or an
            // un-elimination must not flash). turf.difference returns
            // null when nothing was removed, so the diff itself is the
            // guard.
            try {
                const prevWorking = prevWorkingRef.current;
                if (prevWorking && prevInnerRef.current === inner) {
                    const a = asPolygonFeature(prevWorking);
                    const b = asPolygonFeature(working);
                    if (a && b) {
                        const delta = turf.difference(
                            turf.featureCollection([a as never, b as never]),
                        ) as GeoJSON.Feature | null;
                        if (delta && turf.area(delta) > 1) {
                            // While backgrounded, don't fire now (it'd
                            // expire unseen) — the visibilitychange→visible
                            // handler replays the cumulative delta from the
                            // hidden baseline instead.
                            if (document.visibilityState !== "hidden") {
                                triggerEliminationFlash(delta, b);
                            }
                        }
                    }
                }
            } catch (e) {
                console.warn("Map elimination-flash diff failed:", e);
            }
            prevWorkingRef.current = asPolygonFeature(working);
            prevInnerRef.current = inner;

            // v598: clip each pending (draft) PREVIEW to the remaining area
            // (`working`, the cumulative result of the ANSWERED questions)
            // so a new question's footprint doesn't extend into regions
            // already eliminated. Polygons (tentacles/thermometer) are
            // intersected; line outlines (matching/measuring) are split to
            // the runs that fall inside the remaining area. Pure visual —
            // the actual elimination already intersects correctly.
            const clipToWorking = (
                feat: GeoJSON.Feature,
                area: GeoJSON.FeatureCollection | GeoJSON.Feature,
            ): GeoJSON.Feature[] => {
                const areaFeats: GeoJSON.Feature[] =
                    (area as GeoJSON.FeatureCollection).type ===
                    "FeatureCollection"
                        ? (area as GeoJSON.FeatureCollection).features
                        : [area as GeoJSON.Feature];
                const polyAreas = areaFeats.filter(
                    (af) =>
                        af.geometry?.type === "Polygon" ||
                        af.geometry?.type === "MultiPolygon",
                );
                if (polyAreas.length === 0) return [feat];
                const gtype = feat.geometry?.type;
                try {
                    if (gtype === "Polygon" || gtype === "MultiPolygon") {
                        const out: GeoJSON.Feature[] = [];
                        for (const af of polyAreas) {
                            const inter = turf.intersect(
                                turf.featureCollection([
                                    feat as never,
                                    af as never,
                                ]),
                            );
                            if (inter) out.push(inter as GeoJSON.Feature);
                        }
                        return out;
                    }
                    if (
                        gtype === "LineString" ||
                        gtype === "MultiLineString"
                    ) {
                        const lines =
                            gtype === "LineString"
                                ? [
                                      (feat.geometry as GeoJSON.LineString)
                                          .coordinates,
                                  ]
                                : (
                                      feat.geometry as GeoJSON.MultiLineString
                                  ).coordinates;
                        const inside = (c: number[]) =>
                            polyAreas.some((af) => {
                                try {
                                    return turf.booleanPointInPolygon(
                                        c as [number, number],
                                        af as never,
                                    );
                                } catch {
                                    return false;
                                }
                            });
                        const out: GeoJSON.Feature[] = [];
                        for (const coords of lines) {
                            let run: number[][] = [];
                            const flush = () => {
                                if (run.length >= 2) {
                                    out.push(
                                        turf.lineString(
                                            run,
                                            feat.properties ?? {},
                                        ),
                                    );
                                }
                                run = [];
                            };
                            for (const c of coords) {
                                if (inside(c)) run.push(c);
                                else flush();
                            }
                            flush();
                        }
                        return out;
                    }
                } catch {
                    /* fall through to unclipped */
                }
                return [feat];
            };
            const clippedPending: Record<string, GeoJSON.Feature[]> = {};
            for (const [color, feats] of Object.entries(pendingByCategory)) {
                const out: GeoJSON.Feature[] = [];
                for (const f of feats) {
                    try {
                        out.push(...clipToWorking(f, working as never));
                    } catch {
                        out.push(f);
                    }
                }
                if (out.length) clippedPending[color] = out;
            }
            questionFinishedMapData.set(working);
            setEliminationResult({ mask, pendingByCategory: clippedPending });
            setMaskComputed(true); // v381: signal the reveal gate
        })();
        // `mapLoaded` is a dep so the mask re-applies the moment
        // MapLibre's style is ready — needed because a cold PWA
        // start hydrates polyGeoJSON before maplibre-gl is, and any
        // source data set during init is silently dropped.
        // v376: depend on $questionsSig (elimination-relevant fields only)
        // not the raw $questions array, so display-only edits (color,
        // collapsed) don't re-run the pipeline. $questions is still read
        // inside the effect — the sig is just the trigger.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [$mapGeoJSON, $polyGeoJSON, $questionsSig, mapLoaded]);

    // Transit-route overlays: see the useTransitRouteOverlays() call above
    // (the fetch + state now live in the shared hook).

    // Pending-radius circles. The "elimination" pipeline above
    // deliberately skips radius questions so the Leaflet
    // RadarScanOverlay can render a rotating sweep instead. We
    // haven't ported that animation yet, so without something
    // here a pending radius question would have no visual on
    // Map. Static turf-built circle is a clean placeholder —
    // the seeker still sees the affected area; just no sweep.
    // Build pending-radius circles AND the underlying
    // center/radius list in one pass. The list feeds the radar
    // sweep animation below — same source data, different
    // visual representations.
    const { pendingRadiusFeatures, radarTargets } = useMemo(() => {
        const features: GeoJSON.Feature[] = [];
        const targets: Array<{ lat: number; lng: number; radiusKm: number }> =
            [];
        for (const q of $questions) {
            if (q.id !== "radius") continue;
            if (!q.data?.drag) continue;
            // v475: nothing is drawn on the main map for a question until
            // it has actually been SENT. A radius question is created in a
            // drafting state (drag:true, no createdAt) the moment the
            // seeker taps Radar — before the configure dialog even opens —
            // and `createdAt` is stamped only on "Send question". Skipping
            // un-sent drafts here keeps the radar circle (and its sweep)
            // off the map until the seeker confirms.
            if (!(q.data as { createdAt?: number }).createdAt) continue;
            const data = q.data as {
                lat?: number;
                lng?: number;
                radius?: number;
                unit?: "miles" | "kilometers" | "meters";
                color?: string;
            };
            if (
                typeof data.lat !== "number" ||
                typeof data.lng !== "number" ||
                typeof data.radius !== "number"
            ) {
                continue;
            }
            const radiusKm = turf.convertLength(
                data.radius,
                (data.unit as turf.Units | undefined) ?? "kilometers",
                "kilometers",
            );
            try {
                const circle = turf.circle(
                    [data.lng, data.lat],
                    radiusKm,
                    { units: "kilometers", steps: 64 },
                );
                circle.properties = {
                    color:
                        (data.color &&
                            CATEGORIES.radius?.color) ??
                        CATEGORIES.radius?.color ??
                        "#f5a888",
                };
                features.push(circle as GeoJSON.Feature);
                targets.push({
                    lat: data.lat,
                    lng: data.lng,
                    radiusKm,
                });
            } catch (e) {
                console.warn("Map radius circle failed:", e);
            }
        }
        return {
            pendingRadiusFeatures: {
                type: "FeatureCollection",
                features,
            } as GeoJSON.FeatureCollection,
            radarTargets: targets,
        };
    }, [$questions]);

    // Radar sweep animation — a classic rotating radar BEAM with a
    // fading TRAIL behind it, over each pending radius question (the old
    // uniform-opacity wedge read as a rotating pie-slice, not a radar
    // scan). Each frame we build, per target: a triangle-fan TRAIL of
    // `SWEEP_SEGMENTS` thin wedges spanning `SWEEP_TRAIL_DEG` behind the
    // head — each tagged with a brightness `a` (1 at the leading edge →
    // 0 at the tail) that a data-driven `fill-opacity` fades out — PLUS a
    // bright leading beam line from the centre to the perimeter at the
    // head angle. Written straight into the MapLibre source via
    // getSource().setData(...) so the animation stays GPU-side (no React
    // re-render per frame). Gated on having ≥1 target so an empty pending
    // set burns no CPU.
    const SWEEP_PERIOD_MS = 4000; // ms per full rotation
    const SWEEP_TRAIL_DEG = 150; // length of the fading trail behind the beam
    const SWEEP_SEGMENTS = 24; // trail resolution
    useEffect(() => {
        if (radarTargets.length === 0) return;
        let raf = 0;
        const step = SWEEP_TRAIL_DEG / SWEEP_SEGMENTS;
        const tick = () => {
            const map = mapRef.current?.getMap();
            const source = map?.getSource("radar-sweep") as
                | maplibregl.GeoJSONSource
                | undefined;
            if (source) {
                const now = performance.now();
                // Head sweeps clockwise (decreasing bearing over time reads
                // as a clockwise rotation on the map).
                const headDeg =
                    ((now % SWEEP_PERIOD_MS) / SWEEP_PERIOD_MS) * 360;
                const features: GeoJSON.Feature[] = [];
                for (const t of radarTargets) {
                    const center: [number, number] = [t.lng, t.lat];
                    // Perimeter points along the trail arc, head → tail.
                    // v895 perf: this ran `turf.destination` (a full geodesic
                    // solve) ~25×/target EVERY rAF frame — continuous CPU/heat
                    // while a radar question is pending. Replaced with an inline
                    // equirectangular offset (bearing clockwise from north),
                    // which is visually identical at these km-scale radii and
                    // ~10× cheaper. Per-target deg-per-km factors are constant.
                    const DEG = Math.PI / 180;
                    const kmPerDegLat = 111.195;
                    const kmPerDegLng =
                        111.195 * Math.cos(t.lat * DEG) || 111.195;
                    const perim: [number, number][] = [];
                    for (let i = 0; i <= SWEEP_SEGMENTS; i++) {
                        const b = (headDeg - i * step) * DEG;
                        const dLat = (t.radiusKm / kmPerDegLat) * Math.cos(b);
                        const dLng = (t.radiusKm / kmPerDegLng) * Math.sin(b);
                        perim.push([t.lng + dLng, t.lat + dLat]);
                    }
                    // Fan of thin wedges [centre, perim[i], perim[i+1]],
                    // brightness fading from the head (a=1) to the tail.
                    for (let i = 0; i < SWEEP_SEGMENTS; i++) {
                        const a = 1 - i / SWEEP_SEGMENTS;
                        features.push({
                            type: "Feature",
                            properties: { a },
                            geometry: {
                                type: "Polygon",
                                coordinates: [
                                    [
                                        center,
                                        perim[i],
                                        perim[i + 1],
                                        center,
                                    ],
                                ],
                            },
                        });
                    }
                    // Leading beam line — centre → perimeter at the head.
                    features.push({
                        type: "Feature",
                        properties: { beam: 1 },
                        geometry: {
                            type: "LineString",
                            coordinates: [center, perim[0]],
                        },
                    });
                }
                source.setData({
                    type: "FeatureCollection",
                    features,
                });
            }
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [radarTargets]);

    // Click-to-edit: tapping a marker opens the relevant
    // QuestionCard in a Dialog. Uses an isDraggingRef gate so
    // an accidental click at the end of a drag doesn't pop the
    // dialog. The dialog itself is rendered below the Map JSX.
    const [selectedMarker, setSelectedMarker] = useState<{
        questionKey: number;
        slot: "primary" | "a" | "b";
    } | null>(null);
    const isDraggingRef = useRef(false);

    // Context menu — right-click on desktop / long-press on
    // mobile opens an "Add radius / thermometer / tentacles"
    // mini menu at the click coordinates. Mirrors the
    // leaflet-contextmenu plugin the Leaflet path uses, just
    // re-rendered as a positioned div.
    const [contextMenu, setContextMenu] = useState<{
        screenX: number;
        screenY: number;
        lat: number;
        lng: number;
    } | null>(null);

    // Pointer cursor while hovering a tappable station feature (the
    // onMouseEnter/Leave events fire only for STATION_TAP_LAYERS).
    const [stationHover, setStationHover] = useState(false);

    // Map-first trip planning. A tap on a hiding-zone or travel-time
    // feature resolves the station beneath it and opens the station
    // transit card (StationTransitCard, mounted by SeekerPage/HiderPage).
    // Voronoi-like fallback: the nearest hiding-zone station whose zone
    // contains the tap (within the hiding radius). Lets a tap ANYWHERE
    // inside a zone select its station — generous in sparse areas, and it
    // resolves to the nearest centre where zones overlap — without
    // computing/rendering Voronoi polygons (just an O(N) distance scan over
    // the station points already in the overlay).
    const nearestZoneStation = (
        lngLat: maplibregl.LngLat,
    ): { lat: number; lng: number; name?: string; modes?: string[] } | null => {
        if (!$showHidingZones || !$hidingZones?.features?.length) return null;
        const radiusM = turf.convertLength(
            $hidingRadius,
            $hidingRadiusUnits,
            "meters",
        );
        const click = turf.point([lngLat.lng, lngLat.lat]);
        let best: {
            d: number;
            lat: number;
            lng: number;
            name?: string;
            modes?: string[];
        } | null = null;
        for (const f of $hidingZones.features) {
            if (f.geometry?.type !== "Point") continue;
            const [lng, lat] = f.geometry.coordinates as [number, number];
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
            const d = turf.distance(click, turf.point([lng, lat]), {
                units: "meters",
            });
            if (d > radiusM) continue;
            if (!best || d < best.d) {
                const props = (f.properties ?? {}) as Record<string, unknown>;
                best = {
                    d,
                    lat,
                    lng,
                    name:
                        typeof props.name === "string" ? props.name : undefined,
                    modes: Array.isArray(props.modes)
                        ? (props.modes as string[])
                        : undefined,
                };
            }
        }
        return best
            ? { lat: best.lat, lng: best.lng, name: best.name, modes: best.modes }
            : null;
    };

    const handleStationTap = (
        e: maplibregl.MapLayerMouseEvent | maplibregl.MapMouseEvent,
    ) => {
        const features = (e as maplibregl.MapLayerMouseEvent).features;
        if (features && features.length > 0) {
            const station = stationFromFeature(features[0], e.lngLat);
            if (station) {
                selectedMapStation.set(station);
                return;
            }
        }
        // No direct hit on a dot/label — fall back to the zone the tap
        // lands in. Skipped while drawing a question (a tap there is
        // placing geometry, not picking a station).
        if ($drawingQuestionKey !== null) return;
        const nearest = nearestZoneStation(e.lngLat);
        if (nearest) selectedMapStation.set(nearest);
    };

    // Live blue "you are here" dot, always shown on the seeker map (like
    // every other mapping app). Decoupled from the Follow Me toggle —
    // that only controls auto-centering below. The watch (shared with the
    // hider map) writes lastKnownPosition and returns the latest fix for
    // the marker + follow-me. The marker is rendered in JSX below.
    const selfPosition = useSelfPositionWatch();

    // Follow Me: when enabled, recenter the map on each new GPS fix so
    // the seeker's dot stays in view as they move. Off by default so it
    // doesn't fight manual panning.
    useEffect(() => {
        if (!$followMe || !selfPosition) return;
        const map = mapRef.current?.getMap();
        if (!map) return;
        map.easeTo({
            center: [selfPosition.lng, selfPosition.lat],
            duration: 600,
        });
    }, [$followMe, selfPosition]);

    // Map-screenshot trigger. The MapDisplayControls "Save image"
    // button dispatches a `jlhs:save-map-image` CustomEvent on
    // window; we capture the current WebGL canvas as a PNG and
    // trigger a download. Replaces the leaflet-easyprint control
    // that used to live on the Leaflet map.
    useEffect(() => {
        const handler = () => {
            const map = mapRef.current?.getMap();
            if (!map) return;
            // v487: the map no longer runs with `preserveDrawingBuffer`
            // (that flag tanks render perf — see the MapGL props). Without
            // it the WebGL backbuffer is cleared after compositing, so a
            // bare toDataURL() would come back blank. Capture INSIDE a
            // `render` callback — the buffer is valid for that synchronous
            // frame — then force one with triggerRepaint().
            const capture = () => {
                try {
                    const dataUrl = map.getCanvas().toDataURL("image/png");
                    const a = document.createElement("a");
                    a.href = dataUrl;
                    a.download = `jetlag-map-${new Date()
                        .toISOString()
                        .replace(/[:.]/g, "-")}.png`;
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    toast.success("Map image saved");
                } catch (e) {
                    console.error("Map screenshot failed:", e);
                    toast.error("Couldn't save map image");
                }
            };
            map.once("render", capture);
            map.triggerRepaint();
        };
        window.addEventListener("jlhs:save-map-image", handler);
        return () =>
            window.removeEventListener("jlhs:save-map-image", handler);
    }, []);

    // PolygonDraw integration. When drawingQuestionKey flips to
    // a non-null value the user has opened a draw session — for
    // a brand-new custom hiding zone (-1) or to edit an existing
    // custom-typed question (matching custom-zone / custom-
    // points; measuring custom-measure; tentacles custom). We
    // attach a mapbox-gl-draw control configured for the right
    // mode and wire the draw events to the same atom writes the
    // Leaflet PolygonDraw does.
    useEffect(() => {
        if ($drawingQuestionKey === null) return;
        const map = mapRef.current?.getMap();
        if (!map) return;
        const targetQ =
            $drawingQuestionKey === -1
                ? null
                : questions
                      .get()
                      .find((q) => q.key === $drawingQuestionKey);

        // Pick the draw mode + initial features based on what
        // the user is editing. Polygons for zones / hiding
        // zones, points for tentacle locations / matching
        // points / measuring points.
        let mode: "draw_polygon" | "draw_point" = "draw_polygon";
        let initialFeatures: GeoJSON.Feature[] = [];
        if ($drawingQuestionKey === -1) {
            mode = "draw_polygon";
            // Hiding-zone editing reads back the existing
            // polyGeoJSON so the user can refine, not just
            // start over.
            const existing = polyGeoJSON.get();
            if (existing) {
                initialFeatures = existing.features as GeoJSON.Feature[];
            }
        } else if (
            targetQ?.id === "tentacles" &&
            (targetQ.data as { locationType?: string }).locationType ===
                "custom"
        ) {
            mode = "draw_point";
            const places =
                (targetQ.data as { places?: GeoJSON.Feature[] }).places ?? [];
            initialFeatures = places as GeoJSON.Feature[];
        } else if (
            targetQ?.id === "matching" &&
            (targetQ.data as { type?: string }).type === "custom-zone"
        ) {
            mode = "draw_polygon";
            const geo = (targetQ.data as { geo?: GeoJSON.Feature }).geo;
            if (geo) initialFeatures = [geo];
        } else if (
            targetQ?.id === "matching" &&
            (targetQ.data as { type?: string }).type === "custom-points"
        ) {
            mode = "draw_point";
            const geo = (targetQ.data as { geo?: GeoJSON.FeatureCollection })
                .geo;
            if (geo?.features) initialFeatures = geo.features;
        } else if (
            targetQ?.id === "measuring" &&
            (targetQ.data as { type?: string }).type === "custom-measure"
        ) {
            mode = "draw_point";
            const geo = (targetQ.data as { geo?: GeoJSON.FeatureCollection })
                .geo;
            if (geo?.features) initialFeatures = geo.features;
        }

        const draw = new MapboxDraw({
            displayControlsDefault: false,
            controls: {
                polygon: mode === "draw_polygon",
                point: mode === "draw_point",
                trash: true,
            },
            defaultMode: mode,
        });
        map.addControl(
            draw as unknown as maplibregl.IControl,
            "top-right",
        );

        // Load existing features so the user edits in place
        // instead of starting from a blank canvas.
        if (initialFeatures.length > 0) {
            try {
                draw.set({
                    type: "FeatureCollection",
                    features: initialFeatures.filter(
                        (f) => f?.type === "Feature" && f.geometry,
                    ) as GeoJSON.Feature[],
                });
            } catch (e) {
                console.warn("Map draw.set seed failed:", e);
            }
        }

        const onFeatureChange = () => {
            const fc = draw.getAll();
            // Hiding-zone case.
            if ($drawingQuestionKey === -1) {
                const polys = fc.features.filter(
                    (f) =>
                        f.geometry.type === "Polygon" ||
                        f.geometry.type === "MultiPolygon",
                );
                if (polys.length === 0) return;
                const out = turf.featureCollection(polys) as
                    GeoJSON.FeatureCollection<
                        GeoJSON.Polygon | GeoJSON.MultiPolygon
                    >;
                mapGeoJSON.set(out);
                polyGeoJSON.set(out);
                questions.set([]);
                void clearCache(CacheType.ZONE_CACHE);
                return;
            }
            if (!targetQ) return;
            const data = targetQ.data as Record<string, unknown>;
            if (
                targetQ.id === "tentacles" &&
                data.locationType === "custom"
            ) {
                // Points — write to data.places, dedup by coord
                // signature.
                const points = fc.features.filter(
                    (f) => f.geometry.type === "Point",
                );
                const dedup: Record<string, GeoJSON.Feature> = {};
                for (const p of points) {
                    const c = (p.geometry as GeoJSON.Point).coordinates;
                    dedup[`${c[0]},${c[1]}`] = p;
                }
                data.places = Object.values(dedup);
                questionModified();
            } else if (
                targetQ.id === "matching" &&
                data.type === "custom-zone"
            ) {
                const polys = fc.features.filter(
                    (f) =>
                        f.geometry.type === "Polygon" ||
                        f.geometry.type === "MultiPolygon",
                );
                if (polys.length === 0) {
                    data.geo = undefined;
                } else {
                    // Combine into a single feature so the
                    // downstream elimination pipeline sees one
                    // shape.
                    const combined = turf.combine(
                        turf.featureCollection(polys as never),
                    ).features[0];
                    data.geo = combined;
                }
                questionModified();
            } else if (
                targetQ.id === "matching" &&
                data.type === "custom-points"
            ) {
                const points = fc.features.filter(
                    (f) => f.geometry.type === "Point",
                );
                const dedup: Record<string, GeoJSON.Feature> = {};
                for (const p of points) {
                    const c = (p.geometry as GeoJSON.Point).coordinates;
                    dedup[`${c[0]},${c[1]}`] = p;
                }
                data.geo = {
                    type: "FeatureCollection",
                    features: Object.values(dedup),
                };
                questionModified();
            } else if (
                targetQ.id === "measuring" &&
                data.type === "custom-measure"
            ) {
                const points = fc.features.filter(
                    (f) => f.geometry.type === "Point",
                );
                data.geo = {
                    type: "FeatureCollection",
                    features: points,
                };
                questionModified();
            }
        };
        map.on("draw.create", onFeatureChange);
        map.on("draw.update", onFeatureChange);
        map.on("draw.delete", onFeatureChange);

        return () => {
            map.off("draw.create", onFeatureChange);
            map.off("draw.update", onFeatureChange);
            map.off("draw.delete", onFeatureChange);
            try {
                map.removeControl(draw as unknown as maplibregl.IControl);
            } catch {
                /* control was already torn down (e.g. map
                   restyled) — ignore */
            }
        };
    }, [$drawingQuestionKey]);

    // v230+: the OSM-raster + CSS-invert chain is gone. The basemap
    // is Protomaps vector with native light/dark flavors, so we don't
    // need to filter the canvas, pre-invert overlays, or carve
    // satellite out. The elimination mask renders as plain dark slate
    // in every mode.
    // Elimination mask paint — theme-aware. In light mode the original
    // `#0f172a` slate at 0.45 over the bright Protomaps basemap reads
    // instantly as "darkened/eliminated"; in dark mode the basemap is
    // already near-black, so the same paint blended (~3 % perceptual
    // delta) made the mask effectively invisible — eliminated land,
    // remaining play area, and "off the play area entirely" all looked
    // identical, and overlays underneath the mask (rail tiles, transit
    // GeoJSONs) bled through visually. Dark mode now uses near-pure
    // black at 0.75 opacity, which crushes everything outside the
    // in-play polygon to a clearly distinct shade vs. the slate basemap.
    const eliminationFillColor = $theme === "dark" ? "#000000" : "#0f172a";
    const eliminationFillOpacity = $theme === "dark" ? 0.75 : 0.45;
    const eliminationOutlineOpacity = $theme === "dark" ? 0.85 : 0.55;

    // Map-label contrast (v622). Station name / arrival labels sit ON the
    // basemap, so they follow the BASEMAP's brightness, not the UI theme:
    // white-on-dark works over satellite imagery and the dark Protomaps
    // flavor, but on the LIGHT basemap the white fill washed out (only the
    // thin halo read). So invert to dark text + light halo whenever the
    // basemap is light (light theme AND satellite off).
    const darkBasemap = $satellite || $theme === "dark";
    const mapLabelColor = darkBasemap ? "#ffffff" : "#1f2937";
    const mapLabelHalo = darkBasemap
        ? "rgba(0,0,0,0.85)"
        : "rgba(255,255,255,0.9)";

    return (
        <div className={cn("relative w-full h-screen", className)}>
            <MapGL
                ref={mapRef}
                initialViewState={initialView}
                mapStyle={style}
                attributionControl={false}
                style={{ width: "100%", height: "100%" }}
                dragRotate={false}
                pitchWithRotate={false}
                touchPitch={false}
                /* v326: cap zoom one level past the PMTiles archive's
                   z15 ceiling. The archive doesn't carry data above
                   z15, so further zoom is pure overzoom — MapLibre
                   re-rasterises the z15 vector tile larger but no
                   new detail appears. z16 gives one level of inspect-
                   a-block headroom; past that the gesture feels
                   broken. Also short-circuits any temptation to push
                   the preload to higher zooms — the source has
                   nothing more to give. */
                maxZoom={16}
                /* v495: snappier tile updates. fadeDuration=0 drops the
                   300ms cross-fade so a freshly-decoded tile replaces the
                   overzoomed parent placeholder the instant it's ready,
                   instead of lingering blurry while it fades in — the
                   "enlarged low-zoom tile hangs around" symptom. A large
                   maxTileCacheSize keeps recently-seen tiles resident in
                   GPU/RAM so panning or zooming BACK over them repaints
                   with zero fetch (faster than even the SW disk cache).
                   Neither helps a genuinely-uncached first visit — that's
                   bounded by the network round-trip + the z15 source cap. */
                fadeDuration={0}
                maxTileCacheSize={512}
                /* v487: preserveDrawingBuffer REMOVED — it forces the GL
                   backbuffer to be retained every frame, which MapLibre
                   warns "leads to poorer performance" (the choppy
                   pan/zoom). The Save-image action now reads the canvas
                   inside a `render` event instead (see the
                   jlhs:save-map-image handler), so we don't need it. */
                onLoad={handleLoad}
                onIdle={onTilesIdle}
                onMoveEnd={handleMoveEnd}
                // Panning the map turns Follow Me OFF (and stops the
                // auto-recenter that would otherwise fight the pan). Only a
                // USER drag fires this — the follow-me `easeTo` is
                // programmatic and doesn't. (v891)
                onDragStart={() => {
                    if (followMe.get()) followMe.set(false);
                }}
                onError={handleMapLibreError}
                onContextMenu={(e) => {
                    setContextMenu({
                        screenX: e.point.x,
                        screenY: e.point.y,
                        lat: e.lngLat.lat,
                        lng: e.lngLat.lng,
                    });
                }}
                onClick={(e) => {
                    setContextMenu(null);
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
                    // Map-first trip planning: a tap on a candidate
                    // hiding zone / station opens the station transit
                    // card (plan a trip to it from the role-appropriate
                    // origin). This is the primary entry point — far
                    // more common than searching for a station by name.
                    handleStationTap(e);
                }}
                interactiveLayerIds={STATION_TAP_LAYERS}
                cursor={stationHover ? "pointer" : undefined}
                onMouseEnter={() => setStationHover(true)}
                onMouseLeave={() => setStationHover(false)}
            >
                {/* Attribution moved to the top-left (v616) so it's out of
                    the way of the bottom controls. Zoom buttons removed in
                    v101 — they overlap the in-app Map options chip on small
                    phones and pinch-to-zoom covers it natively. The scale
                    ruler was removed in v616 (it sat where the Map-options
                    chip now lives, bottom-left). */}
                <AttributionControl compact position="top-left" />

                {/* Elimination mask — everything OUTSIDE the in-play polygon
                    (the play area minus eliminated regions) gets darkened.
                    v823: mounted FIRST (before transit) and ALWAYS present
                    (empty data when there's no mask) so `elimination-fill` is
                    a stable, already-added `beforeId` target. maplibre REFUSES
                    to add a layer whose `beforeId` doesn't exist yet, so
                    transit — which anchors below this — must find it already on
                    the map. Everything drawn AFTER this (transit anchors below
                    it; hiding zones / play-area / flash / pins are appended
                    above it) lands in the right order deterministically,
                    regardless of async load timing. Empty data draws nothing,
                    so an inactive mask is invisible. */}
                <Source
                    id="elimination"
                    type="geojson"
                    data={eliminationResult.mask ?? EMPTY_FEATURE_COLLECTION}
                >
                    <Layer
                        id={ELIMINATION_MASK_LAYER_ID}
                        type="fill"
                        paint={{
                            "fill-color": eliminationFillColor,
                            "fill-opacity": eliminationFillOpacity,
                        }}
                    />
                    <Layer
                        id="elimination-outline"
                        type="line"
                        paint={{
                            "line-color": eliminationFillColor,
                            "line-width": 1,
                            "line-opacity": eliminationOutlineOpacity,
                        }}
                    />
                </Source>

                {/* Transit-route overlays — shared with the hider map
                    via TransitRouteLayers so colours + behaviour match
                    across both map paths. v823: anchored BELOW the
                    elimination mask (`beforeId`) so lines outside the
                    remaining area get dimmed like everything else — without
                    it, the async-loaded transit layers appended on top of the
                    mask and stayed bright ("subway lines aren't dimmed"). */}
                <TransitRouteLayers
                    transitFC={transitFC}
                    beforeId={ELIMINATION_MASK_LAYER_ID}
                />

                {/* Hiding-zones overlay — mirrored from ZoneSidebar's
                    showGeoJSON via the hidingZonesGeoJSON atom. The default
                    "stations" style emits Point features, painted as the
                    zoom-scaled dots below; the "zones"/"no-overlap" styles
                    emit polygons, painted as the fill + dashed outline. The
                    style picker in the zone sidebar switches between them.

                    Gated on the `displayHidingZones` TOGGLE, not just the
                    data atom: the layers are in `interactiveLayerIds`, so if
                    the atom held stale features after the toggle flipped off
                    the zones stayed clickable (and the station card opened)
                    while invisible. Tying render + interactivity to the
                    toggle makes "off" mean off. */}
                <FadeOverlay
                    active={$showHidingZones}
                    data={
                        hidingZonesDisplay &&
                        hidingZonesDisplay.features.length > 0
                            ? hidingZonesDisplay
                            : null
                    }
                >
                    {(data, shown) => (
                        <Source
                            id="hiding-zones"
                            type="geojson"
                            data={data}
                        >
                            <Layer
                                id="hiding-zones-fill"
                                type="fill"
                                filter={[
                                    "any",
                                    ["==", ["geometry-type"], "Polygon"],
                                    ["==", ["geometry-type"], "MultiPolygon"],
                                ]}
                                paint={fadePaint({
                                    // Light basemap: a NEUTRAL grey wash — the
                                    // red tint read as too prominent / "took
                                    // over" the bright map, so the fill is a
                                    // plain grey that's visible but recedes.
                                    // Dark/satellite basemap: a faint red tint
                                    // disappears on near-black, so the overlay
                                    // paints a brightening near-white wash that
                                    // POSITIVELY lights up the remaining hiding
                                    // circles against the darker surround.
                                    "fill-color": !darkBasemap
                                        ? "hsl(0, 0%, 42%)"
                                        : $theme === "dark"
                                          ? "#f5e7e3"
                                          : "hsl(2, 70%, 54%)",
                                    "fill-opacity": shown
                                        ? !darkBasemap
                                            ? 0.15
                                            : $theme === "dark"
                                              ? 0.16
                                              : 0.08
                                        : 0,
                                    "fill-opacity-transition": {
                                        duration: 280,
                                    },
                                })}
                            />
                            <Layer
                                id="hiding-zones-line"
                                type="line"
                                filter={[
                                    "any",
                                    ["==", ["geometry-type"], "Polygon"],
                                    ["==", ["geometry-type"], "MultiPolygon"],
                                    ["==", ["geometry-type"], "LineString"],
                                    ["==", ["geometry-type"], "MultiLineString"],
                                ]}
                                paint={fadePaint({
                                    "line-color": "hsl(2, 70%, 54%)",
                                    "line-width": 1.5,
                                    // v783: the red dashed extent border was
                                    // removed on every basemap — it read as
                                    // clutter. The faint fill alone conveys the
                                    // extent.
                                    "line-opacity": 0,
                                    "line-opacity-transition": {
                                        duration: 280,
                                    },
                                    "line-dasharray": [6, 5],
                                })}
                            />
                            <Layer
                                id="hiding-zones-points"
                                type="circle"
                                filter={["==", ["geometry-type"], "Point"]}
                                paint={fadePaint({
                                    // Zoom-scaled station dots — small enough that
                                    // a dense network (Stockholm-scale) reads as a
                                    // tidy field of points rather than a solid mass.
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
                                    // Dark/satellite: light-grey dots (v783 —
                                    // the red field was too loud). Light
                                    // basemap: neutral very-dark-grey.
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
                            {/* Invisible larger hit target on each station
                                point so a tap near the dot opens the
                                transit card. The visible dots are tiny; the
                                zone fill is a single union with no
                                per-station data, so this is the tap target
                                (see STATION_TAP_LAYERS). */}
                            <Layer
                                id="hiding-zones-hit"
                                type="circle"
                                filter={["==", ["geometry-type"], "Point"]}
                                paint={{
                                    "circle-radius": 16,
                                    "circle-color": "#000000",
                                    "circle-opacity": 0,
                                }}
                            />
                            {/* Station name labels. Reads `name` off the
                                centre point features the zone overlay ships
                                alongside the circles. Hidden when zoomed out
                                / on overlap so a dense network doesn't turn
                                into a wall of text. */}
                            <Layer
                                id="hiding-zones-labels"
                                type="symbol"
                                filter={["==", ["geometry-type"], "Point"]}
                                minzoom={11}
                                layout={{
                                    // v835: prefer the shortened label
                                    // (abbreviated + truncated) computed in
                                    // `hidingZonesDisplay`; fall back to the
                                    // full name.
                                    "text-field": [
                                        "coalesce",
                                        ["get", "shortName"],
                                        ["get", "name"],
                                        "",
                                    ],
                                    "text-size": 11,
                                    // Must be a fontstack the glyph proxy
                                    // actually serves (Protomaps assets =
                                    // Noto Sans); "Open Sans" 404s → no text.
                                    "text-font": ["Noto Sans Regular"],
                                    "text-anchor": "top",
                                    "text-offset": [0, 0.7],
                                    "text-allow-overlap": false,
                                    "text-optional": true,
                                }}
                                paint={fadePaint({
                                    "text-color": mapLabelColor,
                                    "text-halo-color": mapLabelHalo,
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

                {/* v959: endgame focus — spotlight the final zone (dark mask
                    everywhere else) + a bright gold ring. Drawn above the
                    hiding-zones overlay, below pins. */}
                {endgameFocusFC && (
                    <Source
                        id="endgame-focus"
                        type="geojson"
                        data={endgameFocusFC}
                    >
                        <Layer
                            id="endgame-focus-mask"
                            type="fill"
                            filter={["==", ["get", "kind"], "mask"]}
                            paint={{
                                "fill-color": "#0a0f16",
                                "fill-opacity": 0.62,
                            }}
                        />
                        <Layer
                            id="endgame-focus-ring"
                            type="line"
                            filter={["==", ["get", "kind"], "ring"]}
                            paint={{
                                "line-color": "hsl(45, 93%, 58%)",
                                "line-width": 4,
                                "line-blur": 1,
                            }}
                        />
                        <Layer
                            id="endgame-focus-glow"
                            type="line"
                            filter={["==", ["get", "kind"], "ring"]}
                            paint={{
                                "line-color": "hsl(45, 93%, 58%)",
                                "line-width": 12,
                                "line-blur": 8,
                                "line-opacity": 0.4,
                            }}
                        />
                    </Source>
                )}

                {/* Selected hiding-zone highlight — a prominent ring +
                    fill + dot for the station tapped open in the transit
                    card, so it stands out from the faint candidate field.
                    Drawn above the hiding-zones overlay. */}
                {selectedZoneFC && (
                    <Source
                        id="selected-zone"
                        type="geojson"
                        data={selectedZoneFC}
                    >
                        <Layer
                            id="selected-zone-fill"
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
                            id="selected-zone-line"
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
                            id="selected-zone-dot"
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

                {/* Travel-times overlay — populated by
                    TravelTimesOverlay (mounted as a sibling in
                    SeekerPage) from journey-planner API
                    responses. Symbol layer with a text-field
                    bound to the per-feature arrivalLabel ("HH:MM"
                    or empty when unknown). Color flips to a
                    warning red when the arrival is in the past
                    relative to now — i.e. the hider could already
                    be standing at that stop. */}
                <FadeOverlay
                    active={Boolean(
                        $travelTimes && $travelTimes.features.length > 0,
                    )}
                    data={
                        $travelTimes && $travelTimes.features.length > 0
                            ? $travelTimes
                            : null
                    }
                >
                    {(data, shown) => (
                        <Source
                            id="travel-times"
                            type="geojson"
                            data={data}
                        >
                            {/* Reachability dot — green = the hider could be
                                here, red = rule this zone out, neutral grey
                                while the journey-arrivals API is still
                                resolving. Drawn above the hiding-zones-points
                                dot so this verdict overrides it visually. */}
                            <Layer
                                id="travel-times-dot"
                                type="circle"
                                paint={fadePaint({
                                    "circle-radius": 6,
                                    "circle-color": [
                                        "case",
                                        ["==", ["get", "pending"], true],
                                        "hsl(220, 10%, 70%)",
                                        ["==", ["get", "reachable"], true],
                                        "hsl(142, 70%, 45%)",
                                        "hsl(0, 75%, 55%)",
                                    ],
                                    "circle-stroke-color": "white",
                                    "circle-stroke-width": 1.5,
                                    "circle-opacity": shown
                                        ? [
                                              "case",
                                              ["==", ["get", "pending"], true],
                                              0.55,
                                              0.95,
                                          ]
                                        : 0,
                                    "circle-stroke-opacity": shown ? 1 : 0,
                                    "circle-opacity-transition": {
                                        duration: 280,
                                    },
                                    "circle-stroke-opacity-transition": {
                                        duration: 280,
                                    },
                                })}
                            />
                            <Layer
                                id="travel-times-labels"
                                type="symbol"
                                layout={{
                                    "text-field": ["get", "arrivalLabel"],
                                    "text-size": 12,
                                    "text-font": ["Noto Sans Regular"],
                                    "text-anchor": "left",
                                    "text-offset": [0.8, 0],
                                    "text-allow-overlap": false,
                                    "text-ignore-placement": false,
                                }}
                                paint={fadePaint({
                                    "text-color": mapLabelColor,
                                    "text-halo-color": mapLabelHalo,
                                    "text-halo-width": 1.5,
                                    "text-opacity": shown ? 1 : 0,
                                    "text-opacity-transition": {
                                        duration: 280,
                                    },
                                })}
                            />
                        </Source>
                    )}
                </FadeOverlay>

                {/* Play-area boundary stroke. */}
                {(() => {
                    const data = $mapGeoJSON || $polyGeoJSON;
                    if (!data) return null;
                    return (
                        <Source id="play-area" type="geojson" data={data}>
                            <Layer
                                id="play-area-outline"
                                type="line"
                                paint={{
                                    // v468: canonical play-area stroke
                                    // (shared with the wizard preview +
                                    // adjacent areas), so the boundary
                                    // looks the same in every map view.
                                    "line-color": PLAY_AREA_COLOR,
                                    "line-width": PLAY_AREA_LINE_WIDTH,
                                    "line-opacity": PLAY_AREA_LINE_OPACITY,
                                }}
                            />
                        </Source>
                    );
                })()}


                {/* Newly-eliminated-area flash — a brand-red wash over the
                    slice an answer just ruled out, drawn ON TOP of the dark
                    mask, that fades to nothing (fill-opacity transition).
                    Makes the elimination read as a beat rather than a silent
                    geometry swap. */}
                {eliminationFlash && (
                    <Source
                        id="elimination-flash"
                        type="geojson"
                        data={eliminationFlash.feature}
                    >
                        <Layer
                            id="elimination-flash-fill"
                            type="fill"
                            paint={fadePaint({
                                "fill-color": "hsl(2, 70%, 54%)",
                                "fill-opacity": eliminationFlash.visible
                                    ? 0.5
                                    : 0,
                                "fill-opacity-transition": {
                                    duration: eliminationFlash.fadeMs,
                                },
                            })}
                        />
                        <Layer
                            id="elimination-flash-line"
                            type="line"
                            paint={fadePaint({
                                "line-color": "hsl(2, 70%, 54%)",
                                "line-width": 2,
                                "line-opacity": eliminationFlash.visible
                                    ? 0.9
                                    : 0,
                                "line-opacity-transition": {
                                    duration: eliminationFlash.fadeMs,
                                },
                            })}
                        />
                    </Source>
                )}

                {/* Radar sweep — a rotating beam + fading trail over each
                    pending radius. The Source starts empty; the rAF loop
                    above writes the current frame via getSource().setData().
                    The TRAIL fill fades via a data-driven `fill-opacity`
                    keyed on each wedge's `a` (1 at the leading edge → 0 at
                    the tail); the BEAM line is the bright leading edge (a
                    `line-blur` gives it a soft radar glow). Mounted before
                    the static circle so the sweep paints UNDER the stroke. */}
                {radarTargets.length > 0 && (
                    <Source
                        id="radar-sweep"
                        type="geojson"
                        data={{ type: "FeatureCollection", features: [] }}
                    >
                        <Layer
                            id="radar-sweep-fill"
                            type="fill"
                            filter={["==", ["geometry-type"], "Polygon"]}
                            paint={{
                                "fill-color":
                                    CATEGORIES.radius?.color ?? "#f5a888",
                                // Fade the trail from the leading edge back.
                                "fill-opacity": [
                                    "interpolate",
                                    ["linear"],
                                    ["get", "a"],
                                    0,
                                    0,
                                    1,
                                    0.4,
                                ],
                                "fill-antialias": false,
                            }}
                        />
                        <Layer
                            id="radar-sweep-beam"
                            type="line"
                            filter={["==", ["geometry-type"], "LineString"]}
                            paint={{
                                "line-color":
                                    CATEGORIES.radius?.color ?? "#f5a888",
                                "line-width": 2.5,
                                "line-opacity": 0.95,
                                "line-blur": 2,
                            }}
                        />
                    </Source>
                )}

                {/* Pending-radius circles — outline + light
                    fill that sits over the rotating sweep so
                    the seeker reads the radius as a clearly
                    bounded zone. */}
                {pendingRadiusFeatures.features.length > 0 && (
                    <Source
                        id="pending-radius"
                        type="geojson"
                        data={pendingRadiusFeatures}
                    >
                        <Layer
                            id="pending-radius-fill"
                            type="fill"
                            paint={{
                                "fill-color":
                                    CATEGORIES.radius?.color ??
                                    "#f5a888",
                                "fill-opacity": 0.08,
                            }}
                        />
                        <Layer
                            id="pending-radius-line"
                            type="line"
                            paint={{
                                "line-color":
                                    CATEGORIES.radius?.color ??
                                    "#f5a888",
                                "line-width": 2,
                                "line-opacity": 0.85,
                                "line-dasharray": [3, 2],
                            }}
                        />
                    </Source>
                )}

                {/* Hider-guess pin — the seeker's "I think the
                    hider is here" marker. Green, draggable. Same
                    questionKey=-1 contract as the Leaflet
                    DraggableMarkers path so the rest of the
                    elimination pipeline + autosave bridge see
                    consistent data shape. */}
                {$hiderMode !== false && (
                    <Marker
                        longitude={$hiderMode.longitude}
                        latitude={$hiderMode.latitude}
                        anchor="center"
                        draggable
                        onDragEnd={(e) => {
                            const next = {
                                latitude: e.lngLat.lat,
                                longitude: e.lngLat.lng,
                            };
                            hiderMode.set(next);
                        }}
                    >
                        <div
                            aria-label="Hider guess"
                            style={{
                                width: 16,
                                height: 16,
                                borderRadius: "50%",
                                background: "#2AAD27",
                                border: "2px solid white",
                                boxShadow:
                                    "0 1px 3px rgba(0,0,0,0.55)",
                                cursor: "grab",
                            }}
                        />
                    </Marker>
                )}

                {/* Live GPS dot — the seeker's current position,
                    always shown (the always-on watch-position effect
                    above keeps `selfPosition` current). */}
                {selfPosition && (
                    <Marker
                        longitude={selfPosition.lng}
                        latitude={selfPosition.lat}
                        anchor="center"
                    >
                        <SelfPositionMarker />
                    </Marker>
                )}

                {/* Other seekers' live positions (v946). Player-colour
                    initials avatars matching the lobby roster / the hider
                    map, with the name beneath. */}
                {otherSeekerPins.map((s) => (
                    <Marker
                        key={s.id}
                        longitude={s.lng}
                        latitude={s.lat}
                        anchor="center"
                    >
                        <div className="flex flex-col items-center pointer-events-none">
                            <div
                                title={s.name}
                                className="flex items-center justify-center w-7 h-7 rounded-full border-2 border-background shadow-lg text-[11px] font-black text-white font-inter-tight leading-none"
                                style={{ backgroundColor: playerColor(s.id) }}
                            >
                                {playerInitials(s.name)}
                            </div>
                            <span
                                className="mt-1 px-1.5 py-0.5 rounded text-[10px] font-bold text-white shadow whitespace-nowrap leading-none"
                                style={{ backgroundColor: playerColor(s.id) }}
                            >
                                {s.name}
                            </span>
                        </div>
                    </Marker>
                ))}

                {/* Move powerup: the hider revealed their transit station
                    ("send the seekers the location of your transit station").
                    A distinct brand-red pin + label so the seekers know where
                    the hider WAS before relocating. */}
                {$revealedStation && (
                    <Marker
                        longitude={$revealedStation.lng}
                        latitude={$revealedStation.lat}
                        anchor="bottom"
                    >
                        <div className="flex flex-col items-center pointer-events-none -translate-y-1">
                            <div className="mb-1 px-2 py-0.5 rounded-full bg-primary text-primary-foreground text-[11px] font-semibold shadow-lg whitespace-nowrap max-w-[12rem] truncate">
                                Hider was here
                                {$revealedStation.name
                                    ? ` · ${$revealedStation.name}`
                                    : ""}
                            </div>
                            <svg
                                width="26"
                                height="34"
                                viewBox="0 0 26 34"
                                aria-hidden="true"
                                className="drop-shadow"
                            >
                                <path
                                    d="M13 33C13 33 24 20.5 24 12.5C24 6.15 19.075 1 13 1C6.925 1 2 6.15 2 12.5C2 20.5 13 33 13 33Z"
                                    fill="hsl(var(--primary))"
                                    stroke="#ffffff"
                                    strokeWidth="2"
                                />
                                <circle cx="13" cy="12.5" r="4.5" fill="#ffffff" />
                            </svg>
                        </div>
                    </Marker>
                )}

                {/* Per-question markers. Each question type's
                    coord shape is normalized by questionMarkers()
                    into a flat list of (lat, lng, slot) entries
                    where `slot` tells the drag handler which
                    field of the question's data to write back to
                    on drag-end. Matches the Leaflet path's
                    "mutate in place + call questionModified()"
                    pattern so the multiplayer / autosave bridge
                    fires the same way. Click-to-edit dialog is
                    next. */}
                {questionMarkerList.map(
                    ({ id, questionKey, slot, lat, lng, color, label }) => (
                        <Marker
                            key={id}
                            longitude={lng}
                            latitude={lat}
                            anchor="center"
                            draggable
                            onDragStart={() => {
                                isDraggingRef.current = true;
                            }}
                            onDragEnd={(e) => {
                                const all = questions.get();
                                const target = all.find(
                                    (q) => q.key === questionKey,
                                );
                                if (target) {
                                    const newLat = e.lngLat.lat;
                                    const newLng = e.lngLat.lng;
                                    const data = target.data as Record<
                                        string,
                                        unknown
                                    >;
                                    if (slot === "primary") {
                                        data.lat = newLat;
                                        data.lng = newLng;
                                    } else if (slot === "a") {
                                        data.latA = newLat;
                                        data.lngA = newLng;
                                    } else {
                                        data.latB = newLat;
                                        data.lngB = newLng;
                                    }
                                    questionModified();
                                }
                                // Give the synthesized click event
                                // that fires immediately after
                                // dragend a moment to bounce off the
                                // guard before we reset. Same 100 ms
                                // window the Leaflet path uses.
                                setTimeout(() => {
                                    isDraggingRef.current = false;
                                }, 100);
                            }}
                        >
                            <div
                                aria-label={label}
                                onClick={(e) => {
                                    if (isDraggingRef.current) return;
                                    // Stop the click from also
                                    // counting as a map-canvas click
                                    // (which would fall through to
                                    // any future "tap to add" handler).
                                    e.stopPropagation();
                                    setSelectedMarker({
                                        questionKey,
                                        slot,
                                    });
                                }}
                                style={{
                                    width: 16,
                                    height: 16,
                                    borderRadius: "50%",
                                    background: color,
                                    border: "2px solid white",
                                    boxShadow:
                                        "0 1px 3px rgba(0,0,0,0.55)",
                                    cursor: "grab",
                                }}
                            />
                        </Marker>
                    ))}

                {/* Pending-question dashed outlines, one
                    Source+Layer pair per category color. The
                    Leaflet path does one layer per question
                    (cheap in DOM); for WebGL it's faster to
                    batch by color so each style change
                    becomes a single GL draw call. */}
                {Object.entries(eliminationResult.pendingByCategory).map(
                    ([color, features]) => {
                        if (features.length === 0) return null;
                        const fc: GeoJSON.FeatureCollection = {
                            type: "FeatureCollection",
                            features,
                        };
                        const id = `pending-${color.replace(/[^a-z0-9]/gi, "-")}`;
                        return (
                            <Source key={id} id={id} type="geojson" data={fc}>
                                <Layer
                                    id={`${id}-fill`}
                                    type="fill"
                                    paint={{
                                        "fill-color": color,
                                        "fill-opacity": 0.08,
                                    }}
                                />
                                <Layer
                                    id={`${id}-line`}
                                    type="line"
                                    paint={{
                                        "line-color": color,
                                        "line-width": 2,
                                        "line-opacity": 0.85,
                                        "line-dasharray": [3, 2],
                                    }}
                                />
                            </Source>
                        );
                    },
                )}
            </MapGL>

            {/* Classic map controls: follow-me toggle + reset
                rotation/tilt. Dodge to whichever bottom corner is free:
                bottom-right during the hiding period (timer + Map-options
                chip own the bottom-left then), bottom-left while seeking
                (the clock owns the bottom-right). */}
            <MapNavControls
                mapRef={mapRef}
                gpsSharing={$seekerSharing}
                onToggleGpsShare={
                    showGpsShare
                        ? () =>
                              seekerLocationSharing.set(!$seekerSharing)
                        : undefined
                }
                className={
                    // v622: on mobile the bottom-left Map-options chip moved
                    // to the bottom nav, so these drop to the bottom edge.
                    // On desktop the floating chip still sits bottom-left,
                    // so they ride above it (md:bottom-[76px]). During
                    // hiding they dodge to the bottom-right (the HiderTimer
                    // takes the bottom-left corner).
                    inHidingPeriod
                        ? "right-3 bottom-2 md:bottom-3"
                        : "left-3 bottom-2 md:bottom-[76px]"
                }
            />

            {/* Context menu — absolutely-positioned at the
                click point. Mirrors the leaflet-contextmenu
                items: Add Radius / Thermometer / Tentacles at
                the clicked coords. Closes on item-select or
                map-click (handled via onClick on <MapGL />). */}
            {contextMenu && (
                <div
                    role="menu"
                    style={{
                        position: "absolute",
                        left: contextMenu.screenX,
                        top: contextMenu.screenY,
                        zIndex: 1500,
                    }}
                    className={cn(
                        "min-w-[160px] rounded-md border border-border",
                        "bg-background/95 backdrop-blur-sm shadow-xl",
                        "py-1 text-sm",
                    )}
                    onClick={(e) => e.stopPropagation()}
                >
                    <button
                        type="button"
                        className="w-full text-left px-3 py-1.5 hover:bg-accent"
                        onClick={() => {
                            seekerAddQuestion({
                                id: "radius",
                                data: {
                                    lat: contextMenu.lat,
                                    lng: contextMenu.lng,
                                },
                            });
                            setContextMenu(null);
                        }}
                    >
                        Add Radius
                    </button>
                    <button
                        type="button"
                        className="w-full text-left px-3 py-1.5 hover:bg-accent"
                        onClick={() => {
                            const dest = turf.destination(
                                [contextMenu.lng, contextMenu.lat],
                                5,
                                90,
                                { units: "miles" },
                            );
                            seekerAddQuestion({
                                id: "thermometer",
                                data: {
                                    latA: contextMenu.lat,
                                    lngA: contextMenu.lng,
                                    latB: dest.geometry.coordinates[1],
                                    lngB: dest.geometry.coordinates[0],
                                },
                            });
                            setContextMenu(null);
                        }}
                    >
                        Add Thermometer
                    </button>
                    <button
                        type="button"
                        className="w-full text-left px-3 py-1.5 hover:bg-accent"
                        onClick={() => {
                            seekerAddQuestion({
                                id: "tentacles",
                                data: {
                                    lat: contextMenu.lat,
                                    lng: contextMenu.lng,
                                },
                            });
                            setContextMenu(null);
                        }}
                    >
                        Add Tentacles
                    </button>
                </div>
            )}

            {/* Question-edit dialog. Same QuestionComponent
                dispatch as the Leaflet path's DraggableMarkers
                — radius / tentacles / thermometer / matching /
                measuring each get their full edit UI inline. The
                `sub` prop (Start / End) is set when the user
                tapped a thermometer A/B marker. Dialog portals to
                <body> per shadcn defaults, so it's not trapped
                inside MapLibre's canvas container. */}
            <Dialog
                open={selectedMarker !== null}
                onOpenChange={(o) => {
                    if (!o) setSelectedMarker(null);
                }}
            >
                <DialogContent className="!bg-[hsl(var(--sidebar-background))] !text-[hsl(var(--sidebar-foreground))]">
                    {selectedMarker &&
                        $questions
                            .filter(
                                (q) =>
                                    q.key === selectedMarker.questionKey,
                            )
                            .map((q) => {
                                const sub =
                                    selectedMarker.slot === "a"
                                        ? "Start"
                                        : selectedMarker.slot === "b"
                                          ? "End"
                                          : "";
                                switch (q.id) {
                                    case "radius":
                                        return (
                                            <RadiusQuestionComponent
                                                key={q.key}
                                                data={q.data}
                                                questionKey={q.key}
                                                sub={sub}
                                            />
                                        );
                                    case "tentacles":
                                        return (
                                            <TentacleQuestionComponent
                                                key={q.key}
                                                data={q.data}
                                                questionKey={q.key}
                                                sub={sub}
                                            />
                                        );
                                    case "thermometer":
                                        return (
                                            <ThermometerQuestionComponent
                                                key={q.key}
                                                data={q.data}
                                                questionKey={q.key}
                                                sub={sub}
                                            />
                                        );
                                    case "matching":
                                        return (
                                            <MatchingQuestionComponent
                                                key={q.key}
                                                data={q.data}
                                                questionKey={q.key}
                                                sub={sub}
                                            />
                                        );
                                    case "measuring":
                                        return (
                                            <MeasuringQuestionComponent
                                                key={q.key}
                                                data={q.data}
                                                questionKey={q.key}
                                                sub={sub}
                                            />
                                        );
                                    default:
                                        return null;
                                }
                            })}
                </DialogContent>
            </Dialog>

            {/* Reveal veil — covers the canvas until the basemap tiles
                (and, when a play area is set, its boundary) have
                painted. z below the loading-progress card (1020) and
                the sidebars (1030+) so those stay usable; the map's own
                top-right controls render above it. */}
            <MapTilesVeil
                visible={showVeil}
                className="z-[1010]"
                timedOut={tilesTimedOut}
                sublabel={$playArea?.displayName?.split(",")[0] ?? undefined}
            />
        </div>
    );
}

/**
 * Extract render-ready markers from a question. Different
 * question categories store coordinates under different keys
 * (radius / tentacles: data.lat/data.lng; thermometer: a/b
 * pair; matching/measuring: depends on subtype). The `slot`
 * tells the drag handler WHICH coord field of the question's
 * data to update on drag-end.
 */
function questionMarkers(q: {
    key: number;
    id: string;
    data: Record<string, unknown>;
}): Array<{
    id: string;
    questionKey: number;
    slot: "primary" | "a" | "b";
    lat: number;
    lng: number;
    color: string;
    label: string;
}> {
    const cat = CATEGORIES[q.id as CategoryId] ?? CATEGORIES.matching;
    const out: Array<{
        id: string;
        questionKey: number;
        slot: "primary" | "a" | "b";
        lat: number;
        lng: number;
        color: string;
        label: string;
    }> = [];
    const data = q.data;
    if (
        typeof data.lat === "number" &&
        typeof data.lng === "number"
    ) {
        out.push({
            id: `${q.key}-primary`,
            questionKey: q.key,
            slot: "primary",
            lat: data.lat,
            lng: data.lng,
            color: cat.color,
            label: `${cat.label ?? q.id} marker`,
        });
    }
    if (
        typeof data.latA === "number" &&
        typeof data.lngA === "number"
    ) {
        out.push({
            id: `${q.key}-a`,
            questionKey: q.key,
            slot: "a",
            lat: data.latA,
            lng: data.lngA,
            color: cat.color,
            label: `${cat.label ?? q.id} start`,
        });
    }
    if (
        typeof data.latB === "number" &&
        typeof data.lngB === "number" &&
        // Skip if same as A (thermometer "started" state has
        // latB/lngB mirroring latA/lngA).
        (data.latA !== data.latB || data.lngA !== data.lngB)
    ) {
        out.push({
            id: `${q.key}-b`,
            questionKey: q.key,
            slot: "b",
            lat: data.latB,
            lng: data.lngB,
            color: cat.color,
            label: `${cat.label ?? q.id} end`,
        });
    }
    return out;
}

export default Map;
