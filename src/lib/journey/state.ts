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

/** Which anchor the journey planner uses as the start point.
 *   - hider: the hider's last-known location (latest answered
 *     question's coordinates + that question's createdAt
 *     timestamp). The seeker's primary use case — "where could
 *     the hider be by now?".
 *   - seeker: the seeker's own current GPS position + now. Used
 *     for personal travel planning — "if I leave now, when do
 *     I arrive at this station?". */
export type JourneyAnchorMode = "hider" | "seeker";

export const journeyAnchorMode = persistentAtom<JourneyAnchorMode>(
    "jlhs:journeyAnchorMode",
    "hider",
    {
        encode: (v) => v,
        decode: (v) => (v === "seeker" ? "seeker" : "hider"),
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
 *   - arrivalLabel (string | undefined) — "HH:MM" or "" when unknown
 *   - reachable (boolean) — true if arrival is at or after the anchor's
 *     departAt (i.e. the time wasn't ruled out by being in the past
 *     relative to the journey starting point).
 *   - reached  (boolean) — true if arrival is in the past relative to
 *     now. Map.tsx uses this to color the label red.
 */
export const travelTimesFC = atom<GeoJSON.FeatureCollection<
    GeoJSON.Point,
    {
        stopId: string;
        name?: string;
        arrivalLabel?: string;
        reachable?: boolean;
        reached?: boolean;
    }
> | null>(null);
