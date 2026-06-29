import "maplibre-gl/dist/maplibre-gl.css";

import { useStore } from "@nanostores/react";
import * as turf from "@turf/turf";
import { useEffect, useMemo, useRef, useState } from "react";
import MapGL, { Layer, type MapRef, Source } from "react-map-gl/maplibre";

import { mapGeoJSON, polyGeoJSON } from "@/lib/context";
import {
    PLAY_AREA_COLOR,
    PLAY_AREA_LINE_OPACITY,
    PLAY_AREA_LINE_WIDTH,
} from "@/lib/playAreaStyle";
import {
    handleMapLibreError,
    installMissingImageHandler,
    protomapsMapLibreStyle,
} from "@/lib/protomapsStyle";
import { resolvedTheme } from "@/lib/theme";
import {
    applyQuestionsToMapGeoData,
    determinePlanningPolygon,
    holedMask,
} from "@/maps";
import type { Question } from "@/maps/schema";

/**
 * Static, non-interactive mini-map that highlights ONE question's
 * outcome — the area of the play region still consistent with the answer.
 *
 * Reuses the exact elimination engine the main map runs
 * (`applyQuestionsToMapGeoData`) against a single question and a clone of
 * the play-area boundary, so the highlight matches the big map. For a
 * still-unanswered (draft) question it draws the planning FOOTPRINT.
 *
 * Marking is CONSISTENT across types and reads in BOTH themes: the
 * play-area boundary is the canonical red `PLAY_AREA_COLOR` stroke; the
 * resulting area is DIMMED on the outside (the main map's elimination-mask
 * language) AND brightened on the inside (a translucent white fill) with a
 * white edge — the brighten is what makes the kept area legible on dark
 * near-black tiles, where dimming alone barely shows.
 *
 * Perf: the view is static, so once it has rendered we snapshot the canvas
 * to a PNG and cache it (per theme + question + framing). Re-expanding a
 * card then shows the cached <img> instantly — no MapLibre instance, no
 * tile fetch. The first render of a given card also DEFERS mounting
 * MapLibre by one animation frame's worth of time so the card's
 * expand animation stays smooth instead of fighting GL init.
 */

/** theme|sig|bbox → captured PNG data URL. Module-level so it survives
 *  collapse/expand and is shared across cards. */
const imageCache = new Map<string, string>();

/** Coerce whatever the engine returns into a FeatureCollection. */
function normalizeFC(value: unknown): GeoJSON.FeatureCollection | null {
    if (!value || typeof value !== "object" || !("type" in value)) return null;
    const v = value as GeoJSON.GeoJSON;
    if (v.type === "FeatureCollection") return v;
    if (v.type === "Feature") {
        return { type: "FeatureCollection", features: [v] };
    }
    return {
        type: "FeatureCollection",
        features: [turf.feature(v as GeoJSON.Geometry)],
    };
}

export function QuestionOutcomeMap({
    question,
    height = "h-[180px]",
}: {
    question: Question;
    height?: string;
}) {
    const $theme = useStore(resolvedTheme);
    const $mapGeoJSON = useStore(mapGeoJSON);
    const $polyGeoJSON = useStore(polyGeoJSON);
    const darkTiles = $theme === "dark";

    const base = $mapGeoJSON || $polyGeoJSON;
    const mapRef = useRef<MapRef | null>(null);
    const captured = useRef(false);
    const isDraft = question.data.drag === true;

    type Outcome = {
        mask: GeoJSON.Feature | null;
        area: GeoJSON.FeatureCollection;
        mode: "result" | "footprint";
    } | null;
    const [outcome, setOutcome] = useState<Outcome>(null);
    const [computing, setComputing] = useState(true);
    const [failed, setFailed] = useState(false);
    const [tilesReady, setTilesReady] = useState(false);
    // Defer mounting MapLibre so the expand animation runs against a cheap
    // skeleton, not a synchronous GL init.
    const [mountMap, setMountMap] = useState(false);

    const sig = useMemo(() => {
        const d = question.data as Record<string, unknown>;
        return [
            question.id,
            question.key,
            d.lat,
            d.lng,
            d.drag,
            d.radius,
            d.within,
            d.hiderCloser,
            d.warmer,
            d.type,
            d.distance,
            d.locationType,
        ].join("|");
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [question]);

    const bbox = useMemo(() => {
        if (!base) return null;
        try {
            const [minLng, minLat, maxLng, maxLat] = turf.bbox(base as never);
            if (
                [minLng, minLat, maxLng, maxLat].every((n) =>
                    Number.isFinite(n),
                )
            ) {
                return { minLng, minLat, maxLng, maxLat };
            }
        } catch {
            /* ignore */
        }
        return null;
    }, [base]);

    const cacheKey = useMemo(() => {
        if (!bbox) return null;
        const b = [bbox.minLng, bbox.minLat, bbox.maxLng, bbox.maxLat]
            .map((n) => n.toFixed(3))
            .join(",");
        return `${darkTiles ? "d" : "l"}|${sig}|${b}`;
    }, [darkTiles, sig, bbox]);

    // Cache hit → show the static PNG, skip MapLibre entirely.
    const cachedImage = cacheKey ? imageCache.get(cacheKey) : undefined;

    useEffect(() => {
        if (cachedImage) return; // nothing to compute — image is ready
        let cancelled = false;
        if (!base) {
            setComputing(false);
            setOutcome(null);
            return;
        }
        setComputing(true);
        setFailed(false);
        (async () => {
            try {
                const qClone = {
                    id: question.id,
                    key: question.key,
                    data: { ...(question.data as Record<string, unknown>) },
                } as unknown as Question;

                if (isDraft) {
                    const poly = await determinePlanningPolygon(qClone, true);
                    if (cancelled) return;
                    const fc = poly ? normalizeFC(poly) : null;
                    setOutcome(
                        fc ? { mask: null, area: fc, mode: "footprint" } : null,
                    );
                } else {
                    const baseClone = JSON.parse(
                        JSON.stringify(base),
                    ) as GeoJSON.FeatureCollection;
                    const working = await applyQuestionsToMapGeoData(
                        [qClone] as never,
                        baseClone,
                        false,
                    );
                    if (cancelled) return;
                    const area = normalizeFC(working);
                    if (!area) {
                        setOutcome(null);
                    } else {
                        let mask: GeoJSON.Feature | null = null;
                        try {
                            mask = holedMask(
                                working as never,
                            ) as GeoJSON.Feature | null;
                        } catch {
                            mask = null;
                        }
                        setOutcome({ mask, area, mode: "result" });
                    }
                }
            } catch {
                if (!cancelled) setFailed(true);
            } finally {
                if (!cancelled) setComputing(false);
            }
        })();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sig, base, cachedImage]);

    // Deferred MapLibre mount (skip if we already have the cached image).
    useEffect(() => {
        if (cachedImage) return;
        const t = window.setTimeout(() => setMountMap(true), 350);
        return () => window.clearTimeout(t);
    }, [cachedImage]);

    const fitToBbox = () => {
        const map = mapRef.current?.getMap();
        if (!map || !bbox) return;
        try {
            map.fitBounds(
                [
                    [bbox.minLng, bbox.minLat],
                    [bbox.maxLng, bbox.maxLat],
                ],
                { padding: 18, duration: 0, maxZoom: 13 },
            );
        } catch {
            /* not ready yet */
        }
    };

    useEffect(() => {
        fitToBbox();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [bbox, mountMap]);

    // Skeleton until BOTH geometry + tiles are ready; hard fallback so a
    // stuck tile fetch can't pin it forever.
    useEffect(() => {
        if (cachedImage || tilesReady) return;
        const t = window.setTimeout(() => setTilesReady(true), 4000);
        return () => window.clearTimeout(t);
    }, [tilesReady, cachedImage]);
    const loading = !cachedImage && (computing || !mountMap || !tilesReady);

    // Once the static view has settled, snapshot it to a PNG and cache it
    // (for the NEXT expand). We keep showing the live map this time — no
    // swap — so a blank/failed capture can never replace a good render.
    const trySnapshot = () => {
        if (captured.current || !cacheKey || computing) return;
        const map = mapRef.current?.getMap();
        if (!map) return;
        try {
            const url = map.getCanvas().toDataURL("image/png");
            if (url && url.length > 2048) {
                imageCache.set(cacheKey, url);
                captured.current = true;
            }
        } catch {
            /* GL toDataURL can throw — just skip caching */
        }
    };

    const mapStyle = useMemo(
        () => protomapsMapLibreStyle(darkTiles ? "dark" : "light"),
        [darkTiles],
    );

    const center = bbox
        ? {
              longitude: (bbox.minLng + bbox.maxLng) / 2,
              latitude: (bbox.minLat + bbox.maxLat) / 2,
          }
        : { longitude: 0, latitude: 0 };

    // Start the map already framed on the play area so there's no
    // visible fit-jump on first paint (the skeleton then lifts onto the
    // final, settled view). `fitToBbox` in onLoad fine-tunes the rest.
    const initialZoom = useMemo(() => {
        if (!bbox) return 9;
        const latSpan = Math.max(1e-4, bbox.maxLat - bbox.minLat);
        const lngSpan = Math.max(1e-4, bbox.maxLng - bbox.minLng);
        const span = Math.max(latSpan, lngSpan);
        const z = Math.log2(360 / span) - 0.8;
        return Math.max(2, Math.min(12, z));
    }, [bbox]);

    const containerCls = `${height} relative overflow-hidden rounded-lg border border-border pointer-events-none select-none`;

    if (!base) {
        return (
            <div
                className={`${containerCls} flex items-center justify-center bg-muted/40 text-[11px] text-muted-foreground`}
            >
                No play area to preview
            </div>
        );
    }

    if (cachedImage) {
        return (
            <div className={containerCls}>
                <img
                    src={cachedImage}
                    alt="Question outcome"
                    className="h-full w-full object-cover"
                    draggable={false}
                />
            </div>
        );
    }

    return (
        <div className={containerCls}>
            {mountMap && (
                <MapGL
                    ref={mapRef}
                    initialViewState={{ ...center, zoom: initialZoom }}
                    style={{ width: "100%", height: "100%" }}
                    mapStyle={mapStyle}
                    attributionControl={false}
                    interactive={false}
                    dragRotate={false}
                    pitchWithRotate={false}
                    touchPitch={false}
                    // Needed for the canvas snapshot (toDataURL) to return
                    // pixels rather than a blank buffer.
                    preserveDrawingBuffer
                    onLoad={(e) => {
                        installMissingImageHandler(e.target);
                        fitToBbox();
                    }}
                    onIdle={() => {
                        setTilesReady(true);
                        // Give the overlay layers a beat to paint, then cache.
                        window.setTimeout(trySnapshot, 200);
                    }}
                    onError={handleMapLibreError}
                >
                    {/* Resulting area: dim outside + a crisp white edge, AND
                        a translucent white fill INSIDE so the kept area
                        reads on dark tiles (dimming alone is invisible on
                        near-black). Consistent for every question type. */}
                    {outcome?.mode === "result" && outcome.mask && (
                        <Source
                            id="qom-mask"
                            type="geojson"
                            data={outcome.mask}
                        >
                            <Layer
                                id="qom-mask-fill"
                                type="fill"
                                paint={{
                                    "fill-color": "#000000",
                                    "fill-opacity": darkTiles ? 0.6 : 0.5,
                                }}
                            />
                        </Source>
                    )}

                    {outcome && (
                        <Source
                            id="qom-area"
                            type="geojson"
                            data={outcome.area}
                        >
                            <Layer
                                id="qom-area-fill"
                                type="fill"
                                paint={{
                                    "fill-color": "#ffffff",
                                    "fill-opacity":
                                        outcome.mode === "footprint"
                                            ? 0.06
                                            : darkTiles
                                              ? 0.16
                                              : 0.06,
                                }}
                            />
                            <Layer
                                id="qom-area-line"
                                type="line"
                                paint={{
                                    "line-color": "#ffffff",
                                    "line-width": 2,
                                    "line-opacity": 0.9,
                                    ...(outcome.mode === "footprint"
                                        ? { "line-dasharray": [3, 2] }
                                        : {}),
                                }}
                            />
                        </Source>
                    )}

                    {/* Canonical play-area boundary — same red stroke as
                        every other map. */}
                    <Source id="qom-boundary" type="geojson" data={base}>
                        <Layer
                            id="qom-boundary-line"
                            type="line"
                            paint={{
                                "line-color": PLAY_AREA_COLOR,
                                "line-width": PLAY_AREA_LINE_WIDTH,
                                "line-opacity": PLAY_AREA_LINE_OPACITY,
                            }}
                        />
                    </Source>
                </MapGL>
            )}

            {/* Loading skeleton — through the expand animation, geometry
                compute, and first tile paint. */}
            {loading && (
                <div className="absolute inset-0 animate-pulse bg-muted" />
            )}

            {!loading && (failed || !outcome) && (
                <div className="absolute inset-x-0 bottom-0 flex justify-center pb-1.5">
                    <span className="rounded-full bg-background/80 px-2 py-0.5 text-[10px] font-poppins text-muted-foreground backdrop-blur-sm">
                        {failed
                            ? "Couldn't render this outcome"
                            : "No resulting area"}
                    </span>
                </div>
            )}
        </div>
    );
}

export default QuestionOutcomeMap;
