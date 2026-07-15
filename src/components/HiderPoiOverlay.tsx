import { useStore } from "@nanostores/react";
import type { Feature, FeatureCollection, Point } from "geojson";
import type { MapGeoJSONFeature } from "maplibre-gl";
import { useEffect, useState } from "react";
import { Layer, Source, useMap } from "react-map-gl/maplibre";

import { hidingZone } from "@/lib/hiderRole";
import {
    hiderPoiAlwaysShown,
    hiderPoiColor,
    hiderPoiHighlightKind,
    hiderPoiShow,
} from "@/lib/hiderPois";
import { fadePaint } from "@/lib/mapPaint";

/**
 * Hider "points of interest" overlay. Reads the `pois` source-layer that
 * lives INSIDE the basemap pmtiles (we drop it from the rendered style but
 * the tile data is still there) via `map.querySourceFeatures`, so it's
 * ENTIRELY Overpass-free — for a starred city it reads the offline tile
 * pack.
 *
 * Behaviour (v888): once the hider commits a zone, the useful POI field is
 * shown AUTOMATICALLY, clipped to that zone's radius. The map drawer's
 * search HIGHLIGHTS one kind (e.g. supermarkets) — matching POIs pop with
 * a ring + label while the rest of the field dims, so the hider can see
 * "where are all the X in my zone" at a glance. A highlighted kind is
 * drawn even if it's outside the always-on field (e.g. transit stops).
 *
 * Purely informational — the dots aren't tappable (no hit layer), so they
 * never interfere with tapping a hiding-zone station behind them.
 */

const PROTOMAPS_SOURCE_ID = "protomaps";
const POIS_SOURCE_LAYER = "pois";

const EMPTY_FC: FeatureCollection<Point> = {
    type: "FeatureCollection",
    features: [],
};

/** Metres between two lng/lat points (haversine). */
function metersBetween(
    aLng: number,
    aLat: number,
    bLng: number,
    bLat: number,
): number {
    const R = 6371000;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(bLat - aLat);
    const dLng = toRad(bLng - aLng);
    const s =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(aLat)) *
            Math.cos(toRad(bLat)) *
            Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function HiderPoiOverlay({ darkBasemap }: { darkBasemap: boolean }) {
    const { current: mapRef } = useMap();
    const $show = useStore(hiderPoiShow);
    const $highlight = useStore(hiderPoiHighlightKind);
    const $zone = useStore(hidingZone);
    const [fc, setFc] = useState<FeatureCollection<Point>>(EMPTY_FC);

    // POIs are clipped to the committed zone circle.
    const zoneLng = $zone?.stationLng ?? null;
    const zoneLat = $zone?.stationLat ?? null;
    const zoneRadius = $zone?.radiusMeters ?? 0;
    const active = $show && zoneLng != null && zoneLat != null;

    useEffect(() => {
        const map = mapRef?.getMap();
        if (!map || !active || zoneLng == null || zoneLat == null) {
            setFc(EMPTY_FC);
            return;
        }

        const recompute = () => {
            // The vector source is absent on a raster basemap
            // (Thunderforest) — nothing to draw then.
            if (!map.getSource(PROTOMAPS_SOURCE_ID)) {
                setFc(EMPTY_FC);
                return;
            }
            let raw: MapGeoJSONFeature[] = [];
            try {
                raw = map.querySourceFeatures(PROTOMAPS_SOURCE_ID, {
                    sourceLayer: POIS_SOURCE_LAYER,
                });
            } catch {
                setFc(EMPTY_FC);
                return;
            }
            const seen = new Set<string>();
            const features: Feature<Point>[] = [];
            for (const f of raw) {
                const kind = f.properties?.kind as string | undefined;
                if (!kind) continue;
                const isHi = kind === $highlight;
                // Base field = the always-on groups; a highlighted kind is
                // always included even if it isn't in that field.
                if (!isHi && !hiderPoiAlwaysShown(kind)) continue;
                if (f.geometry?.type !== "Point") continue;
                const [lng, lat] = (f.geometry as Point).coordinates;
                if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
                // Clip to the committed zone circle (+ a small margin so a
                // POI right on the edge still shows).
                if (
                    metersBetween(zoneLng, zoneLat, lng, lat) >
                    zoneRadius + 50
                )
                    continue;
                const key = `${kind}:${lng.toFixed(5)}:${lat.toFixed(5)}`;
                if (seen.has(key)) continue;
                seen.add(key);
                const name = (f.properties?.name as string | undefined) ?? "";
                features.push({
                    type: "Feature",
                    properties: {
                        kind,
                        name,
                        color: hiderPoiColor(kind),
                        hi: isHi ? 1 : 0,
                    },
                    geometry: { type: "Point", coordinates: [lng, lat] },
                });
            }
            setFc({ type: "FeatureCollection", features });
        };

        recompute();
        // `idle` fires after pan/zoom settles and after new tiles parse, so
        // the overlay tracks the viewport without a per-frame recompute.
        map.on("idle", recompute);
        return () => {
            map.off("idle", recompute);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active, zoneLng, zoneLat, zoneRadius, $highlight, mapRef]);

    if (fc.features.length === 0) return null;

    // When a highlight is active, dim the non-matching field so the
    // highlighted kind reads at a glance.
    const highlighting = $highlight !== "";
    const baseOpacity = highlighting ? 0.28 : 0.95;

    return (
        <Source id="hider-pois" type="geojson" data={fc}>
            {/* Highlight ring under the matching dots. */}
            <Layer
                id="hider-pois-ring"
                type="circle"
                filter={["==", ["get", "hi"], 1]}
                paint={fadePaint({
                    "circle-radius": [
                        "interpolate",
                        ["linear"],
                        ["zoom"],
                        12,
                        8,
                        16,
                        13,
                        19,
                        18,
                    ],
                    "circle-color": ["get", "color"],
                    "circle-opacity": 0.22,
                    "circle-stroke-width": 2,
                    "circle-stroke-color": ["get", "color"],
                    "circle-stroke-opacity": 0.9,
                })}
            />
            <Layer
                id="hider-pois-dots"
                type="circle"
                paint={fadePaint({
                    "circle-radius": [
                        "interpolate",
                        ["linear"],
                        ["zoom"],
                        12,
                        ["case", ["==", ["get", "hi"], 1], 4.5, 3],
                        16,
                        ["case", ["==", ["get", "hi"], 1], 6.5, 5],
                        19,
                        ["case", ["==", ["get", "hi"], 1], 8.5, 7],
                    ],
                    "circle-color": ["get", "color"],
                    "circle-stroke-width": 1.5,
                    "circle-stroke-color": darkBasemap
                        ? "rgba(0,0,0,0.55)"
                        : "rgba(255,255,255,0.9)",
                    "circle-opacity": [
                        "case",
                        ["==", ["get", "hi"], 1],
                        0.98,
                        baseOpacity,
                    ],
                })}
            />
            <Layer
                id="hider-pois-labels"
                type="symbol"
                minzoom={15}
                filter={
                    // While highlighting, ONLY the matching POIs get labels
                    // (keeps the popped set legible); otherwise everything
                    // labels at zoom.
                    highlighting ? ["==", ["get", "hi"], 1] : ["!=", ["get", "name"], ""]
                }
                layout={{
                    "text-field": ["get", "name"],
                    "text-font": ["Noto Sans Regular"],
                    "text-size": ["case", ["==", ["get", "hi"], 1], 12, 11],
                    "text-offset": [0, 1.1],
                    "text-anchor": "top",
                    "text-max-width": 8,
                    "text-optional": true,
                    "text-allow-overlap": false,
                }}
                paint={{
                    "text-color": darkBasemap ? "#f5f5f5" : "#1f2937",
                    "text-halo-color": darkBasemap
                        ? "rgba(0,0,0,0.85)"
                        : "rgba(255,255,255,0.95)",
                    "text-halo-width": 1.4,
                }}
            />
        </Source>
    );
}

export default HiderPoiOverlay;
