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
    ScaleControl,
    Source,
    type ViewStateChangeEvent,
} from "react-map-gl/maplibre";
import { toast } from "react-toastify";

import {
    Dialog,
    DialogContent,
} from "@/components/ui/dialog";
import { MapNavControls } from "@/components/MapNavControls";
import { useMapTilesReady } from "@/hooks/useMapTilesReady";
import { CATEGORIES, type CategoryId } from "@/lib/categories";
import {
    baseTileLayer,
    drawingQuestionKey,
    followMe,
    hiderMode,
    hidingZonesGeoJSON,
    isLoading,
    lastKnownPosition,
    mapContext,
    mapGeoJSON,
    mapGeoLocation,
    planningModeEnabled,
    polyGeoJSON,
    polyGeoJSONHydrated,
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
import { playArea } from "@/lib/gameSetup";
import {
    allowedTransit,
    satelliteView,
    showBusRoutes,
    showFerryRoutes,
    showSubwayRoutes,
    showTrainRoutes,
    showTramRoutes,
    showTransitLines,
    transitRoutesLoading,
} from "@/lib/gameSetup";
import { selectedMapStation, travelTimesFC } from "@/lib/journey/state";
import { clipPolygonToLand } from "@/lib/landClip";
import { createMapShim } from "@/lib/mapShim";
import { seekerAddQuestion } from "@/lib/multiplayer/store";
import {
    handleMapLibreError,
    pmtilesUrl,
    protomapsMapLibreStyle,
    recordPmtilesError,
} from "@/lib/protomapsStyle";
import { resolvedTheme } from "@/lib/theme";
import { activeTilePackId } from "@/lib/tilePack";
import { cn } from "@/lib/utils";
import { applyQuestionsToMapGeoData, holedMask } from "@/maps";
import { clearCache, determineMapBoundaries } from "@/maps/api";
import { RAIL_TILE_BASE } from "@/maps/api/constants";
import {
    fetchTransitRoutesFeatures,
    type TransitMode,
} from "@/maps/api/transitRoutes";
import { CacheType } from "@/maps/api/types";

import { MapTilesVeil } from "./MapTilesVeil";
import { SelfPositionMarker } from "./SelfPositionMarker";
import {
    MatchingQuestionComponent,
    MeasuringQuestionComponent,
    RadiusQuestionComponent,
    TentacleQuestionComponent,
    ThermometerQuestionComponent,
} from "./QuestionCards";

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

const SATELLITE_SOURCE = {
    tiles: [
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    ],
    attribution: "Imagery &copy; Esri",
};

const RAIL_OVERLAY_SOURCE = {
    // v351: proxied + R2-cached through our worker (was the three
    // a/b/c.tiles.openrailwaymap.org hosts directly). OpenRailwayMap's
    // servers 503 constantly; the proxy serves cached tiles from R2 even
    // during their outages, and removes the external dependency.
    tiles: [`${RAIL_TILE_BASE}/{z}/{x}/{y}.png`],
    attribution:
        '&copy; <a href="https://www.openrailwaymap.org/">OpenRailwayMap</a>',
};

function thunderforestSource(
    flavor: "transport" | "neighbourhood",
    key: string,
) {
    return {
        tiles: [
            `https://tile.thunderforest.com/${flavor}/{z}/{x}/{y}.png?apikey=${key}`,
        ],
        attribution:
            '&copy; <a href="http://www.thunderforest.com/">Thunderforest</a>',
    };
}

function buildStyle(
    baseKey: string,
    withSatellite: boolean,
    withRail: boolean,
    thunderforestKey: string,
    resolvedThemeMode: "light" | "dark" = "dark",
): maplibregl.StyleSpecification {
    // v230+: the "auto"/"light"/"dark"/"voyager"/"osm" keys all
    // resolve to the Protomaps vector basemap with our transit-first
    // style. Theme follows the UI ("auto") or the explicit pick.
    // Thunderforest keys (transport/neighbourhood) are still served
    // as raster, since the user provided an API key specifically for
    // those styles and overriding them with Protomaps would defeat
    // the purpose.
    const effectiveKey =
        baseKey === "auto"
            ? resolvedThemeMode === "dark"
                ? "dark"
                : "light"
            : baseKey;

    let base: maplibregl.StyleSpecification;
    if (
        (effectiveKey === "transport" || effectiveKey === "neighbourhood") &&
        thunderforestKey
    ) {
        const tf = thunderforestSource(effectiveKey, thunderforestKey);
        base = {
            version: 8,
            sources: {
                base: {
                    type: "raster",
                    tiles: tf.tiles,
                    tileSize: 256,
                    attribution: tf.attribution,
                },
            },
            layers: [{ id: "base", type: "raster", source: "base" }],
        };
    } else {
        // Protomaps vector basemap. The style ships a flat sources +
        // layers shape that we can extend with satellite/rail
        // overlays below — they just go on top.
        base = protomapsMapLibreStyle(
            effectiveKey === "dark" ? "dark" : "light",
        ) as maplibregl.StyleSpecification;
    }

    const sources: maplibregl.StyleSpecification["sources"] = {
        ...base.sources,
    };
    const layers: maplibregl.LayerSpecification[] = [...base.layers];

    if (withSatellite) {
        sources.satellite = {
            type: "raster",
            tiles: SATELLITE_SOURCE.tiles,
            tileSize: 256,
            attribution: SATELLITE_SOURCE.attribution,
        };
        layers.push({
            id: "satellite",
            type: "raster",
            source: "satellite",
            paint: { "raster-opacity": 0.7 },
        });
    }

    if (withRail) {
        sources.rail = {
            type: "raster",
            tiles: RAIL_OVERLAY_SOURCE.tiles,
            tileSize: 256,
            attribution: RAIL_OVERLAY_SOURCE.attribution,
        };
        layers.push({
            id: "rail",
            type: "raster",
            source: "rail",
            paint: { "raster-opacity": 0.85 },
        });
    }

    return {
        version: 8,
        glyphs: base.glyphs,
        sources,
        layers,
    };
}

/** Overlay layers a tap can resolve to a station for the station
 *  transit card. The hiding-zone circle fill + station points (the
 *  candidate zones the seeker scans) and the travel-time labels (the
 *  reachable stations) are all valid targets. */
const STATION_TAP_LAYERS = [
    "hiding-zones-fill",
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
): { lat: number; lng: number; name?: string } | null {
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

    // Coordinates.
    if (f.geometry?.type === "Point") {
        const [lng, lat] = f.geometry.coordinates as [number, number];
        if (Number.isFinite(lat) && Number.isFinite(lng))
            return { lat, lng, name };
    }
    // Circle / polygon — prefer the embedded station center, else
    // centroid, else the click point.
    const center = nested?.geometry?.coordinates as
        | [number, number]
        | undefined;
    if (center && Number.isFinite(center[1]) && Number.isFinite(center[0])) {
        return { lat: center[1], lng: center[0], name };
    }
    try {
        const c = turf.centroid(f as never);
        const [lng, lat] = c.geometry.coordinates as [number, number];
        if (Number.isFinite(lat) && Number.isFinite(lng))
            return { lat, lng, name };
    } catch {
        /* fall through to click point */
    }
    return { lat: clickLngLat.lat, lng: clickLngLat.lng, name };
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

export function Map({ className }: MapProps) {
    const $drawingQuestionKey = useStore(drawingQuestionKey);
    const $followMe = useStore(followMe);
    const $hiderMode = useStore(hiderMode);
    const $hidingZones = useStore(hidingZonesGeoJSON);
    const $travelTimes = useStore(travelTimesFC);
    const $allowedTransit = useStore(allowedTransit);
    const $subway = useStore(showSubwayRoutes);
    const $bus = useStore(showBusRoutes);
    const $ferry = useStore(showFerryRoutes);
    const $train = useStore(showTrainRoutes);
    const $tram = useStore(showTramRoutes);
    const $tileKey = useStore(baseTileLayer);
    const $satellite = useStore(satelliteView);
    const $rail = useStore(showTransitLines);
    const $tfKey = useStore(thunderforestApiKey);
    const $polyGeoJSON = useStore(polyGeoJSON);
    const $mapGeoJSON = useStore(mapGeoJSON);
    const $mapGeoLocation = useStore(mapGeoLocation);
    const $questions = useStore(questions);
    useStore(triggerLocalRefresh); // subscribe to manual re-render kicks
    const $savedViewport = useStore(mapLibreViewport);
    const $playArea = useStore(playArea);

    const mapRef = useRef<MapRef | null>(null);
    // v377: debounce handle for persisting the viewport to localStorage.
    const viewportPersistTimer = useRef<number | null>(null);
    // v445: latches true once any real protomaps tile has painted, so the
    // basemap-health watchdog never flips a working map to the (404-ing)
    // fallback on a later re-arm. See the watchdog effect below.
    const everPaintedTileRef = useRef(false);

    const $theme = useStore(resolvedTheme);
    // v241: rebuild style when the resolved PMTiles URL flips (e.g.
    // fallback from our worker to the demo bucket on tile error).
    const $pmtilesUrl = useStore(pmtilesUrl);
    // v336: rebuild the style when a city tile pack activates so the
    // basemap source flips to the merge scheme (pack-first rendering).
    const $tilePackId = useStore(activeTilePackId);
    const style = useMemo(
        () => buildStyle($tileKey, $satellite, $rail, $tfKey ?? "", $theme),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [$tileKey, $satellite, $rail, $tfKey, $theme, $pmtilesUrl, $tilePackId],
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
        if (inner) mapContext.set(createMapShim(inner));
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
        if (extent) {
            const [maxLat, minLng, minLat, maxLng] = extent;
            bounds = [
                [minLng, minLat],
                [maxLng, maxLat],
            ];
        } else if ($mapGeoJSON || $polyGeoJSON) {
            // Fallback: if mapGeoLocation didn't carry an extent
            // (e.g. a guest-joined session where the host's push
            // only included playArea / displayName + coords),
            // center on the boundary's own bbox once it loads.
            // Without this the map sat at the default world view
            // zoom 2 and the user saw a uniform blue — the
            // tile-layer's pacific ocean — instead of the play
            // area they joined (v98 user report).
            try {
                const fc = ($mapGeoJSON || $polyGeoJSON) as
                    | GeoJSON.FeatureCollection
                    | null;
                if (fc) {
                    const b = turf.bbox(fc);
                    bounds = [
                        [b[0], b[1]],
                        [b[2], b[3]],
                    ];
                }
            } catch (e) {
                console.warn("Map bbox fallback failed:", e);
            }
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

    // Boundary fetch trigger. The old Leaflet Map.tsx owned this
    // flow inside a `refreshQuestions()` helper; when v80 retired
    // that file the call site was lost and the seeker would land
    // on a play area with no one actually fetching the boundary
    // GeoJSON — the MapLoadingOverlay sat on 'Fetching boundary…'
    // forever (v85 user report). Restored as a focused effect
    // here. Gates:
    //   - playArea !== null: the user has explicitly picked an
    //     area. mapGeoLocation defaults to Japan on a fresh load
    //     (persistent atom seed); gating on playArea (which
    //     defaults to null) means we only fetch once the wizard
    //     has actually committed something — and we fetch as
    //     soon as it does, not waiting for the user to finish
    //     the rest of the wizard.
    //   - polyGeoJSONHydrated: the polyGeoJSON atom is
    //     async-hydrated from Cache API on boot; reading too
    //     early gives null and we mistakenly re-fetch a boundary
    //     we already have on disk. Wait for the hydration flag.
    //   - mapGeoJSON / polyGeoJSON: skip when we already have
    //     a boundary loaded.
    //   - isLoading: skip when another fetch is in flight.
    useEffect(() => {
        const props = $mapGeoLocation?.properties as
            | { osm_id?: number }
            | undefined;
        if (!($mapGeoLocation && (props?.osm_id ?? 0) > 0)) return;
        if ($mapGeoJSON || $polyGeoJSON) return;
        if (!$playArea) return;

        let cancelled = false;
        (async () => {
            // Wait for the persistent-cache hydration before
            // deciding we have no boundary on disk. Race against a
            // 3 s wall-clock timeout so a stuck Cache API (iOS
            // PWA bug) doesn't block the boundary fetch forever.
            if (!polyGeoJSONHydrated.get()) {
                await Promise.race([
                    new Promise<void>((resolve) => {
                        const unsub = polyGeoJSONHydrated.subscribe(
                            (v) => {
                                if (v) {
                                    unsub();
                                    resolve();
                                }
                            },
                        );
                    }),
                    new Promise<void>((resolve) =>
                        setTimeout(resolve, 3000),
                    ),
                ]);
                if (cancelled) return;
                // Re-check after hydration — Cache API may have
                // produced a value we should use as-is.
                if (mapGeoJSON.get() || polyGeoJSON.get()) return;
            }
            if (isLoading.get()) return;
            isLoading.set(true);
            // One silent retry pass. A first-time-ever play area
            // often misses every fast path (R2 cold + polygons.osm.fr
            // returning "None") and lands on the rate-limited public
            // mirrors. The first attempt is the slowest, but it
            // (a) writes the polygons.osm.fr build trigger, (b) warms
            // the cache worker's R2, and (c) gives the public mirrors'
            // rate window time to relax. The second attempt — 8 s
            // later — usually hits something warm and resolves
            // quickly. Total cap: two passes, so we never loop
            // forever. The user-facing failure toast only fires after
            // BOTH attempts come back empty.
            let boundary:
                | Awaited<ReturnType<typeof determineMapBoundaries>>
                | null = null;
            for (let attempt = 1; attempt <= 2; attempt++) {
                try {
                    boundary = await determineMapBoundaries();
                } catch (e) {
                    console.warn(
                        `determineMapBoundaries attempt ${attempt} failed:`,
                        e,
                    );
                    boundary = null;
                }
                if (cancelled) return;
                const hasFeatures = Boolean(
                    boundary?.features?.length,
                );
                if (hasFeatures) break;
                if (attempt < 2) {
                    console.debug(
                        "[map] boundary attempt 1 returned nothing — retrying in 8 s",
                    );
                    await new Promise((r) => setTimeout(r, 8000));
                    if (cancelled) return;
                }
            }
            try {
                const hadFeatures = Boolean(boundary?.features?.length);
                if (!hadFeatures && !cancelled) {
                    // Both attempts came back empty. Surface a single
                    // user-facing toast (the per-fetch silent path
                    // suppresses any sub-toasts so we're the only
                    // voice). The wording avoids blaming the user —
                    // boundary fetches fail mostly when the public
                    // mirrors are rate-limited or the relation hasn't
                    // been built at polygons.osm.fr yet.
                    toast.error(
                        "Couldn't load the play-area boundary. The mirrors are busy — try again in a minute.",
                        { toastId: "boundary-load-error" },
                    );
                }
                if (boundary) {
                    // Trim the legal-boundary polygon to actual land
                    // before we publish it. OSM admin boundaries
                    // include coastal waters (Nagasaki Prefecture
                    // sweeps ~50 km out to sea), which made ~half the
                    // visible play area look playable when it's
                    // open ocean. Best-effort: if the clip fails for
                    // any reason we publish the original polygon so a
                    // bad clip can never break the game.
                    const f =
                        (boundary.features?.[0] as any) ?? null;
                    let clipped = boundary;
                    if (f && f.geometry) {
                        try {
                            const c = await clipPolygonToLand(f);
                            if (c) {
                                clipped = {
                                    type: "FeatureCollection",
                                    features: [c],
                                } as any;
                            }
                        } catch (e) {
                            console.warn(
                                "clipPolygonToLand failed; using raw boundary",
                                e,
                            );
                        }
                    }
                    if (cancelled) return;
                    mapGeoJSON.set(clipped);
                    // Mirror to polyGeoJSON so the persistent-
                    // cache layer in context.ts picks up the
                    // value and stashes it for next session.
                    polyGeoJSON.set(clipped);
                }
            } catch (e) {
                console.warn("determineMapBoundaries failed:", e);
            } finally {
                if (!cancelled) isLoading.set(false);
            }
        })();

        return () => {
            cancelled = true;
            // Clear the gate so the next effect run (triggered by
            // deps changing) isn't silently skipped. Without this,
            // isLoading stays true when we cancel a mid-flight fetch,
            // and every subsequent run hits the early-return and
            // never fetches (the lobby "Fetching boundary…" hang).
            isLoading.set(false);
        };
        // $playArea is in the deps so the wizard's set-then-set
        // write order wakes the effect on the playArea-commit
        // tick rather than the mapGeoLocation-commit tick. Same
        // logic as v87's $setupCompleted dep, just on the new
        // gate.
    }, [
        $mapGeoLocation?.properties,
        $mapGeoJSON,
        $polyGeoJSON,
        $playArea,
    ]);

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
            let mask: GeoJSON.Feature | null = null;
            try {
                mask = holedMask(
                    working as never,
                ) as GeoJSON.Feature | null;
            } catch (e) {
                console.warn("Map holedMask failed:", e);
            }
            if (myGen !== eliminationGenRef.current) return; // stale
            questionFinishedMapData.set(working);
            setEliminationResult({ mask, pendingByCategory });
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

    // Transit-route overlays per mode. Each toggle (subway /
    // bus / ferry) gates an Overpass fetch via
    // fetchTransitRoutesFeatures. Results live in state as
    // FeatureCollections; the JSX renders one Source+Layer per
    // mode. Re-fetch when the play area changes
    // ($mapGeoLocation) so cached results from a previous area
    // get replaced. Loading flag mirrored into
    // transitRoutesLoading so MapDisplayControls' spinner shows
    // during fetch.
    const subwayOn = $subway && $allowedTransit.includes("subway");
    const busOn = $bus && $allowedTransit.includes("bus");
    const ferryOn = $ferry && $allowedTransit.includes("ferry");
    const trainOn = $train && $allowedTransit.includes("train");
    const tramOn = $tram && $allowedTransit.includes("tram");
    const [transitFC, setTransitFC] = useState<
        Record<TransitMode, GeoJSON.FeatureCollection | null>
    >({ subway: null, bus: null, ferry: null, train: null, tram: null });
    const areaKey =
        $mapGeoLocation?.properties?.osm_id ??
        ($polyGeoJSON ? "custom-poly" : "none");
    useEffect(() => {
        let cancelled = false;
        const fetchAndSet = async (mode: TransitMode, on: boolean) => {
            if (!on) {
                setTransitFC((curr) => ({ ...curr, [mode]: null }));
                return;
            }
            const curr = transitRoutesLoading.get();
            transitRoutesLoading.set({ ...curr, [mode]: true });
            try {
                const fc = await fetchTransitRoutesFeatures(mode);
                if (cancelled) return;
                setTransitFC((c) => ({ ...c, [mode]: fc }));
            } catch (e) {
                console.warn(`Map transit (${mode}) fetch failed`, e);
            } finally {
                // Don't clobber the loading flag if the effect was
                // already torn down — we'd be writing into a stale
                // store after the user toggled away. Skip-with-guard
                // instead of return-from-finally so we don't swallow
                // any in-flight exception escape.
                if (!cancelled) {
                    const c = transitRoutesLoading.get();
                    transitRoutesLoading.set({ ...c, [mode]: false });
                }
            }
        };
        fetchAndSet("subway", subwayOn);
        fetchAndSet("bus", busOn);
        fetchAndSet("ferry", ferryOn);
        fetchAndSet("train", trainOn);
        fetchAndSet("tram", tramOn);
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [subwayOn, busOn, ferryOn, trainOn, tramOn, areaKey]);

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

    // Radar sweep animation — rotating wedge over each pending
    // radius question. Builds a turf sector per target every
    // animation frame and feeds the FeatureCollection back to
    // MapLibre via getSource().setData(...) so re-rendering
    // stays GPU-side instead of triggering a React re-render
    // each frame. Loop is gated on having at least one target
    // so an empty pending set burns no CPU.
    const SWEEP_PERIOD_MS = 3500; // ms per full rotation
    const SWEEP_WIDTH_DEG = 60;
    useEffect(() => {
        if (radarTargets.length === 0) return;
        let raf = 0;
        const tick = () => {
            const map = mapRef.current?.getMap();
            const source = map?.getSource("radar-sweep") as
                | maplibregl.GeoJSONSource
                | undefined;
            if (source) {
                const now = performance.now();
                const headDeg =
                    ((now % SWEEP_PERIOD_MS) / SWEEP_PERIOD_MS) * 360;
                const features: GeoJSON.Feature[] = [];
                for (const t of radarTargets) {
                    try {
                        const sector = turf.sector(
                            [t.lng, t.lat],
                            t.radiusKm,
                            headDeg,
                            (headDeg + SWEEP_WIDTH_DEG) % 360,
                            { units: "kilometers", steps: 32 },
                        );
                        features.push(sector as GeoJSON.Feature);
                    } catch {
                        /* turf.sector occasionally fails on
                           degenerate bearings; skip the frame
                           rather than crash. */
                    }
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
    const handleStationTap = (
        e: maplibregl.MapLayerMouseEvent | maplibregl.MapMouseEvent,
    ) => {
        const features = (e as maplibregl.MapLayerMouseEvent).features;
        if (!features || features.length === 0) return;
        const f = features[0];
        const station = stationFromFeature(f, e.lngLat);
        if (station) selectedMapStation.set(station);
    };

    // Live blue "you are here" dot, always shown on the seeker map
    // (like every other mapping app). Decoupled from the Follow Me
    // toggle — that now only controls auto-centering below. The watch
    // runs for the whole session; errors are silent (a denied or
    // unavailable fix just means no dot, no toast spam on every load).
    // The marker is rendered in JSX below; we keep just the position
    // in state here.
    const [selfPosition, setSelfPosition] = useState<
        | {
              lat: number;
              lng: number;
          }
        | null
    >(null);
    useEffect(() => {
        if (
            typeof navigator === "undefined" ||
            !navigator.geolocation
        ) {
            return;
        }
        const id = navigator.geolocation.watchPosition(
            (pos) => {
                const next = {
                    lat: pos.coords.latitude,
                    lng: pos.coords.longitude,
                };
                setSelfPosition(next);
                // Share the fix so question pickers can default to the
                // player's real position instead of the play-area centroid.
                lastKnownPosition.set(next);
            },
            () => {
                // Stay quiet — no dot is the correct degraded state.
            },
            { enableHighAccuracy: true, maximumAge: 10_000, timeout: 20_000 },
        );
        return () => {
            navigator.geolocation.clearWatch(id);
        };
    }, []);

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
            try {
                // Force a synchronous repaint so the screenshot
                // reflects the latest state (otherwise we get the
                // previous frame's buffer).
                map.triggerRepaint();
                const dataUrl = map
                    .getCanvas()
                    .toDataURL("image/png");
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
                /* Required so map.getCanvas().toDataURL() works
                   for the Save-image action (otherwise the WebGL
                   buffer is cleared before we can read it). */
                preserveDrawingBuffer
                onLoad={handleLoad}
                onIdle={onTilesIdle}
                onMoveEnd={handleMoveEnd}
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
                <AttributionControl compact />
                {/* Zoom buttons removed in v101 — they overlap
                    the in-app Map options chip on small phones
                    and pinch-to-zoom covers the same affordance
                    natively. */}
                <ScaleControl />

                {/* Transit-route overlays — one Source+Layer per
                    mode. Colors match the Leaflet
                    TransitRoutesOverlay's MODE_CONFIG (subway
                    purple, bus orange, ferry blue dashed) so
                    operators see consistent visuals across the
                    two map paths. */}
                {transitFC.subway && (
                    <Source
                        id="transit-subway"
                        type="geojson"
                        data={transitFC.subway}
                    >
                        <Layer
                            id="transit-subway-line"
                            type="line"
                            paint={{
                                "line-color": "hsl(280, 60%, 60%)",
                                "line-width": 2,
                                "line-opacity": 0.8,
                            }}
                        />
                    </Source>
                )}
                {transitFC.bus && (
                    <Source
                        id="transit-bus"
                        type="geojson"
                        data={transitFC.bus}
                    >
                        <Layer
                            id="transit-bus-line"
                            type="line"
                            paint={{
                                "line-color": "hsl(35, 90%, 55%)",
                                "line-width": 2,
                                "line-opacity": 0.8,
                            }}
                        />
                    </Source>
                )}
                {transitFC.ferry && (
                    <Source
                        id="transit-ferry"
                        type="geojson"
                        data={transitFC.ferry}
                    >
                        <Layer
                            id="transit-ferry-line"
                            type="line"
                            paint={{
                                "line-color": "hsl(200, 85%, 55%)",
                                "line-width": 2,
                                "line-opacity": 0.8,
                                "line-dasharray": [4, 4],
                            }}
                        />
                    </Source>
                )}
                {/* v334: colored train + tram overlays. Train uses a
                    saturated green so it reads distinctly from the
                    OpenRailwayMap raster's brown track; tram uses a
                    pink so it doesn't collide with subway purple in
                    cities that have both. Same width/opacity as the
                    other modes for visual parity. */}
                {transitFC.train && (
                    <Source
                        id="transit-train"
                        type="geojson"
                        data={transitFC.train}
                    >
                        <Layer
                            id="transit-train-line"
                            type="line"
                            paint={{
                                "line-color": "hsl(140, 55%, 45%)",
                                "line-width": 2,
                                "line-opacity": 0.8,
                            }}
                        />
                    </Source>
                )}
                {transitFC.tram && (
                    <Source
                        id="transit-tram"
                        type="geojson"
                        data={transitFC.tram}
                    >
                        <Layer
                            id="transit-tram-line"
                            type="line"
                            paint={{
                                "line-color": "hsl(330, 75%, 60%)",
                                "line-width": 2,
                                "line-opacity": 0.8,
                            }}
                        />
                    </Source>
                )}

                {/* Hiding-zones overlay — mirrored from
                    ZoneSidebar's showGeoJSON via the
                    hidingZonesGeoJSON atom. Renders the same
                    red-dashed polygon outline + low-opacity
                    fill that the Leaflet path uses, plus
                    circle markers for any Point features
                    (stations) so both styles surface on
                    Map. */}
                {$hidingZones && $hidingZones.features.length > 0 && (
                    <Source
                        id="hiding-zones"
                        type="geojson"
                        data={$hidingZones}
                    >
                        <Layer
                            id="hiding-zones-fill"
                            type="fill"
                            filter={[
                                "any",
                                ["==", ["geometry-type"], "Polygon"],
                                ["==", ["geometry-type"], "MultiPolygon"],
                            ]}
                            paint={{
                                // Light mode: faint red tint over the bright
                                // basemap reads as "highlighted remaining
                                // area". Dark mode: a faint red tint over a
                                // near-black basemap disappears, so the
                                // overlay paints a brightening near-white
                                // wash that POSITIVELY lights up the
                                // remaining hiding circles against the
                                // (now much darker) eliminated surround.
                                "fill-color":
                                    $theme === "dark"
                                        ? "#f5e7e3"
                                        : "hsl(2, 70%, 54%)",
                                "fill-opacity":
                                    $theme === "dark" ? 0.22 : 0.12,
                            }}
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
                            paint={{
                                "line-color": "hsl(2, 70%, 54%)",
                                "line-width": 2,
                                "line-opacity": 0.9,
                                "line-dasharray": [6, 5],
                            }}
                        />
                        <Layer
                            id="hiding-zones-points"
                            type="circle"
                            filter={["==", ["geometry-type"], "Point"]}
                            paint={{
                                "circle-radius": 5,
                                "circle-color": "hsl(2, 70%, 54%)",
                                "circle-stroke-color": "white",
                                "circle-stroke-width": 1.5,
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
                {$travelTimes && $travelTimes.features.length > 0 && (
                    <Source
                        id="travel-times"
                        type="geojson"
                        data={$travelTimes}
                    >
                        {/* Reachability dot — green = the hider could be
                            here, red = rule this zone out, neutral grey
                            while the journey-arrivals API is still
                            resolving. Drawn above the hiding-zones-points
                            dot so this verdict overrides it visually. */}
                        <Layer
                            id="travel-times-dot"
                            type="circle"
                            paint={{
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
                                "circle-opacity": [
                                    "case",
                                    ["==", ["get", "pending"], true],
                                    0.55,
                                    0.95,
                                ],
                            }}
                        />
                        <Layer
                            id="travel-times-labels"
                            type="symbol"
                            layout={{
                                "text-field": ["get", "arrivalLabel"],
                                "text-size": 12,
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
                                    "line-color": "hsl(5, 69%, 55%)",
                                    "line-width": 2,
                                    "line-opacity": 0.9,
                                }}
                            />
                        </Source>
                    );
                })()}

                {/* Elimination mask — everything OUTSIDE the
                    in-play polygon (which is the play area
                    minus eliminated regions) gets darkened.
                    Same visual cue Leaflet's Map.tsx draws. */}
                {eliminationResult.mask && (
                    <Source
                        id="elimination"
                        type="geojson"
                        data={eliminationResult.mask}
                    >
                        <Layer
                            id="elimination-fill"
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
                )}

                {/* Radar sweep — rotating wedge over each
                    pending radius. The Source starts with an
                    empty FeatureCollection; the
                    requestAnimationFrame loop above writes the
                    current rotation directly via
                    getSource().setData(), so this Source
                    declaration is just there to set up the
                    rendering pipeline. Mounted before the
                    static fill so the sweep paints UNDER the
                    circle stroke. */}
                {radarTargets.length > 0 && (
                    <Source
                        id="radar-sweep"
                        type="geojson"
                        data={{ type: "FeatureCollection", features: [] }}
                    >
                        <Layer
                            id="radar-sweep-fill"
                            type="fill"
                            paint={{
                                "fill-color":
                                    CATEGORIES.radius?.color ??
                                    "#f5a888",
                                "fill-opacity": 0.25,
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
                {$questions
                    .flatMap((q) => questionMarkers(q))
                    .map(({ id, questionKey, slot, lat, lng, color, label }) => (
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
                rotation/tilt. Stacked bottom-left of the map so they
                don't compete with the map-options chip top-right. */}
            <MapNavControls
                mapRef={mapRef}
                className="left-3 bottom-20"
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
