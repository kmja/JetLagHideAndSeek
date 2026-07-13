import { useStore } from "@nanostores/react";
import type { Dispatch, SetStateAction } from "react";
import { useEffect, useState } from "react";

import { mapGeoLocation, polyGeoJSON } from "@/lib/context";
import {
    allowedTransit,
    showBusRoutes,
    showFerryRoutes,
    showSubwayRoutes,
    showTrainRoutes,
    showTramRoutes,
    type TransitMode,
    transitRoutesLoading,
} from "@/lib/gameSetup";
import { fetchTransitRoutesFeatures } from "@/maps/api/transitRoutes";

export type TransitFC = Record<TransitMode, GeoJSON.FeatureCollection | null>;

/**
 * Shared transit-route-overlay fetcher for BOTH the seeker (`Map`) and
 * hider (`HiderBackgroundMap`) maps.
 *
 * Each per-mode toggle (subway / bus / ferry / train / tram), gated on
 * the game's `allowedTransit` set, drives an Overpass fetch via
 * `fetchTransitRoutesFeatures`. Results are returned as a per-mode map of
 * FeatureCollections; render them with `<TransitRouteLayers>`. Re-fetches
 * when the play area changes so cached results from a previous area get
 * replaced. The in-flight loading flag is mirrored into
 * `transitRoutesLoading` so the map-options spinner shows during a fetch.
 *
 * This used to live inline in `Map.tsx` only — so the hider map's
 * identical toggles did nothing (no fetch, no render). Extracted here so
 * the two maps stay in lockstep and a fix to one reaches both.
 */
/**
 * One mode's fetch effect. Split out (one effect per mode, fixed count) so
 * toggling ANOTHER mode — or the same mode re-rendering — doesn't re-fetch
 * this one or cancel its in-flight request. The old single effect over all
 * five modes re-ran on any toggle and re-fetched every enabled mode (a
 * spurious loading-spinner flash on already-loaded overlays); worse, a
 * naive "only fetch the changed mode" guard on that shared effect would
 * have cancelled an in-flight fetch for an unchanged mode without
 * restarting it. A per-mode effect fixes both cleanly: it fires only when
 * THIS mode's on-state or the play area changes.
 */
function useOneTransitOverlay(
    mode: TransitMode,
    on: boolean,
    areaKey: string | number,
    setTransitFC: Dispatch<SetStateAction<TransitFC>>,
): void {
    useEffect(() => {
        let cancelled = false;
        if (!on) {
            setTransitFC((curr) => ({ ...curr, [mode]: null }));
            return;
        }
        const curr = transitRoutesLoading.get();
        transitRoutesLoading.set({ ...curr, [mode]: true });
        void (async () => {
            try {
                const fc = await fetchTransitRoutesFeatures(mode);
                if (cancelled) return;
                setTransitFC((c) => ({ ...c, [mode]: fc }));
            } catch (e) {
                console.warn(`transit (${mode}) fetch failed`, e);
            } finally {
                // Don't clobber the loading flag if the effect was torn
                // down mid-flight — we'd be writing a stale store after the
                // user toggled away.
                if (!cancelled) {
                    const c = transitRoutesLoading.get();
                    transitRoutesLoading.set({ ...c, [mode]: false });
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [mode, on, areaKey, setTransitFC]);
}

export function useTransitRouteOverlays(): TransitFC {
    const $allowedTransit = useStore(allowedTransit);
    const $subway = useStore(showSubwayRoutes);
    const $bus = useStore(showBusRoutes);
    const $ferry = useStore(showFerryRoutes);
    const $train = useStore(showTrainRoutes);
    const $tram = useStore(showTramRoutes);
    const $mapGeoLocation = useStore(mapGeoLocation);
    const $polyGeoJSON = useStore(polyGeoJSON);

    const subwayOn = $subway && $allowedTransit.includes("subway");
    const busOn = $bus && $allowedTransit.includes("bus");
    const ferryOn = $ferry && $allowedTransit.includes("ferry");
    const trainOn = $train && $allowedTransit.includes("train");
    const tramOn = $tram && $allowedTransit.includes("tram");

    const [transitFC, setTransitFC] = useState<TransitFC>({
        subway: null,
        bus: null,
        ferry: null,
        train: null,
        tram: null,
    });

    const areaKey =
        $mapGeoLocation?.properties?.osm_id ??
        ($polyGeoJSON ? "custom-poly" : "none");

    useOneTransitOverlay("subway", subwayOn, areaKey, setTransitFC);
    useOneTransitOverlay("bus", busOn, areaKey, setTransitFC);
    useOneTransitOverlay("ferry", ferryOn, areaKey, setTransitFC);
    useOneTransitOverlay("train", trainOn, areaKey, setTransitFC);
    useOneTransitOverlay("tram", tramOn, areaKey, setTransitFC);

    return transitFC;
}
