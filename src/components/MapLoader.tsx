import { useStore } from "@nanostores/react";

import { resolvedTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

/**
 * Abstract Protomaps-styled map loader (v281 rebuild).
 *
 * No global reveal envelope — each shape has its OWN slow, eased
 * draw/fade animation. Per-element `animation-delay` is computed
 * from the shape's distance to the panel centre, stretched into a
 * wide ~0 → 4 s band so closer shapes start drawing well before
 * outer ones — and each individual draw is long enough (~1.4 s of
 * actual motion inside a 7 s cycle) for the eye to follow it.
 *
 * Brief from the user:
 *   - "Staggered objects being drawn individually and slowly with
 *      lots of easing." (v280's clip-path made everything wipe in
 *      together; v281 abandons that approach.)
 *   - "Thin roads stretching out, rivers snaking lazily, buildings
 *      growing outward instead of rising from the ground."
 *   - "Everything starts from the centre and grows outward."
 *
 * The distance-from-centre delay is what gives the radial growth
 * feel without needing a clip-path: at any wall-clock moment, the
 * elements currently in their "drawing" window sit at a roughly
 * matching distance from centre, so the leading edge of activity
 * sweeps outward.
 *
 * Palette stays muted (less saturated than the live basemap), pulled
 * from `@protomaps/basemaps`' named flavors and blended toward earth
 * so the loader reads as a sketch.
 */

interface Palette {
    earth: string;
    park_a: string;
    park_b: string;
    wood: string;
    water: string;
    buildings: string;
    minor: string;
    minor_casing: string;
    major: string;
    major_casing: string;
    railway: string;
}

// Desaturated grayscale palette — the loader reads as a skeleton
// placeholder for a map tile rather than a real basemap. Two
// luminance ramps (light + dark theme); the same ramp positions are
// used for the same map layer in each so the loader's silhouette
// stays consistent across themes.
const LIGHT: Palette = {
    earth: "#e6e6e6",
    park_a: "#d6d6d6",
    park_b: "#cfcfcf",
    wood: "#d2d2d2",
    water: "#c4c4c4",
    buildings: "#bababa",
    minor: "#dcdcdc",
    minor_casing: "#cfcfcf",
    major: "#d4d4d4",
    major_casing: "#bcbcbc",
    railway: "#a8a8a8",
};
const DARK: Palette = {
    earth: "#1f1f1f",
    park_a: "#262626",
    park_b: "#2a2a2a",
    wood: "#242424",
    water: "#2e2e2e",
    buildings: "#333333",
    minor: "#2c2c2c",
    minor_casing: "#252525",
    major: "#363636",
    major_casing: "#2a2a2a",
    railway: "#3a3a3a",
};

/* ─────────────────── Geometry table ───────────────────
 * 320×180 viewBox, centre at (160, 90). Delays for each shape are a
 * function of distance from centre, stretched into a wide 0 → 3 s
 * band: closer shapes start drawing well before outer ones, which
 * gives the radial "drawn out from the middle" feel without any
 * global clip-path envelope. Each individual draw runs slowly with
 * heavy easing (see keyframes), so the eye can follow each shape's
 * line/grow in turn.
 */

const CENTER_X = 160;
const CENTER_Y = 90;
const MAX_RADIUS = Math.hypot(160, 90); // ~183.6

// 0–1 normalised distance from centre.
function dist01(x: number, y: number): number {
    return Math.min(1, Math.hypot(x - CENTER_X, y - CENTER_Y) / MAX_RADIUS);
}

// 0 → 3 s delay band based on distance from centre. With a 7 s loop
// this means the last outer shape starts drawing ~3 s in, while
// inner shapes are already approaching their hold phase — the
// staggered overlap is what makes the loader read as drawn rather
// than wiped.
function delayFromCenter(x: number, y: number): number {
    return dist01(x, y) * 3;
}

// Midpoint of a 2-point or 4-point linear path. Used to compute the
// delay for stroke-drawn paths.
function midpoint(d: string): { x: number; y: number } {
    const nums = d.match(/-?\d+(?:\.\d+)?/g);
    if (!nums || nums.length < 4) return { x: CENTER_X, y: CENTER_Y };
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i + 1 < nums.length; i += 2) {
        xs.push(+nums[i]);
        ys.push(+nums[i + 1]);
    }
    return {
        x: xs.reduce((a, b) => a + b, 0) / xs.length,
        y: ys.reduce((a, b) => a + b, 0) / ys.length,
    };
}

/* ─────── Parks ───────
 * Big organic polygons — abstracted from the dominant green blobs
 * of a Stockholm-style tile (Vasaparken / Kungsholmen / waterfront
 * parks). Each grows from its own centre. */

interface PolyDef {
    points: string;
}
const PARKS: PolyDef[] = [
    // Big top-centre park (Vasaparken-shaped)
    { points: "78,24 124,20 146,36 142,60 116,70 86,64 68,46" },
    // Left-edge park
    { points: "0,76 32,72 44,90 36,110 12,114 -6,100" },
    // Bottom-centre park (with a sub-blob extension)
    { points: "86,134 130,130 152,150 138,170 96,170 78,156" },
    // Right-top park
    { points: "248,26 282,24 298,42 290,64 262,68 244,52" },
    // Right-bottom park
    { points: "226,140 268,136 290,154 280,172 236,174 218,158" },
];
const WOODS: PolyDef[] = [
    // Small wooded patch between top park and right-top park
    { points: "172,40 200,36 208,54 192,66 172,60" },
];

/* ─────── Water — wide canal curving NW → SE through the centre ───────
 * Drawn as a thick stroked path so it reads as a body of water; the
 * curve mimics Klara sjö / Karlbergskanalen widening into a bay near
 * the centre of the panel. */

interface PathDef {
    d: string;
    length: number;
}
const RIVERS: PathDef[] = [
    {
        d: "M -10 58 C 40 52, 80 76, 130 100 S 200 116, 250 102 S 320 138, 340 148",
        length: 460,
    },
];

/* ─────── Roads ───────
 * Sparser than v281, with varied angles so districts don't read as
 * a single perfect grid. Three meandering majors + ~12 minors with
 * intentional skew between left-side and right-side districts. */
const MAJOR_ROADS: PathDef[] = [
    { d: "M -10 32 Q 90 24 160 44 T 330 30", length: 380 },
    { d: "M 156 -10 Q 168 60 152 100 T 168 190", length: 240 },
    { d: "M -10 168 Q 90 152 170 158 T 330 144", length: 380 },
];
const MINOR_ROADS: PathDef[] = [
    // Left district — slight downward tilt
    { d: "M -10 14 L 150 8", length: 165 },
    { d: "M -10 70 L 150 64", length: 165 },
    { d: "M 26 -10 L 32 110", length: 125 },
    { d: "M 60 -10 L 66 110", length: 125 },
    { d: "M 94 -10 L 100 110", length: 125 },
    // Right district — counter-tilt
    { d: "M 170 8 L 330 14", length: 165 },
    { d: "M 170 66 L 330 72", length: 165 },
    { d: "M 218 -10 L 212 110", length: 125 },
    { d: "M 252 -10 L 246 110", length: 125 },
    { d: "M 286 -10 L 280 110", length: 125 },
    // Cross-streets through the lower half
    { d: "M -10 122 L 330 118", length: 340 },
    { d: "M -10 144 Q 150 140 330 134", length: 340 },
    // Two boulevards on diagonals
    { d: "M -10 6 L 70 90", length: 122 },
    { d: "M 250 90 L 330 8", length: 118 },
];
const RAILWAY: PathDef = {
    // Curves through the lower third, parallel to the river south side.
    d: "M -10 130 Q 80 124 180 132 T 330 124",
    length: 360,
};

/* ─────── Buildings ───────
 * Footprints placed in the gaps between parks and water — not just
 * the orthogonal "rows" of v281. Each grows from its own centre.
 */
interface BlockDef {
    x: number;
    y: number;
    w: number;
    h: number;
}
const BUILDINGS: BlockDef[] = [
    // Top strip (y=10-22) — above the parks
    { x: 14, y: 12, w: 8, h: 4 },
    { x: 36, y: 14, w: 6, h: 5 },
    { x: 54, y: 12, w: 8, h: 4 },
    { x: 78, y: 14, w: 6, h: 4 },
    { x: 100, y: 12, w: 8, h: 5 },
    { x: 124, y: 14, w: 6, h: 4 },
    { x: 184, y: 12, w: 8, h: 5 },
    { x: 206, y: 14, w: 6, h: 4 },
    { x: 230, y: 12, w: 8, h: 5 },
    { x: 252, y: 14, w: 7, h: 4 },
    { x: 296, y: 12, w: 8, h: 5 },
    { x: 312, y: 14, w: 6, h: 4 },
    // Row y=36-46 — between top park and right-top park
    { x: 6, y: 38, w: 8, h: 6 },
    { x: 22, y: 40, w: 7, h: 5 },
    { x: 42, y: 38, w: 8, h: 6 },
    { x: 58, y: 40, w: 6, h: 4 },
    { x: 154, y: 38, w: 8, h: 6 },
    { x: 166, y: 42, w: 6, h: 4 },
    { x: 216, y: 38, w: 7, h: 6 },
    { x: 228, y: 40, w: 6, h: 5 },
    { x: 306, y: 38, w: 8, h: 6 },
    // Row y=58-68
    { x: 6, y: 58, w: 9, h: 6 },
    { x: 22, y: 60, w: 6, h: 5 },
    { x: 50, y: 58, w: 8, h: 7 },
    { x: 152, y: 58, w: 9, h: 7 },
    { x: 224, y: 60, w: 8, h: 6 },
    { x: 238, y: 62, w: 7, h: 5 },
    { x: 304, y: 60, w: 7, h: 5 },
    // Right of water bay (y=78-100, x>250)
    { x: 256, y: 78, w: 8, h: 6 },
    { x: 270, y: 80, w: 6, h: 5 },
    { x: 290, y: 78, w: 8, h: 7 },
    { x: 304, y: 82, w: 6, h: 5 },
    { x: 256, y: 122, w: 7, h: 5 },
    // Above water arc (y=78-92, x<60)
    { x: 6, y: 80, w: 8, h: 6 },
    { x: 22, y: 82, w: 6, h: 5 },
    { x: 42, y: 80, w: 7, h: 5 },
    // Below water (between water and lower parks): y=110-130
    { x: 60, y: 108, w: 8, h: 6 },
    { x: 76, y: 110, w: 6, h: 5 },
    { x: 96, y: 108, w: 8, h: 6 },
    { x: 112, y: 112, w: 6, h: 4 },
    { x: 158, y: 108, w: 8, h: 6 },
    { x: 172, y: 112, w: 6, h: 4 },
    { x: 196, y: 108, w: 8, h: 6 },
    { x: 212, y: 112, w: 6, h: 4 },
    // Row y=140-152 — between parks
    { x: 14, y: 140, w: 8, h: 7 },
    { x: 30, y: 144, w: 6, h: 4 },
    { x: 54, y: 140, w: 8, h: 7 },
    { x: 162, y: 140, w: 8, h: 6 },
    { x: 178, y: 144, w: 6, h: 4 },
    { x: 200, y: 140, w: 8, h: 6 },
    { x: 296, y: 140, w: 8, h: 7 },
    { x: 310, y: 144, w: 6, h: 4 },
    // Bottom strip y=162-172 — between parks
    { x: 14, y: 162, w: 8, h: 5 },
    { x: 30, y: 164, w: 6, h: 4 },
    { x: 60, y: 162, w: 8, h: 5 },
    { x: 162, y: 162, w: 8, h: 5 },
    { x: 178, y: 164, w: 6, h: 4 },
    { x: 200, y: 162, w: 8, h: 5 },
    { x: 296, y: 162, w: 8, h: 5 },
    { x: 310, y: 164, w: 6, h: 4 },
];

const DURATION = "8s";

export function MapLoader({
    className,
    /** When true, fills its parent via `absolute inset-0`. Default
     *  on for the loading panels in MapTilesVeil and the wizard. */
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
            {/* Earth — instant solid fill so the panel never flashes
                empty. Every shape draws on top of this. */}
            <rect width="320" height="180" fill={c.earth} />

            <g>
                {/* Wood — muted undertone, layered below parks */}
                {WOODS.map((w, i) => {
                    const m = polyCentroid(w.points);
                    const delay = delayFromCenter(m.x, m.y);
                    return (
                        <polygon
                            key={`wood-${i}`}
                            points={w.points}
                            fill={c.wood}
                            style={{
                                animation: `jl-pmap-grow ${DURATION} infinite cubic-bezier(0.65, 0, 0.35, 1)`,
                                animationDelay: `${delay.toFixed(2)}s`,
                                transformOrigin: "center",
                                transformBox: "fill-box",
                            }}
                        />
                    );
                })}

                {/* Parks — slightly brighter than wood, still muted */}
                {PARKS.map((p, i) => {
                    const m = polyCentroid(p.points);
                    const delay = delayFromCenter(m.x, m.y);
                    return (
                        <polygon
                            key={`park-${i}`}
                            points={p.points}
                            fill={i % 2 === 0 ? c.park_a : c.park_b}
                            style={{
                                animation: `jl-pmap-grow ${DURATION} infinite cubic-bezier(0.65, 0, 0.35, 1)`,
                                animationDelay: `${delay.toFixed(2)}s`,
                                transformOrigin: "center",
                                transformBox: "fill-box",
                            }}
                        />
                    );
                })}

                {/* Rivers — drawn slow + lazy with ease-in-out, gives
                    the languid snaking feel the brief asked for */}
                {RIVERS.map((r, i) => (
                    <path
                        key={`river-${i}`}
                        d={r.d}
                        stroke={c.water}
                        strokeWidth="20"
                        fill="none"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeDasharray={r.length}
                        style={{
                            animation: `jl-pmap-river ${DURATION} infinite ease-in-out`,
                            animationDelay: `0.05s`,
                            ["--jl-pmap-len" as string]: `${r.length}`,
                        }}
                    />
                ))}

                {/* Major-road casings — dimmer underlay drawn just
                    before the fill on top */}
                {MAJOR_ROADS.map((r, i) => {
                    const m = midpoint(r.d);
                    const delay = delayFromCenter(m.x, m.y);
                    return (
                        <path
                            key={`major-c-${i}`}
                            d={r.d}
                            stroke={c.major_casing}
                            strokeWidth="2.5"
                            fill="none"
                            strokeLinecap="round"
                            strokeDasharray={r.length}
                            style={{
                                animation: `jl-pmap-stretch ${DURATION} infinite cubic-bezier(0.65, 0, 0.35, 1)`,
                                animationDelay: `${Math.max(0, delay - 0.05).toFixed(2)}s`,
                                ["--jl-pmap-len" as string]: `${r.length}`,
                            }}
                        />
                    );
                })}
                {MINOR_ROADS.map((r, i) => {
                    const m = midpoint(r.d);
                    const delay = delayFromCenter(m.x, m.y);
                    return (
                        <path
                            key={`minor-c-${i}`}
                            d={r.d}
                            stroke={c.minor_casing}
                            strokeWidth="1.4"
                            fill="none"
                            strokeLinecap="round"
                            strokeDasharray={r.length}
                            style={{
                                animation: `jl-pmap-stretch ${DURATION} infinite cubic-bezier(0.65, 0, 0.35, 1)`,
                                animationDelay: `${Math.max(0, delay - 0.05).toFixed(2)}s`,
                                ["--jl-pmap-len" as string]: `${r.length}`,
                            }}
                        />
                    );
                })}

                {/* Road fills — thinner than casings, drawn on top */}
                {MAJOR_ROADS.map((r, i) => {
                    const m = midpoint(r.d);
                    const delay = delayFromCenter(m.x, m.y);
                    return (
                        <path
                            key={`major-${i}`}
                            d={r.d}
                            stroke={c.major}
                            strokeWidth="1.6"
                            fill="none"
                            strokeLinecap="round"
                            strokeDasharray={r.length}
                            style={{
                                animation: `jl-pmap-stretch ${DURATION} infinite cubic-bezier(0.65, 0, 0.35, 1)`,
                                animationDelay: `${delay.toFixed(2)}s`,
                                ["--jl-pmap-len" as string]: `${r.length}`,
                            }}
                        />
                    );
                })}
                {MINOR_ROADS.map((r, i) => {
                    const m = midpoint(r.d);
                    const delay = delayFromCenter(m.x, m.y);
                    return (
                        <path
                            key={`minor-${i}`}
                            d={r.d}
                            stroke={c.minor}
                            strokeWidth="0.7"
                            fill="none"
                            strokeLinecap="round"
                            strokeDasharray={r.length}
                            style={{
                                animation: `jl-pmap-stretch ${DURATION} infinite cubic-bezier(0.65, 0, 0.35, 1)`,
                                animationDelay: `${delay.toFixed(2)}s`,
                                ["--jl-pmap-len" as string]: `${r.length}`,
                            }}
                        />
                    );
                })}

                {/* Railway — dashed, dimmest of the line elements */}
                {(() => {
                    const m = midpoint(RAILWAY.d);
                    const delay = delayFromCenter(m.x, m.y) + 0.2;
                    return (
                        <path
                            d={RAILWAY.d}
                            stroke={c.railway}
                            strokeWidth="0.9"
                            fill="none"
                            strokeLinecap="round"
                            strokeDasharray="3 3"
                            style={{
                                animation: `jl-pmap-railway ${DURATION} infinite cubic-bezier(0.65, 0, 0.35, 1)`,
                                animationDelay: `${delay.toFixed(2)}s`,
                            }}
                        />
                    );
                })()}

                {/* Buildings — scale from each block's own centre.
                    transform-origin (with transformBox: fill-box) is
                    what makes them GROW rather than rise from base. */}
                {BUILDINGS.map((b, i) => {
                    const cx = b.x + b.w / 2;
                    const cy = b.y + b.h / 2;
                    const delay = delayFromCenter(cx, cy) + 0.25;
                    return (
                        <rect
                            key={`b-${i}`}
                            x={b.x}
                            y={b.y}
                            width={b.w}
                            height={b.h}
                            fill={c.buildings}
                            style={{
                                animation: `jl-pmap-grow ${DURATION} infinite cubic-bezier(0.65, 0, 0.35, 1)`,
                                animationDelay: `${delay.toFixed(2)}s`,
                                transformOrigin: "center",
                                transformBox: "fill-box",
                            }}
                        />
                    );
                })}
            </g>
        </svg>
    );
}

/** Average of all (x,y) pairs in a `points="x,y x,y …"` attribute. */
function polyCentroid(points: string): { x: number; y: number } {
    const pairs = points.trim().split(/\s+/);
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (const p of pairs) {
        const [x, y] = p.split(",").map(Number);
        if (Number.isFinite(x) && Number.isFinite(y)) {
            sx += x;
            sy += y;
            n++;
        }
    }
    return n > 0
        ? { x: sx / n, y: sy / n }
        : { x: CENTER_X, y: CENTER_Y };
}

export default MapLoader;
