import { cn } from "@/lib/utils";

/**
 * Map-tile skeleton loader. v293 strips the loader to bare grid
 * lines on a transparent background — it now reads as an empty
 * container with a shimmering tile-line pattern over it, rather
 * than a filled mosaic in a different shade from the surrounding
 * chrome. The container's own background shows through.
 *
 * The grid lines come from stroking the existing tile layout; the
 * shimmer is a diagonal gradient defined in globals.css that
 * sweeps across the panel on a slow loop, briefly brightening the
 * lines as it passes.
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
                {TILES.map(([x, y, w, h], i) => (
                    <rect
                        key={i}
                        x={x}
                        y={y}
                        width={w}
                        height={h}
                        fill="none"
                        stroke="hsl(var(--foreground) / 0.14)"
                        strokeWidth="1"
                        // Keep stroke a constant width regardless of
                        // how the SVG is scaled to fill the panel —
                        // otherwise tall containers bloat the lines.
                        vectorEffect="non-scaling-stroke"
                    />
                ))}
            </svg>
            <div
                aria-hidden
                className="jl-skeleton-shimmer absolute inset-0 pointer-events-none"
            />
        </div>
    );
}

export default MapLoader;
