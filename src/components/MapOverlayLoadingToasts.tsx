import { useStore } from "@nanostores/react";
import { Loader2 } from "lucide-react";

import { displayHidingZones, isLoading } from "@/lib/context";
import { transitRoutesLoading } from "@/lib/gameSetup";
import { hiderReachLoading, travelTimesLoading } from "@/lib/journey/state";
import { cn } from "@/lib/utils";

/**
 * Small "Loading …" pills at the top of the map while any async map
 * overlay is computing — the top-of-map counterpart to the per-toggle
 * spinners in the map-options panels, so loading is legible even with the
 * panel closed.
 *
 * Shared by the seeker `Map` (mounted in `SeekerPage`) and the hider
 * `HiderBackgroundMap`. Each mounts it and it surfaces whichever overlays
 * are loading in that view — the other view's atoms are always false
 * because only one map is ever mounted. Hiding-zones has two producers
 * (seeker `isLoading` via `ZoneSidebar`, hider `hiderReachLoading` via
 * `HiderReachOverlay`); both map to the one "Loading hiding zones…" pill.
 *
 * `pointer-events-none` so it never blocks a tap on the map beneath.
 */
export function MapOverlayLoadingToasts() {
    // Call every hook UNCONDITIONALLY — a short-circuited `useStore(a) &&
    // useStore(b)` skips the second hook when `a` is falsy and trips React
    // error #310 (fewer hooks than the previous render), crashing the map.
    const $isLoading = useStore(isLoading);
    const $displayHidingZones = useStore(displayHidingZones);
    const hiderZones = useStore(hiderReachLoading);
    const travel = useStore(travelTimesLoading);
    const transit = useStore(transitRoutesLoading);

    // Gate the seeker flag on the toggle: its compute isn't abortable, so
    // `isLoading` can linger for a beat after the overlay is switched off.
    const seekerZones = $isLoading && $displayHidingZones;
    const anyTransit = Object.values(transit).some(Boolean);
    const items: string[] = [];
    if (seekerZones || hiderZones) items.push("Loading hiding zones…");
    if (travel) items.push("Loading travel times…");
    if (anyTransit) items.push("Loading transit lines…");

    if (items.length === 0) return null;

    return (
        <div className="pointer-events-none absolute left-1/2 top-2 z-[1035] flex -translate-x-1/2 flex-col items-center gap-1.5">
            {items.map((labelText) => (
                <div
                    key={labelText}
                    className={cn(
                        "flex items-center gap-2 rounded-full px-3 py-1.5",
                        "border border-border bg-background/90 shadow-md backdrop-blur-sm",
                        "font-poppins text-xs font-semibold text-foreground",
                        "animate-in fade-in slide-in-from-top-1 duration-200",
                    )}
                >
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                    {labelText}
                </div>
            ))}
        </div>
    );
}

export default MapOverlayLoadingToasts;
