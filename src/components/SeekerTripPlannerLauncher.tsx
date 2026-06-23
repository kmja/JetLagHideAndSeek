import { Search } from "lucide-react";

import { seekerTripPlannerOpen } from "@/lib/journey/state";
import { cn } from "@/lib/utils";

/**
 * Secondary trip-planning entry: opens `SeekerTripPlannerSheet`'s
 * search-by-name flow. The primary entry is now a map tap on a
 * candidate hiding zone (resolved by Map.tsx → selectedMapStation →
 * `StationTransitCard`), so this chip is the fallback for "I want to
 * check somewhere that isn't a visible station" (a landmark, an
 * address, a "lat,lng" paste). Sits in the top-right map-controls
 * stack underneath `MapDisplayControls`.
 */
export function SeekerTripPlannerLauncher() {
    return (
        <button
            type="button"
            onClick={() => seekerTripPlannerOpen.set(true)}
            aria-label="Search a place to plan a trip"
            title="Search a place — for stations, tap them on the map instead"
            className={cn(
                "shadow-md rounded-md border-2 border-border bg-background",
                "h-9 px-3 gap-1.5 flex items-center justify-center transition-colors",
                "hover:bg-accent",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                // v446: fade in with the rest of the in-game top cluster.
                "animate-in fade-in duration-200",
            )}
        >
            <Search className="w-4 h-4" />
            <span className="text-xs font-poppins font-semibold">
                Search place
            </span>
        </button>
    );
}

export default SeekerTripPlannerLauncher;
