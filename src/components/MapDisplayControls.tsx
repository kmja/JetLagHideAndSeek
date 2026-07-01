import { useStore } from "@nanostores/react";
import type { LucideIcon } from "lucide-react";
import {
    Camera,
    Clock,
    Layers,
    Loader2,
    Map as MapIcon,
    Satellite,
    Target,
} from "lucide-react";
import { Drawer as VaulDrawer } from "vaul";

import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import { displayHidingZones, isLoading } from "@/lib/context";
import {
    allowedTransit,
    mapOptionsDrawerOpen,
    satelliteView,
    showBusRoutes,
    showFerryRoutes,
    showSubwayRoutes,
    showTrainRoutes,
    showTramRoutes,
    TRANSIT_ICONS,
    transitRoutesLoading,
} from "@/lib/gameSetup";
import { showTravelTimes } from "@/lib/journey/state";
import { cn } from "@/lib/utils";

/**
 * Map display controls — basemap toggle, overlay toggles, image export,
 * and per-mode transit overlays.
 *
 * v622: two surfaces share ONE roomy `MapOptionsPanel`:
 *   • Desktop — a floating "Map options" chip (bottom-left) whose
 *     popover holds the panel. Mounted by SeekerPage, gated `md:block`
 *     (mobile has no room there — the bottom-left corner + the bottom
 *     nav own it).
 *   • Mobile — a bottom-nav "Map" slot opens `MapOptionsDrawer` (a vaul
 *     bottom sheet) with the same panel, sized to breathe with big
 *     touch targets.
 */

/** How many overlays are currently active — drives the count badge on
 *  both the desktop chip and the bottom-nav "Map" slot. */
export function useMapOptionsActiveCount(): number {
    const $satellite = useStore(satelliteView);
    const $subway = useStore(showSubwayRoutes);
    const $bus = useStore(showBusRoutes);
    const $ferry = useStore(showFerryRoutes);
    const $train = useStore(showTrainRoutes);
    const $tram = useStore(showTramRoutes);
    const $hidingZones = useStore(displayHidingZones);
    const $allowedTransit = useStore(allowedTransit);
    return (
        (Number($satellite) || 0) +
        (Number($hidingZones) || 0) +
        (Number($subway && $allowedTransit.includes("subway")) || 0) +
        (Number($bus && $allowedTransit.includes("bus")) || 0) +
        (Number($ferry && $allowedTransit.includes("ferry")) || 0) +
        (Number($train && $allowedTransit.includes("train")) || 0) +
        (Number($tram && $allowedTransit.includes("tram")) || 0)
    );
}

/**
 * The actual controls. `roomy` gives every button a bigger touch target
 * + more breathing room (used in the mobile drawer); the compact default
 * suits the desktop popover.
 */
function MapOptionsPanel({ roomy = false }: { roomy?: boolean }) {
    const $satellite = useStore(satelliteView);
    const $subway = useStore(showSubwayRoutes);
    const $bus = useStore(showBusRoutes);
    const $ferry = useStore(showFerryRoutes);
    const $train = useStore(showTrainRoutes);
    const $tram = useStore(showTramRoutes);
    const $hidingZones = useStore(displayHidingZones);
    const $isLoading = useStore(isLoading);
    const $allowedTransit = useStore(allowedTransit);
    const $transitLoading = useStore(transitRoutesLoading);
    const $showTravelTimes = useStore(showTravelTimes);

    const showSubwayBtn = $allowedTransit.includes("subway");
    const showBusBtn = $allowedTransit.includes("bus");
    const showFerryBtn = $allowedTransit.includes("ferry");
    const showTrainBtn = $allowedTransit.includes("train");
    const showTramBtn = $allowedTransit.includes("tram");
    const hasAnyTransitBtn =
        showSubwayBtn ||
        showBusBtn ||
        showFerryBtn ||
        showTrainBtn ||
        showTramBtn;

    // Sizing tokens — roomy for the drawer, compact for the popover.
    const rowH = roomy ? "h-12" : "h-9";
    const rowText = roomy ? "text-sm" : "text-xs";
    const rowIcon = roomy ? "w-5 h-5" : "w-4 h-4";
    const sectionGap = roomy ? "space-y-5" : "space-y-3";
    const label =
        "text-[11px] uppercase tracking-[0.16em] font-poppins font-bold text-muted-foreground";

    return (
        <div className={sectionGap}>
            {/* Map / Satellite */}
            <div className="space-y-2">
                <div className={label}>Basemap</div>
                <div
                    className={cn(
                        "rounded-lg border-2 border-border bg-background overflow-hidden flex",
                        rowH,
                    )}
                    role="group"
                    aria-label="Map style"
                >
                    <button
                        type="button"
                        onClick={() => satelliteView.set(false)}
                        aria-pressed={!$satellite}
                        className={cn(
                            "flex-1 px-2 gap-1.5 flex items-center justify-center transition-colors",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            !$satellite
                                ? "bg-primary text-primary-foreground hover:bg-primary/90"
                                : "hover:bg-accent",
                        )}
                    >
                        <MapIcon className={rowIcon} />
                        <span
                            className={cn(
                                "font-poppins font-semibold",
                                rowText,
                            )}
                        >
                            Map
                        </span>
                    </button>
                    <button
                        type="button"
                        onClick={() => satelliteView.set(true)}
                        aria-pressed={$satellite}
                        className={cn(
                            "flex-1 px-2 gap-1.5 flex items-center justify-center border-l-2 border-border transition-colors",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            $satellite
                                ? "bg-primary text-primary-foreground hover:bg-primary/90"
                                : "hover:bg-accent",
                        )}
                    >
                        <Satellite className={rowIcon} />
                        <span
                            className={cn(
                                "font-poppins font-semibold",
                                rowText,
                            )}
                        >
                            Satellite
                        </span>
                    </button>
                </div>
            </div>

            {/* Overlays */}
            <div className="space-y-2">
                <div className={label}>Overlays</div>
                <button
                    type="button"
                    onClick={() => displayHidingZones.set(!$hidingZones)}
                    aria-pressed={$hidingZones}
                    className={cn(
                        "w-full rounded-lg border-2 px-3 gap-2.5 flex items-center transition-colors",
                        rowH,
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        $hidingZones
                            ? "bg-primary border-primary text-primary-foreground hover:bg-primary/90"
                            : "bg-background border-border hover:bg-accent",
                    )}
                    title="Toggle hiding zones overlay"
                >
                    <Target className={cn(rowIcon, "shrink-0")} />
                    <span
                        className={cn("font-poppins font-semibold", rowText)}
                    >
                        Hiding zones
                    </span>
                    {$isLoading && (
                        <Loader2 className="w-4 h-4 animate-spin ml-auto" />
                    )}
                </button>
                {/* Travel times — earliest arrival at each station for the
                    hider, given they departed from the game-start location
                    when the hiding period began. Requires hiding zones +
                    GPS at game start (overpass-cache /api/journey/arrivals). */}
                <button
                    type="button"
                    onClick={() => showTravelTimes.set(!$showTravelTimes)}
                    aria-pressed={$showTravelTimes}
                    className={cn(
                        "w-full rounded-lg border-2 px-3 gap-2.5 flex items-center transition-colors",
                        rowH,
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        $showTravelTimes
                            ? "bg-primary border-primary text-primary-foreground hover:bg-primary/90"
                            : "bg-background border-border hover:bg-accent",
                    )}
                    title="Stations reachable within the hiding period (requires Hiding zones + GPS at game start)"
                >
                    <Clock className={cn(rowIcon, "shrink-0")} />
                    <span
                        className={cn("font-poppins font-semibold", rowText)}
                    >
                        Travel times
                    </span>
                </button>
            </div>

            {/* Export */}
            <div className="space-y-2">
                <div className={label}>Export</div>
                <button
                    type="button"
                    onClick={() => {
                        window.dispatchEvent(
                            new CustomEvent("jlhs:save-map-image"),
                        );
                    }}
                    className={cn(
                        "w-full rounded-lg border-2 px-3 gap-2.5 flex items-center transition-colors",
                        rowH,
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        "bg-background border-border hover:bg-accent",
                    )}
                    title="Save current map view as a PNG image"
                >
                    <Camera className={cn(rowIcon, "shrink-0")} />
                    <span className={cn("font-poppins font-semibold", rowText)}>
                        Save image
                    </span>
                </button>
            </div>

            {/* Per-mode transit toggles */}
            {hasAnyTransitBtn && (
                <div className="space-y-2">
                    <div className={label}>Transit overlays</div>
                    <div
                        className={cn(
                            "rounded-lg border-2 border-border bg-background overflow-hidden flex",
                            rowH,
                        )}
                        role="group"
                        aria-label="Transit overlays"
                    >
                        {(() => {
                            const buttons: React.ReactNode[] = [];
                            const push = (
                                key: string,
                                icon: LucideIcon,
                                lbl: string,
                                on: boolean,
                                loading: boolean,
                                onToggle: () => void,
                            ) =>
                                buttons.push(
                                    <TransitIconToggle
                                        key={key}
                                        icon={icon}
                                        label={lbl}
                                        on={on}
                                        loading={loading}
                                        onToggle={onToggle}
                                        borderLeft={buttons.length > 0}
                                        iconClass={rowIcon}
                                    />,
                                );
                            if (showSubwayBtn)
                                push(
                                    "subway",
                                    TRANSIT_ICONS.subway,
                                    "Subway",
                                    $subway,
                                    $transitLoading.subway,
                                    () => showSubwayRoutes.set(!$subway),
                                );
                            if (showBusBtn)
                                push(
                                    "bus",
                                    TRANSIT_ICONS.bus,
                                    "Bus",
                                    $bus,
                                    $transitLoading.bus,
                                    () => showBusRoutes.set(!$bus),
                                );
                            if (showFerryBtn)
                                push(
                                    "ferry",
                                    TRANSIT_ICONS.ferry,
                                    "Ferry",
                                    $ferry,
                                    $transitLoading.ferry,
                                    () => showFerryRoutes.set(!$ferry),
                                );
                            // Colored, named-service line overlays per rail
                            // mode (train / tram). v488 dropped the old
                            // all-rail OpenRailwayMap raster toggle.
                            if (showTrainBtn)
                                push(
                                    "train",
                                    TRANSIT_ICONS.train,
                                    "Train (lines)",
                                    $train,
                                    $transitLoading.train,
                                    () => showTrainRoutes.set(!$train),
                                );
                            if (showTramBtn)
                                push(
                                    "tram",
                                    TRANSIT_ICONS.tram,
                                    "Tram (lines)",
                                    $tram,
                                    $transitLoading.tram,
                                    () => showTramRoutes.set(!$tram),
                                );
                            return buttons;
                        })()}
                    </div>
                </div>
            )}
        </div>
    );
}

/**
 * Desktop floating chip — the Layers button + a popover holding the
 * (compact) panel. SeekerPage gates this to `md:block`.
 */
export function MapDisplayControls() {
    const activeCount = useMapOptionsActiveCount();

    return (
        <div className="flex flex-col gap-2 items-start">
            <Popover>
                <PopoverTrigger asChild>
                    <button
                        type="button"
                        aria-label="Map display options"
                        className={cn(
                            "relative shadow-md rounded-md border-2 border-border bg-background",
                            "h-14 w-14 flex items-center justify-center transition-colors",
                            "hover:bg-accent",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        )}
                        title="Map display options"
                    >
                        <Layers className="w-8 h-8" />
                        {activeCount > 0 && (
                            <span
                                className={cn(
                                    "absolute -top-1.5 -right-1.5",
                                    "inline-flex items-center justify-center",
                                    "min-w-[18px] h-[18px] px-1 rounded-full",
                                    "bg-primary text-primary-foreground",
                                    "text-[10px] font-poppins font-bold tabular-nums",
                                    "border-2 border-background",
                                )}
                                aria-label={`${activeCount} option(s) active`}
                            >
                                {activeCount}
                            </span>
                        )}
                    </button>
                </PopoverTrigger>
                <PopoverContent
                    side="top"
                    align="start"
                    className="w-[280px] p-4 bg-card border-2 border-border shadow-xl"
                >
                    <MapOptionsPanel />
                </PopoverContent>
            </Popover>
        </div>
    );
}

/**
 * Mobile bottom sheet — opened from the bottom-nav "Map" slot. Roomy
 * panel with big touch targets.
 */
export function MapOptionsDrawer() {
    const open = useStore(mapOptionsDrawerOpen);
    return (
        <VaulDrawer.Root
            open={open}
            onOpenChange={(o) => mapOptionsDrawerOpen.set(o)}
            shouldScaleBackground={false}
        >
            <VaulDrawer.Portal>
                <VaulDrawer.Overlay className="fixed inset-0 z-[1040] bg-black/60" />
                <VaulDrawer.Content className="fixed inset-x-0 bottom-0 z-[1045] mt-24 flex h-auto max-h-[85vh] flex-col rounded-t-[10px] border bg-background text-foreground pb-[env(safe-area-inset-bottom)]">
                    <div className="mx-auto mt-3 mb-1 h-1.5 w-12 shrink-0 rounded-full bg-foreground/25" />
                    <div className="overflow-y-auto px-6 pt-4 pb-8">
                        <div className="space-y-1 mb-4">
                            <VaulDrawer.Title className="text-lg font-semibold leading-none tracking-tight">
                                Map options
                            </VaulDrawer.Title>
                            <VaulDrawer.Description className="text-sm text-muted-foreground">
                                Basemap, overlays, and transit lines.
                            </VaulDrawer.Description>
                        </div>
                        <MapOptionsPanel roomy />
                    </div>
                </VaulDrawer.Content>
            </VaulDrawer.Portal>
        </VaulDrawer.Root>
    );
}

function TransitIconToggle({
    icon: Icon,
    label,
    on,
    loading,
    onToggle,
    borderLeft,
    iconClass = "w-4 h-4",
}: {
    icon: LucideIcon;
    label: string;
    on: boolean;
    /** True while the Overpass fetch + chunked render is in progress.
     *  Spinner is shown and the button uses a distinct in-progress
     *  visual (translucent primary) rather than the solid "active"
     *  colour, so the user doesn't think the routes are already on
     *  the map. */
    loading?: boolean;
    onToggle: () => void;
    borderLeft?: boolean;
    iconClass?: string;
}) {
    return (
        <button
            type="button"
            onClick={onToggle}
            aria-pressed={on}
            aria-busy={loading || undefined}
            title={loading ? `${label} — loading routes…` : label}
            aria-label={loading ? `${label} (loading routes)` : label}
            className={cn(
                "flex-1 flex items-center justify-center transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                borderLeft && "border-l-2 border-border",
                loading
                    ? "bg-primary/20 text-primary hover:bg-primary/30"
                    : on
                      ? "bg-primary text-primary-foreground hover:bg-primary/90"
                      : "hover:bg-accent",
            )}
        >
            {loading ? (
                <Loader2 className={cn(iconClass, "animate-spin")} />
            ) : (
                <Icon className={iconClass} />
            )}
        </button>
    );
}
