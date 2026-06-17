import { useStore } from "@nanostores/react";

import { resolvedTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

/**
 * Abstract Protomaps-styled map loader (v280 rebuild). The brief:
 *
 *   - Less saturated than the live basemap so it reads as a
 *     "drawing in progress" rather than the real thing.
 *   - Thin roads stretching outward; rivers snake in lazily;
 *     buildings grow from their own centres (not from their base).
 *   - Everything originates at the centre of the panel and grows
 *     outward — as if a z15 city tile is being inked from the middle.
 *
 * Implementation:
 *
 *   - A CSS `clip-path: circle()` on the whole-content group expands
 *     from a tiny disc at centre to fully cover the panel, then
 *     reverses. The clip-path animation is what gives the
 *     "everything stretches outward from the centre" feel.
 *   - Inside the clip, each shape has its own subtle fade / draw
 *     animation with a small per-element delay. Roads draw via
 *     stroke-dashoffset (still reads as "stretching"); rivers do the
 *     same on a longer eased curve; buildings scale from `transform-
 *     origin: center` (both axes) so they expand rather than rise.
 *   - Palette pulled from `@protomaps/basemaps` but warmed / muted
 *     toward the earth tone — keeps the colours recognisably "map"
 *     without competing visually with the live basemap once tiles
 *     start painting.
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

// Desaturated relative to the live `namedFlavor` palette — each
// chroma'd colour pulled partway toward earth so the loader reads as
// a soft sketch rather than a vibrant map.
const LIGHT: Palette = {
    earth: "#e2dfda",
    park_a: "#cdd6cd",
    park_b: "#bdcfc1",
    wood: "#d2d8d0",
    water: "#bfd2da",
    buildings: "#c8c4be",
    minor: "#e6e1d8",
    minor_casing: "#dad5cc",
    major: "#f0ebe2",
    major_casing: "#dcd7ce",
    railway: "#a09ea0",
};
const DARK: Palette = {
    earth: "#1f1f1f",
    park_a: "#1f2622",
    park_b: "#1f2723",
    wood: "#21221e",
    water: "#2c3138",
    buildings: "#1a1a1a",
    minor: "#34343a",
    minor_casing: "#2d2d33",
    major: "#3e3e44",
    major_casing: "#34343a",
    railway: "#1a1a1a",
};

/* ─────────────────── Geometry table ───────────────────
 * 320×180 viewBox, centre at (160, 90). Delays for each shape are a
 * function of distance from centre — closer shapes start their own
 * fade/draw earlier so the apparent reveal sweeps outward, layered
 * on top of the radial clip-path. Distances are scaled into a
 * 0.0–1.4 s delay band; the clip-path reveal itself runs over the
 * first 2.4 s of a 4.5 s loop, so most shapes start their animation
 * around the time the clip reaches them.
 */

const CENTER_X = 160;
const CENTER_Y = 90;
const MAX_RADIUS = Math.hypot(160, 90); // ~183.6

// 0–1 normalised distance from centre.
function dist01(x: number, y: number): number {
    return Math.min(1, Math.hypot(x - CENTER_X, y - CENTER_Y) / MAX_RADIUS);
}

// 0 → 1.4 s delay band based on distance from centre.
function delayFromCenter(x: number, y: number): number {
    return dist01(x, y) * 1.4;
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

/* ─────── Parks (soft green blobs scattered across the frame) ─────── */

interface PolyDef {
    points: string;
}
const PARKS: PolyDef[] = [
    { points: "120,40 156,36 168,58 148,72 120,66" },
    { points: "180,108 214,104 224,124 200,138 178,128" },
    { points: "30,114 60,110 70,128 50,144 28,138" },
    { points: "238,42 268,40 278,58 260,72 240,66" },
    { points: "92,128 122,126 128,148 102,156 88,148" },
];
const WOODS: PolyDef[] = [
    { points: "8,40 38,38 46,60 24,74 4,68" },
    { points: "278,108 308,110 314,132 294,146 274,138" },
];

/* ─────── Water — long lazy snake threading through the centre ─────── */

interface PathDef {
    d: string;
    length: number;
}
const RIVERS: PathDef[] = [
    {
        // Snakes from upper-left, kisses centre, exits lower-right.
        d: "M -10 50 C 50 38, 90 78, 140 76 S 220 96, 270 88 S 320 128, 330 130",
        length: 400,
    },
];

/* ─────── Roads — thinner network, denser grid ───────
 * Mostly straight grid lines with a few diagonals so it doesn't
 * read as perfectly orthogonal. Major + minor splits keep the
 * "casing under fill" look the live basemap uses.
 */
const MAJOR_ROADS: PathDef[] = [
    { d: "M -10 92 L 330 92", length: 340 },
    { d: "M 160 -10 L 160 190", length: 200 },
    { d: "M -10 30 Q 80 22 160 36 T 330 26", length: 360 },
];
const MINOR_ROADS: PathDef[] = [
    { d: "M -10 50 L 330 50", length: 340 },
    { d: "M -10 70 L 330 70", length: 340 },
    { d: "M -10 110 L 330 110", length: 340 },
    { d: "M -10 132 L 330 132", length: 340 },
    { d: "M -10 154 L 330 154", length: 340 },
    { d: "M 40 -10 L 40 190", length: 200 },
    { d: "M 80 -10 L 80 190", length: 200 },
    { d: "M 120 -10 L 120 190", length: 200 },
    { d: "M 200 -10 L 200 190", length: 200 },
    { d: "M 240 -10 L 240 190", length: 200 },
    { d: "M 280 -10 L 280 190", length: 200 },
    // A couple of diagonals to break the grid
    { d: "M -10 16 L 100 110", length: 145 },
    { d: "M 220 110 L 330 16", length: 145 },
    { d: "M -10 170 L 110 100", length: 140 },
    { d: "M 210 100 L 330 168", length: 140 },
];
const RAILWAY: PathDef = {
    // Curves under the river.
    d: "M -10 122 L 90 118 L 200 124 L 330 116",
    length: 360,
};

/* ─────── Buildings ───────
 * Denser than v275 so the frame reads as a z15 city block grid.
 * Footprints clustered between roads, sizes varied. Each will grow
 * out from its own centre (scale, not scaleY).
 */
interface BlockDef {
    x: number;
    y: number;
    w: number;
    h: number;
}
const BUILDINGS: BlockDef[] = [
    // Row near top (between y=30 and y=50)
    { x: 50, y: 36, w: 8, h: 6 },
    { x: 64, y: 34, w: 10, h: 8 },
    { x: 90, y: 36, w: 7, h: 6 },
    { x: 130, y: 38, w: 8, h: 6 },
    { x: 144, y: 40, w: 10, h: 6 },
    { x: 170, y: 38, w: 8, h: 7 },
    { x: 184, y: 40, w: 6, h: 5 },
    { x: 210, y: 36, w: 9, h: 7 },
    { x: 224, y: 40, w: 7, h: 5 },
    { x: 290, y: 36, w: 7, h: 8 },
    { x: 302, y: 38, w: 8, h: 6 },
    // Row between 50 and 70
    { x: 6, y: 56, w: 9, h: 7 },
    { x: 20, y: 58, w: 7, h: 5 },
    { x: 50, y: 56, w: 10, h: 8 },
    { x: 64, y: 58, w: 6, h: 6 },
    { x: 90, y: 56, w: 8, h: 8 },
    { x: 104, y: 60, w: 7, h: 4 },
    { x: 184, y: 56, w: 8, h: 8 },
    { x: 224, y: 58, w: 8, h: 6 },
    { x: 248, y: 56, w: 7, h: 8 },
    { x: 262, y: 60, w: 6, h: 4 },
    { x: 288, y: 56, w: 9, h: 7 },
    { x: 302, y: 60, w: 7, h: 4 },
    // Row between 72 and 90 (dense around centre)
    { x: 6, y: 78, w: 8, h: 6 },
    { x: 22, y: 80, w: 6, h: 5 },
    { x: 50, y: 78, w: 10, h: 6 },
    { x: 64, y: 76, w: 8, h: 9 },
    { x: 90, y: 78, w: 6, h: 6 },
    { x: 104, y: 76, w: 8, h: 9 },
    { x: 120, y: 80, w: 6, h: 5 },
    { x: 136, y: 78, w: 8, h: 6 },
    { x: 164, y: 78, w: 9, h: 6 },
    { x: 176, y: 78, w: 6, h: 6 },
    { x: 200, y: 76, w: 9, h: 9 },
    { x: 224, y: 78, w: 7, h: 6 },
    { x: 248, y: 80, w: 9, h: 5 },
    { x: 288, y: 78, w: 8, h: 6 },
    // Row between 95 and 110
    { x: 6, y: 98, w: 8, h: 7 },
    { x: 20, y: 100, w: 6, h: 5 },
    { x: 46, y: 98, w: 7, h: 6 },
    { x: 60, y: 98, w: 6, h: 8 },
    { x: 90, y: 98, w: 8, h: 9 },
    { x: 104, y: 100, w: 7, h: 6 },
    { x: 124, y: 100, w: 7, h: 5 },
    { x: 136, y: 100, w: 6, h: 7 },
    { x: 164, y: 100, w: 6, h: 6 },
    { x: 176, y: 100, w: 8, h: 6 },
    { x: 246, y: 100, w: 8, h: 6 },
    { x: 290, y: 100, w: 8, h: 7 },
    { x: 304, y: 102, w: 6, h: 4 },
    // Row between 132 and 154
    { x: 6, y: 138, w: 8, h: 8 },
    { x: 22, y: 140, w: 6, h: 5 },
    { x: 64, y: 138, w: 8, h: 8 },
    { x: 130, y: 138, w: 7, h: 8 },
    { x: 144, y: 142, w: 8, h: 6 },
    { x: 164, y: 138, w: 7, h: 6 },
    { x: 178, y: 142, w: 5, h: 4 },
    { x: 246, y: 138, w: 7, h: 6 },
    { x: 258, y: 142, w: 6, h: 5 },
    { x: 290, y: 138, w: 8, h: 8 },
    { x: 304, y: 140, w: 6, h: 5 },
    // Bottom strip 156–174
    { x: 50, y: 162, w: 8, h: 5 },
    { x: 64, y: 164, w: 6, h: 4 },
    { x: 144, y: 162, w: 7, h: 6 },
    { x: 220, y: 162, w: 6, h: 5 },
    { x: 240, y: 164, w: 7, h: 4 },
    { x: 268, y: 162, w: 8, h: 6 },
];

const DURATION = "4.5s";

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
                empty. Sits below the radial-reveal group so even at
                t=0 the panel has a coloured background. */}
            <rect width="320" height="180" fill={c.earth} />

            {/* Everything else lives under a radial clip that grows
                from a tiny disc at centre to fully cover the panel,
                then reverses back to centre at loop end. That gives
                the whole frame a "drawn out from the middle"
                envelope on top of each shape's own animation. */}
            <g className="jl-pmap-reveal">
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
                                animation: `jl-pmap-grow ${DURATION} infinite ease-out`,
                                animationDelay: `${delay.toFixed(2)}s`,
                                transformOrigin: `${m.x}px ${m.y}px`,
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
                                animation: `jl-pmap-grow ${DURATION} infinite ease-out`,
                                animationDelay: `${delay.toFixed(2)}s`,
                                transformOrigin: `${m.x}px ${m.y}px`,
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
                        strokeWidth="9"
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
                                animation: `jl-pmap-stretch ${DURATION} infinite ease-out`,
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
                                animation: `jl-pmap-stretch ${DURATION} infinite ease-out`,
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
                                animation: `jl-pmap-stretch ${DURATION} infinite ease-out`,
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
                                animation: `jl-pmap-stretch ${DURATION} infinite ease-out`,
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
                                animation: `jl-pmap-railway ${DURATION} infinite ease-out`,
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
                                animation: `jl-pmap-grow ${DURATION} infinite ease-out`,
                                animationDelay: `${delay.toFixed(2)}s`,
                                transformOrigin: `${cx}px ${cy}px`,
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
