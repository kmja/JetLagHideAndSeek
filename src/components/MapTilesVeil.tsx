import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";

import { MapLoader } from "./MapLoader";

/**
 * Full-bleed loading veil for a map view, shown until every layer the
 * view needs has painted (see `useMapTilesReady`). Absolutely
 * positioned — drop it inside a `relative` map container as a sibling
 * of the `<MapGL>`.
 *
 * Covers the deliberate-half-built-map problem the user flagged: a map
 * should read as "loading", not show a boundary outline floating on a
 * dark void while tiles stream in (or fail to).
 *
 * v274: the veil is now always mounted; visibility flips via the
 * `visible` prop with a CSS opacity transition. This is the only way
 * to fade OUT smoothly — if the parent conditionally unmounts the
 * veil the moment tiles are ready, the fade-out animation has no
 * chance to run before the DOM node disappears. Always-mounted +
 * opacity is the simplest way to get a smooth dissolve when the map
 * settles.
 */
export function MapTilesVeil({
    visible = true,
    label = "Loading map",
    sublabel,
    timedOut = false,
    rounded = false,
    /** z-index for the veil. Map previews can use the default; the
     *  full-screen seeker map sits below its overlays/sidebars. */
    className,
}: {
    /** When false, the veil fades out (~300 ms) and becomes
     *  pointer-events-none so the map below is interactive. Default
     *  true to preserve old behaviour where callers conditionally
     *  rendered the veil. */
    visible?: boolean;
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
                "select-none transition-opacity duration-300 ease-out",
                visible
                    ? "opacity-100"
                    : "opacity-0 pointer-events-none",
                // While visible we still want to swallow pointer
                // events on the canvas underneath so a half-revealed
                // map doesn't get accidental panning.
                visible && "pointer-events-auto",
                rounded && "rounded-md",
                className,
            )}
            role="status"
            aria-live="polite"
            aria-hidden={!visible}
        >
            {timedOut ? (
                <Loader2 className="w-6 h-6 animate-spin text-primary" />
            ) : (
                <MapLoader />
            )}
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
