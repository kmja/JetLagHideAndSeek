import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Full-bleed loading veil for a map view, shown until every layer the
 * view needs has painted (see `useMapTilesReady`). Absolutely
 * positioned — drop it inside a `relative` map container as a sibling
 * of the `<MapGL>`.
 *
 * Covers the deliberate-half-built-map problem the user flagged: a map
 * should read as "loading", not show a boundary outline floating on a
 * dark void while tiles stream in (or fail to).
 */
export function MapTilesVeil({
    label = "Loading map",
    sublabel,
    timedOut = false,
    rounded = false,
    /** z-index for the veil. Map previews can use the default; the
     *  full-screen seeker map sits below its overlays/sidebars. */
    className,
}: {
    label?: string;
    sublabel?: string;
    /** When true we force-revealed before tiles settled — soften the
     *  copy so it reads as "slow" rather than "still loading". */
    timedOut?: boolean;
    rounded?: boolean;
    className?: string;
}) {
    return (
        <div
            className={cn(
                "absolute inset-0 z-[5] flex flex-col items-center justify-center gap-2.5",
                "bg-[hsl(var(--background))]/95 backdrop-blur-[2px]",
                "pointer-events-none select-none",
                rounded && "rounded-md",
                className,
            )}
            role="status"
            aria-live="polite"
        >
            <Loader2 className="w-6 h-6 animate-spin text-primary" />
            <div className="text-sm font-medium text-foreground">
                {timedOut ? "Map tiles are slow to load" : label}
            </div>
            {(sublabel || timedOut) && (
                <div className="text-xs text-muted-foreground max-w-[80%] text-center leading-snug">
                    {timedOut
                        ? "Showing the map anyway — tiles will fill in as they arrive."
                        : sublabel}
                </div>
            )}
        </div>
    );
}

export default MapTilesVeil;
