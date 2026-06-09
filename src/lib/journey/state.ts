/**
 * Journey-overlay state. Atoms only; the fetching + rendering glue
 * lives in `components/TravelTimesOverlay.tsx`.
 */

import { persistentAtom } from "@nanostores/persistent";
import { atom } from "nanostores";

/** Whether the Travel Times overlay is currently rendered. */
export const showTravelTimes = persistentAtom<boolean>(
    "jlhs:showTravelTimes",
    false,
    {
        encode: (v) => (v ? "true" : "false"),
        decode: (v) => v === "true",
    },
);

/**
 * Overlay shadow atom — TravelTimesOverlay writes the rendered
 * station FeatureCollection (with arrival-time props baked in) here,
 * and Map.tsx renders it as a symbol Source/Layer pair. Same shadow-
 * atom pattern hiding-zones uses. Null when the overlay is off OR
 * before the first fetch completes.
 *
 * Each feature is a Point with these properties:
 *   - stopId  (string)
 *   - name    (string | undefined)
 *   - arrivalLabel (string) — "HH:MM" for reachable stations, "" while
 *     the API is still loading (optimistic pre-fetch step).
 *
 * Only stations reachable before hidingPeriodEndsAt are included
 * in the final (post-fetch) set.
 */
export const travelTimesFC = atom<GeoJSON.FeatureCollection<
    GeoJSON.Point,
    {
        stopId: string;
        name?: string;
        arrivalLabel: string;
    }
> | null>(null);
