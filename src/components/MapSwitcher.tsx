import { useStore } from "@nanostores/react";
import { lazy, Suspense } from "react";

import { useMapLibre } from "@/lib/featureFlags";

// Both map implementations are lazy-loaded so only the one the user
// actually renders ships over the wire. Leaflet (Map.tsx) is the
// legacy safety-net path; MapLibre (MapV2.tsx) is the default. Each
// pulls in ~600 KB+ of map runtime so loading both would double the
// initial JS payload for no benefit.
const MapV2 = lazy(() =>
    import("./MapV2").then((m) => ({ default: m.MapV2 })),
);
const LeafletMap = lazy(() =>
    import("./Map").then((m) => ({ default: m.Map })),
);

/**
 * Picks between the Leaflet-backed Map and the MapLibre-backed
 * MapV2 based on the `useMapLibre` feature flag. MapLibre is the
 * default; the Leaflet path is kept around so a real-game
 * regression can be worked around with one localStorage toggle.
 *
 * To switch back to Leaflet:
 *
 *     localStorage.setItem('jlhs:useMapLibre', 'false');
 *     location.reload();
 */
export function MapSwitcher({ className }: { className?: string }) {
    const $useMapLibre = useStore(useMapLibre);
    return (
        <Suspense fallback={null}>
            {$useMapLibre ? (
                <MapV2 className={className} />
            ) : (
                <LeafletMap className={className} />
            )}
        </Suspense>
    );
}

export default MapSwitcher;
