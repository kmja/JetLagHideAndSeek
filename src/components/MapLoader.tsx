import type { CSSProperties } from "react";
import { useRef } from "react";

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

/** Comet travel speed in viewBox units per second. Each tile's cycle
 *  duration is its OWN perimeter ÷ this speed, so:
 *    1. every comet moves at the SAME visual pace regardless of tile
 *       size, and
 *    2. the dash period equals the exact perimeter — so a single comet
 *       circulates the closed rect with no pattern/seam mismatch. The
 *       old fixed 200-unit period didn't divide the real perimeter, so
 *       the comet "jumped" at the path seam each lap (read as a stop /
 *       stutter). Perimeter-locked = perfectly continuous motion. */
const SPEED = 38;

/** Wall-clock epoch (set once when this module loads). Comet delays are
 *  computed relative to it, so a freshly-mounted MapLoader picks up the
 *  animation at the phase it would have been at had it been running the
 *  whole time. That keeps the motion continuous across a remount — e.g.
 *  the locate-phase loader handing off to the preview-map loader no
 *  longer "jerks" back to the start of the cycle. */
const LOADER_EPOCH = Date.now();

/** Seconds the mid-tail trails the head. With constant SPEED a fixed
 *  time delay is a fixed DISTANCE behind, so the trio stays welded into
 *  one comet on every tile. */
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

    // Capture the epoch offset ONCE at mount. Computing it on every
    // render (the old `Date.now()` in the JSX) meant each parent
    // re-render — the loading overlay ticks its elapsed/ETA every second
    // — recomputed every comet's `animationDelay`, which RESTARTS the CSS
    // animation at the new phase: the comets visibly jumped once a second.
    // A ref keeps the value stable so the inline styles never change after
    // mount and the animation runs continuously. The in-phase-on-mount
    // resume is preserved (it's read at mount, which is all it needs).
    const elapsedAtMountRef = useRef((Date.now() - LOADER_EPOCH) / 1000);

    return (
        <div
            // v379: per-theme loader palette via `jl-loader`'s CSS
            // variables (see globals.css). Dark mode keeps the original
            // night-sky / glowing-comet look; light mode renders bright
            // brand-coral comets on a soft light-grey backdrop. Stroke
            // hues and opacities both vary per theme so the design
            // doesn't read as a flat inversion in either direction.
            className={cn(
                "jl-loader relative overflow-hidden",
                fillCls,
                fill && "bg-[hsl(var(--jl-loader-bg))]",
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
                        stroke="hsl(var(--jl-loader-grid) / var(--jl-loader-grid-opacity))"
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
                {(() => {
                    // Seconds elapsed since the module loaded, captured
                    // ONCE at mount (see elapsedAtMountRef) so re-renders
                    // don't recompute the delays and restart the anim.
                    const elapsed = elapsedAtMountRef.current;
                    return TILES.map(([x, y, w, h], i) => {
                        // Per-tile perimeter → its own cycle duration and
                        // dash period, so the comet laps the rect with no
                        // seam jump and at the same pace as every other.
                        const perim = 2 * (w + h);
                        const dur = perim / SPEED;
                        // Hash the index into the tile's own cycle so
                        // adjacent tiles don't share a phase. Deterministic
                        // (no Math.random).
                        const baseDelay = ((i * 7) % 11) * (dur / 11);
                        // animation-delay = base phase offset MINUS the
                        // wall-clock elapsed, so every instance lands on
                        // the same phase at the same instant.
                        const delayFor = (extra: number) =>
                            (baseDelay + extra - elapsed).toFixed(2);
                        const travel = {
                            "--jl-dash-travel": `-${perim}`,
                        } as CSSProperties;
                        return (
                            <g key={`comet-${i}`}>
                                {/* Wisp — long, faint, heavily blurred. */}
                                <rect
                                    x={x}
                                    y={y}
                                    width={w}
                                    height={h}
                                    fill="none"
                                    stroke="hsl(var(--jl-loader-comet) / var(--jl-loader-wisp-opacity))"
                                    strokeWidth="1"
                                    strokeLinecap="round"
                                    strokeDasharray={`30 ${perim - 30}`}
                                    vectorEffect="non-scaling-stroke"
                                    filter="url(#jl-comet-wisp)"
                                    className="jl-tile-pulse"
                                    style={{
                                        ...travel,
                                        animationDuration: `${dur.toFixed(2)}s`,
                                        animationDelay: `${delayFor(
                                            TAIL_WISP_DELAY_S,
                                        )}s`,
                                    }}
                                />
                                {/* Body — mid-length, softer. */}
                                <rect
                                    x={x}
                                    y={y}
                                    width={w}
                                    height={h}
                                    fill="none"
                                    stroke="hsl(var(--jl-loader-comet) / var(--jl-loader-body-opacity))"
                                    strokeWidth="1"
                                    strokeLinecap="round"
                                    strokeDasharray={`16 ${perim - 16}`}
                                    vectorEffect="non-scaling-stroke"
                                    filter="url(#jl-comet-body)"
                                    className="jl-tile-pulse"
                                    style={{
                                        ...travel,
                                        animationDuration: `${dur.toFixed(2)}s`,
                                        animationDelay: `${delayFor(
                                            TAIL_BODY_DELAY_S,
                                        )}s`,
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
                                    stroke="hsl(var(--jl-loader-comet) / var(--jl-loader-head-opacity))"
                                    strokeWidth="1"
                                    strokeLinecap="round"
                                    strokeDasharray={`4 ${perim - 4}`}
                                    vectorEffect="non-scaling-stroke"
                                    filter="url(#jl-comet-head)"
                                    className="jl-tile-pulse"
                                    style={{
                                        ...travel,
                                        animationDuration: `${dur.toFixed(2)}s`,
                                        animationDelay: `${delayFor(0)}s`,
                                    }}
                                />
                            </g>
                        );
                    });
                })()}
            </svg>
        </div>
    );
}

export default MapLoader;
