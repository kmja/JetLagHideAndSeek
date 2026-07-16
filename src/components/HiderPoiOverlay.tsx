import { useStore } from "@nanostores/react";
import type { Feature, FeatureCollection, Point } from "geojson";
import type { MapGeoJSONFeature } from "maplibre-gl";
import { useEffect, useState } from "react";
import { Layer, Source, useMap } from "react-map-gl/maplibre";

import { hiderPoiColor, hiderPoiHighlightKinds } from "@/lib/hiderPois";
import { fadePaint } from "@/lib/mapPaint";

/**
 * Hider POI HIGHLIGHT overlay (v894). The general in-zone POI field renders
 * via the basemap's native `pois` layer (see `HiderBackgroundMap` /
 * `keepPois`); THIS overlay draws bold group-coloured DOTS + labels only for
 * the kinds the hider has toggled on in the map drawer
 * (`hiderPoiHighlightKinds`) — so "where are all the supermarkets" pops over
 * the native field. Read straight from the pmtiles `pois` source-layer
 * (Overpass-free), viewport-scoped, recomputed on map idle.
 *
 * Purely informational — no hit layer, so it never blocks tapping a hiding
 * zone behind it.
 */

const PROTOMAPS_SOURCE_ID = "protomaps";
const POIS_SOURCE_LAYER = "pois";

const EMPTY_FC: FeatureCollection<Point> = {
    type: "FeatureCollection",
    features: [],
};

export function HiderPoiOverlay({ darkBasemap }: { darkBasemap: boolean }) {
    const { current: mapRef } = useMap();
    const $highlight = useStore(hiderPoiHighlightKinds);
    const [fc, setFc] = useState<FeatureCollection<Point>>(EMPTY_FC);

    const activeKey = [...$highlight].sort().join(",");

    useEffect(() => {
        const map = mapRef?.getMap();
        if (!map) return;

        const allowed = new Set($highlight);
        if (allowed.size === 0) {
            setFc(EMPTY_FC);
            return;
        }

        const recompute = () => {
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
                if (!kind || !allowed.has(kind)) continue;
                if (f.geometry?.type !== "Point") continue;
                const [lng, lat] = (f.geometry as Point).coordinates;
                if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
                const key = `${kind}:${lng.toFixed(5)}:${lat.toFixed(5)}`;
                if (seen.has(key)) continue;
                seen.add(key);
                const name = (f.properties?.name as string | undefined) ?? "";
                features.push({
                    type: "Feature",
                    properties: { kind, name, color: hiderPoiColor(kind) },
                    geometry: { type: "Point", coordinates: [lng, lat] },
                });
            }
            setFc({ type: "FeatureCollection", features });
        };

        recompute();
        map.on("idle", recompute);
        return () => {
            map.off("idle", recompute);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeKey, mapRef]);

    if (fc.features.length === 0) return null;

    return (
        <Source id="hider-pois" type="geojson" data={fc}>
            {/* Soft halo ring so the highlighted dots read over the native
                POI field. */}
            <Layer
                id="hider-pois-ring"
                type="circle"
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
                    "circle-opacity": 0.2,
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
                        4.5,
                        16,
                        6.5,
                        19,
                        8.5,
                    ],
                    "circle-color": ["get", "color"],
                    "circle-stroke-width": 1.5,
                    "circle-stroke-color": darkBasemap
                        ? "rgba(0,0,0,0.55)"
                        : "rgba(255,255,255,0.95)",
                    "circle-opacity": 0.98,
                })}
            />
            <Layer
                id="hider-pois-labels"
                type="symbol"
                minzoom={14}
                layout={{
                    "text-field": ["get", "name"],
                    "text-font": ["Noto Sans Regular"],
                    "text-size": 12,
                    "text-offset": [0, 1.2],
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
