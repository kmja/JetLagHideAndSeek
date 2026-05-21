import { useStore } from "@nanostores/react";
import {
    Bus,
    Loader2,
    Map as MapIcon,
    Satellite,
    Ship,
    Target,
    Train,
    TrainTrack,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { displayHidingZones, isLoading } from "@/lib/context";
import {
    satelliteView,
    showBusRoutes,
    showFerryRoutes,
    showSubwayRoutes,
    showTransitLines,
} from "@/lib/gameSetup";
import { cn } from "@/lib/utils";

/**
 * Top-right cluster of map-display controls. Three pieces, ordered top to
 * bottom:
 *
 *  1. Map / Satellite segmented switch — basemap style.
 *  2. Hiding zones toggle — on/off overlay of station radii.
 *  3. Per-mode transit toggles — independent icon-only buttons for
 *     Rail (OpenRailwayMap raster — bundles train/tram/light rail),
 *     Subway (Overpass `route=subway`), Bus (Overpass `route=bus`), and
 *     Ferry (Overpass `route=ferry`). Each can be turned on
 *     independently of the others.
 */

/** Shared dimensions so all three controls form a clean vertical stack. */
const PANE_HEIGHT = "h-9";

export function MapDisplayControls() {
    const $satellite = useStore(satelliteView);
    const $rail = useStore(showTransitLines);
    const $subway = useStore(showSubwayRoutes);
    const $bus = useStore(showBusRoutes);
    const $ferry = useStore(showFerryRoutes);
    const $hidingZones = useStore(displayHidingZones);
    const $isLoading = useStore(isLoading);

    return (
        <div className="flex flex-col gap-2 items-end">
            {/* Map / Satellite segmented switch. */}
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

            {/* Hiding zones toggle. Loading pill sits to its left when
                station data is being fetched. */}
            <div className="flex items-center gap-2">
                {$isLoading && (
                    <div
                        className={cn(
                            "shadow-md rounded-md border-2 border-border bg-background",
                            "px-2.5 gap-1.5 flex items-center",
                            PANE_HEIGHT,
                        )}
                        role="status"
                        aria-live="polite"
                        title="Fetching station data — this may take a moment"
                    >
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
                        <span className="text-xs font-poppins font-semibold whitespace-nowrap">
                            Finding stations
                        </span>
                    </div>
                )}
                <button
                    type="button"
                    onClick={() => displayHidingZones.set(!$hidingZones)}
                    aria-pressed={$hidingZones}
                    className={cn(
                        "shadow-md rounded-md border-2",
                        "px-3 gap-2 flex items-center transition-colors",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        PANE_HEIGHT,
                        $hidingZones
                            ? "bg-primary border-primary text-primary-foreground hover:bg-primary/90"
                            : "bg-background border-border hover:bg-accent",
                    )}
                    title="Toggle hiding zones overlay"
                >
                    <Target className="w-4 h-4" />
                    <span className="text-xs font-poppins font-semibold">
                        Hiding zones
                    </span>
                </button>
            </div>

            {/* Per-mode transit toggles — icon-only to keep the cluster
                compact. Grouped in a segmented row that visually pairs
                them as a related family. */}
            <div
                className={cn(
                    "shadow-md rounded-md border-2 border-border bg-background overflow-hidden",
                    "flex",
                    PANE_HEIGHT,
                )}
                role="group"
                aria-label="Transit overlays"
            >
                <TransitIconToggle
                    icon={Train}
                    label="Rail (all modes — bundled OpenRailwayMap layer)"
                    on={$rail}
                    onToggle={() => showTransitLines.set(!$rail)}
                />
                <TransitIconToggle
                    icon={TrainTrack}
                    label="Subway"
                    on={$subway}
                    onToggle={() => showSubwayRoutes.set(!$subway)}
                    borderLeft
                />
                <TransitIconToggle
                    icon={Bus}
                    label="Bus"
                    on={$bus}
                    onToggle={() => showBusRoutes.set(!$bus)}
                    borderLeft
                />
                <TransitIconToggle
                    icon={Ship}
                    label="Ferry"
                    on={$ferry}
                    onToggle={() => showFerryRoutes.set(!$ferry)}
                    borderLeft
                />
            </div>
        </div>
    );
}

function TransitIconToggle({
    icon: Icon,
    label,
    on,
    onToggle,
    borderLeft,
}: {
    icon: LucideIcon;
    label: string;
    on: boolean;
    onToggle: () => void;
    borderLeft?: boolean;
}) {
    return (
        <button
            type="button"
            onClick={onToggle}
            aria-pressed={on}
            title={label}
            aria-label={label}
            className={cn(
                "w-9 flex items-center justify-center transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                borderLeft && "border-l-2 border-border",
                on
                    ? "bg-primary text-primary-foreground hover:bg-primary/90"
                    : "hover:bg-accent",
            )}
        >
            <Icon className="w-4 h-4" />
        </button>
    );
}
