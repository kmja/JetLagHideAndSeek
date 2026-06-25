import { Layer, Source } from "react-map-gl/maplibre";

import type { TransitFC } from "@/hooks/useTransitRouteOverlays";

/**
 * Shared transit-route line overlays, rendered as MapLibre Source/Layer
 * pairs. Used inside BOTH the seeker (`Map`) and hider
 * (`HiderBackgroundMap`) `<Map>` trees so the colours + behaviour stay
 * identical across the two map paths.
 *
 * One canonical colour per mode (subway purple, bus orange, ferry blue
 * dashed, train green, tram pink) so a tram doesn't collide with subway
 * purple in cities that have both. Pass the per-mode FeatureCollections
 * from `useTransitRouteOverlays`.
 */
export function TransitRouteLayers({ transitFC }: { transitFC: TransitFC }) {
    return (
        <>
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
                <Source id="transit-bus" type="geojson" data={transitFC.bus}>
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
                <Source id="transit-tram" type="geojson" data={transitFC.tram}>
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
        </>
    );
}

export default TransitRouteLayers;
