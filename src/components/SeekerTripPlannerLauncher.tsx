import { Route } from "lucide-react";

import { seekerTripPlannerOpen } from "@/lib/journey/state";
import { cn } from "@/lib/utils";

/**
 * Small chip that opens the seeker's `SeekerTripPlannerSheet`.
 * Sits in the top-right map-controls stack underneath
 * `MapDisplayControls` — same visual weight as the other map chips.
 *
 * No reactive state to read — the launcher only writes to the open
 * atom; the sheet itself subscribes.
 */
export function SeekerTripPlannerLauncher() {
    return (
        <button
            type="button"
            onClick={() => seekerTripPlannerOpen.set(true)}
            aria-label="Plan a trip"
            title="Plan a trip from your GPS to a place"
            className={cn(
                "shadow-md rounded-md border-2 border-border bg-background",
                "h-9 px-3 gap-1.5 flex items-center justify-center transition-colors",
                "hover:bg-accent",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            )}
        >
            <Route className="w-4 h-4" />
            <span className="text-xs font-poppins font-semibold">
                Plan trip
            </span>
        </button>
    );
}

export default SeekerTripPlannerLauncher;
