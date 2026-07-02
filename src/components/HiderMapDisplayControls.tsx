import { useStore } from "@nanostores/react";
import type { LucideIcon } from "lucide-react";
import { Loader2, Map as MapIcon, Radar, Satellite } from "lucide-react";
import { Drawer as VaulDrawer } from "vaul";

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
import { showHiderReach } from "@/lib/journey/state";
import { cn } from "@/lib/utils";

/**
 * Hider-side counterpart to the seeker's MapDisplayControls (v632: brought
 * to parity with the seeker's bottom-nav "Map" pattern). One shared
 * `HiderMapOptionsPanel` is rendered inside a vaul bottom sheet
 * (`HiderMapOptionsDrawer`) opened from the hider bottom-nav "Map" slot.
 * Trimmed vs. the seeker's panel:
 *
 *   • Basemap (Map / Satellite)
 *   • Reach ("Reachable zones" overlay)
 *   • Per-mode transit overlays
 *
 * The seeker-only "Hiding zones" overlay (lists every possible zone the
 * seeker might quiz on), "Travel times" (seeker mobility), and "Save
 * image" (game-state share) all stay off the hider menu — they're either
 * irrelevant to the hider's view or could leak deduction shape back to
 * the seeker via a screenshot.
 *
 * The old floating top-right `Layers` popover was removed: the hider
 * bottom nav is shown on every viewport, so the nav "Map" slot is the
 * single entry point (mirrors the seeker's mobile surface).
 */

/** Count of active hider map overlays — drives the bottom-nav "Map"
 *  badge (mirrors the seeker's `useMapOptionsActiveCount`). */
export function useHiderMapOptionsActiveCount(): number {
    const $satellite = useStore(satelliteView);
    const $subway = useStore(showSubwayRoutes);
    const $bus = useStore(showBusRoutes);
    const $ferry = useStore(showFerryRoutes);
    const $train = useStore(showTrainRoutes);
    const $tram = useStore(showTramRoutes);
    const $allowedTransit = useStore(allowedTransit);
    const $reach = useStore(showHiderReach);

    const showSubwayBtn = $allowedTransit.includes("subway");
    const showBusBtn = $allowedTransit.includes("bus");
    const showFerryBtn = $allowedTransit.includes("ferry");
    const showTrainBtn = $allowedTransit.includes("train");
    const showTramBtn = $allowedTransit.includes("tram");

    return (
        (Number($satellite) || 0) +
        (Number($reach) || 0) +
        (Number($subway && showSubwayBtn) || 0) +
        (Number($bus && showBusBtn) || 0) +
        (Number($ferry && showFerryBtn) || 0) +
        (Number($train && showTrainBtn) || 0) +
        (Number($tram && showTramBtn) || 0)
    );
}

/** The shared options body. `roomy` bumps touch targets for the drawer. */
export function HiderMapOptionsPanel({ roomy = false }: { roomy?: boolean }) {
    const $satellite = useStore(satelliteView);
    const $subway = useStore(showSubwayRoutes);
    const $bus = useStore(showBusRoutes);
    const $ferry = useStore(showFerryRoutes);
    const $train = useStore(showTrainRoutes);
    const $tram = useStore(showTramRoutes);
    const $allowedTransit = useStore(allowedTransit);
    const $transitLoading = useStore(transitRoutesLoading);
    const $reach = useStore(showHiderReach);

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
    const rowIcon = roomy ? "w-5 h-5" : "w-3.5 h-3.5";
    const sectionGap = roomy ? "space-y-5" : "space-y-3";
    const label =
        "text-[11px] uppercase tracking-[0.16em] font-poppins font-bold text-muted-foreground";

    return (
        <div className={sectionGap}>
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
                            className={cn("font-poppins font-semibold", rowText)}
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
                            className={cn("font-poppins font-semibold", rowText)}
                        >
                            Satellite
                        </span>
                    </button>
                </div>
            </div>

            {/* Hiding-zones overlay — paints EVERY candidate hiding zone in
                the area, colour-coded by whether the hider can reach it
                before the whistle (green reachable / red out of reach /
                amber pending). Self-disables when GPS is missing, when the
                zone is committed, or post-hiding-period. */}
            <div className="space-y-2">
                <div className={label}>Overlays</div>
                <button
                    type="button"
                    onClick={() => showHiderReach.set(!$reach)}
                    aria-pressed={$reach}
                    className={cn(
                        "w-full rounded-lg border-2 px-3 gap-2.5 flex items-center transition-colors",
                        rowH,
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        $reach
                            ? "bg-primary border-primary text-primary-foreground hover:bg-primary/90"
                            : "bg-background border-border hover:bg-accent",
                    )}
                    title="Show candidate hiding zones, colour-coded green (reachable in time) vs red (out of reach)"
                >
                    <Radar className={cn(rowIcon, "shrink-0")} />
                    <span className={cn("font-poppins font-semibold", rowText)}>
                        Hiding zones
                    </span>
                </button>
            </div>

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
                            if (showSubwayBtn) {
                                buttons.push(
                                    <TransitIconToggle
                                        key="subway"
                                        icon={TRANSIT_ICONS.subway}
                                        label="Subway"
                                        on={$subway}
                                        loading={$transitLoading.subway}
                                        onToggle={() =>
                                            showSubwayRoutes.set(!$subway)
                                        }
                                        borderLeft={buttons.length > 0}
                                        iconClass={rowIcon}
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
                                        iconClass={rowIcon}
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
                                        loading={$transitLoading.ferry}
                                        onToggle={() =>
                                            showFerryRoutes.set(!$ferry)
                                        }
                                        borderLeft={buttons.length > 0}
                                        iconClass={rowIcon}
                                    />,
                                );
                            }
                            // Colored, named-service line overlays per rail
                            // mode (train / tram). v488 dropped the old
                            // all-rail OpenRailwayMap raster toggle.
                            if (showTrainBtn) {
                                buttons.push(
                                    <TransitIconToggle
                                        key="train"
                                        icon={TRANSIT_ICONS.train}
                                        label="Train (lines)"
                                        on={$train}
                                        loading={$transitLoading.train}
                                        onToggle={() =>
                                            showTrainRoutes.set(!$train)
                                        }
                                        borderLeft={buttons.length > 0}
                                        iconClass={rowIcon}
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
                                        loading={$transitLoading.tram}
                                        onToggle={() =>
                                            showTramRoutes.set(!$tram)
                                        }
                                        borderLeft={buttons.length > 0}
                                        iconClass={rowIcon}
                                    />,
                                );
                            }
                            return buttons;
                        })()}
                    </div>
                </div>
            )}
        </div>
    );
}

/**
 * Bottom sheet opened from the hider bottom-nav "Map" slot. Roomy panel
 * with big touch targets. Mirrors the seeker's `MapOptionsDrawer`; reuses
 * the shared `mapOptionsDrawerOpen` atom (the seeker + hider views never
 * coexist, so there's no cross-talk).
 */
export function HiderMapOptionsDrawer() {
    const open = useStore(mapOptionsDrawerOpen);
    return (
        <VaulDrawer.Root
            open={open}
            onOpenChange={(o) => mapOptionsDrawerOpen.set(o)}
            shouldScaleBackground={false}
        >
            <VaulDrawer.Portal>
                <VaulDrawer.Overlay className="fixed inset-0 z-[1040] bg-black/60" />
                <VaulDrawer.Content className="fixed inset-x-0 bottom-0 z-[1045] mt-24 flex h-auto max-h-[85vh] flex-col rounded-t-[10px] border bg-background text-foreground pb-[env(safe-area-inset-bottom)] sm:max-w-md sm:mx-auto">
                    <div className="mx-auto mt-3 mb-1 h-1.5 w-12 shrink-0 rounded-full bg-foreground/25" />
                    <div className="overflow-y-auto px-6 pt-4 pb-8">
                        <div className="space-y-1 mb-4">
                            <VaulDrawer.Title className="text-lg font-semibold leading-none tracking-tight">
                                Map options
                            </VaulDrawer.Title>
                            <VaulDrawer.Description className="text-sm text-muted-foreground">
                                Basemap, hiding zones, and transit lines.
                            </VaulDrawer.Description>
                        </div>
                        <HiderMapOptionsPanel roomy />
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

export default HiderMapOptionsDrawer;
