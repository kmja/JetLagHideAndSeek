import { useStore } from "@nanostores/react";
import { useEffect, useRef } from "react";

import { lastKnownPosition } from "@/lib/context";
import { allowedTransit } from "@/lib/gameSetup";
import { hidingZone } from "@/lib/hiderRole";
import { fetchTripPlan } from "@/lib/journey/plan";
import { journeyToRouteFC } from "@/lib/journey/route";
import { tripRouteFC } from "@/lib/journey/state";

/**
 * Persistent, HEADLESS owner of the committed-hiding-zone route overlay.
 *
 * `HiderTripPlanCard` used to draw the trip route (via `useOwnedTripRoute`),
 * but it lives inside the Zone drawer (`HiderHomeContent`), which vaul
 * UNMOUNTS when the drawer closes — so the route to the committed zone
 * vanished the moment the hider dismissed the drawer to look at the map
 * (the "map frames my spot + the station but shows no route" bug). This
 * component is mounted directly on `HiderPage`, so it lives for the whole
 * seeking phase and keeps the route painted whether or not the drawer is
 * open. The card keeps its own `JourneyCard` (its plan is R2-cached, so the
 * second lookup is a cache hit).
 *
 * Plan lifecycle mirrors the card: plan ONCE when a GPS fix is first
 * available, re-plan only on zone / allowed-mode change (GPS jitter is
 * deliberately ignored — a stationary city fix jumps hundreds of metres).
 * It also RE-ASSERTS its route if another writer (a tapped
 * `StationTransitCard`) drew and then cleared its own route, so dismissing
 * a tapped-zone card restores the committed-zone route instead of leaving
 * the map bare.
 */
export function HiderZoneRoute() {
    const $gps = useStore(lastKnownPosition);
    const $zone = useStore(hidingZone);
    const $allowed = useStore(allowedTransit);
    const $trip = useStore(tripRouteFC);
    const hasGps = $gps != null;

    const myRouteRef = useRef<GeoJSON.FeatureCollection | null>(null);
    const lastSigRef = useRef<string | null>(null);

    useEffect(() => {
        if (!$zone || !hasGps) {
            // Zone uncommitted (or no fix): drop our route if we still own
            // what's on the map, and reset so a future commit re-plans.
            if (
                myRouteRef.current &&
                tripRouteFC.get() === myRouteRef.current
            ) {
                tripRouteFC.set(null);
            }
            myRouteRef.current = null;
            lastSigRef.current = null;
            return;
        }
        const sig = `${$zone.stationLat},${$zone.stationLng}|${$allowed.join(",")}`;
        if (lastSigRef.current === sig) return;
        const gps = lastKnownPosition.get();
        if (!gps) return;
        lastSigRef.current = sig;

        let cancelled = false;
        const controller = new AbortController();
        (async () => {
            const resp = await fetchTripPlan(
                {
                    origin: { lat: gps.lat, lng: gps.lng },
                    destination: {
                        lat: $zone.stationLat,
                        lng: $zone.stationLng,
                        name: $zone.stationName,
                    },
                    departAt: Date.now(),
                    modes: $allowed,
                },
                controller.signal,
            );
            if (cancelled || !resp?.journey) return;
            const fc = journeyToRouteFC(resp.journey);
            myRouteRef.current = fc;
            tripRouteFC.set(fc);
        })();
        return () => {
            cancelled = true;
            controller.abort();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [$zone?.stationLat, $zone?.stationLng, $allowed, hasGps]);

    // Re-assert the committed-zone route if something else cleared the
    // overlay while a zone is still committed — e.g. the hider tapped a
    // different zone (StationTransitCard drew its own route) and then
    // dismissed it (which nulls the atom). Without this the committed route
    // wouldn't come back until a zone/mode change re-planned it.
    useEffect(() => {
        if ($zone && myRouteRef.current && $trip === null) {
            tripRouteFC.set(myRouteRef.current);
        }
    }, [$trip, $zone]);

    return null;
}

export default HiderZoneRoute;
