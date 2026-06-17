import { useStore } from "@nanostores/react";

import { resolvedTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

/**
 * Map-tile skeleton loader. Replaces the v280-v283 Protomaps-style
 * abstraction with a classic skeleton: a grid of differently-sized
 * map-tile-shaped rectangles in muted grey, with a diagonal shimmer
 * sweeping across.
 *
 * Reads like a placeholder for a map view (it's obviously not the
 * real thing) rather than a stylised fake basemap, which is what
 * the user wanted.
 *
 * Shimmer is driven by `.jl-skeleton-shimmer` in globals.css — a
 * 100° gradient with `background-size: 200% 100%` that slides
 * across the panel on a slow linear loop.
 */

interface Palette {
    base: string;
    tile: string;
}

const LIGHT: Palette = { base: "#e9e9e9", tile: "#d4d4d4" };
const DARK: Palette = { base: "#1c1c1c", tile: "#2a2a2a" };

/**
 * Tile layout on a 320×180 frame. Four bands of varying heights;
 * within each band, tiles of varying widths. Per-row widths sum to
 * 320, row heights sum to 180 — full coverage without gaps in the
 * data (the visual gap between tiles is the GAP inset below). */
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

/** Inset between tiles so the gridlines read as gaps, not borders.
 *  Half is shaved off each side of the rect; the panel's
 *  `backgroundColor` shows through. */
const GAP = 2;

export function MapLoader({
    className,
    fill = true,
}: {
    className?: string;
    fill?: boolean;
}) {
    const theme = useStore(resolvedTheme);
    const c = theme === "dark" ? DARK : LIGHT;
    const fillCls = fill ? "absolute inset-0 w-full h-full" : "";

    return (
        <div
            className={cn("relative overflow-hidden", fillCls, className)}
            style={{ backgroundColor: c.base }}
            role="img"
            aria-label="Loading map"
        >
            <svg
                viewBox="0 0 320 180"
                preserveAspectRatio="xMidYMid slice"
                className="absolute inset-0 w-full h-full"
            >
                {TILES.map(([x, y, w, h], i) => (
                    <rect
                        key={i}
                        x={x + GAP / 2}
                        y={y + GAP / 2}
                        width={w - GAP}
                        height={h - GAP}
                        rx="1.5"
                        fill={c.tile}
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
