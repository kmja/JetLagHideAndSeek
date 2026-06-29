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
 * (`applyQuestionsToMapGeoData`) but against a single question and a clone
 * of the play-area boundary, so the highlighted region matches precisely
 * what the seeker sees on the big map. For a still-unanswered (draft /
 * awaiting) question there's no answer to resolve yet, so we draw the
 * question's planning FOOTPRINT outline instead.
 *
 * Marking is CONSISTENT across every question type and matches the big
 * map: the play-area boundary is the canonical red stroke
 * (`PLAY_AREA_COLOR`), and the resulting area is shown by DIMMING
 * everything outside it (the same elimination-mask language the main map
 * uses) with a white edge — no per-category fill colour.
 *
 * Lazy by design — only rendered when a question card is expanded, and
 * `pointer-events-none` so it never steals touch/scroll from the drawer.
 */

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
    const isDraft = question.data.drag === true;

    type Outcome = {
        /** result-mode: the dark mask that dims everything OUTSIDE the
         *  resulting area; footprint-mode: null. */
        mask: GeoJSON.Feature | null;
        /** The resulting-area / footprint polygon, for the white edge. */
        area: GeoJSON.FeatureCollection;
        mode: "result" | "footprint";
    } | null;
    const [outcome, setOutcome] = useState<Outcome>(null);
    const [computing, setComputing] = useState(true);
    const [failed, setFailed] = useState(false);
    const [tilesReady, setTilesReady] = useState(false);

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

    useEffect(() => {
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
                        // Dim everything OUTSIDE the resulting area — the
                        // same elimination-mask treatment as the main map.
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
    }, [sig, base]);

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
    }, [bbox]);

    // Skeleton until BOTH the geometry is computed AND the tiles have
    // painted once. Hard fallback so a stuck tile fetch can't pin the
    // skeleton forever (e.g. the basemap host is unreachable).
    useEffect(() => {
        if (tilesReady) return;
        const t = window.setTimeout(() => setTilesReady(true), 4000);
        return () => window.clearTimeout(t);
    }, [tilesReady]);
    const loading = computing || !tilesReady;

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

    return (
        <div className={containerCls}>
            <MapGL
                ref={mapRef}
                initialViewState={{ ...center, zoom: 9 }}
                style={{ width: "100%", height: "100%" }}
                mapStyle={mapStyle}
                attributionControl={false}
                interactive={false}
                dragRotate={false}
                pitchWithRotate={false}
                touchPitch={false}
                onLoad={(e) => {
                    installMissingImageHandler(e.target);
                    fitToBbox();
                }}
                onIdle={() => setTilesReady(true)}
                onError={handleMapLibreError}
            >
                {/* Resulting area: dim everything outside it (the main
                    map's elimination-mask language) + a crisp white edge.
                    Consistent for every question type — no category fill. */}
                {outcome?.mode === "result" && outcome.mask && (
                    <Source id="qom-mask" type="geojson" data={outcome.mask}>
                        <Layer
                            id="qom-mask-fill"
                            type="fill"
                            paint={{
                                "fill-color": "#000000",
                                "fill-opacity": 0.55,
                            }}
                        />
                    </Source>
                )}

                {outcome && (
                    <Source id="qom-area" type="geojson" data={outcome.area}>
                        {outcome.mode === "footprint" && (
                            <Layer
                                id="qom-area-fill"
                                type="fill"
                                paint={{
                                    "fill-color": "#ffffff",
                                    "fill-opacity": 0.06,
                                }}
                            />
                        )}
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

                {/* Canonical play-area boundary — same red stroke as every
                    other map (wizard / lobby / seeker / hider). */}
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

            {/* Loading skeleton — covers the map until geometry + tiles
                are ready, so the answer region never pops in abruptly. */}
            {loading && (
                <div className="absolute inset-0 animate-pulse bg-muted" />
            )}

            {/* Settled empty/failure states (only once loading is done). */}
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
