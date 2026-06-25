import { useStore } from "@nanostores/react";
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

    useEffect(() => {
        let cancelled = false;
        const fetchAndSet = async (mode: TransitMode, on: boolean) => {
            if (!on) {
                setTransitFC((curr) => ({ ...curr, [mode]: null }));
                return;
            }
            const curr = transitRoutesLoading.get();
            transitRoutesLoading.set({ ...curr, [mode]: true });
            try {
                const fc = await fetchTransitRoutesFeatures(mode);
                if (cancelled) return;
                setTransitFC((c) => ({ ...c, [mode]: fc }));
            } catch (e) {
                console.warn(`transit (${mode}) fetch failed`, e);
            } finally {
                // Don't clobber the loading flag if the effect was already
                // torn down — we'd be writing into a stale store after the
                // user toggled away. Skip-with-guard instead of
                // return-from-finally so we don't swallow any in-flight
                // exception escape.
                if (!cancelled) {
                    const c = transitRoutesLoading.get();
                    transitRoutesLoading.set({ ...c, [mode]: false });
                }
            }
        };
        fetchAndSet("subway", subwayOn);
        fetchAndSet("bus", busOn);
        fetchAndSet("ferry", ferryOn);
        fetchAndSet("train", trainOn);
        fetchAndSet("tram", tramOn);
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [subwayOn, busOn, ferryOn, trainOn, tramOn, areaKey]);

    return transitFC;
}
