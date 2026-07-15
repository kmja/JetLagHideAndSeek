import { useStore } from "@nanostores/react";
import type { LucideIcon } from "lucide-react";
import {
    Loader2,
    Map as MapIcon,
    MapPin,
    Radar,
    Satellite,
    Search,
    X,
} from "lucide-react";
import { useState } from "react";
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
import {
    HIDER_POI_BY_KIND,
    HIDER_POI_CATALOG,
    HIDER_POI_GROUPS,
    hiderPoiHighlightKind,
    hiderPoiShow,
} from "@/lib/hiderPois";
import { hidingZone } from "@/lib/hiderRole";
import { hiderReachLoading, showHiderReach } from "@/lib/journey/state";
import { cn } from "@/lib/utils";

/**
 * Hider-side counterpart to the seeker's MapDisplayControls (v632: brought
 * to parity with the seeker's bottom-nav "Map" pattern). One shared
 * `HiderMapOptionsPanel` is rendered inside a vaul bottom sheet
 * (`HiderMapOptionsDrawer`) opened from the hider bottom-nav "Map" slot.
 * Trimmed vs. the seeker's panel:
 *
 *   • Basemap (Map / Satellite)
 *   • Hiding zones (candidate-zone station field; v643)
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
    const $poiHighlight = useStore(hiderPoiHighlightKind);

    const showSubwayBtn = $allowedTransit.includes("subway");
    const showBusBtn = $allowedTransit.includes("bus");
    const showFerryBtn = $allowedTransit.includes("ferry");
    const showTrainBtn = $allowedTransit.includes("train");
    const showTramBtn = $allowedTransit.includes("tram");

    return (
        (Number($satellite) || 0) +
        (Number($reach) || 0) +
        (Number($poiHighlight !== "") || 0) +
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
    const $reachLoading = useStore(hiderReachLoading);

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
                    className="grid grid-cols-2 gap-2"
                    role="group"
                    aria-label="Map style"
                >
                    <button
                        type="button"
                        onClick={() => satelliteView.set(false)}
                        aria-pressed={!$satellite}
                        className={cn(
                            "px-2 gap-1.5 flex items-center justify-center rounded-lg border-2 transition-all",
                            rowH,
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            !$satellite
                                ? "bg-primary/10 border-primary text-primary"
                                : "bg-secondary border-border text-muted-foreground hover:bg-accent",
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
                            "px-2 gap-1.5 flex items-center justify-center rounded-lg border-2 transition-all",
                            rowH,
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            $satellite
                                ? "bg-primary/10 border-primary text-primary"
                                : "bg-secondary border-border text-muted-foreground hover:bg-accent",
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

            {/* Hiding-zones overlay — paints every candidate hiding-zone
                station in the play area as name-labeled dots (v643: same
                look as the seeker's hiding-zones overlay). Tap a zone to
                plan a route and check whether it's reachable before the
                whistle. Self-disables when GPS is missing, when the zone is
                committed, or post-hiding-period. */}
            <div className="space-y-2">
                <div className={label}>Overlays</div>
                <button
                    type="button"
                    onClick={() => showHiderReach.set(!$reach)}
                    aria-pressed={$reach}
                    className={cn(
                        "w-full rounded-lg border-2 px-3 gap-2.5 flex items-center transition-all",
                        rowH,
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        $reach
                            ? "bg-primary/10 border-primary text-primary"
                            : "bg-secondary border-border text-muted-foreground hover:bg-accent",
                    )}
                    title="Show candidate hiding zones — tap one to plan a route and check reachability"
                >
                    <Radar className={cn(rowIcon, "shrink-0")} />
                    <span className={cn("font-poppins font-semibold", rowText)}>
                        Hiding zones
                    </span>
                    {$reachLoading && (
                        <Loader2 className="w-4 h-4 animate-spin ml-auto" />
                    )}
                </button>
            </div>

            <HiderPoiSection label={label} roomy={roomy} />

            {hasAnyTransitBtn && (
                <div className="space-y-2">
                    <div className={label}>Transit overlays</div>
                    <div
                        className="grid grid-cols-2 gap-2"
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
                                        label="Train"
                                        on={$train}
                                        loading={$transitLoading.train}
                                        onToggle={() =>
                                            showTrainRoutes.set(!$train)
                                        }
                                        iconClass={rowIcon}
                                    />,
                                );
                            }
                            if (showTramBtn) {
                                buttons.push(
                                    <TransitIconToggle
                                        key="tram"
                                        icon={TRANSIT_ICONS.tram}
                                        label="Tram"
                                        on={$tram}
                                        loading={$transitLoading.tram}
                                        onToggle={() =>
                                            showTramRoutes.set(!$tram)
                                        }
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
                                Basemap, hiding zones, places, and transit
                                lines.
                            </VaulDrawer.Description>
                        </div>
                        <HiderMapOptionsPanel roomy />
                    </div>
                </VaulDrawer.Content>
            </VaulDrawer.Portal>
        </VaulDrawer.Root>
    );
}

/**
 * Points-of-interest controls. Once the hider commits a zone, the useful
 * POI field (cafes / shops / toilets / parks…) is drawn AUTOMATICALLY
 * within that zone, straight from the basemap pmtiles (Overpass-free, via
 * `HiderPoiOverlay`). A master toggle turns the whole field off; a SEARCH
 * field HIGHLIGHTS one kind (e.g. supermarkets) so the hider sees where
 * all of them in their zone are at a glance.
 */
function HiderPoiSection({ label, roomy }: { label: string; roomy: boolean }) {
    const $show = useStore(hiderPoiShow);
    const $highlight = useStore(hiderPoiHighlightKind);
    const $zone = useStore(hidingZone);
    const [query, setQuery] = useState("");

    const q = query.trim().toLowerCase();
    const results = q
        ? HIDER_POI_CATALOG.filter(
              (d) =>
                  d.label.toLowerCase().includes(q) ||
                  d.kind.includes(q) ||
                  HIDER_POI_GROUPS[d.group].label.toLowerCase().includes(q),
          ).slice(0, 8)
        : [];

    const highlightDef = $highlight ? HIDER_POI_BY_KIND[$highlight] : null;
    const inputH = roomy ? "h-11" : "h-9";
    const rowH = roomy ? "h-12" : "h-9";
    const rowText = roomy ? "text-sm" : "text-xs";

    const pickHighlight = (kind: string) => {
        hiderPoiHighlightKind.set(kind);
        // Turning on a highlight implies the field should be visible.
        if (!hiderPoiShow.get()) hiderPoiShow.set(true);
        setQuery("");
    };

    return (
        <div className="space-y-2">
            <div className={label}>Points of interest</div>

            {/* Master on/off for the in-zone POI field. */}
            <button
                type="button"
                onClick={() => hiderPoiShow.set(!$show)}
                aria-pressed={$show}
                className={cn(
                    "w-full rounded-lg border-2 px-3 gap-2.5 flex items-center transition-all",
                    rowH,
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    $show
                        ? "bg-primary/10 border-primary text-primary"
                        : "bg-secondary border-border text-muted-foreground hover:bg-accent",
                )}
            >
                <MapPin className={cn(roomy ? "w-5 h-5" : "w-3.5 h-3.5", "shrink-0")} />
                <span className={cn("font-poppins font-semibold", rowText)}>
                    Places in my zone
                </span>
            </button>

            {!$zone && (
                <p className="text-[11px] text-muted-foreground px-0.5 leading-snug">
                    Commit a hiding zone to see the places inside it.
                </p>
            )}

            {/* Active highlight chip. */}
            {highlightDef && (
                <div className="flex items-center gap-2">
                    <span className="text-[11px] text-muted-foreground">
                        Highlighting
                    </span>
                    <span className="inline-flex items-center gap-1.5 rounded-full border-2 border-primary bg-primary/10 pl-2.5 pr-1.5 py-1 text-xs font-medium text-primary">
                        <span
                            className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
                            style={{
                                backgroundColor:
                                    HIDER_POI_GROUPS[highlightDef.group].color,
                            }}
                            aria-hidden="true"
                        />
                        {highlightDef.label}
                        <button
                            type="button"
                            onClick={() => hiderPoiHighlightKind.set("")}
                            aria-label="Clear highlight"
                            className="text-primary/70 hover:text-primary"
                        >
                            <X className="w-3.5 h-3.5" />
                        </button>
                    </span>
                </div>
            )}

            {/* Search to highlight one kind (e.g. supermarkets). */}
            <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Highlight a place type (supermarket, library…)"
                    className={cn(
                        "w-full rounded-lg border-2 border-border bg-secondary pl-8 pr-3 text-sm",
                        "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        inputH,
                    )}
                />
            </div>
            {results.length > 0 && (
                <div className="flex flex-col gap-1 rounded-lg border border-border bg-background/60 p-1">
                    {results.map((d) => (
                        <button
                            key={d.kind}
                            type="button"
                            onClick={() => pickHighlight(d.kind)}
                            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                        >
                            <span
                                className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
                                style={{
                                    backgroundColor:
                                        HIDER_POI_GROUPS[d.group].color,
                                }}
                                aria-hidden="true"
                            />
                            <span className="flex-1 min-w-0 truncate">
                                {d.label}
                            </span>
                            <span className="text-[11px] text-muted-foreground">
                                {HIDER_POI_GROUPS[d.group].label}
                            </span>
                        </button>
                    ))}
                </div>
            )}
            {q && results.length === 0 && (
                <p className="text-[11px] text-muted-foreground px-0.5">
                    No matching place type — try &quot;cafe&quot;,
                    &quot;museum&quot;, &quot;park&quot;…
                </p>
            )}
        </div>
    );
}

function TransitIconToggle({
    icon: Icon,
    label,
    on,
    loading,
    onToggle,
    iconClass = "w-4 h-4",
}: {
    icon: LucideIcon;
    label: string;
    on: boolean;
    loading?: boolean;
    onToggle: () => void;
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
                // Self-contained pill filling its grid cell, label beside the
                // icon — matches the seeker's MapDisplayControls (v809/v834).
                "w-full flex items-center justify-center gap-1.5 py-2 px-2.5",
                "rounded-lg border-2 transition-all",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                loading
                    ? "bg-primary/10 border-primary/40 text-primary"
                    : on
                      ? "bg-primary/10 border-primary text-primary"
                      : "bg-secondary border-border text-muted-foreground hover:bg-accent",
            )}
        >
            {loading ? (
                <Loader2 className={cn(iconClass, "shrink-0 animate-spin")} />
            ) : (
                <Icon className={cn(iconClass, "shrink-0")} />
            )}
            <span className="text-xs font-poppins font-semibold leading-none text-center">
                {label}
            </span>
        </button>
    );
}

export default HiderMapOptionsDrawer;
