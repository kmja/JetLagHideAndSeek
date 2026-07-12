import { useStore } from "@nanostores/react";
import { useEffect, useRef, useState } from "react";

import { JourneyCard } from "@/components/JourneyCard";
import { lastKnownPosition } from "@/lib/context";
import { allowedTransit } from "@/lib/gameSetup";
import { hidingZone } from "@/lib/hiderRole";
import { fetchTripPlan, type Journey } from "@/lib/journey/plan";

/**
 * Hider's trip-plan card. Fetches a journey from the hider's live
 * GPS to their committed `hidingZone` station and renders it with
 * `JourneyCard`.
 *
 * Lifecycle: mounts when the hider has committed a zone (parent
 * is responsible for gating on `hidingZone !== null`). The fetch
 * runs ONCE when a GPS fix is first available and re-fires only when
 * the zone identity or allowed modes change, or the user taps Refresh
 * (which recomputes from the current GPS). GPS coordinate changes are
 * deliberately ignored: a city fix can jump hundreds of metres while
 * standing still, which used to re-plan endlessly (v620).
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
    // We only need to know IF we have a fix to drive the first plan — NOT
    // the live coordinates. A city GPS fix can jump hundreds of metres
    // while standing still (urban multipath), past any sane movement
    // threshold, which made the card reload constantly. So we plan once
    // when a fix is available and re-plan only on Refresh / zone / mode
    // changes (see effect).
    const hasGps = $gps != null;

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
        if (!$zone || !hasGps) return;
        const zoneKey = `${$zone.stationLat},${$zone.stationLng}`;
        // GPS is deliberately NOT in the signature or deps — a jittering
        // city fix can't re-run this. We read the freshest
        // `lastKnownPosition` lazily at plan time (so Refresh recomputes
        // from where you are now). Re-fires only on zone / mode / Refresh
        // changes, or a GPS fix first becoming available (initial plan).
        const sig = `${zoneKey}|${$allowed.join(",")}|${nonce}`;
        if (lastSigRef.current === sig) return;
        const gps = lastKnownPosition.get();
        if (!gps) return;
        lastSigRef.current = sig;

        let cancelled = false;
        const controller = new AbortController();
        setLoading(true);
        setError(null);

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
    }, [$zone?.stationLat, $zone?.stationLng, $allowed, nonce, hasGps]);

    // NOTE: the map route overlay is owned by the PERSISTENT `HiderZoneRoute`
    // (mounted on HiderPage), NOT here — this card lives in the Zone drawer,
    // which vaul unmounts on close, so owning the route here made it vanish
    // the moment the drawer closed (v774). This card just renders the
    // JourneyCard detail; the route stays on the map regardless.

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
