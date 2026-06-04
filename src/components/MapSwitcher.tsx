import { useStore } from "@nanostores/react";
import { lazy, Suspense } from "react";

import { useMapLibre } from "@/lib/featureFlags";

import { Map as LeafletMap } from "./Map";

// MapV2 is lazy-loaded so the heavyweight maplibre-gl bundle
// (~600 KB minified) only ships when the user actually flips
// the feature flag. While the flag is off this comes out as
// dead code at build time.
const MapV2 = lazy(() =>
    import("./MapV2").then((m) => ({ default: m.MapV2 })),
);

/**
 * Picks between the Leaflet-backed Map and the MapLibre-backed
 * MapV2 based on the `useMapLibre` feature flag. While we work
 * MapV2 to parity (see its header checklist), users on the
 * default flag value (false) see the existing Leaflet
 * implementation — nothing changes for them.
 *
 * To preview MapV2 in the browser:
 *
 *     localStorage.setItem('jlhs:useMapLibre', 'true');
 *     location.reload();
 *
 * Flip back with `false`.
 */
export function MapSwitcher({ className }: { className?: string }) {
    const $useMapLibre = useStore(useMapLibre);
    if ($useMapLibre) {
        return (
            <Suspense fallback={null}>
                <MapV2 className={className} />
            </Suspense>
        );
    }
    return <LeafletMap className={className} />;
}

export default MapSwitcher;
