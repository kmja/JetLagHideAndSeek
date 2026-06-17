import { cn } from "@/lib/utils";

/**
 * Map-tile skeleton loader. The panel is left transparent (the
 * container's background shows through); the grid is painted in
 * two passes:
 *
 *   1. A static low-opacity stroke that defines the tile shapes
 *      so the grid remains legible between pulses.
 *   2. A brighter stroke with a long-dash / short-pulse pattern.
 *      Each pulse rect's `stroke-dashoffset` animates from 0 →
 *      -(dash + gap) over `--jl-tile-cycle`, making the bright
 *      segment travel along the rect's perimeter like a packet of
 *      light moving around the line.
 *
 * Per-rect `animation-delay` is staggered with a small hash of the
 * index so the pulses don't all line up — they drift relative to
 * each other and the panel reads as alive with little moving
 * lights, not as a single synchronised cycle.
 */

/**
 * Tile layout on a 320×180 frame. Four bands of varying heights;
 * within each band, tiles of varying widths. Per-row widths sum to
 * 320, row heights sum to 180 — full coverage so the grid lines
 * partition the panel cleanly. */
const TILES: ReadonlyArray<readonly [number, number, number, number]> = [
    // Band 1 (y 0 → 44)
    [0, 0, 80, 44],
    [80, 0, 60, 44],
    [140, 0, 80, 44],
    [220, 0, 100, 44],
    // Band 2 (y 44 → 102)
    [0, 44, 60, 58],
    [60, 44, 100, 58],
    [160, 44, 60, 58],
    [220, 44, 100, 58],
    // Band 3 (y 102 → 138)
    [0, 102, 120, 36],
    [120, 102, 80, 36],
    [200, 102, 60, 36],
    [260, 102, 60, 36],
    // Band 4 (y 138 → 180)
    [0, 138, 80, 42],
    [80, 138, 60, 42],
    [140, 138, 80, 42],
    [220, 138, 40, 42],
    [260, 138, 60, 42],
];

/** Duration of one pulse-cycle around a rect's perimeter (s). */
const CYCLE_S = 2.8;
/** Per-rect delay band in seconds — spread out so the pulses
 *  don't line up. Hashed off the index for stable variety. */
const DELAY_SPREAD_S = CYCLE_S;

export function MapLoader({
    className,
    fill = true,
}: {
    className?: string;
    fill?: boolean;
}) {
    const fillCls = fill ? "absolute inset-0 w-full h-full" : "";

    return (
        <div
            className={cn("relative overflow-hidden", fillCls, className)}
            role="img"
            aria-label="Loading map"
        >
            <svg
                viewBox="0 0 320 180"
                preserveAspectRatio="none"
                className="absolute inset-0 w-full h-full"
            >
                {/* Pass 1 — static low-opacity grid so the shape of
                    the tile pattern is legible at all times, even
                    when no pulse happens to be on a given rect. */}
                {TILES.map(([x, y, w, h], i) => (
                    <rect
                        key={`grid-${i}`}
                        x={x}
                        y={y}
                        width={w}
                        height={h}
                        fill="none"
                        stroke="hsl(var(--foreground) / 0.12)"
                        strokeWidth="1"
                        vectorEffect="non-scaling-stroke"
                    />
                ))}
                {/* Pass 2 — animated dash pulses on the same rects,
                    one full perimeter loop per CYCLE_S, delayed
                    per-rect so the panel reads as several lights
                    drifting along different tiles at once. */}
                {TILES.map(([x, y, w, h], i) => {
                    // Hash the index into the delay band so adjacent
                    // tiles don't share a phase. Cheap deterministic
                    // sprinkle — keeps SSR / hydration happy.
                    const delay =
                        ((i * 7) % 11) * (DELAY_SPREAD_S / 11);
                    return (
                        <rect
                            key={`pulse-${i}`}
                            x={x}
                            y={y}
                            width={w}
                            height={h}
                            fill="none"
                            stroke="hsl(var(--foreground) / 0.55)"
                            strokeWidth="1"
                            strokeLinecap="round"
                            // Short bright pulse (10 units) followed
                            // by a long gap (180). One bright packet
                            // visible per rect at a time. Total
                            // cycle = 190.
                            strokeDasharray="10 180"
                            vectorEffect="non-scaling-stroke"
                            className="jl-tile-pulse"
                            style={{
                                animationDelay: `${delay.toFixed(2)}s`,
                            }}
                        />
                    );
                })}
            </svg>
        </div>
    );
}

export default MapLoader;
