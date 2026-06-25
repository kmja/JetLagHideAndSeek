import { useStore } from "@nanostores/react";
import { useEffect, useRef, useState } from "react";

import { JourneyCard } from "@/components/JourneyCard";
import { lastKnownPosition } from "@/lib/context";
import { allowedTransit } from "@/lib/gameSetup";
import { hidingZone } from "@/lib/hiderRole";
import { fetchTripPlan, type Journey } from "@/lib/journey/plan";
import { journeyToRouteFC } from "@/lib/journey/route";
import { tripRouteFC } from "@/lib/journey/state";

/**
 * Hider's trip-plan card. Fetches a journey from the hider's live
 * GPS to their committed `hidingZone` station and renders it with
 * `JourneyCard`.
 *
 * Lifecycle: mounts when the hider has committed a zone (parent
 * is responsible for gating on `hidingZone !== null`). The fetch
 * re-fires whenever GPS moves more than 75 m OR the zone identity
 * changes OR the user taps refresh — anything finer would burn
 * proxy quota for trivially-different plans.
 *
 * The card is *intentionally* a present-tense plan. We don't
 * pre-compute "what would happen if you started at hiding-period
 * start"; the hider asks the question while standing somewhere,
 * and they care about how to get to their zone *from where they
 * are now*. The worker's walking backstop guarantees a plan even
 * when no regional planner serves the origin.
 */
export function HiderTripPlanCard() {
    const $gps = useStore(lastKnownPosition);
    const $zone = useStore(hidingZone);
    const $allowed = useStore(allowedTransit);

    const [journey, setJourney] = useState<Journey | null>(null);
    const [source, setSource] = useState<string | undefined>(undefined);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [nonce, setNonce] = useState(0);
    // Signature of the inputs the plan actually depends on (zone + allowed
    // modes + manual-refresh nonce). GPS is deliberately NOT part of it:
    // a phone's position jitters tens of metres every few seconds, and
    // re-planning on every twitch made the card flicker + reload
    // constantly. We plan once for a zone and let the user tap Refresh to
    // re-plan from their current spot.
    const lastSigRef = useRef<string | null>(null);

    useEffect(() => {
        if (!$zone || !$gps) return;
        const zoneKey = `${$zone.stationLat},${$zone.stationLng}`;
        const sig = `${zoneKey}|${$allowed.join(",")}|${nonce}`;
        // GPS drift alone leaves the signature unchanged → no re-plan.
        // Only a new zone, a transit-mode change, or a Refresh tap re-plans
        // (reading the CURRENT GPS at fetch time).
        if (lastSigRef.current === sig) return;
        lastSigRef.current = sig;

        let cancelled = false;
        const controller = new AbortController();
        setLoading(true);
        setError(null);

        (async () => {
            const resp = await fetchTripPlan(
                {
                    origin: { lat: $gps.lat, lng: $gps.lng },
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
            if (cancelled) return;
            setLoading(false);
            if (!resp) {
                setJourney(null);
                setSource(undefined);
                setError(
                    "Couldn't reach the route planner — check your connection.",
                );
                return;
            }
            setJourney(resp.journey);
            setSource(resp.source);
            if (!resp.journey) {
                setError("No route could be planned right now.");
            }
        })();

        return () => {
            cancelled = true;
            controller.abort();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        $zone?.stationLat,
        $zone?.stationLng,
        $gps?.lat,
        $gps?.lng,
        $allowed,
        nonce,
    ]);

    // Mirror the planned journey onto the map route overlay; clear it
    // when the card unmounts (zone uncommitted / new round).
    useEffect(() => {
        tripRouteFC.set(journey ? journeyToRouteFC(journey) : null);
    }, [journey]);
    useEffect(() => () => tripRouteFC.set(null), []);

    if (!$zone) return null;

    return (
        <JourneyCard
            title={`Trip to ${$zone.stationName}`}
            journey={journey}
            source={source}
            loading={loading}
            error={error}
            onRefresh={() => setNonce((n) => n + 1)}
        />
    );
}

export default HiderTripPlanCard;
