import { useEffect, useRef } from "react";

import type { Journey } from "@/lib/journey/plan";
import { journeyToRouteFC } from "@/lib/journey/route";
import { tripRouteFC } from "@/lib/journey/state";

/**
 * Publish `journey` to the shared `tripRouteFC` map overlay with
 * OWNERSHIP tracking.
 *
 * Three components write this one atom (`StationTransitCard`,
 * `HiderTripPlanCard`, `SeekerTripPlannerSheet`), and the old pattern —
 * every writer unconditionally `set(null)` when its own journey was
 * null or on unmount — meant any of them could silently wipe a route
 * ANOTHER one had just drawn (e.g. the zone drawer closing cleared the
 * station card's route — a reported "trip route never shows on the map"
 * bug). Each writer now remembers the exact FC it published and only
 * clears the atom if it still holds THAT object.
 */
export function useOwnedTripRoute(journey: Journey | null) {
    const mine = useRef<GeoJSON.FeatureCollection | null>(null);

    useEffect(() => {
        if (journey) {
            const fc = journeyToRouteFC(journey);
            mine.current = fc;
            tripRouteFC.set(fc);
        } else if (mine.current && tripRouteFC.get() === mine.current) {
            tripRouteFC.set(null);
            mine.current = null;
        }
    }, [journey]);

    // Unmount: clear only if the overlay still shows OUR route.
    useEffect(
        () => () => {
            if (mine.current && tripRouteFC.get() === mine.current) {
                tripRouteFC.set(null);
            }
        },
        [],
    );
}
