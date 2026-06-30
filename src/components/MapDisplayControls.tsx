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

import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import { displayHidingZones, isLoading } from "@/lib/context";
import {
    allowedTransit,
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
 * Bottom-left cluster (v616) — a single compact "Map options" chip
 * with a popover (opening up + left-aligned) containing basemap
 * toggle, hiding-zone toggle, and per-mode transit overlay toggles.
 * Positioned by its parent in SeekerPage; pushed up above the
 * HiderTimer during the hiding period.
 *
 * v266: the room-code pill that used to sit above this got removed
 * per user feedback — players reach the room code via the lobby
 * drawer.
 *
 *
 * Both chips share the same `h-9` height so the cluster reads as a
 * single compact toolbar.
 */

export function MapDisplayControls() {
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

    // Only render transit buttons for modes that are actually
    // allowed in this session's game settings — no point cluttering
    // the popover with a Ferry toggle for a landlocked play area.
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

    // How many overlays are currently active? Surfaces a tiny count
    // badge on the Map-options chip so the user can see at a glance
    // that something is on without opening the popover.
    const activeCount =
        (Number($satellite) || 0) +
        (Number($hidingZones) || 0) +
        (Number($subway && showSubwayBtn) || 0) +
        (Number($bus && showBusBtn) || 0) +
        (Number($ferry && showFerryBtn) || 0) +
        (Number($train && showTrainBtn) || 0) +
        (Number($tram && showTramBtn) || 0);

    return (
        <div className="flex flex-col gap-2 items-start">
            {/* Map options — single popover with all display toggles. */}
            <Popover>
                <PopoverTrigger asChild>
                    <button
                        type="button"
                        aria-label="Map display options"
                        className={cn(
                            "relative shadow-md rounded-md border-2 border-border bg-background",
                            // v314: square footprint bumped from
                            // h-12/w-12 to h-14/w-14 — with the
                            // glyph now at w-8 the previous
                            // 8 px-per-side padding read as cramped.
                            // 12 px on each side gives the icon some
                            // breathing room.
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
                    className="w-[260px] p-3 bg-card border-2 border-border shadow-xl space-y-3"
                >
                    {/* Map / Satellite */}
                    <div className="space-y-1.5">
                        <div className="text-[10px] uppercase tracking-[0.16em] font-poppins font-bold text-muted-foreground">
                            Basemap
                        </div>
                        <div
                            className={cn(
                                "rounded-md border-2 border-border bg-background overflow-hidden",
                                "flex h-9",
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
                                <MapIcon className="w-3.5 h-3.5" />
                                <span className="text-xs font-poppins font-semibold">
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
                                <Satellite className="w-3.5 h-3.5" />
                                <span className="text-xs font-poppins font-semibold">
                                    Satellite
                                </span>
                            </button>
                        </div>
                    </div>

                    {/* Hiding zones */}
                    <div className="space-y-1.5">
                        <div className="text-[10px] uppercase tracking-[0.16em] font-poppins font-bold text-muted-foreground">
                            Overlays
                        </div>
                        <button
                            type="button"
                            onClick={() =>
                                displayHidingZones.set(!$hidingZones)
                            }
                            aria-pressed={$hidingZones}
                            className={cn(
                                "w-full rounded-md border-2 h-9",
                                "px-3 gap-2 flex items-center transition-colors",
                                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                $hidingZones
                                    ? "bg-primary border-primary text-primary-foreground hover:bg-primary/90"
                                    : "bg-background border-border hover:bg-accent",
                            )}
                            title="Toggle hiding zones overlay"
                        >
                            <Target className="w-4 h-4 shrink-0" />
                            <span className="text-xs font-poppins font-semibold">
                                Hiding zones
                            </span>
                            {$isLoading && (
                                <Loader2 className="w-3.5 h-3.5 animate-spin ml-auto" />
                            )}
                        </button>
                        {/* Travel times — labels the earliest arrival
                            at each station for the hider, given they
                            departed from the game-start location when
                            the hiding period began. Only stations
                            reachable before the hiding period ends are
                            shown. Requires hiding zones + GPS at game
                            start. Powered by the overpass-cache
                            worker's /api/journey/arrivals proxy. */}
                        <button
                            type="button"
                            onClick={() =>
                                showTravelTimes.set(!$showTravelTimes)
                            }
                            aria-pressed={$showTravelTimes}
                            className={cn(
                                "w-full rounded-md border-2 h-9",
                                "px-3 gap-2 flex items-center transition-colors",
                                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                $showTravelTimes
                                    ? "bg-primary border-primary text-primary-foreground hover:bg-primary/90"
                                    : "bg-background border-border hover:bg-accent",
                            )}
                            title="Stations reachable within the hiding period (requires Hiding zones + GPS at game start)"
                        >
                            <Clock className="w-4 h-4 shrink-0" />
                            <span className="text-xs font-poppins font-semibold">
                                Travel times
                            </span>
                        </button>
                    </div>

                    {/* Save image — captures the current map view as
                        a PNG. Replaces the leaflet-easyprint control
                        the old Leaflet map had; MapV2 listens for the
                        custom event and snapshots its WebGL canvas. */}
                    <div className="space-y-1.5">
                        <div className="text-[10px] uppercase tracking-[0.16em] font-poppins font-bold text-muted-foreground">
                            Export
                        </div>
                        <button
                            type="button"
                            onClick={() => {
                                window.dispatchEvent(
                                    new CustomEvent("jlhs:save-map-image"),
                                );
                            }}
                            className={cn(
                                "w-full rounded-md border-2 h-9",
                                "px-3 gap-2 flex items-center transition-colors",
                                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                "bg-background border-border hover:bg-accent",
                            )}
                            title="Save current map view as a PNG image"
                        >
                            <Camera className="w-4 h-4 shrink-0" />
                            <span className="text-xs font-poppins font-semibold">
                                Save image
                            </span>
                        </button>
                    </div>

                    {/* Per-mode transit toggles */}
                    {hasAnyTransitBtn && (
                        <div className="space-y-1.5">
                            <div className="text-[10px] uppercase tracking-[0.16em] font-poppins font-bold text-muted-foreground">
                                Transit overlays
                            </div>
                            <div
                                className={cn(
                                    "rounded-md border-2 border-border bg-background overflow-hidden",
                                    "flex h-9",
                                )}
                                role="group"
                                aria-label="Transit overlays"
                            >
                                {(() => {
                                    const buttons: React.ReactNode[] = [];
                                    if (showSubwayBtn) {
                                        buttons.push(
                                            <TransitIconToggle
                                                key="subway"
                                                icon={TRANSIT_ICONS.subway}
                                                label="Subway"
                                                on={$subway}
                                                loading={
                                                    $transitLoading.subway
                                                }
                                                onToggle={() =>
                                                    showSubwayRoutes.set(
                                                        !$subway,
                                                    )
                                                }
                                                borderLeft={buttons.length > 0}
                                            />,
                                        );
                                    }
                                    if (showBusBtn) {
                                        buttons.push(
                                            <TransitIconToggle
                                                key="bus"
                                                icon={TRANSIT_ICONS.bus}
                                                label="Bus"
                                                on={$bus}
                                                loading={$transitLoading.bus}
                                                onToggle={() =>
                                                    showBusRoutes.set(!$bus)
                                                }
                                                borderLeft={buttons.length > 0}
                                            />,
                                        );
                                    }
                                    if (showFerryBtn) {
                                        buttons.push(
                                            <TransitIconToggle
                                                key="ferry"
                                                icon={TRANSIT_ICONS.ferry}
                                                label="Ferry"
                                                on={$ferry}
                                                loading={
                                                    $transitLoading.ferry
                                                }
                                                onToggle={() =>
                                                    showFerryRoutes.set(
                                                        !$ferry,
                                                    )
                                                }
                                                borderLeft={buttons.length > 0}
                                            />,
                                        );
                                    }
                                    // Colored, named-service line overlays
                                    // per rail mode (train / tram). v488
                                    // dropped the old all-rail OpenRailwayMap
                                    // raster toggle — the per-mode overlays
                                    // cover it.
                                    if (showTrainBtn) {
                                        buttons.push(
                                            <TransitIconToggle
                                                key="train"
                                                icon={TRANSIT_ICONS.train}
                                                label="Train (lines)"
                                                on={$train}
                                                loading={
                                                    $transitLoading.train
                                                }
                                                onToggle={() =>
                                                    showTrainRoutes.set(
                                                        !$train,
                                                    )
                                                }
                                                borderLeft={buttons.length > 0}
                                            />,
                                        );
                                    }
                                    if (showTramBtn) {
                                        buttons.push(
                                            <TransitIconToggle
                                                key="tram"
                                                icon={TRANSIT_ICONS.tram}
                                                label="Tram (lines)"
                                                on={$tram}
                                                loading={
                                                    $transitLoading.tram
                                                }
                                                onToggle={() =>
                                                    showTramRoutes.set(
                                                        !$tram,
                                                    )
                                                }
                                                borderLeft={buttons.length > 0}
                                            />,
                                        );
                                    }
                                    return buttons;
                                })()}
                            </div>
                        </div>
                    )}
                </PopoverContent>
            </Popover>
        </div>
    );
}

function TransitIconToggle({
    icon: Icon,
    label,
    on,
    loading,
    onToggle,
    borderLeft,
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
                <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
                <Icon className="w-4 h-4" />
            )}
        </button>
    );
}
