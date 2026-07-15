import "maplibre-gl/dist/maplibre-gl.css";

import { useStore } from "@nanostores/react";
import * as turf from "@turf/turf";
import { Check, Plus } from "lucide-react";
import type {
    ExpressionSpecification,
    MapLayerMouseEvent,
} from "maplibre-gl";
import { useEffect, useMemo, useRef, useState } from "react";
import MapGL, {
    Layer,
    type MapRef,
    Marker,
    Source,
} from "react-map-gl/maplibre";

import { useMapTilesReady } from "@/hooks/useMapTilesReady";
import {
    additionalMapGeoLocations,
    adjacentCandidatePreview,
    lastKnownPosition,
    mapGeoJSON,
    toggleAdjacentArea,
} from "@/lib/context";
import { clipPolygonToLand } from "@/lib/geometry/client";
import { fadePaint } from "@/lib/mapPaint";
import {
    PLAY_AREA_COLOR,
    PLAY_AREA_FILL_OPACITY,
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
import { fetchRawBoundaryPolygon } from "@/maps/api/polygonsOsmFr";
import type { OpenStreetMap } from "@/maps/api/types";

import { MapTilesVeil } from "./MapTilesVeil";
import { SelfPositionMarker } from "./SelfPositionMarker";

/**
 * In-memory cache so swapping back to a previously-previewed result
 * snaps to its real polygon instantly (and doesn't refetch). Keyed by
 * OSM relation id. (Aliased the react-map-gl `Map` import to `MapGL`
 * so the built-in `Map<K, V>` type stays in scope here.)
 */
const polygonCache = new Map<
    number,
    GeoJSON.Polygon | GeoJSON.MultiPolygon | null
>();

/**
 * In-flight boundary loads, keyed by OSM relation id. Two jobs:
 *
 *   1. Dedupe — the wizard preview and the lobby preview (separate map
 *      instances) asking for the same area share one fetch.
 *   2. Persist — the load populates `polygonCache` when it resolves
 *      REGARDLESS of whether the component that kicked it off is still
 *      mounted. Previously the fetch was tied to an AbortController that
 *      fired on unmount, so finishing the wizard mid-fetch (to create the
 *      game) aborted the boundary load before it cached — and the lobby
 *      preview then re-ran the whole load + veil instead of snapping
 *      straight to the already-chosen area. Letting it complete in the
 *      background means the lobby reliably hits the cache.
 */
const inFlightPolygon = new Map<
    number,
    Promise<GeoJSON.Polygon | GeoJSON.MultiPolygon | null>
>();

function ensurePolygonCached(
    osmId: number,
): Promise<GeoJSON.Polygon | GeoJSON.MultiPolygon | null> {
    if (polygonCache.has(osmId)) {
        return Promise.resolve(polygonCache.get(osmId) ?? null);
    }
    const existing = inFlightPolygon.get(osmId);
    if (existing) return existing;
    const job = (async () => {
        try {
            const geom = await fetchRawBoundaryPolygon(osmId);
            if (!geom) {
                polygonCache.set(osmId, geom);
                return geom;
            }
            // Clip to land — same `clipPolygonToLand` the main map uses —
            // so the preview matches the real play surface (no ocean/lake
            // bite). Cache the CLIPPED result; fall back to raw on failure.
            try {
                const clipped = await clipPolygonToLand({
                    type: "Feature",
                    properties: {},
                    geometry: geom,
                });
                const finalGeom = clipped?.geometry ?? geom;
                polygonCache.set(osmId, finalGeom);
                return finalGeom;
            } catch {
                polygonCache.set(osmId, geom);
                return geom;
            }
        } catch {
            // Don't cache failures — allow a later retry.
            return null;
        } finally {
            inFlightPolygon.delete(osmId);
        }
    })();
    inFlightPolygon.set(osmId, job);
    return job;
}

/**
 * Sibling cache for ADJACENT-AREA candidate boundaries (the dashed-pill
 * overlay). Kept separate from `polygonCache` (which holds the primary's
 * land-clipped boundary) because candidate outlines are drawn raw — no
 * coastline clip needed for a faint reference rectangle/outline. Keyed
 * by OSM relation id; `null` = fetch resolved with no geometry.
 */
const candidatePolygonCache = new Map<
    number,
    GeoJSON.Polygon | GeoJSON.MultiPolygon | null
>();

/**
 * Tiny map preview for the wizard's PlayAreaStep — shows the selected
 * Photon result. Renders nothing on top of the base tiles until the
 * real polygon lands; we don't draw the bbox rectangle as a
 * placeholder anymore. The bbox over-approximates everywhere (Dalarna
 * County's bbox includes parts of Norway and Uppsala, etc.) so
 * showing it as the actual shape is misleading. Leaving the tiles
 * bare for a beat is better than implying a wrong outline.
 *
 * The map still pans / zooms to fit the bbox so the user sees the
 * right region while the polygon loads; only the polygon overlay
 * itself is gated on real data.
 *
 * Renders as `client:only`-safe — MapLibre's window deps are
 * imported lazily at this leaf, so a static import in the wizard
 * doesn't pull leaflet/maplibre into the SSR graph.
 */
/**
 * Register a small DOT-stipple image (`adjacent-dots`) the unselected
 * neighbour fill uses as a `fill-pattern`. A flat off-white tint is nearly
 * invisible over the light-mode basemap; a dotted texture makes the
 * candidate area read clearly WITHOUT the "crossed-out" look a diagonal
 * hatch gave it. Idempotent — safe to call on every load. Structural param
 * type so `onLoad`'s MapLibre target matches without a maplibre-gl import.
 */
function ensureAdjacentDots(map: {
    hasImage: (id: string) => boolean;
    addImage: (
        id: string,
        img: ImageData,
        opts?: { pixelRatio?: number },
    ) => void;
}): void {
    try {
        if (map.hasImage("adjacent-dots")) return;
        const size = 8;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.clearRect(0, 0, size, size);
        // One dot centred in a tile → a regular stipple grid when tiled.
        // Neutral slate so it textures the off-white fill legibly.
        ctx.fillStyle = "rgba(70, 82, 100, 0.6)";
        ctx.beginPath();
        ctx.arc(size / 2, size / 2, 1.3, 0, Math.PI * 2);
        ctx.fill();
        map.addImage("adjacent-dots", ctx.getImageData(0, 0, size, size), {
            pixelRatio: 2,
        });
    } catch {
        /* image race / no canvas — the flat fill still shows */
    }
}

export function PlayAreaPreviewMap({
    value,
    height = "h-[160px]",
    onReady,
    veilLabel,
    veilSublabel,
    awaitAdjacent = false,
    preferCombinedBoundary = false,
    deferReveal = false,
    framePadding = 24,
}: {
    value: OpenStreetMap;
    height?: string;
    /** v382: fires once when the map's veil drops (tiles + polygon both
     *  in, or the safety timeout elapsed). The wizard uses this to fade
     *  in the play-area name and Change/Adjacent buttons in sync with
     *  the map appearing, instead of letting them show ahead of it. */
    onReady?: () => void;
    /** v454: override the loading-veil copy. The wizard passes the same
     *  "Finding a play area near you…" wording the GPS-pending placeholder
     *  used, so the GPS → tile-load handoff reads as ONE continuous load
     *  instead of the label jumping to a second "Loading map" phase. */
    veilLabel?: string;
    veilSublabel?: string;
    /** v474: hold the loading veil up until the adjacent-area candidates
     *  have also resolved (not just the boundary + tiles), so the camera's
     *  widen-to-include-neighbours happens UNDER the veil and the user
     *  sees the map reveal exactly once, fully settled — never a load
     *  followed by a late zoom-out. Only the wizard's step-1 preview sets
     *  this (it's the one with a PlayAreaExtensions sibling publishing
     *  candidates); the lobby + summary previews leave it false so they
     *  don't wait on a controller that never mounts. */
    awaitAdjacent?: boolean;
    /** v674: draw the AUTHORITATIVE combined play-area boundary
     *  (`mapGeoJSON`, the `determineMapBoundaries` union of primary + every
     *  added adjacent area, minus subtracted) when it's loaded, instead of
     *  re-fetching the primary + each neighbour separately via
     *  `CommittedAreasOverlay`. The lobby passes this so its preview shows
     *  the exact same shape the in-game map does — the per-area re-fetch
     *  could miss an added area (the Vancouver "+ North Van didn't show"
     *  report). The wizard leaves it false (there `value` is a candidate
     *  being previewed, which may differ from the committed play area). */
    preferCombinedBoundary?: boolean;
    /** v703: keep the loading veil up until tiles actually paint, even on a
     *  polygon-cache hit. The lobby preview is a FRESHLY-mounted GL instance
     *  (separate from the wizard's — closing the setup dialog destroyed that
     *  one), so its canvas is blank at mount; the cache-hit fast path
     *  (`initialRevealed`) then revealed a BLANK canvas that repainted in
     *  view — the "lobby reloaded the map" flash. Deferring the reveal shows
     *  a clean loader until the tiles land instead. The wizard leaves this
     *  false: there the cache-hit fast path avoids a veil flash when `value`
     *  swaps within the already-painted mounted instance. */
    deferReveal?: boolean;
    /** v879: extra fit padding (px) around the framed boundary. A larger
     *  value zooms the camera OUT so more context shows around the play
     *  area — the lobby header passes a bigger value than the default. */
    framePadding?: number;
}) {
    const mapRef = useRef<MapRef | null>(null);
    // v228: opt into the dark-tile CSS filter only when the resolved
    // theme is dark — so the preview map follows the OS / app theme
    // setting instead of always being dark.
    const $theme = useStore(resolvedTheme);
    const darkTiles = $theme === "dark";

    // v867: the "you are here" blue dot. The wizard's GPS suggestion (and
    // the game maps' watch) publish to `lastKnownPosition`; show the marker
    // whenever a fix is known so the player can see where they are relative
    // to the play area they're picking. No fix → no dot (correct degraded
    // state), same as the main maps.
    const $selfPos = useStore(lastKnownPosition);

    // Photon's extent we normalised to [maxLat, minLng, minLat, maxLng].
    // Fall back to the centroid + a small box if extent is missing
    // (rare — usually only Point-shaped entries without a polygon).
    // The bbox is now ONLY used for camera framing, never drawn as an
    // overlay — see the file header for the rationale.
    const bbox = useMemo(() => {
        const extent = (value.properties as { extent?: number[] }).extent;
        if (extent && extent.length === 4) {
            const [maxLat, minLng, minLat, maxLng] = extent;
            return { minLng, minLat, maxLng, maxLat };
        }
        const coords = value.geometry.coordinates as unknown as [
            number,
            number,
        ];
        const [lat, lng] = coords;
        if (typeof lat !== "number" || typeof lng !== "number") return null;
        return {
            minLng: lng - 0.1,
            minLat: lat - 0.1,
            maxLng: lng + 0.1,
            maxLat: lat + 0.1,
        };
    }, [value]);

    // Async fetch of the real OSM relation boundary via
    // polygons.openstreetmap.fr. Only fires when Photon's result is a
    // Relation (osm_type === "R") — Way / Node results don't have a
    // pre-computed polygon to fetch. Cached in-module so repeated
    // previews of the same result are instant. Stale-request guard via
    // an AbortController so the fast Stockholm preview doesn't get
    // clobbered by a slow Tokyo preview that landed after.
    const osmId = value.properties.osm_id;
    const osmType = value.properties.osm_type;
    const [realPolygon, setRealPolygon] = useState<
        GeoJSON.Polygon | GeoJSON.MultiPolygon | null
    >(() => (osmId ? (polygonCache.get(osmId) ?? null) : null));

    // v319: was this exact area already previewed earlier this session?
    // A module-cache hit at first mount means the boundary geometry is in
    // memory and the basemap tiles are HTTP-cached — so a fresh MapLibre
    // instance (the wizard preview and the lobby preview are separate GL
    // canvases) will repaint in well under a second. Skip the veil
    // entirely in that case so we don't flash a misleading "loading"
    // spinner over content the user already saw load. Captured once at
    // mount via a ref — it must NOT change when `value` swaps to a
    // different (uncached) area within the same mounted instance.
    const cacheHitAtMount = useRef(
        osmType === "R" && osmId ? polygonCache.has(osmId) : false,
    );

    useEffect(() => {
        if (osmType !== "R" || !osmId) {
            setRealPolygon(null);
            return;
        }
        const cached = polygonCache.get(osmId);
        if (cached !== undefined) {
            setRealPolygon(cached);
            return;
        }
        // Kick off (or join) the shared load. It runs to completion and
        // caches in the background even if this component unmounts first
        // — `active` only gates whether WE apply the result, so a stale
        // swap (osmId changed) or an unmount no longer aborts the fetch.
        let active = true;
        ensurePolygonCached(osmId).then((geom) => {
            if (active) setRealPolygon(geom);
        });
        return () => {
            active = false;
        };
    }, [osmId, osmType]);

    // v674: the authoritative COMBINED play-area boundary (primary + every
    // added area), published by `determineMapBoundaries`. When
    // `preferCombinedBoundary` is on and this is loaded, we draw + frame to
    // it and skip the per-area `CommittedAreasOverlay` entirely, so the
    // lobby preview can't disagree with the in-game map.
    const $combinedBoundary = useStore(mapGeoJSON);
    const combinedGeom = useMemo<
        GeoJSON.Polygon | GeoJSON.MultiPolygon | null
    >(() => {
        if (!preferCombinedBoundary) return null;
        const geom = (
            $combinedBoundary as GeoJSON.FeatureCollection | null
        )?.features?.[0]?.geometry;
        if (
            geom &&
            (geom.type === "Polygon" || geom.type === "MultiPolygon")
        ) {
            return geom as GeoJSON.Polygon | GeoJSON.MultiPolygon;
        }
        return null;
    }, [preferCombinedBoundary, $combinedBoundary]);

    // Prefer the combined boundary; fall back to the primary-only polygon.
    const effectiveGeom = combinedGeom ?? realPolygon;

    // The overlay is the effective polygon or nothing. No bbox fallback.
    const polygon = useMemo<GeoJSON.Feature<
        GeoJSON.Polygon | GeoJSON.MultiPolygon
    > | null>(() => {
        if (!effectiveGeom) return null;
        return {
            type: "Feature",
            properties: {},
            geometry: effectiveGeom,
        };
    }, [effectiveGeom]);

    // v438: subscribe to the adjacent-area candidates so the camera can
    // widen to include their pills. Without this, neighbours whose
    // centroid falls OUTSIDE the primary's bbox (an adjacent county,
    // a cross-line municipality) would have their boundary parked
    // off-screen until the user manually zoomed out.
    const $adjacent = useStore(adjacentCandidatePreview);
    // Added (committed) adjacent areas — the camera must frame these as
    // part of the play area too, so a lobby/preview showing a primary +
    // folded-in neighbours fits the WHOLE assembled shape, not just the
    // primary (the "zoom to fit adjacent areas" the user asked for). The
    // CommittedAreasOverlay already DRAWS them; this just frames them.
    const $added = useStore(additionalMapGeoLocations);
    const hasAdded = $added.some((e) => e.added && e.location);
    // v483: true once every adjacent candidate's boundary polygon has
    // settled (reported by AdjacentCandidatesOverlay). Folds into the
    // reveal gate so the preview waits for the neighbour boundaries to
    // paint before dropping the veil — one load, not list-then-polygons.
    const [candPolysReady, setCandPolysReady] = useState(false);

    // v637: whether MapLibre has fired `onLoad` (the map instance is
    // ready for `fitBounds`). The committed-area fit below can run BEFORE
    // the map is ready — most reliably in the lobby preview, where the
    // primary boundary is already module-cached at mount, so the fit
    // effect runs once (map null → bails) and, since its data never
    // changes afterwards, never re-runs. Folding this flag into that
    // effect's deps makes it re-fire the moment the map is ready, so the
    // camera actually widens to include folded-in neighbours.
    const [mapReady, setMapReady] = useState(false);

    // v473: the camera moves in at most two beats, never the jarring
    // three-stage frame→tighten→zoom-out the user reported:
    //   1. an initial bbox frame (fitToBbox, below — runs on select),
    //   2. EITHER a tighten to the accurate boundary (no candidates yet)
    //      OR a single smooth widen that includes every candidate bbox.
    // The widen is one-shot per area (guarded by `widenedRef`), so the
    // camera settles once and stays put while areas are toggled, and the
    // boundary-tighten is suppressed once we've widened so the two never
    // fight each other. `widenedRef` resets when a new area is chosen
    // (see the bbox effect below).
    const widenedRef = useRef(false);

    // Tighten to the accurate boundary once it lands — but only while we
    // haven't already widened to candidates (the widen supersedes this).
    // The bbox extent was an over-approximation for irregular shapes
    // (Dalarna's bbox swallowed parts of Norway + Uppsala).
    useEffect(() => {
        // v674: when drawing the COMBINED boundary, frame straight to it —
        // it already includes every added area, so none of the
        // candidate/committed-fit gymnastics below apply.
        if (combinedGeom) {
            try {
                const map = mapRef.current?.getMap();
                if (!map) return;
                const [minX, minY, maxX, maxY] = turf.bbox({
                    type: "Feature",
                    properties: {},
                    geometry: combinedGeom,
                } as GeoJSON.Feature) as [number, number, number, number];
                map.fitBounds(
                    [
                        [minX, minY],
                        [maxX, maxY],
                    ],
                    { padding: framePadding, duration: 400, maxZoom: 12 },
                );
            } catch {
                /* ignore */
            }
            return;
        }
        // When the area has folded-in neighbours, the committed-fit effect
        // below owns framing (primary + every added area); tightening to
        // the primary alone here would just crop them back out.
        if (!realPolygon || widenedRef.current || hasAdded) return;
        try {
            const map = mapRef.current?.getMap();
            if (!map) return;
            const [minX, minY, maxX, maxY] = turf.bbox({
                type: "Feature",
                properties: {},
                geometry: realPolygon,
            } as GeoJSON.Feature) as [number, number, number, number];
            map.fitBounds(
                [
                    [minX, minY],
                    [maxX, maxY],
                ],
                { padding: framePadding, duration: 400, maxZoom: 12 },
            );
        } catch {
            /* ignore */
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [realPolygon, hasAdded, combinedGeom, mapReady]);

    // Committed-area fit: frame the camera to the WHOLE assembled play
    // area — the primary plus every ADDED neighbour — whenever the
    // candidate picker isn't the thing driving the camera (the wizard's
    // widen effect owns that case). This is what makes the lobby preview
    // zoom out to include folded-in adjacents instead of cropping to the
    // primary. Re-fits when the added set changes (add/remove a neighbour)
    // and once the primary boundary lands.
    const committedFitRef = useRef<string | null>(null);
    useEffect(() => {
        if (combinedGeom) return; // v674: combined-boundary framing owns it
        if ($adjacent?.candidates?.length) return; // wizard widen owns it
        const added = $added.filter((e) => e.added && e.location);
        if (added.length === 0) return;
        const base: [number, number, number, number] | null = realPolygon
            ? (turf.bbox({
                  type: "Feature",
                  properties: {},
                  geometry: realPolygon,
              } as GeoJSON.Feature) as [number, number, number, number])
            : bbox
              ? [bbox.minLng, bbox.minLat, bbox.maxLng, bbox.maxLat]
              : null;
        if (!base) return;
        let [minX, minY, maxX, maxY] = base;
        for (const e of added) {
            // extent order is [maxLat, minLng, minLat, maxLng].
            const ext = (
                e.location?.properties as { extent?: number[] } | undefined
            )?.extent;
            if (!ext || ext.length < 4) continue;
            const [cMaxLat, cMinLng, cMinLat, cMaxLng] = ext;
            minX = Math.min(minX, cMinLng);
            maxX = Math.max(maxX, cMaxLng);
            minY = Math.min(minY, cMinLat);
            maxY = Math.max(maxY, cMaxLat);
        }
        const key = `${minX.toFixed(4)},${minY.toFixed(4)},${maxX.toFixed(4)},${maxY.toFixed(4)}`;
        if (committedFitRef.current === key) return;
        try {
            const map = mapRef.current?.getMap();
            if (!map) return;
            committedFitRef.current = key;
            // Mark as "framed wider" so the primary-only tighten/widen
            // effects don't fight this fit.
            widenedRef.current = true;
            map.fitBounds(
                [
                    [minX, minY],
                    [maxX, maxY],
                ],
                { padding: 24, duration: 600, maxZoom: 12, essential: true },
            );
        } catch {
            /* ignore */
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [$added, $adjacent, realPolygon, bbox, mapReady]);

    // One smooth, one-time widen to include every adjacent-candidate
    // bbox, the first time candidates are available for this area. A
    // single deliberate motion (longer eased duration) rather than a
    // sudden snap — and guarded so later candidate updates / area toggles
    // never re-fit. v438 added the widen so off-screen neighbours start
    // visible; v473 makes it a single smooth beat instead of a late jump.
    useEffect(() => {
        if (widenedRef.current) return;
        const candidates = $adjacent?.candidates ?? [];
        if (candidates.length === 0) return;
        const base = realPolygon
            ? (turf.bbox({
                  type: "Feature",
                  properties: {},
                  geometry: realPolygon,
              } as GeoJSON.Feature) as [number, number, number, number])
            : bbox
              ? ([bbox.minLng, bbox.minLat, bbox.maxLng, bbox.maxLat] as [
                    number,
                    number,
                    number,
                    number,
                ])
              : null;
        if (!base) return;
        let [minX, minY, maxX, maxY] = base;
        // candidate bboxes are [maxLat, minLng, minLat, maxLng].
        for (const [cMaxLat, cMinLng, cMinLat, cMaxLng] of candidates.map(
            (c) => c.bbox,
        )) {
            minX = Math.min(minX, cMinLng);
            maxX = Math.max(maxX, cMaxLng);
            minY = Math.min(minY, cMinLat);
            maxY = Math.max(maxY, cMaxLat);
        }
        try {
            const map = mapRef.current?.getMap();
            if (!map) return;
            widenedRef.current = true;
            map.fitBounds(
                [
                    [minX, minY],
                    [maxX, maxY],
                ],
                { padding: 24, duration: 800, maxZoom: 12, essential: true },
            );
        } catch {
            /* ignore */
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [$adjacent, realPolygon, bbox]);

    // Fit the map to the bbox. Called both from the bbox-change effect
    // (parent swaps `value` without unmounting) AND from the map's
    // onLoad — on first mount the effect runs before MapLibre has
    // initialised, so its fitBounds was being silently swallowed,
    // leaving the preview stuck at the hardcoded initial zoom (way too
    // tight for a large region like a whole county). onLoad guarantees
    // the fit lands once the map is actually ready.
    const fitToBbox = (animate: boolean) => {
        const map = mapRef.current?.getMap();
        if (!map || !bbox) return;
        try {
            map.fitBounds(
                [
                    [bbox.minLng, bbox.minLat],
                    [bbox.maxLng, bbox.maxLat],
                ],
                { padding: 16, duration: animate ? 400 : 0, maxZoom: 12 },
            );
        } catch {
            /* ignore — the map may not be ready yet */
        }
    };

    useEffect(() => {
        // New area chosen → allow exactly one fresh widen for it, and let
        // the committed-area fit recompute for the new primary.
        widenedRef.current = false;
        committedFitRef.current = null;
        fitToBbox(true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [bbox]);

    // Rough initial zoom from the bbox span so the very first paint is
    // already close to framed (before onLoad's exact fit). Larger spans
    // → lower zoom. Keeps a big county from flashing in over-zoomed.
    const initialZoom = useMemo(() => {
        if (!bbox) return 9;
        const span = Math.max(
            bbox.maxLat - bbox.minLat,
            bbox.maxLng - bbox.minLng,
        );
        if (span > 4) return 5;
        if (span > 2) return 6;
        if (span > 1) return 7;
        if (span > 0.5) return 8;
        if (span > 0.25) return 9;
        return 10;
    }, [bbox]);

    // v230: switched from OSM standard raster (which we couldn't
    // de-clutter) to Protomaps vector tiles. Style is rebuilt when
    // the theme OR the resolved PMTiles URL changes (v241: fallback
    // to demo bucket on worker failure).
    const $pmtilesUrl = useStore(pmtilesUrl);
    const mapStyle = useMemo(
        () => protomapsMapLibreStyle(darkTiles ? "dark" : "light"),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [darkTiles, $pmtilesUrl],
    );

    // Gate the reveal on the boundary polygon landing AND the basemap
    // tiles painting. A relation result is expected to produce a
    // polygon; Way/Node results never do, so they only wait on tiles.
    const boundaryExpected = osmType === "R";
    // v474: when `awaitAdjacent`, also wait for the adjacency lookup to
    // RESOLVE (status "ready").
    // v483: AND wait for every candidate's BOUNDARY POLYGON to land —
    // `candPolysReady`, reported by AdjacentCandidatesOverlay once all its
    // per-candidate boundary fetches have settled. Without this the veil
    // dropped after the candidate LIST resolved, then the precise
    // boundaries streamed in afterwards (bbox rectangle → real polygon
    // swap) — the visible "second load" of the adjacent areas. Now the
    // map reveals once, with the primary + every neighbour boundary
    // already painted. (candPolysReady is only set true once the list is
    // "ready", so it subsumes the status check.)
    const adjacentReady = !awaitAdjacent || candPolysReady;
    const dataReady =
        (!boundaryExpected || polygon !== null) && adjacentReady;
    // Re-arm the idle latch whenever the data that drives the camera /
    // overlay changes (boundary lands, candidates resolve, candidate
    // polygons paint), so the reveal waits for the tiles + final paint of
    // the FULLY-built viewport — not an intermediate frame.
    const resetKey = `${osmId ?? "-"}:${polygon ? "p" : "-"}:${
        $adjacent?.status ?? "none"
    }:${$adjacent?.candidates.length ?? 0}:${candPolysReady ? "cp" : "-"}`;
    const { showVeil, timedOut, onLoad, onIdle } = useMapTilesReady({
        dataReady,
        resetKey,
        // When waiting on adjacency, give the gate longer before it
        // force-reveals. The default 12 s frequently expired before a
        // multi-neighbour city (e.g. Bucharest + 6 adjacents) finished its
        // adjacency Overpass query + per-candidate boundary fetches, which
        // force-revealed the primary-only map and then streamed the
        // neighbours in afterwards — the "loads in two parts" the user
        // reported. 30 s keeps it a single settle in all but pathological
        // cases; the veil shows a normal loader the whole time.
        revealTimeoutMs: awaitAdjacent ? 30_000 : 12_000,
        // The cache-hit fast path (start already revealed) is skipped when
        // we're waiting on adjacency: candidate readiness isn't knowable
        // at mount, so honour the full gate instead of flashing the map
        // and then widening. On a full cache hit the gate still clears in
        // well under a second (cached boundary + HTTP-cached tiles).
        initialRevealed:
            cacheHitAtMount.current && !awaitAdjacent && !deferReveal,
    });

    // v382: surface the reveal moment to the wizard so it can fade in
    // the play-area name + Change/Adjacent buttons in sync with the map
    // appearing. Latched-via-useMapTilesReady, so this fires exactly
    // once per mount once the veil truly drops.
    const onReadyFiredRef = useRef(false);
    useEffect(() => {
        if (showVeil || onReadyFiredRef.current) return;
        onReadyFiredRef.current = true;
        onReady?.();
    }, [showVeil, onReady]);

    // v327: the wizard preview NO longer flips the global pmtilesUrl
    // on a reveal timeout. The reveal gate's 12 s timer is a "should
    // we keep the veil up" signal, not a "is the basemap broken"
    // signal — one slow range request (Copenhagen test, v326 logs) is
    // enough to trip it without anything actually being wrong, and
    // flipping to the demo bucket made the load WORSE. The seeker
    // Map's sourcedata-based watchdog (Map.tsx v321) is the canonical
    // basemap-health check: it only fires when zero protomaps tiles
    // arrive in the grace window, so genuinely-aborted archive fetches
    // still self-heal once the seeker view mounts. `timedOut` is
    // still consumed below to soften the veil copy from "Loading map"
    // to "Map tiles are slow to load" while the user waits.

    if (!bbox) return null;

    return (
        <div
            className={`relative w-full ${height} rounded-md overflow-hidden border border-border`}
        >
            <MapGL
                ref={mapRef}
                initialViewState={{
                    longitude: (bbox.minLng + bbox.maxLng) / 2,
                    latitude: (bbox.minLat + bbox.maxLat) / 2,
                    zoom: initialZoom,
                }}
                style={{ width: "100%", height: "100%" }}
                mapStyle={mapStyle}
                attributionControl={false}
                /* Interactive so the +/✓ Markers below receive taps;
                   pinch-zoom and drag also work, which fits the
                   "explore neighbouring areas" flow. */
                interactive
                dragRotate={false}
                pitchWithRotate={false}
                touchPitch={false}
                onLoad={(e) => {
                    installMissingImageHandler(e.target);
                    ensureAdjacentDots(e.target);
                    fitToBbox(false);
                    // v637: flag the map ready so the committed-area fit
                    // effect re-fires and widens to include folded-in
                    // neighbours (the lobby-preview zoom fix). When there
                    // are added areas it widens right after this primary
                    // fit; with none, the primary fit is the final frame.
                    setMapReady(true);
                    onLoad();
                }}
                onIdle={onIdle}
                onError={handleMapLibreError}
            >
                {/* Unselected neighbour candidates render FIRST so they sit
                    BENEATH the primary boundary + committed areas. Their
                    faint off-white/grey fills (and the bbox-fallback
                    rectangles, which overlap the primary before real
                    boundaries load) would otherwise paint OVER the main
                    play area's red and desaturate it to pink. Drawing them
                    underneath keeps the primary boundary + fill reading as
                    their own brand red. (The pill markers are DOM elements,
                    always on top regardless of layer order, and fill
                    hit-testing is by layer id, so tapping still works.) */}
                <AdjacentCandidatesOverlay
                    mapRef={mapRef}
                    onPolysReady={setCandPolysReady}
                />
                {polygon && (
                    <Source id="bbox" type="geojson" data={polygon}>
                        <Layer
                            id="bbox-fill"
                            type="fill"
                            paint={{
                                "fill-color": PLAY_AREA_COLOR,
                                "fill-opacity": PLAY_AREA_FILL_OPACITY,
                            }}
                        />
                        <Layer
                            id="bbox-line"
                            type="line"
                            paint={{
                                "line-color": PLAY_AREA_COLOR,
                                "line-width": PLAY_AREA_LINE_WIDTH,
                                "line-opacity": PLAY_AREA_LINE_OPACITY,
                            }}
                        />
                    </Source>
                )}
                {/* When drawing the authoritative combined boundary, the
                    added areas are ALREADY in `polygon` — don't also
                    re-fetch + draw them per-area (which could miss one). */}
                {!combinedGeom && <CommittedAreasOverlay />}
                {/* "You are here" — the local player's live GPS, so they can
                    see where they sit relative to the play area they pick. */}
                {$selfPos && (
                    <Marker
                        latitude={$selfPos.lat}
                        longitude={$selfPos.lng}
                        anchor="center"
                    >
                        <SelfPositionMarker />
                    </Marker>
                )}
            </MapGL>
            <MapTilesVeil
                visible={showVeil}
                rounded
                timedOut={timedOut}
                label={veilLabel}
                sublabel={veilSublabel}
            />
        </div>
    );
}

/**
 * Paints the COMMITTED play-area extensions (everything in
 * `additionalMapGeoLocations`) in the same red as the primary boundary,
 * so the assembled play area on the wizard preview matches what the
 * seeker map will show. Distinct from `AdjacentCandidatesOverlay`, which
 * only renders the +/✓ picker overlay WHILE the extend panel is open —
 * this one is always on, so added areas don't vanish when the panel
 * collapses or the user moves to a later wizard step (the bug this
 * fixes). Fetches each added area's real boundary lazily (shared
 * `candidatePolygonCache`), falling back to the extent rectangle until
 * it lands.
 */
function CommittedAreasOverlay() {
    const $additional = useStore(additionalMapGeoLocations);
    const [polys, setPolys] = useState<
        Map<number, GeoJSON.Polygon | GeoJSON.MultiPolygon>
    >(new Map());

    const ids = $additional
        .map(
            (e) =>
                (e.location?.properties as { osm_id?: number } | undefined)
                    ?.osm_id,
        )
        .filter((v): v is number => typeof v === "number");
    const idsKey = ids.join(",");

    useEffect(() => {
        if (ids.length === 0) return;
        let cancelled = false;
        const ctrl = new AbortController();
        setPolys((prev) => {
            let next = prev;
            for (const id of ids) {
                const cached = candidatePolygonCache.get(id);
                if (cached && !next.has(id)) {
                    if (next === prev) next = new Map(prev);
                    next.set(id, cached);
                }
            }
            return next;
        });
        for (const id of ids) {
            if (candidatePolygonCache.has(id)) continue;
            fetchRawBoundaryPolygon(id, ctrl.signal)
                .then((geom) => {
                    if (cancelled) return;
                    candidatePolygonCache.set(id, geom);
                    if (geom) setPolys((prev) => new Map(prev).set(id, geom));
                })
                .catch(() => {
                    /* swallowed */
                });
        }
        return () => {
            cancelled = true;
            ctrl.abort();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [idsKey]);

    // v458: fade the NEWLY-added area in. The most-recent id ($additional
    // appends on add) renders in a separate "fade" layer that ramps
    // 0 → target via a paint transition; every earlier area renders in a
    // "stable" layer at constant opacity. That way adding an area fades
    // ONLY the new boundary — the ones already placed don't blink.
    const lastId = ids.length ? ids[ids.length - 1] : null;
    const [lit, setLit] = useState(true);
    const prevCount = useRef(0);
    useEffect(() => {
        const grew = ids.length > prevCount.current;
        prevCount.current = ids.length;
        if (grew && lastId !== null) {
            setLit(false);
            const raf = requestAnimationFrame(() => setLit(true));
            return () => cancelAnimationFrame(raf);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [idsKey]);

    if ($additional.length === 0) return null;

    // Real OSM boundary only — NO bbox-rectangle fallback. The bbox
    // over-approximates wildly, so drawing it first and swapping to the
    // real polygon a beat later made an added area "start too big then
    // shrink". Candidates are pre-fetched into `candidatePolygonCache`,
    // so by the time one is added its real polygon is almost always in
    // hand and paints immediately; on the rare miss the area simply
    // isn't drawn for the moment it takes to resolve (no shrink).
    const featureFor = (
        e: (typeof $additional)[number],
    ): GeoJSON.Feature | null => {
        const id = (e.location?.properties as { osm_id?: number } | undefined)
            ?.osm_id;
        const geom =
            typeof id === "number"
                ? (polys.get(id) ?? candidatePolygonCache.get(id))
                : undefined;
        if (geom) return { type: "Feature", properties: {}, geometry: geom };
        // v636: bbox fallback. The real boundary hasn't landed yet — the
        // neighbour municipality isn't a curated/prewarmed relation, so its
        // polygon fetch goes live and can be slow or throttled
        // (polygons.osm.fr rate-limits residential IPs). Without a fallback
        // a just-added area rendered NOTHING until its polygon arrived
        // ("selected areas don't show a boundary at all"). Draw the extent
        // rectangle so the selection is immediately visible, swapping to the
        // real polygon the moment it loads. The bbox over-approximates, so
        // there's a small shrink when the real one lands — acceptable vs.
        // showing nothing.
        const ext = (
            e.location?.properties as { extent?: number[] } | undefined
        )?.extent;
        if (ext && ext.length >= 4) {
            // extent order: [maxLat, minLng, minLat, maxLng].
            const [maxLat, minLng, minLat, maxLng] = ext;
            return {
                type: "Feature",
                properties: {},
                geometry: {
                    type: "Polygon",
                    coordinates: [
                        [
                            [minLng, minLat],
                            [maxLng, minLat],
                            [maxLng, maxLat],
                            [minLng, maxLat],
                            [minLng, minLat],
                        ],
                    ],
                },
            };
        }
        return null;
    };
    const idOf = (e: (typeof $additional)[number]) =>
        (e.location?.properties as { osm_id?: number } | undefined)?.osm_id;

    const stableFC: GeoJSON.FeatureCollection = {
        type: "FeatureCollection",
        features: $additional
            .filter((e) => idOf(e) !== lastId)
            .flatMap((e) => {
                const f = featureFor(e);
                return f ? [f] : [];
            }),
    };
    const fadeFeature = $additional.find((e) => idOf(e) === lastId);
    const fadeFC: GeoJSON.FeatureCollection = {
        type: "FeatureCollection",
        features: fadeFeature
            ? (() => {
                  const f = featureFor(fadeFeature);
                  return f ? [f] : [];
              })()
            : [],
    };

    return (
        <>
            {/* Already-placed areas — steady, no transition (no blink). */}
            <Source id="committed-areas" type="geojson" data={stableFC}>
                <Layer
                    id="committed-areas-fill"
                    type="fill"
                    paint={{
                        "fill-color": PLAY_AREA_COLOR,
                        "fill-opacity": PLAY_AREA_FILL_OPACITY,
                    }}
                />
                <Layer
                    id="committed-areas-line"
                    type="line"
                    paint={{
                        "line-color": PLAY_AREA_COLOR,
                        "line-width": PLAY_AREA_LINE_WIDTH,
                        "line-opacity": PLAY_AREA_LINE_OPACITY,
                    }}
                />
            </Source>
            {/* Just-added area — fades 0 → target via paint transition. */}
            <Source id="committed-areas-fade" type="geojson" data={fadeFC}>
                <Layer
                    id="committed-areas-fade-fill"
                    type="fill"
                    paint={fadePaint({
                        "fill-color": PLAY_AREA_COLOR,
                        "fill-opacity": lit ? PLAY_AREA_FILL_OPACITY : 0,
                        "fill-opacity-transition": { duration: 280, delay: 0 },
                    })}
                />
                <Layer
                    id="committed-areas-fade-line"
                    type="line"
                    paint={fadePaint({
                        "line-color": PLAY_AREA_COLOR,
                        "line-width": PLAY_AREA_LINE_WIDTH,
                        "line-opacity": lit ? PLAY_AREA_LINE_OPACITY : 0,
                        "line-opacity-transition": { duration: 280, delay: 0 },
                    })}
                />
            </Source>
        </>
    );
}

/**
 * Renders adjacent-area candidates published by `PlayAreaExtensions` as
 * faint dashed bbox-rectangles + a tappable "+/✓" pill at each
 * candidate's centroid. Tapping a pill flips the candidate's added
 * state via `toggleAdjacentArea` — same mutation the in-dialog
 * checklist makes, so both surfaces stay in sync.
 *
 * Candidates without matching transit paint in muted grey rather than
 * the primary tint so the player can still see them as picker options
 * but the visual weight matches their "you probably don't want this"
 * status. Self-renders null when the picker is closed.
 *
 * Name labels are collision-aware (v784): rather than a crude
 * centroid-distance radius (which ignored label width, so a wide label
 * like "NASSAU COUNTY" still overlapped a pill more than the radius away),
 * we project every pill to screen pixels and run a GREEDY box-reservation
 * pass. Every pill's icon-only box is a hard obstacle; a pill earns its
 * label only if the label's bounding box clears every other pill's icon
 * and every already-accepted label. Recomputed on every pan / zoom.
 */
// Pill/label box metrics in CSS px (from the marker styles below): the
// icon-only pill ≈ 30px wide, the row ≈ 22px tall, a gap of ~4px, and each
// label char ≈ 6.2px of a max-120px width. PAD is inter-box breathing room.
const PILL_ICON_W_PX = 30;
const PILL_H_PX = 22;
const LABEL_GAP_PX = 4;
const LABEL_MAX_W_PX = 120;
const LABEL_CHAR_W_PX = 6.2;
const LABEL_BOX_PAD_PX = 4;

function AdjacentCandidatesOverlay({
    mapRef,
    onPolysReady,
}: {
    mapRef: React.RefObject<MapRef | null>;
    /** v483: reports the preview's reveal gate whether every candidate
     *  boundary polygon has settled (fetched or failed → bbox fallback),
     *  so the veil only drops once neighbours are painted. `false` while
     *  the list is still loading; `true` when ready (incl. zero
     *  candidates). */
    onPolysReady?: (ready: boolean) => void;
}) {
    const preview = useStore(adjacentCandidatePreview);
    const $additional = useStore(additionalMapGeoLocations);
    // v464: dim the unselected fill/outline in dark mode — the off-white
    // tint that reads well on the light basemap is glaring on the dark
    // one. Lower the opacities when the resolved theme is dark.
    const dark = useStore(resolvedTheme) === "dark";
    const [labeledIds, setLabeledIds] = useState<Set<number>>(new Set());
    // Real OSM boundaries for each candidate, fetched lazily once the
    // pills are revealed (the bbox rectangle is the fallback until each
    // lands). Seeded from the module cache so re-reveals are instant.
    const [polys, setPolys] = useState<
        Map<number, GeoJSON.Polygon | GeoJSON.MultiPolygon>
    >(new Map());

    const candidates = preview?.candidates;

    useEffect(() => {
        // v483: also drive the preview's reveal gate. Not ready until the
        // candidate LIST has resolved; ready immediately when there are
        // none; otherwise ready once every candidate's boundary fetch
        // settles (success OR failure → bbox fallback), so a single dead
        // candidate can't strand the veil.
        if (!preview || preview.status !== "ready") {
            onPolysReady?.(false);
            return;
        }
        if (!candidates || candidates.length === 0) {
            onPolysReady?.(true);
            return;
        }
        let cancelled = false;
        const ctrl = new AbortController();
        // Apply any cache hits synchronously so they paint immediately.
        setPolys((prev) => {
            let next = prev;
            for (const c of candidates) {
                const cached = candidatePolygonCache.get(c.osmId);
                if (cached && !next.has(c.osmId)) {
                    if (next === prev) next = new Map(prev);
                    next.set(c.osmId, cached);
                }
            }
            return next;
        });
        let settled = 0;
        const markSettled = () => {
            settled++;
            if (!cancelled && settled >= candidates.length) {
                onPolysReady?.(true);
            }
        };
        // Cached candidates settle immediately.
        const toFetch = candidates.filter((c) => {
            if (candidatePolygonCache.has(c.osmId)) {
                markSettled();
                return false;
            }
            return true;
        });
        // v636: fetch the remaining boundaries with LIMITED CONCURRENCY.
        // Firing all ~14 candidate polygon fetches at once hammered
        // polygons.osm.fr, whose residential-IP throttling then failed most
        // of the burst — so every candidate stayed stuck on its bbox
        // rectangle instead of its real outline. A small pool lets each
        // request through cleanly (and hit the worker/R2 fallback) so the
        // real boundaries actually paint.
        const CONCURRENCY = 4;
        let idx = 0;
        const runNext = async (): Promise<void> => {
            while (!cancelled && idx < toFetch.length) {
                const c = toFetch[idx++];
                try {
                    const geom = await fetchRawBoundaryPolygon(
                        c.osmId,
                        ctrl.signal,
                    );
                    if (!cancelled) {
                        candidatePolygonCache.set(c.osmId, geom);
                        if (geom)
                            setPolys((prev) =>
                                new Map(prev).set(c.osmId, geom),
                            );
                    }
                } catch {
                    /* swallowed — bbox fallback stays */
                } finally {
                    markSettled();
                }
            }
        };
        for (let i = 0; i < Math.min(CONCURRENCY, toFetch.length); i++) {
            void runNext();
        }
        return () => {
            cancelled = true;
            ctrl.abort();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [preview, onPolysReady]);
    useEffect(() => {
        const map = mapRef.current?.getMap();
        if (!map || !candidates || candidates.length === 0) {
            setLabeledIds(new Set());
            return;
        }
        const recompute = () => {
            // Project every candidate centroid to screen px. The Marker is
            // anchor="center", so the whole inline-flex pill (icon + optional
            // label) is centred on this point → boxes are centred on (x,y).
            const pts = candidates.map((c) => {
                const [maxLat, minLng, minLat, maxLng] = c.bbox;
                const p = map.project([
                    (minLng + maxLng) / 2,
                    (minLat + maxLat) / 2,
                ]);
                return { id: c.osmId, x: p.x, y: p.y, name: c.name };
            });
            type Box = { x1: number; y1: number; x2: number; y2: number };
            const boxCentred = (x: number, y: number, w: number): Box => ({
                x1: x - w / 2 - LABEL_BOX_PAD_PX,
                y1: y - PILL_H_PX / 2 - LABEL_BOX_PAD_PX,
                x2: x + w / 2 + LABEL_BOX_PAD_PX,
                y2: y + PILL_H_PX / 2 + LABEL_BOX_PAD_PX,
            });
            const overlaps = (a: Box, b: Box) =>
                a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
            const labelWidth = (name: string) =>
                Math.min(LABEL_MAX_W_PX, Math.max(1, name.length) * LABEL_CHAR_W_PX);

            // Hard obstacles: every pill's icon-only box (all pills always
            // render, labelled or not).
            const iconBoxes = pts.map((p) => ({
                id: p.id,
                box: boxCentred(p.x, p.y, PILL_ICON_W_PX),
            }));
            // Greedy order: shortest labels first (cheapest to place), stable
            // by id as a tiebreak so the result doesn't jitter frame to frame.
            const order = [...pts].sort(
                (a, b) => a.name.length - b.name.length || a.id - b.id,
            );
            const accepted: Box[] = [];
            const labeled = new Set<number>();
            for (const p of order) {
                const w =
                    PILL_ICON_W_PX + LABEL_GAP_PX + labelWidth(p.name);
                const box = boxCentred(p.x, p.y, w);
                const hitsIcon = iconBoxes.some(
                    (ic) => ic.id !== p.id && overlaps(box, ic.box),
                );
                const hitsLabel = accepted.some((ab) => overlaps(box, ab));
                if (!hitsIcon && !hitsLabel) {
                    labeled.add(p.id);
                    accepted.push(box);
                }
            }
            setLabeledIds(labeled);
        };
        recompute();
        map.on("move", recompute);
        map.on("zoom", recompute);
        return () => {
            map.off("move", recompute);
            map.off("zoom", recompute);
        };
    }, [candidates, mapRef]);

    // v456: the WHOLE candidate boundary is the add/remove target — tap
    // anywhere inside it, not just the pill. Bind a click handler to the
    // fill layer (registering against the layer id is safe even before
    // the layer mounts), plus a pointer cursor on hover.
    useEffect(() => {
        const map = mapRef.current?.getMap();
        if (!map) return;
        const layerId = "adjacent-candidates-fill";
        const onClick = (e: MapLayerMouseEvent) => {
            const id = e.features?.[0]?.properties?.osmId;
            if (id !== undefined && id !== null) {
                toggleAdjacentArea(Number(id));
            }
        };
        const onEnter = () => {
            map.getCanvas().style.cursor = "pointer";
        };
        const onLeave = () => {
            map.getCanvas().style.cursor = "";
        };
        map.on("click", layerId, onClick);
        map.on("mouseenter", layerId, onEnter);
        map.on("mouseleave", layerId, onLeave);
        return () => {
            map.off("click", layerId, onClick);
            map.off("mouseenter", layerId, onEnter);
            map.off("mouseleave", layerId, onLeave);
        };
    }, [mapRef]);

    if (!preview || preview.candidates.length === 0) return null;

    const addedIds = new Set<number>(
        $additional
            .map(
                (e) =>
                    (e.location?.properties as { osm_id?: number } | undefined)
                        ?.osm_id,
            )
            .filter((v): v is number => typeof v === "number"),
    );

    // Build a FeatureCollection of candidate outlines. Prefer the real
    // OSM admin boundary (fetched in the effect above); fall back to the
    // bbox rectangle until each polygon lands, so there's always
    // something to tap towards. `real` drives solid-vs-dashed styling.
    const fc: GeoJSON.FeatureCollection = {
        type: "FeatureCollection",
        features: preview.candidates.map((c) => {
            const geom = polys.get(c.osmId);
            const [maxLat, minLng, minLat, maxLng] = c.bbox;
            const fallback: GeoJSON.Polygon = {
                type: "Polygon",
                coordinates: [
                    [
                        [minLng, minLat],
                        [maxLng, minLat],
                        [maxLng, maxLat],
                        [minLng, maxLat],
                        [minLng, minLat],
                    ],
                ],
            };
            return {
                type: "Feature",
                properties: {
                    osmId: c.osmId,
                    added: addedIds.has(c.osmId),
                    transit: c.hasMatchingTransit,
                    real: !!geom,
                },
                geometry: geom ?? fallback,
            };
        }),
    };

    // added (red) → every unselected neighbour ONE neutral off-white.
    // The transit-vs-no-transit signal lives on the PILLS (border + label),
    // not the fill — a per-area colour split read as "why is one area white
    // and the others grey?". The dot stipple (below) makes each area legible
    // over the light basemap. Reused by the fill and both line layers.
    const colorExpr: ExpressionSpecification = [
        "case",
        ["==", ["get", "added"], true],
        "hsl(2, 70%, 54%)",
        "hsl(45, 23%, 92%)",
    ];

    return (
        <>
            <Source id="adjacent-candidates" type="geojson" data={fc}>
                {/* Fill across EVERY candidate — the unselected fill AND
                    the whole-area click target. Selected (added) areas
                    drop their candidate fill to 0 so the COMMITTED red
                    (drawn underneath) is what shows: that's how a
                    selected adjacent area ends up with the exact same
                    fill + stroke as the main play area. Opacity-0 fills
                    are still hit-testable, so tapping an added area
                    toggles it back off. */}
                <Layer
                    id="adjacent-candidates-fill"
                    // Pin BENEATH the primary boundary so an unselected
                    // neighbour never washes over it. JSX order alone isn't
                    // enough — candidates load AFTER the primary mounts, so
                    // without an explicit beforeId their layers get inserted
                    // on TOP of the already-present `bbox-fill`.
                    beforeId="bbox-fill"
                    type="fill"
                    paint={{
                        "fill-color": colorExpr,
                        // Faint but visible in BOTH modes. The off-white
                        // transit fill is low-contrast over the LIGHT
                        // basemap, so it needs a higher opacity there to
                        // read as a wash (the old 0.2 vanished); over the
                        // DARK basemap a lighter touch already pops, so keep
                        // it lower to avoid glare.
                        "fill-opacity": [
                            "case",
                            ["==", ["get", "added"], true],
                            0,
                            // Bbox FALLBACK (real boundary not loaded yet):
                            // its rectangle contains the whole primary (e.g.
                            // Akershus's bbox wraps Oslo), so a visible fill
                            // here washes the play area. Keep it invisible
                            // (opacity 0 is still tap-hittable) until the
                            // real municipality shape lands, which only fills
                            // its OWN area, not the primary's.
                            ["==", ["get", "real"], false],
                            0,
                            // One opacity for every unselected neighbour.
                            dark ? 0.16 : 0.36,
                        ],
                    }}
                />
                {/* Dot-stipple texture over the flat tint so an unselected
                    neighbour reads clearly (the flat off-white alone is
                    near-invisible over the light basemap) — dots rather than
                    a diagonal hatch, which read as "crossed out". Only on
                    REAL boundaries (a bbox rectangle shouldn't get stippled)
                    and unselected areas; pinned beneath the primary. */}
                <Layer
                    id="adjacent-candidates-dots"
                    beforeId="bbox-fill"
                    type="fill"
                    filter={[
                        "all",
                        ["!=", ["get", "added"], true],
                        ["==", ["get", "real"], true],
                    ]}
                    paint={{
                        "fill-pattern": "adjacent-dots",
                        "fill-opacity": dark ? 0.5 : 0.85,
                    }}
                />
                {/* Solid outline for resolved boundaries — unselected
                    only; added areas wear the committed red stroke. */}
                <Layer
                    id="adjacent-candidates-line"
                    beforeId="bbox-fill"
                    type="line"
                    filter={["==", ["get", "real"], true]}
                    paint={{
                        "line-color": colorExpr,
                        "line-width": 1.5,
                        "line-opacity": [
                            "case",
                            ["==", ["get", "added"], true],
                            0,
                            dark ? 0.6 : 0.9,
                        ],
                    }}
                />
                {/* Bbox fallback (still loading): dashed rectangle. */}
                <Layer
                    id="adjacent-candidates-line-bbox"
                    beforeId="bbox-fill"
                    type="line"
                    filter={["==", ["get", "real"], false]}
                    paint={{
                        "line-color": colorExpr,
                        "line-width": 1.5,
                        "line-opacity": [
                            "case",
                            ["==", ["get", "added"], true],
                            0,
                            dark ? 0.35 : 0.5,
                        ],
                        "line-dasharray": [3, 3],
                    }}
                />
            </Source>
            {preview.candidates.map((c) => {
                const [maxLat, minLng, minLat, maxLng] = c.bbox;
                const lat = (minLat + maxLat) / 2;
                const lng = (minLng + maxLng) / 2;
                const isAdded = addedIds.has(c.osmId);
                return (
                    <Marker
                        key={c.osmId}
                        latitude={lat}
                        longitude={lng}
                        anchor="center"
                    >
                        <button
                            type="button"
                            onClick={(e) => {
                                e.stopPropagation();
                                toggleAdjacentArea(c.osmId);
                            }}
                            aria-pressed={isAdded}
                            aria-label={
                                isAdded
                                    ? `Remove ${c.name} from play area`
                                    : `Add ${c.name} to play area`
                            }
                            title={
                                isAdded
                                    ? `Remove ${c.name}`
                                    : c.hasMatchingTransit
                                      ? `Add ${c.name} (has transit)`
                                      : `Add ${c.name} (no matching transit)`
                            }
                            className={cn(
                                "inline-flex items-center gap-1 px-1.5 py-0.5",
                                "rounded-full border-2 shadow-md",
                                "text-[10px] font-poppins font-bold uppercase tracking-wide",
                                "transition-colors",
                                isAdded
                                    ? "bg-primary border-primary text-primary-foreground hover:bg-primary/90"
                                    : c.hasMatchingTransit
                                      ? "bg-background border-[hsl(45,23%,92%)]/70 text-foreground hover:bg-[hsl(45,23%,92%)]/10"
                                      : "bg-background/90 border-muted-foreground/50 text-muted-foreground hover:bg-accent",
                            )}
                        >
                            {isAdded ? (
                                <Check className="h-3 w-3" />
                            ) : (
                                <Plus className="h-3 w-3" />
                            )}
                            {labeledIds.has(c.osmId) && (
                                <span className="max-w-[120px] truncate">
                                    {c.name}
                                </span>
                            )}
                        </button>
                    </Marker>
                );
            })}
        </>
    );
}

export default PlayAreaPreviewMap;
