import { useStore } from "@nanostores/react";
import { Layer, Source } from "react-map-gl/maplibre";

import { FadeOverlay } from "@/components/FadeOverlay";
import { tripRouteFC } from "@/lib/journey/state";

/**
 * Renders the active planned trip's route + steps on the map (shared by
 * the seeker `Map` and hider `HiderBackgroundMap`). Reads the
 * `tripRouteFC` shadow atom, written by whichever trip planner is
 * active. Fades in / out with the rest of the overlays.
 *
 * Layers (bottom → top):
 *   - a casing line (dark, wide) under every leg for contrast,
 *   - the coloured per-leg line (walking legs dashed),
 *   - step dots (start green, transfers white, destination red),
 *   - step labels (the line to board + its departure time).
 */
const FADE_MS = 280;

export function TripRouteLayers() {
    const fc = useStore(tripRouteFC);
    return (
        <FadeOverlay
            active={Boolean(fc && fc.features.length > 0)}
            data={fc && fc.features.length > 0 ? fc : null}
            durationMs={FADE_MS}
        >
            {(data, shown) => (
                <Source id="trip-route" type="geojson" data={data}>
                    {/* Casing under the legs for contrast on any basemap. */}
                    <Layer
                        id="trip-route-casing"
                        type="line"
                        filter={["==", ["get", "kind"], "leg"]}
                        layout={{
                            "line-cap": "round",
                            "line-join": "round",
                        }}
                        paint={{
                            "line-color": "rgba(0,0,0,0.55)",
                            "line-width": 6,
                            "line-opacity": shown ? 0.9 : 0,
                            "line-opacity-transition": { duration: FADE_MS },
                        }}
                    />
                    {/* Coloured leg line — solid for transit. */}
                    <Layer
                        id="trip-route-line"
                        type="line"
                        filter={[
                            "all",
                            ["==", ["get", "kind"], "leg"],
                            ["!=", ["get", "walk"], true],
                        ]}
                        layout={{
                            "line-cap": "round",
                            "line-join": "round",
                        }}
                        paint={{
                            "line-color": ["get", "color"],
                            "line-width": 3.5,
                            "line-opacity": shown ? 1 : 0,
                            "line-opacity-transition": { duration: FADE_MS },
                        }}
                    />
                    {/* Walking legs — dashed. */}
                    <Layer
                        id="trip-route-walk"
                        type="line"
                        filter={[
                            "all",
                            ["==", ["get", "kind"], "leg"],
                            ["==", ["get", "walk"], true],
                        ]}
                        layout={{ "line-cap": "round", "line-join": "round" }}
                        paint={{
                            "line-color": ["get", "color"],
                            "line-width": 3,
                            "line-dasharray": [1.5, 1.5],
                            "line-opacity": shown ? 1 : 0,
                            "line-opacity-transition": { duration: FADE_MS },
                        }}
                    />
                    {/* Step dots. */}
                    <Layer
                        id="trip-route-stops"
                        type="circle"
                        filter={["==", ["get", "kind"], "stop"]}
                        paint={{
                            "circle-radius": [
                                "case",
                                ["==", ["get", "role"], "stop"],
                                4,
                                6,
                            ],
                            "circle-color": [
                                "match",
                                ["get", "role"],
                                "start",
                                "hsl(142, 70%, 45%)",
                                "end",
                                "hsl(0, 75%, 55%)",
                                "#ffffff",
                            ],
                            "circle-stroke-color": "rgba(0,0,0,0.7)",
                            "circle-stroke-width": 1.5,
                            "circle-opacity": shown ? 1 : 0,
                            "circle-stroke-opacity": shown ? 1 : 0,
                            "circle-opacity-transition": { duration: FADE_MS },
                            "circle-stroke-opacity-transition": {
                                duration: FADE_MS,
                            },
                        }}
                    />
                    {/* Step labels — the line to board + its departure. */}
                    <Layer
                        id="trip-route-labels"
                        type="symbol"
                        filter={["==", ["get", "kind"], "stop"]}
                        layout={{
                            "text-field": ["get", "label"],
                            "text-size": 11,
                            "text-font": ["Open Sans Regular"],
                            "text-anchor": "left",
                            "text-offset": [0.8, 0],
                            "text-allow-overlap": false,
                            "text-optional": true,
                        }}
                        paint={{
                            "text-color": "white",
                            "text-halo-color": "rgba(0,0,0,0.85)",
                            "text-halo-width": 1.5,
                            "text-opacity": shown ? 1 : 0,
                            "text-opacity-transition": { duration: FADE_MS },
                        }}
                    />
                </Source>
            )}
        </FadeOverlay>
    );
}

export default TripRouteLayers;
