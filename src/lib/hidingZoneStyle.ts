/**
 * Shared MapLibre paint/geometry producers for the candidate-hiding-zone
 * overlay and the selected-zone highlight — the ONE source for the seeker map
 * (`hiding-zones-*` / `selected-zone-*`) AND the hider map (`hider-reach-*` /
 * `hider-selected-zone-*`).
 *
 * v1121: these two overlays were hand-kept "byte-for-byte identical" across the
 * two map components (see the v643/v833/v1064 notes), which is exactly the
 * seeker/hider drift class we've been unifying — and they had already drifted:
 * the hider's candidate-fill was a 2-way basemap check while the seeker's is a
 * 3-way theme-aware one (so a light-theme hider got a red wash where the seeker
 * got a neutral grey), and the hider's label colour was the jetlag navy
 * `#1F2F3F` where the seeker's is the slate `#1f2937`. Both now derive from the
 * seeker's (canonical, v622) values here.
 *
 * These are PAINT/DATA producers, not JSX — the two maps keep their own
 * `<Layer>` elements with their existing ids (the seeker's point layer is
 * `hiding-zones-points`, the hider's `hider-reach-dots`, and tap resolvers key
 * off those ids), so parameterising the values (not the layers) fixes the drift
 * without touching the tap plumbing.
 */
import * as turf from "@turf/turf";

import { fadePaint } from "@/lib/mapPaint";

/** Zoom-scaled candidate-station dot radius (shared by both maps). */
const CANDIDATE_DOT_RADIUS = [
    "interpolate",
    ["linear"],
    ["zoom"],
    8,
    1.5,
    13,
    2.8,
    16,
    4,
];

const FADE_MS = 280;

/**
 * Map-label contrast (v622). Station-name / arrival labels sit ON the basemap,
 * so they follow the BASEMAP's brightness, not the UI theme: white-on-dark over
 * satellite / dark Protomaps, dark text + light halo on the light basemap.
 */
export function mapLabelColors(darkBasemap: boolean): {
    color: string;
    halo: string;
} {
    return {
        color: darkBasemap ? "#ffffff" : "#1f2937",
        halo: darkBasemap ? "rgba(0,0,0,0.85)" : "rgba(255,255,255,0.9)",
    };
}

/**
 * The faint unioned-extent fill for the candidate-zone overlay.
 * - Light basemap: a NEUTRAL grey wash (the red tint read as too prominent).
 * - Dark theme: a brightening near-white wash that lights the circles up.
 * - Satellite (light theme + satellite on): a faint red tint.
 */
export function candidateZoneFillPaint({
    darkBasemap,
    theme,
    shown,
}: {
    darkBasemap: boolean;
    theme: "light" | "dark";
    shown: boolean;
}) {
    return fadePaint({
        "fill-color": !darkBasemap
            ? "hsl(0, 0%, 42%)"
            : theme === "dark"
              ? "#f5e7e3"
              : "hsl(2, 70%, 54%)",
        "fill-opacity": shown
            ? !darkBasemap
                ? 0.15
                : theme === "dark"
                  ? 0.16
                  : 0.08
            : 0,
        "fill-opacity-transition": { duration: FADE_MS },
    });
}

/**
 * The (currently invisible) extent envelope line. v783 removed the red dashed
 * border on every basemap — kept as a layer so the geometry stays styleable.
 */
export function candidateZoneLinePaint() {
    return fadePaint({
        "line-color": "hsl(2, 70%, 54%)",
        "line-width": 1.5,
        "line-opacity": 0,
        "line-opacity-transition": { duration: FADE_MS },
        "line-dasharray": [6, 5],
    });
}

/** Zoom-scaled station dots — grey on dark/satellite, dark-grey on light. */
export function candidateZoneDotPaint({
    darkBasemap,
    shown,
}: {
    darkBasemap: boolean;
    shown: boolean;
}) {
    return fadePaint({
        "circle-radius": CANDIDATE_DOT_RADIUS,
        "circle-color": darkBasemap ? "hsl(0, 0%, 80%)" : "hsl(0, 0%, 20%)",
        "circle-stroke-width": 0,
        "circle-opacity": shown ? 1 : 0,
        "circle-stroke-opacity": shown ? 1 : 0,
        "circle-opacity-transition": { duration: FADE_MS },
        "circle-stroke-opacity-transition": { duration: FADE_MS },
    });
}

/** Invisible larger hit target on each station point (tap opens the card). */
export const CANDIDATE_ZONE_HIT_PAINT = {
    "circle-radius": 16,
    "circle-color": "#000000",
    "circle-opacity": 0,
} as const;

/** Station-name label layout (identical on both maps). */
export const CANDIDATE_ZONE_LABEL_LAYOUT = {
    // v835: prefer the shortened label (abbreviated + truncated) the overlay
    // ships as `shortName`, fall back to the full name.
    "text-field": ["coalesce", ["get", "shortName"], ["get", "name"], ""],
    "text-size": 11,
    // Must be a fontstack the glyph proxy serves (Protomaps = Noto Sans);
    // "Open Sans" 404s → no text.
    "text-font": ["Noto Sans Regular"],
    "text-anchor": "top",
    "text-offset": [0, 0.7],
    "text-allow-overlap": false,
    "text-optional": true,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

/** Station-name label paint — follows the basemap brightness. */
export function candidateZoneLabelPaint({
    darkBasemap,
    shown,
}: {
    darkBasemap: boolean;
    shown: boolean;
}) {
    const { color, halo } = mapLabelColors(darkBasemap);
    return fadePaint({
        "text-color": color,
        "text-halo-color": halo,
        "text-halo-width": 1.4,
        "text-opacity": shown ? 1 : 0,
        "text-opacity-transition": { duration: FADE_MS },
    });
}

/**
 * The FeatureCollection for the selected-zone highlight — the tapped station's
 * hiding-radius circle + its centre dot (the layers filter by geometry-type).
 * Returns null on any degenerate input.
 */
export function buildSelectedZoneFC(
    lat: number,
    lng: number,
    radius: number,
    units: turf.Units,
): GeoJSON.FeatureCollection | null {
    try {
        const circle = turf.circle([lng, lat], radius, { steps: 128, units });
        const dot = turf.point([lng, lat]);
        return turf.featureCollection([
            circle,
            dot,
        ] as never) as GeoJSON.FeatureCollection;
    } catch {
        return null;
    }
}

/** Selected-zone highlight paints — a prominent white ring + fill + dot. */
export const SELECTED_ZONE_FILL_PAINT = {
    "fill-color": "#ffffff",
    "fill-opacity": 0.16,
} as const;

export const SELECTED_ZONE_LINE_PAINT = {
    "line-color": "#ffffff",
    "line-width": 3,
} as const;

export const SELECTED_ZONE_DOT_PAINT = {
    "circle-radius": 7,
    "circle-color": "#ffffff",
    "circle-stroke-color": "#1F2F3F",
    "circle-stroke-width": 2.5,
} as const;
