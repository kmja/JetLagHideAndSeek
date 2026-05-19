import { useStore } from "@nanostores/react";
import { Satellite, TrainFront } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar-r";
import { satelliteView, showTransitLines } from "@/lib/gameSetup";

/**
 * Top-right cluster of map-display controls.
 *
 * - Zones trigger: opens the right sidebar (ZoneSidebar). Used to live by
 *   itself at top-right on desktop only; now lives here on both desktop
 *   and mobile, since the Zone button got reassigned to "Game" in the
 *   bottom nav.
 * - Satellite toggle: overlays Esri World Imagery on top of the base tile
 *   layer. Map.tsx reads `satelliteView` directly and renders the overlay.
 * - Transit-lines toggle: overlays OpenRailwayMap tiles. Same pattern —
 *   Map.tsx reads `showTransitLines` and renders the overlay.
 */
export function MapDisplayControls() {
    const $satellite = useStore(satelliteView);
    const $transit = useStore(showTransitLines);

    return (
        <div className="flex flex-col gap-2 items-end">
            <SidebarTrigger
                className="shadow-md"
                aria-label="Open zone settings"
            />
            <Button
                variant={$satellite ? "default" : "outline"}
                size="icon"
                className="shadow-md"
                onClick={() => satelliteView.set(!$satellite)}
                aria-label="Toggle satellite view"
                aria-pressed={$satellite}
                title="Toggle satellite view"
            >
                <Satellite className="w-4 h-4" />
            </Button>
            <Button
                variant={$transit ? "default" : "outline"}
                size="icon"
                className="shadow-md"
                onClick={() => showTransitLines.set(!$transit)}
                aria-label="Toggle transit lines"
                aria-pressed={$transit}
                title="Toggle transit lines"
            >
                <TrainFront className="w-4 h-4" />
            </Button>
        </div>
    );
}
