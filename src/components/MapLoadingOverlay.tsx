import { useStore } from "@nanostores/react";
import { Loader2 } from "lucide-react";

import {
    mapGeoJSON,
    mapGeoLocation,
    polyGeoJSON,
} from "@/lib/context";
import { cn } from "@/lib/utils";

/**
 * Full-bleed loading veil over the map while we don't yet have a boundary
 * polygon to render. Triggers whenever:
 *
 *   - `mapGeoJSON` is null (no Overpass-fetched polygon cached this load)
 *   - AND `polyGeoJSON` is null (no manually drawn polygon either)
 *   - AND `mapGeoLocation` points to a real OSM relation (osm_id > 0)
 *
 * In practice this fires for ~the first 1–5 seconds after a wizard finish
 * or a "New game" play-area change, while determineMapBoundaries() pulls
 * the relation from Overpass. Before the fix, the seeker would see an
 * unrestricted world map for those seconds — confusing because the play
 * area is supposed to be visibly limited.
 */
export function MapLoadingOverlay() {
    const $mapGeoJSON = useStore(mapGeoJSON);
    const $polyGeoJSON = useStore(polyGeoJSON);
    const $mapGeoLocation = useStore(mapGeoLocation);

    const haveBoundary = Boolean($mapGeoJSON || $polyGeoJSON);
    const haveValidLocation =
        ($mapGeoLocation?.properties?.osm_id ?? 0) > 0;

    // Only veil when we're *expecting* a boundary to arrive but it hasn't
    // landed yet. If mapGeoLocation has no real osm_id (e.g. fresh game
    // before the wizard, or a stale state), don't get stuck behind the veil.
    const shouldShow = !haveBoundary && haveValidLocation;

    if (!shouldShow) return null;

    const name = $mapGeoLocation?.properties?.name ?? "play area";

    return (
        <div
            className={cn(
                "absolute inset-0 z-[1020] pointer-events-none",
                "flex items-center justify-center",
                "bg-background/80 backdrop-blur-sm",
                "transition-opacity duration-200",
            )}
            role="status"
            aria-live="polite"
        >
            <div
                className={cn(
                    "pointer-events-auto",
                    "flex items-center gap-3 px-5 py-3 rounded-md",
                    "bg-card border-2 border-primary shadow-xl",
                    "max-w-[90vw]",
                )}
            >
                <Loader2 className="w-5 h-5 text-primary animate-spin shrink-0" />
                <div className="min-w-0">
                    <div className="font-inter-tight font-black uppercase text-xs tracking-[0.12em] text-primary">
                        Loading play area
                    </div>
                    <div className="text-sm font-medium truncate">{name}</div>
                </div>
            </div>
        </div>
    );
}

export default MapLoadingOverlay;
