import { useStore } from "@nanostores/react";
import type { Feature, FeatureCollection, Point } from "geojson";
import type { MapGeoJSONFeature } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { Layer, Source, useMap } from "react-map-gl/maplibre";

import { hidingZone } from "@/lib/hiderRole";
import { hiderPoiColor, hiderPoiHighlightKinds } from "@/lib/hiderPois";
import { fadePaint } from "@/lib/mapPaint";

/**
 * Hider POI HIGHLIGHT overlay (v894, reworked v946). The general in-zone POI
 * field renders via the basemap's native `pois` layer (see
 * `HiderBackgroundMap` / `keepPois`); THIS overlay draws bold group-coloured
 * DOTS + labels only for the kinds the hider has toggled on in the map drawer
 * (`hiderPoiHighlightKinds`) — so "where are all the supermarkets" pops.
 *
 * v946 — no more BLINKING. The old version replaced the whole feature set on
 * every map `idle` from `querySourceFeatures`, which only returns features in
 * the CURRENTLY-RENDERED tiles — so panning/zooming made highlighted POIs
 * flicker in and out. Now the found POIs are ACCUMULATED (union, deduped) and
 * CLIPPED TO THE COMMITTED HIDING ZONE, so once a POI in the zone is seen it
 * stays drawn — persistent like every other toggled overlay. The zone is tiny
 * (a ~500 m radius), so a single pass over it captures them all; the
 * accumulator resets when the highlight set or the zone changes.
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

/** Metres between two lat/lng points (haversine). */
function haversineMeters(
    aLat: number,
    aLng: number,
    bLat: number,
    bLng: number,
): number {
    const R = 6371000;
    const dLat = ((bLat - aLat) * Math.PI) / 180;
    const dLng = ((bLng - aLng) * Math.PI) / 180;
    const s =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((aLat * Math.PI) / 180) *
            Math.cos((bLat * Math.PI) / 180) *
            Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function HiderPoiOverlay({ darkBasemap }: { darkBasemap: boolean }) {
    const { current: mapRef } = useMap();
    const $highlight = useStore(hiderPoiHighlightKinds);
    const $zone = useStore(hidingZone);
    const [fc, setFc] = useState<FeatureCollection<Point>>(EMPTY_FC);
    // Persistent accumulator (key → feature) so a POI seen once stays drawn
    // even after it scrolls out of the rendered tiles. Reset on key change.
    const acc = useRef<Map<string, Feature<Point>>>(new Map());

    const activeKey = [...$highlight].sort().join(",");
    // Clip envelope: the committed zone centre + radius (+ a small margin), or
    // null when no zone is committed yet (then accumulate everything seen).
    const zoneKey = $zone
        ? `${$zone.stationLat},${$zone.stationLng},${$zone.radiusMeters}`
        : "none";

    useEffect(() => {
        const map = mapRef?.getMap();
        if (!map) return;

        const allowed = new Set($highlight);
        // Fresh accumulator for this (highlight, zone) combination.
        acc.current = new Map();
        setFc(EMPTY_FC);
        if (allowed.size === 0) return;

        const inZone = (lat: number, lng: number): boolean => {
            if (!$zone) return true; // no zone yet → keep everything seen
            return (
                haversineMeters(
                    $zone.stationLat,
                    $zone.stationLng,
                    lat,
                    lng,
                ) <=
                $zone.radiusMeters + 50
            );
        };

        const recompute = () => {
            if (!map.getSource(PROTOMAPS_SOURCE_ID)) return;
            let raw: MapGeoJSONFeature[] = [];
            try {
                raw = map.querySourceFeatures(PROTOMAPS_SOURCE_ID, {
                    sourceLayer: POIS_SOURCE_LAYER,
                });
            } catch {
                return;
            }
            let added = false;
            for (const f of raw) {
                const kind = f.properties?.kind as string | undefined;
                if (!kind || !allowed.has(kind)) continue;
                if (f.geometry?.type !== "Point") continue;
                const [lng, lat] = (f.geometry as Point).coordinates;
                if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
                if (!inZone(lat, lng)) continue;
                const key = `${kind}:${lng.toFixed(5)}:${lat.toFixed(5)}`;
                if (acc.current.has(key)) continue;
                const name = (f.properties?.name as string | undefined) ?? "";
                acc.current.set(key, {
                    type: "Feature",
                    properties: { kind, name, color: hiderPoiColor(kind) },
                    geometry: { type: "Point", coordinates: [lng, lat] },
                });
                added = true;
            }
            // Only re-render when the union actually grew (never SHRINKS on a
            // pan away — that was the blink).
            if (added) {
                setFc({
                    type: "FeatureCollection",
                    features: [...acc.current.values()],
                });
            }
        };

        recompute();
        map.on("idle", recompute);
        return () => {
            map.off("idle", recompute);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeKey, zoneKey, mapRef]);

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
                        10,
                        6,
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
                        10,
                        3.5,
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
                minzoom={12}
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
