import { useStore } from "@nanostores/react";
import type { LucideIcon } from "lucide-react";
import {
    Bus,
    Layers,
    Loader2,
    Map as MapIcon,
    Satellite,
    Ship,
    Train,
    TrainTrack,
} from "lucide-react";

import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import {
    allowedTransit,
    satelliteView,
    showBusRoutes,
    showFerryRoutes,
    showSubwayRoutes,
    showTransitLines,
    transitRoutesLoading,
} from "@/lib/gameSetup";
import { cn } from "@/lib/utils";

/**
 * Hider-side counterpart to MapDisplayControls. Same popover shape
 * as the seeker's, but trimmed:
 *
 *   • Basemap (Map / Satellite)
 *   • Per-mode transit overlays
 *
 * The seeker-only "Hiding zones" overlay (lists every possible zone
 * the seeker might quiz on), "Travel times" (seeker mobility), and
 * "Save image" (game-state share) all stay off the hider menu —
 * they're either irrelevant to the hider's view or could leak
 * deduction shape back to the seeker via a screenshot.
 */
const PANE_HEIGHT = "h-9";

export function HiderMapDisplayControls() {
    const $satellite = useStore(satelliteView);
    const $rail = useStore(showTransitLines);
    const $subway = useStore(showSubwayRoutes);
    const $bus = useStore(showBusRoutes);
    const $ferry = useStore(showFerryRoutes);
    const $allowedTransit = useStore(allowedTransit);
    const $transitLoading = useStore(transitRoutesLoading);

    const showRailBtn =
        $allowedTransit.includes("train") || $allowedTransit.includes("tram");
    const showSubwayBtn = $allowedTransit.includes("subway");
    const showBusBtn = $allowedTransit.includes("bus");
    const showFerryBtn = $allowedTransit.includes("ferry");
    const hasAnyTransitBtn =
        showRailBtn || showSubwayBtn || showBusBtn || showFerryBtn;

    const activeCount =
        (Number($satellite) || 0) +
        (Number($rail && showRailBtn) || 0) +
        (Number($subway && showSubwayBtn) || 0) +
        (Number($bus && showBusBtn) || 0) +
        (Number($ferry && showFerryBtn) || 0);

    return (
        <Popover>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    aria-label="Map display options"
                    className={cn(
                        "relative shadow-md rounded-md border-2 border-border bg-background",
                        // v314: bumped from h-12/w-12 to h-14/w-14
                        // — the doubled glyph (w-8) needed more
                        // padding to keep the button from reading
                        // as cramped.
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
                align="end"
                className="w-[260px] p-3 bg-card border-2 border-border shadow-xl space-y-3"
            >
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
                                            label="Rail (train/tram)"
                                            on={$rail}
                                            onToggle={() =>
                                                showTransitLines.set(!$rail)
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
                                            loading={$transitLoading.subway}
                                            onToggle={() =>
                                                showSubwayRoutes.set(!$subway)
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
                                            loading={$transitLoading.ferry}
                                            onToggle={() =>
                                                showFerryRoutes.set(!$ferry)
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

export default HiderMapDisplayControls;
