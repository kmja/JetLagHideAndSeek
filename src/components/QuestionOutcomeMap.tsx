import "maplibre-gl/dist/maplibre-gl.css";

import { useStore } from "@nanostores/react";
import * as turf from "@turf/turf";
import { useEffect, useMemo, useRef, useState } from "react";
import MapGL, { Layer, type MapRef, Source } from "react-map-gl/maplibre";

import { CATEGORIES, type CategoryId } from "@/lib/categories";
import { mapGeoJSON, polyGeoJSON } from "@/lib/context";
import {
    handleMapLibreError,
    installMissingImageHandler,
    protomapsMapLibreStyle,
} from "@/lib/protomapsStyle";
import { resolvedTheme } from "@/lib/theme";
import { applyQuestionsToMapGeoData, determinePlanningPolygon } from "@/maps";
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
 * question's planning FOOTPRINT outline instead (what it'll constrain once
 * answered).
 *
 * Lazy by design — only rendered when a question card is expanded. The
 * answered spatial types (matching / measuring / tentacles) read their
 * reference POIs from the already-warmed play-area cache, so no fresh
 * Overpass round-trip happens on the happy path; the engine's own
 * try/catch degrades to "show the whole play area" on any failure.
 */

/** Coerce whatever the engine returns into a FeatureCollection. */
function normalizeFC(
    value: unknown,
): GeoJSON.FeatureCollection | null {
    if (!value || typeof value !== "object" || !("type" in value)) return null;
    const v = value as GeoJSON.GeoJSON;
    if (v.type === "FeatureCollection") return v;
    if (v.type === "Feature") {
        return { type: "FeatureCollection", features: [v] };
    }
    // A bare geometry.
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

    const cat = CATEGORIES[question.id as CategoryId] ?? CATEGORIES.matching;
    const isDraft = question.data.drag === true;

    type Outcome = {
        fc: GeoJSON.FeatureCollection;
        mode: "result" | "footprint";
    } | null;
    const [outcome, setOutcome] = useState<Outcome>(null);
    const [computing, setComputing] = useState(true);
    const [failed, setFailed] = useState(false);

    // Elimination-relevant signature so we recompute only on a real change.
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
                // Clone so the engine's in-place tweaks can't touch the
                // live store. The question clone keeps the real answer
                // fields; only `drag` matters to the engine's skip logic.
                const qClone = {
                    id: question.id,
                    key: question.key,
                    data: { ...(question.data as Record<string, unknown>) },
                } as unknown as Question;

                if (isDraft) {
                    const poly = await determinePlanningPolygon(qClone, true);
                    if (cancelled) return;
                    const fc = poly ? normalizeFC(poly) : null;
                    setOutcome(fc ? { fc, mode: "footprint" } : null);
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
                    const fc = normalizeFC(working);
                    setOutcome(fc ? { fc, mode: "result" } : null);
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

    // Re-fit when the framing changes (new question / boundary).
    useEffect(() => {
        fitToBbox();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [bbox]);

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

    if (!base) {
        return (
            <div
                className={`${height} flex items-center justify-center rounded-lg bg-muted/40 text-[11px] text-muted-foreground`}
            >
                No play area to preview
            </div>
        );
    }

    return (
        <div
            className={`${height} relative overflow-hidden rounded-lg border border-border`}
        >
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
                onError={handleMapLibreError}
            >
                {/* Faint full play-area outline for context. */}
                <Source id="qom-base" type="geojson" data={base}>
                    <Layer
                        id="qom-base-line"
                        type="line"
                        paint={{
                            "line-color": darkTiles ? "#94a3b8" : "#475569",
                            "line-width": 1,
                            "line-opacity": 0.5,
                            "line-dasharray": [2, 2],
                        }}
                    />
                </Source>

                {outcome && outcome.mode === "result" && (
                    <Source id="qom-result" type="geojson" data={outcome.fc}>
                        <Layer
                            id="qom-result-fill"
                            type="fill"
                            paint={{
                                "fill-color": cat.color,
                                "fill-opacity": 0.3,
                            }}
                        />
                        <Layer
                            id="qom-result-line"
                            type="line"
                            paint={{
                                "line-color": cat.color,
                                "line-width": 2,
                                "line-opacity": 0.9,
                            }}
                        />
                    </Source>
                )}

                {outcome && outcome.mode === "footprint" && (
                    <Source id="qom-foot" type="geojson" data={outcome.fc}>
                        <Layer
                            id="qom-foot-fill"
                            type="fill"
                            paint={{
                                "fill-color": cat.color,
                                "fill-opacity": 0.08,
                            }}
                        />
                        <Layer
                            id="qom-foot-line"
                            type="line"
                            paint={{
                                "line-color": cat.color,
                                "line-width": 2,
                                "line-opacity": 0.85,
                                "line-dasharray": [3, 2],
                            }}
                        />
                    </Source>
                )}
            </MapGL>

            {/* Status veil — computing / failed / nothing-to-show. */}
            {(computing || failed || (!outcome && !computing)) && (
                <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center pb-1.5">
                    <span className="rounded-full bg-background/80 px-2 py-0.5 text-[10px] font-poppins text-muted-foreground backdrop-blur-sm">
                        {computing
                            ? "Computing outcome…"
                            : failed
                              ? "Couldn't render this outcome"
                              : question.id === "photo"
                                ? "Photo questions don't narrow the map"
                                : "No resulting area"}
                    </span>
                </div>
            )}
        </div>
    );
}

export default QuestionOutcomeMap;
