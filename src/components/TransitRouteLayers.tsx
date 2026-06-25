import { Layer, Source } from "react-map-gl/maplibre";

import { FadeOverlay } from "@/components/FadeOverlay";
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
 *
 * Each mode fades in / out (via `FadeOverlay`) when its overlay is
 * toggled, instead of popping — the per-mode FC going null IS the
 * toggle, so `data` presence drives the fade.
 */
const LINE_OPACITY = 0.8;
const FADE_MS = 280;

function FadingTransitLine({
    id,
    data,
    color,
    dash,
}: {
    id: string;
    data: GeoJSON.FeatureCollection | null | undefined;
    color: string;
    dash?: [number, number];
}) {
    return (
        <FadeOverlay active data={data} durationMs={FADE_MS}>
            {(fc, shown) => (
                <Source id={id} type="geojson" data={fc}>
                    <Layer
                        id={`${id}-line`}
                        type="line"
                        paint={{
                            "line-color": color,
                            "line-width": 2,
                            "line-opacity": shown ? LINE_OPACITY : 0,
                            "line-opacity-transition": { duration: FADE_MS },
                            ...(dash ? { "line-dasharray": dash } : {}),
                        }}
                    />
                </Source>
            )}
        </FadeOverlay>
    );
}

export function TransitRouteLayers({ transitFC }: { transitFC: TransitFC }) {
    return (
        <>
            <FadingTransitLine
                id="transit-subway"
                data={transitFC.subway}
                color="hsl(280, 60%, 60%)"
            />
            <FadingTransitLine
                id="transit-bus"
                data={transitFC.bus}
                color="hsl(35, 90%, 55%)"
            />
            <FadingTransitLine
                id="transit-ferry"
                data={transitFC.ferry}
                color="hsl(200, 85%, 55%)"
                dash={[4, 4]}
            />
            <FadingTransitLine
                id="transit-train"
                data={transitFC.train}
                color="hsl(140, 55%, 45%)"
            />
            <FadingTransitLine
                id="transit-tram"
                data={transitFC.tram}
                color="hsl(330, 75%, 60%)"
            />
        </>
    );
}

export default TransitRouteLayers;
