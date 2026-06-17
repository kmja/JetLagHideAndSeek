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
                "absolute inset-0 z-[5] overflow-hidden",
                "select-none transition-opacity duration-300 ease-out",
                visible ? "opacity-100" : "opacity-0 pointer-events-none",
                visible && "pointer-events-auto",
                rounded && "rounded-md",
                className,
            )}
            role="status"
            aria-live="polite"
            aria-hidden={!visible}
        >
            {/* Loader fills the whole panel as the visual surface.
                The Protomaps "earth" fill is the opaque background; we
                don't need an extra bg-background scrim on top of it.
                For the timed-out fallback we DO want a plain scrim,
                since the generic spinner doesn't carry its own
                background. */}
            {timedOut ? (
                <div className="absolute inset-0 bg-[hsl(var(--background))]/95 backdrop-blur-[2px]" />
            ) : (
                <MapLoader />
            )}

            {/* Label pill — sits above the loader, semi-translucent
                so it reads against the map graphics without erasing
                them. Centered both ways via absolute positioning so
                the loader behind it can extend edge-to-edge. */}
            <div
                className={cn(
                    "absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2",
                    "flex flex-col items-center justify-center gap-1",
                    "px-4 py-2.5 rounded-md",
                    "bg-[hsl(var(--background))]/85 backdrop-blur-sm",
                    "border border-border/60 shadow-sm",
                    "max-w-[80%]",
                )}
            >
                {timedOut && (
                    <Loader2 className="w-4 h-4 animate-spin text-primary mb-0.5" />
                )}
                <div className="text-sm font-medium text-foreground text-center">
                    {timedOut ? "Map tiles are slow to load" : label}
                </div>
                {(sublabel || timedOut) && (
                    <div className="text-xs text-muted-foreground text-center leading-snug">
                        {timedOut
                            ? "Showing the map anyway — tiles will fill in as they arrive."
                            : sublabel}
                    </div>
                )}
            </div>
        </div>
    );
}

export default MapTilesVeil;
