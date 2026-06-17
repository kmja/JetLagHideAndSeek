import { useStore } from "@nanostores/react";

import { resolvedTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

/**
 * Map loader styled to match Protomaps' actual basemap palette
 * (`namedFlavor("light")` / `namedFlavor("dark")` from
 * `@protomaps/basemaps`) — earth fill, paired park / wood shades,
 * water, building grey, road white over a 1-px lighter casing.
 *
 * Fills its container edge-to-edge via `absolute inset-0` so the
 * loading panel reads as "the map is being drawn in place" rather
 * than "a small icon while we wait". Elements fade in across the
 * whole frame simultaneously with a small per-shape stagger; the
 * loop is ~4 s so the metaphor lingers long enough to read.
 *
 * Keyframes live in `globals.css` under `jl-pmap-*`.
 */

interface Palette {
    earth: string;
    park_a: string;
    park_b: string;
    wood_a: string;
    wood_b: string;
    water: string;
    buildings: string;
    minor: string;
    minor_casing: string;
    major: string;
    major_casing: string;
    railway: string;
}

// Pulled from `@protomaps/basemaps`' `namedFlavor` exports so the
// loader stays in lockstep with the live basemap if Protomaps ever
// rebalances the palette.
const LIGHT: Palette = {
    earth: "#e2dfda",
    park_a: "#cfddd5",
    park_b: "#9cd3b4",
    wood_a: "#d0ded0",
    wood_b: "#a0d9a0",
    water: "#80deea",
    buildings: "#cccccc",
    minor: "#ebebeb",
    minor_casing: "#e0e0e0",
    major: "#ffffff",
    major_casing: "#e0e0e0",
    railway: "#a7b1b3",
};
const DARK: Palette = {
    earth: "#1f1f1f",
    park_a: "#1c2421",
    park_b: "#192a24",
    wood_a: "#202121",
    wood_b: "#202121",
    water: "#31353f",
    buildings: "#111111",
    minor: "#3d3d3d",
    minor_casing: "#333333",
    major: "#474747",
    major_casing: "#3d3d3d",
    railway: "#000000",
};

/* ──────────────────── Fixed geometry table ────────────────────
 * Pre-computed so the SVG render is just JSX iteration. Coordinates
 * are inside a 320×180 viewBox (16:9, matches the loading panels'
 * h-[180]/h-[220] aspect closely enough that nothing gets cropped at
 * either size). Each element carries an `animation-delay` so the
 * frame fills in dispersed-but-not-sequential — by ~25% of the loop
 * every region has at least one shape in flight.
 */

interface PolyDef {
    points: string;
    delay: number;
}
const PARKS: PolyDef[] = [
    { points: "22,118 60,114 78,128 70,150 30,148", delay: 0.30 },
    { points: "180,16 222,12 234,30 214,42 184,38", delay: 0.45 },
    { points: "262,108 300,110 312,134 290,150 258,140", delay: 0.55 },
    { points: "112,150 156,148 168,170 132,178 108,172", delay: 0.65 },
];
const WOODS: PolyDef[] = [
    { points: "236,52 282,48 296,80 268,92 240,82", delay: 0.40 },
    { points: "8,40 44,36 56,68 30,80 4,72", delay: 0.50 },
];

interface PathDef {
    d: string;
    /** Length used for stroke-dashoffset; rough is fine — slight
     *  overshoot just means the draw finishes a touch early. */
    length: number;
    delay: number;
}
const WATER_PATHS: PathDef[] = [
    // River drifting across the middle, north-east → south-west.
    { d: "M -10 70 C 60 60, 110 90, 160 78 S 260 96, 330 88", length: 380, delay: 0.10 },
];
const MAJOR_ROADS: PathDef[] = [
    { d: "M -10 100 L 330 100", length: 340, delay: 0.55 },
    { d: "M 100 -10 L 100 190", length: 200, delay: 0.65 },
    { d: "M 220 -10 L 220 190", length: 200, delay: 0.80 },
    { d: "M -10 50 Q 80 40, 160 52 T 330 44", length: 360, delay: 0.50 },
];
const MINOR_ROADS: PathDef[] = [
    { d: "M -10 30 L 330 30", length: 340, delay: 0.75 },
    { d: "M -10 130 L 330 130", length: 340, delay: 0.70 },
    { d: "M -10 160 L 330 160", length: 340, delay: 0.85 },
    { d: "M 40 -10 L 40 190", length: 200, delay: 0.95 },
    { d: "M 160 -10 L 160 190", length: 200, delay: 0.90 },
    { d: "M 280 -10 L 280 190", length: 200, delay: 1.0 },
    { d: "M 320 30 L 280 110 L 220 150", length: 130, delay: 0.85 },
    { d: "M -10 110 L 60 130 L 110 160", length: 140, delay: 0.80 },
];
const RAILWAY: PathDef = {
    d: "M -10 145 L 100 140 L 200 148 L 330 138",
    length: 360,
    delay: 1.2,
};

interface BlockDef {
    x: number;
    y: number;
    w: number;
    h: number;
    delay: number;
}
// Building footprints — dense city-block grid that fills the
// majority of "earth" but leaves the parks/water/wood polygons
// visible. Sizes vary so the frame doesn't read as a uniform mesh.
// Delays are staggered within ~0.7s so buildings come up "all over"
// rather than in a wave.
const BUILDINGS: BlockDef[] = [
    // Top band
    { x: 16,  y: 12,  w: 18, h: 12, delay: 1.1 },
    { x: 50,  y: 14,  w: 22, h: 10, delay: 1.0 },
    { x: 88,  y: 10,  w: 14, h: 14, delay: 1.2 },
    { x: 116, y: 14,  w: 26, h: 10, delay: 1.3 },
    { x: 152, y: 12,  w: 18, h: 12, delay: 1.05 },
    { x: 250, y: 30,  w: 18, h: 10, delay: 1.25 },
    { x: 274, y: 28,  w: 14, h: 12, delay: 1.35 },
    { x: 296, y: 32,  w: 14, h: 10, delay: 1.45 },
    // Mid-left cluster
    { x: 110, y: 60,  w: 16, h: 14, delay: 1.0 },
    { x: 132, y: 58,  w: 20, h: 16, delay: 1.15 },
    { x: 160, y: 62,  w: 14, h: 12, delay: 1.25 },
    { x: 184, y: 60,  w: 24, h: 16, delay: 1.10 },
    { x: 184, y: 80,  w: 18, h: 12, delay: 1.35 },
    { x: 208, y: 82,  w: 14, h: 10, delay: 1.45 },
    // Mid-right cluster around the major road
    { x: 228, y: 76,  w: 18, h: 12, delay: 1.20 },
    { x: 252, y: 78,  w: 22, h: 14, delay: 1.30 },
    { x: 280, y: 74,  w: 14, h: 18, delay: 1.40 },
    { x: 298, y: 80,  w: 14, h: 12, delay: 1.50 },
    // Lower band
    { x: 12,  y: 122, w: 14, h: 14, delay: 1.05 },
    { x: 32,  y: 124, w: 18, h: 12, delay: 1.15 },
    { x: 70,  y: 122, w: 16, h: 14, delay: 1.25 },
    { x: 90,  y: 126, w: 14, h: 10, delay: 1.35 },
    { x: 200, y: 122, w: 18, h: 12, delay: 1.20 },
    { x: 224, y: 120, w: 14, h: 14, delay: 1.30 },
    { x: 244, y: 126, w: 18, h: 10, delay: 1.40 },
    // Bottom strip
    { x: 32,  y: 162, w: 14, h: 10, delay: 1.55 },
    { x: 56,  y: 164, w: 18, h: 8, delay: 1.45 },
    { x: 84,  y: 162, w: 22, h: 10, delay: 1.50 },
    { x: 178, y: 162, w: 16, h: 10, delay: 1.45 },
    { x: 202, y: 164, w: 14, h: 8, delay: 1.55 },
    { x: 246, y: 162, w: 14, h: 10, delay: 1.40 },
    { x: 270, y: 162, w: 18, h: 10, delay: 1.50 },
    { x: 296, y: 164, w: 14, h: 8, delay: 1.60 },
];

const DURATION = "4s";

export function MapLoader({
    className,
    /**
     * When true, the SVG fills its parent (`absolute inset-0`). The
     * loading panels in MapTilesVeil and the wizard placeholder use
     * this. Set false for a sized inline preview if ever needed.
     */
    fill = true,
}: {
    className?: string;
    fill?: boolean;
}) {
    const theme = useStore(resolvedTheme);
    const c = theme === "dark" ? DARK : LIGHT;
    const fillCls = fill ? "absolute inset-0 w-full h-full" : "";

    return (
        <svg
            viewBox="0 0 320 180"
            preserveAspectRatio="xMidYMid slice"
            className={cn(fillCls, className)}
            role="img"
            aria-label="Loading map"
        >
            {/* Earth — instant fill, sets the basemap canvas */}
            <rect width="320" height="180" fill={c.earth} />

            {/* Wood polygons — dimmer green undertone */}
            {WOODS.map((w, i) => (
                <polygon
                    key={`wood-${i}`}
                    points={w.points}
                    fill={c.wood_a}
                    style={{
                        animation: `jl-pmap-poly ${DURATION} infinite ease-out`,
                        animationDelay: `${w.delay}s`,
                        transformOrigin: "center",
                    }}
                />
            ))}

            {/* Parks — brighter green, layered above wood */}
            {PARKS.map((p, i) => (
                <polygon
                    key={`park-${i}`}
                    points={p.points}
                    fill={c.park_a}
                    style={{
                        animation: `jl-pmap-poly ${DURATION} infinite ease-out`,
                        animationDelay: `${p.delay}s`,
                        transformOrigin: "center",
                    }}
                />
            ))}

            {/* Water — drawn first along the path, kept visible after */}
            {WATER_PATHS.map((wp, i) => (
                <path
                    key={`water-${i}`}
                    d={wp.d}
                    stroke={c.water}
                    strokeWidth="14"
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeDasharray={wp.length}
                    style={{
                        animation: `jl-pmap-line ${DURATION} infinite ease-out`,
                        animationDelay: `${wp.delay}s`,
                        ["--jl-pmap-len" as string]: `${wp.length}`,
                    }}
                />
            ))}

            {/* Road casings — slightly fatter and dimmer, drawn first */}
            {MAJOR_ROADS.map((r, i) => (
                <path
                    key={`major-casing-${i}`}
                    d={r.d}
                    stroke={c.major_casing}
                    strokeWidth="6"
                    fill="none"
                    strokeLinecap="round"
                    strokeDasharray={r.length}
                    style={{
                        animation: `jl-pmap-line ${DURATION} infinite ease-out`,
                        animationDelay: `${r.delay - 0.04}s`,
                        ["--jl-pmap-len" as string]: `${r.length}`,
                    }}
                />
            ))}
            {MINOR_ROADS.map((r, i) => (
                <path
                    key={`minor-casing-${i}`}
                    d={r.d}
                    stroke={c.minor_casing}
                    strokeWidth="3.5"
                    fill="none"
                    strokeLinecap="round"
                    strokeDasharray={r.length}
                    style={{
                        animation: `jl-pmap-line ${DURATION} infinite ease-out`,
                        animationDelay: `${r.delay - 0.04}s`,
                        ["--jl-pmap-len" as string]: `${r.length}`,
                    }}
                />
            ))}

            {/* Road fills — thinner and brighter, drawn on top */}
            {MAJOR_ROADS.map((r, i) => (
                <path
                    key={`major-${i}`}
                    d={r.d}
                    stroke={c.major}
                    strokeWidth="4"
                    fill="none"
                    strokeLinecap="round"
                    strokeDasharray={r.length}
                    style={{
                        animation: `jl-pmap-line ${DURATION} infinite ease-out`,
                        animationDelay: `${r.delay}s`,
                        ["--jl-pmap-len" as string]: `${r.length}`,
                    }}
                />
            ))}
            {MINOR_ROADS.map((r, i) => (
                <path
                    key={`minor-${i}`}
                    d={r.d}
                    stroke={c.minor}
                    strokeWidth="2"
                    fill="none"
                    strokeLinecap="round"
                    strokeDasharray={r.length}
                    style={{
                        animation: `jl-pmap-line ${DURATION} infinite ease-out`,
                        animationDelay: `${r.delay}s`,
                        ["--jl-pmap-len" as string]: `${r.length}`,
                    }}
                />
            ))}

            {/* Railway — dashed, last to draw */}
            <path
                d={RAILWAY.d}
                stroke={c.railway}
                strokeWidth="1.4"
                fill="none"
                strokeLinecap="round"
                strokeDasharray="6 4"
                style={{
                    animation: `jl-pmap-railway ${DURATION} infinite ease-out`,
                    animationDelay: `${RAILWAY.delay}s`,
                }}
            />

            {/* Buildings — pop in across the frame in a tight stagger */}
            {BUILDINGS.map((b, i) => (
                <rect
                    key={`b-${i}`}
                    x={b.x}
                    y={b.y}
                    width={b.w}
                    height={b.h}
                    fill={c.buildings}
                    style={{
                        animation: `jl-pmap-building ${DURATION} infinite ease-out`,
                        animationDelay: `${b.delay}s`,
                        transformOrigin: `${b.x + b.w / 2}px ${b.y + b.h}px`,
                    }}
                />
            ))}
        </svg>
    );
}

export default MapLoader;
