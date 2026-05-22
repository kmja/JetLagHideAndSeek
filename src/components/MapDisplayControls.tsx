import { useStore } from "@nanostores/react";
import {
    Bus,
    Layers,
    Loader2,
    Map as MapIcon,
    Satellite,
    Ship,
    Target,
    Train,
    TrainTrack,
    Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { InvitePanel } from "@/components/multiplayer/InviteSheet";
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
    showTransitLines,
    transitRoutesLoading,
} from "@/lib/gameSetup";
import { currentGameCode } from "@/lib/multiplayer/session";
import { cn } from "@/lib/utils";

/**
 * Top-right cluster — now collapsed into two compact dropdown chips
 * so the map view stays uncluttered:
 *
 *  1. Online game chip — shows the active 6-char code; tap to open a
 *     popover with the full `InvitePanel` (copy / share / leave +
 *     participant roster). Only renders when actually in a room.
 *
 *  2. Map options chip — basemap + hiding-zone toggle + per-mode
 *     transit overlay toggles, all under one popover.
 *
 * Both chips share the same `h-9` height so the cluster reads as a
 * single compact toolbar.
 */
const PANE_HEIGHT = "h-9";

export function MapDisplayControls() {
    const $satellite = useStore(satelliteView);
    const $rail = useStore(showTransitLines);
    const $subway = useStore(showSubwayRoutes);
    const $bus = useStore(showBusRoutes);
    const $ferry = useStore(showFerryRoutes);
    const $hidingZones = useStore(displayHidingZones);
    const $isLoading = useStore(isLoading);
    const $allowedTransit = useStore(allowedTransit);
    const $transitLoading = useStore(transitRoutesLoading);
    const $gameCode = useStore(currentGameCode);

    // Only render transit buttons for modes that are actually
    // allowed in this session's game settings — no point cluttering
    // the popover with a Ferry toggle for a landlocked play area.
    const showRailBtn =
        $allowedTransit.includes("train") || $allowedTransit.includes("tram");
    const showSubwayBtn = $allowedTransit.includes("subway");
    const showBusBtn = $allowedTransit.includes("bus");
    const showFerryBtn = $allowedTransit.includes("ferry");
    const hasAnyTransitBtn =
        showRailBtn || showSubwayBtn || showBusBtn || showFerryBtn;

    // How many overlays are currently active? Surfaces a tiny count
    // badge on the Map-options chip so the user can see at a glance
    // that something is on without opening the popover.
    const activeCount =
        (Number($satellite) || 0) +
        (Number($hidingZones) || 0) +
        (Number($rail && showRailBtn) || 0) +
        (Number($subway && showSubwayBtn) || 0) +
        (Number($bus && showBusBtn) || 0) +
        (Number($ferry && showFerryBtn) || 0);

    return (
        <div className="flex flex-col gap-2 items-end">
            {/* Online game chip — only when in a room. Tap opens the
                full InvitePanel for sharing + presence + leave. */}
            {$gameCode && (
                <Popover>
                    <PopoverTrigger asChild>
                        <button
                            type="button"
                            className={cn(
                                "shadow-md rounded-md border-2 border-primary",
                                "px-3 gap-2 flex items-center transition-colors",
                                "bg-primary/10 hover:bg-primary/20",
                                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                PANE_HEIGHT,
                            )}
                            title="Online game — tap to share or leave"
                        >
                            <Users className="w-4 h-4 text-primary" />
                            <span className="font-mono font-black tracking-[0.18em] text-xs text-primary">
                                {$gameCode}
                            </span>
                        </button>
                    </PopoverTrigger>
                    <PopoverContent
                        align="end"
                        className="w-[300px] p-3 bg-card border-2 border-border shadow-xl"
                    >
                        <InvitePanel />
                    </PopoverContent>
                </Popover>
            )}

            {/* Map options — single popover with all display toggles. */}
            <Popover>
                <PopoverTrigger asChild>
                    <button
                        type="button"
                        className={cn(
                            "shadow-md rounded-md border-2 border-border bg-background",
                            "px-3 gap-2 flex items-center transition-colors",
                            "hover:bg-accent",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            PANE_HEIGHT,
                        )}
                        title="Map display options"
                    >
                        <Layers className="w-4 h-4" />
                        <span className="text-xs font-poppins font-semibold">
                            Map options
                        </span>
                        {activeCount > 0 && (
                            <span
                                className={cn(
                                    "inline-flex items-center justify-center",
                                    "min-w-[18px] h-[18px] px-1 rounded-full",
                                    "bg-primary text-primary-foreground",
                                    "text-[10px] font-poppins font-bold tabular-nums",
                                )}
                                aria-label={`${activeCount} option(s) active`}
                            >
                                {activeCount}
                            </span>
                        )}
                    </button>
                </PopoverTrigger>
                <PopoverContent
                    align="end"
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
                                    if (showRailBtn) {
                                        buttons.push(
                                            <TransitIconToggle
                                                key="rail"
                                                icon={Train}
                                                label="Rail (train/tram — bundled OpenRailwayMap layer)"
                                                on={$rail}
                                                onToggle={() =>
                                                    showTransitLines.set(
                                                        !$rail,
                                                    )
                                                }
                                                borderLeft={buttons.length > 0}
                                            />,
                                        );
                                    }
                                    if (showSubwayBtn) {
                                        buttons.push(
                                            <TransitIconToggle
                                                key="subway"
                                                icon={TrainTrack}
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
                                                icon={Bus}
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
                                                icon={Ship}
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
