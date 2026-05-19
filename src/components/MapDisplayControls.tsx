import { useStore } from "@nanostores/react";
import { Map as MapIcon, Satellite, Target, TrainFront } from "lucide-react";

import { SidebarContext as SidebarContextR } from "@/components/ui/sidebar-r";
import { satelliteView, showTransitLines } from "@/lib/gameSetup";
import { cn } from "@/lib/utils";

/**
 * Top-right cluster of map-display controls. Three pieces:
 *
 * 1. Hiding zone trigger — opens the right sidebar (ZoneSidebar). Styled
 *    consistently with the toggles below; uses a Target icon to suggest
 *    "the hiding zone area".
 *
 * 2. Map / Satellite segmented switch — single pill with both labels
 *    visible, the active one filled in. Mutually exclusive.
 *
 * 3. Transit-lines toggle — binary on/off with clear filled vs outline
 *    states; OpenRailwayMap overlay.
 */

/** Shared dimensions so all three controls form a clean vertical stack. */
const PANE_HEIGHT = "h-9";

export function MapDisplayControls() {
    const $satellite = useStore(satelliteView);
    const $transit = useStore(showTransitLines);

    return (
        <div className="flex flex-col gap-2 items-end">
            {/* Hiding zone trigger */}
            <button
                type="button"
                onClick={() => {
                    SidebarContextR.get().setOpenMobile(true);
                    SidebarContextR.get().setOpen(true);
                }}
                className={cn(
                    "shadow-md rounded-md border bg-background",
                    "px-3 gap-2 flex items-center",
                    "hover:bg-accent transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    PANE_HEIGHT,
                )}
                aria-label="Open hiding zone settings"
                title="Hiding zone"
            >
                <Target className="w-4 h-4" />
                <span className="text-xs font-poppins font-semibold">
                    Zone
                </span>
            </button>

            {/* Map / Satellite segmented switch */}
            <div
                className={cn(
                    "shadow-md rounded-md border bg-background overflow-hidden",
                    "flex",
                    PANE_HEIGHT,
                )}
                role="group"
                aria-label="Map style"
            >
                <button
                    type="button"
                    onClick={() => satelliteView.set(false)}
                    aria-pressed={!$satellite}
                    className={cn(
                        "px-3 gap-1.5 flex items-center transition-colors",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        !$satellite
                            ? "bg-primary text-primary-foreground"
                            : "hover:bg-accent",
                    )}
                >
                    <MapIcon className="w-4 h-4" />
                    <span className="text-xs font-poppins font-semibold">
                        Map
                    </span>
                </button>
                <button
                    type="button"
                    onClick={() => satelliteView.set(true)}
                    aria-pressed={$satellite}
                    className={cn(
                        "px-3 gap-1.5 flex items-center border-l border-border transition-colors",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        $satellite
                            ? "bg-primary text-primary-foreground"
                            : "hover:bg-accent",
                    )}
                >
                    <Satellite className="w-4 h-4" />
                    <span className="text-xs font-poppins font-semibold">
                        Satellite
                    </span>
                </button>
            </div>

            {/* Transit lines toggle */}
            <button
                type="button"
                onClick={() => showTransitLines.set(!$transit)}
                aria-pressed={$transit}
                className={cn(
                    "shadow-md rounded-md border",
                    "px-3 gap-2 flex items-center transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    PANE_HEIGHT,
                    $transit
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-background hover:bg-accent",
                )}
                title="Toggle transit lines"
            >
                <TrainFront className="w-4 h-4" />
                <span className="text-xs font-poppins font-semibold">
                    Transit
                </span>
            </button>
        </div>
    );
}
