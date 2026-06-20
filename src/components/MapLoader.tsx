import { cn } from "@/lib/utils";

/**
 * Map-tile skeleton loader. The panel is left transparent (the
 * container's background shows through); the grid is painted in
 * two passes:
 *
 *   1. A static low-opacity stroke that defines the tile shapes
 *      so the grid remains legible between pulses.
 *   2. Three phase-locked dash layers per tile that together render
 *      as a comet: a small bright HEAD, a softer mid-tail BODY,
 *      and a wide faint WISP further back. Each layer's
 *      `stroke-dashoffset` animates from 0 → -200 over the cycle,
 *      so every layer travels around the rect's perimeter at the
 *      same speed. The tail layers carry a fixed positive
 *      `animation-delay` relative to the head, which after the
 *      first cycle stabilises them at a constant distance BEHIND
 *      the head — that's what makes the trio read as one comet
 *      instead of three independent dots. Each layer has its own
 *      Gaussian blur (tightening from wisp → head) so the alpha
 *      falls off continuously along the tail.
 *
 * Per-rect `animation-delay` is staggered with a small hash of the
 * index so the comets on different tiles don't all line up — they
 * drift relative to each other and the panel reads as alive with
 * little moving lights, not as a single synchronised cycle. Kept
 * deliberately slow so it's a calm ambient shimmer, not a flash.
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

/** Duration of one comet trip around a rect's perimeter (s). All
 *  three layers share this period so their phase offset stays
 *  constant after the first cycle. */
const CYCLE_S = 5.5;
/** Per-rect delay band in seconds — spread out so the comets on
 *  different tiles don't share a phase. Hashed off the index for
 *  stable variety (no Math.random — keeps SSR / hydration happy). */
const DELAY_SPREAD_S = CYCLE_S;

/** Seconds of additional delay applied to the mid-tail layer
 *  relative to its tile's head. The head travels at 200/CYCLE_S
 *  units per second along the perimeter, so a delay of D s places
 *  the mid-tail's leading edge D × (200/CYCLE_S) units behind the
 *  head — sized below so the body's right end meets the head's
 *  left end with a small overlap for the blurs to dissolve into. */
const TAIL_BODY_DELAY_S = 0.4;
/** Same idea, further back: the wisp lags behind the body. */
const TAIL_WISP_DELAY_S = 1.15;

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
            // v378: scope this subtree as "dark" regardless of the page
            // theme. The comet's blurred bright strokes are designed
            // light-on-dark — they read as photons against a night sky.
            // Inverted to dark-on-light (the literal fallback when
            // `--foreground` resolves to near-black in light mode) the
            // same blur reads as dirty smears rather than glow. Forcing
            // dark CSS variables here keeps the aesthetic in both themes.
            // shadcn `darkMode: "class"` resolves `--background` /
            // `--foreground` from `.dark` selectors, so adding the class
            // is enough — no theme detection or atom subscribe needed.
            // The fill bg uses the (now-dark) background token so the
            // loader sits on its own dark sky no matter what the page is.
            className={cn(
                "dark relative overflow-hidden",
                fillCls,
                fill && "bg-[hsl(var(--background))]",
                className,
            )}
            role="img"
            aria-label="Loading map"
        >
            <svg
                viewBox="0 0 320 180"
                preserveAspectRatio="none"
                className="absolute inset-0 w-full h-full"
            >
                <defs>
                    {/* One Gaussian-blur filter per comet layer. The
                        head gets a tight blur so it still reads as a
                        crisp point of light; the wisp gets a heavy
                        blur so it dissolves into the background.
                        Generous filter regions because the blur can
                        spill past the rect's bounding box. */}
                    <filter
                        id="jl-comet-head"
                        x="-15%"
                        y="-15%"
                        width="130%"
                        height="130%"
                    >
                        <feGaussianBlur stdDeviation="0.55" />
                    </filter>
                    <filter
                        id="jl-comet-body"
                        x="-25%"
                        y="-25%"
                        width="150%"
                        height="150%"
                    >
                        <feGaussianBlur stdDeviation="1.6" />
                    </filter>
                    <filter
                        id="jl-comet-wisp"
                        x="-40%"
                        y="-40%"
                        width="180%"
                        height="180%"
                    >
                        <feGaussianBlur stdDeviation="2.8" />
                    </filter>
                </defs>
                {/* Pass 1 — static low-opacity grid so the shape of
                    the tile pattern is legible at all times, even
                    when no comet happens to be on a given rect. */}
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
                {/* Pass 2 — comet trio per tile. Render order goes
                    wisp → body → head so the brightest point sits on
                    top of the trailing layers (later DOM children
                    paint over earlier ones in SVG). Each layer uses a
                    dasharray summing to 200 so the cycle period
                    matches the keyframe's -200 dashoffset travel
                    exactly. */}
                {TILES.map(([x, y, w, h], i) => {
                    // Hash the index into the delay band so adjacent
                    // tiles don't share a phase. Cheap deterministic
                    // sprinkle — keeps SSR / hydration happy.
                    const baseDelay =
                        ((i * 7) % 11) * (DELAY_SPREAD_S / 11);
                    return (
                        <g key={`comet-${i}`}>
                            {/* Wisp — long, faint, heavily blurred. */}
                            <rect
                                x={x}
                                y={y}
                                width={w}
                                height={h}
                                fill="none"
                                stroke="hsl(var(--foreground) / 0.10)"
                                strokeWidth="1"
                                strokeLinecap="round"
                                strokeDasharray="30 170"
                                vectorEffect="non-scaling-stroke"
                                filter="url(#jl-comet-wisp)"
                                className="jl-tile-pulse"
                                style={{
                                    animationDelay: `${(
                                        baseDelay + TAIL_WISP_DELAY_S
                                    ).toFixed(2)}s`,
                                }}
                            />
                            {/* Body — mid-length, softer. */}
                            <rect
                                x={x}
                                y={y}
                                width={w}
                                height={h}
                                fill="none"
                                stroke="hsl(var(--foreground) / 0.22)"
                                strokeWidth="1"
                                strokeLinecap="round"
                                strokeDasharray="16 184"
                                vectorEffect="non-scaling-stroke"
                                filter="url(#jl-comet-body)"
                                className="jl-tile-pulse"
                                style={{
                                    animationDelay: `${(
                                        baseDelay + TAIL_BODY_DELAY_S
                                    ).toFixed(2)}s`,
                                }}
                            />
                            {/* Head — short, bright, tight blur.
                                Painted last so it reads as the
                                comet's point of light on top of the
                                fading tail layers. */}
                            <rect
                                x={x}
                                y={y}
                                width={w}
                                height={h}
                                fill="none"
                                stroke="hsl(var(--foreground) / 0.7)"
                                strokeWidth="1"
                                strokeLinecap="round"
                                strokeDasharray="4 196"
                                vectorEffect="non-scaling-stroke"
                                filter="url(#jl-comet-head)"
                                className="jl-tile-pulse"
                                style={{
                                    animationDelay: `${baseDelay.toFixed(2)}s`,
                                }}
                            />
                        </g>
                    );
                })}
            </svg>
        </div>
    );
}

export default MapLoader;
