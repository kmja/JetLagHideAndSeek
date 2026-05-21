import { useStore } from "@nanostores/react";
import {
    Map as MapIcon,
    Satellite,
    Settings,
    Target,
    TrainFront,
} from "lucide-react";

import { displayHidingZones, zoneSidebarOpen } from "@/lib/context";
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
    const $hidingZones = useStore(displayHidingZones);

    return (
        <div className="flex flex-col gap-2 items-end">
            {/* Hiding zones toggle + settings. Toggle (on/off) — solid red
                fill when active so the on/off state reads at a glance. */}
            <div
                className={cn(
                    "shadow-md rounded-md border-2 overflow-hidden flex",
                    PANE_HEIGHT,
                    $hidingZones
                        ? "bg-primary border-primary text-primary-foreground"
                        : "bg-background border-border",
                )}
                role="group"
                aria-label="Hiding zones"
            >
                <button
                    type="button"
                    onClick={() => displayHidingZones.set(!$hidingZones)}
                    aria-pressed={$hidingZones}
                    className={cn(
                        "px-3 gap-2 flex items-center transition-colors",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        $hidingZones
                            ? "hover:bg-primary/90"
                            : "text-foreground hover:bg-accent",
                    )}
                    title="Toggle hiding zones overlay"
                >
                    <Target className="w-4 h-4" />
                    <span className="text-xs font-poppins font-semibold">
                        Hiding zones
                    </span>
                </button>
                <button
                    type="button"
                    onClick={() => zoneSidebarOpen.set(true)}
                    className={cn(
                        "px-2.5 flex items-center justify-center border-l-2 transition-colors",
                        $hidingZones
                            ? "border-primary-foreground/30 hover:bg-primary/80"
                            : "border-border hover:bg-accent",
                    )}
                    aria-label="Hiding zone settings"
                    title="Hiding zone settings"
                >
                    <Settings className="w-4 h-4" />
                </button>
            </div>

            {/* Map / Satellite segmented switch — solid red fill on the
                active half so it matches the Hiding-zones and Transit
                toggles' "selected = filled" pattern. */}
            <div
                className={cn(
                    "shadow-md rounded-md border-2 border-border bg-background overflow-hidden",
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
                            ? "bg-primary text-primary-foreground hover:bg-primary/90"
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
                        "px-3 gap-1.5 flex items-center border-l-2 border-border transition-colors",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        $satellite
                            ? "bg-primary text-primary-foreground hover:bg-primary/90"
                            : "hover:bg-accent",
                    )}
                >
                    <Satellite className="w-4 h-4" />
                    <span className="text-xs font-poppins font-semibold">
                        Satellite
                    </span>
                </button>
            </div>

            {/* Transit lines toggle. Toggle (on/off) — solid red fill when
                active to match the Hiding-zones toggle. */}
            <button
                type="button"
                onClick={() => showTransitLines.set(!$transit)}
                aria-pressed={$transit}
                className={cn(
                    "shadow-md rounded-md border-2",
                    "px-3 gap-2 flex items-center transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    PANE_HEIGHT,
                    $transit
                        ? "bg-primary border-primary text-primary-foreground hover:bg-primary/90"
                        : "bg-background border-border hover:bg-accent",
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
