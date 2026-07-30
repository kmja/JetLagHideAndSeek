import { useStore } from "@nanostores/react";
import { circle as turfCircle } from "@turf/turf";
import { useEffect, useRef } from "react";

import { lastKnownPosition } from "@/lib/context";
import { haversineMeters } from "@/lib/geo";
import { allowedTransit, gameSize, hidingPeriodEndsAt } from "@/lib/gameSetup";
import { radiusForGameSize } from "@/lib/hiderRole";
import { hidingZone } from "@/lib/hiderRole";
import { hiderInZoneFC, hiderInZones } from "@/lib/journey/state";
import { findZonesNearPoint } from "@/lib/journey/stations";

/**
 * v1177: computes the candidate hiding zones the hider is CURRENTLY STANDING IN
 * — the zones whose hiding-radius circle contains their live GPS — and publishes
 * them to `hiderInZones` (the list, for the timer nudge) + `hiderInZoneFC` (the
 * circle polygons, for the subtle on-map highlight).
 *
 * Runs only during the hiding period before a zone is committed (the actionable
 * window). Deband-throttled: it only re-queries when the hider has moved
 * ≥ MOVE_DEBAND_M since the last fetch, so stationary GPS jitter doesn't spam
 * the (cheap, play-area-keyed) `findZonesNearPoint` lookup. Clears both atoms
 * whenever it's not applicable (committed / past the whistle / no GPS).
 *
 * A headless watcher (renders nothing) mounted on `HiderPage`, mirroring
 * `HiderReachOverlay` / `SeekerProximityWatcher`.
 */
const MOVE_DEBAND_M = 25;

export function HiderInZoneWatcher() {
    const $endsAt = useStore(hidingPeriodEndsAt);
    const $zone = useStore(hidingZone);
    const $gps = useStore(lastKnownPosition);
    const $allowed = useStore(allowedTransit);
    const $gameSize = useStore(gameSize);

    const active =
        $endsAt !== null &&
        $zone === null &&
        $gps !== null &&
        Date.now() < $endsAt;

    const lastAnchorRef = useRef<{ lat: number; lng: number } | null>(null);

    useEffect(() => {
        if (!active || !$gps) {
            hiderInZones.set([]);
            hiderInZoneFC.set(null);
            lastAnchorRef.current = null;
            return;
        }
        // Deband: skip a fetch until the hider has actually moved. Keeps the
        // prior result on tiny jitter (the effect still re-runs on every fix,
        // but bails cheaply here).
        const prev = lastAnchorRef.current;
        if (
            prev &&
            haversineMeters(prev.lat, prev.lng, $gps.lat, $gps.lng) <
                MOVE_DEBAND_M
        ) {
            return;
        }
        lastAnchorRef.current = { lat: $gps.lat, lng: $gps.lng };

        const radiusMeters = radiusForGameSize($gameSize);
        let cancelled = false;
        void findZonesNearPoint($gps.lat, $gps.lng, {
            allowed: $allowed,
            radiusMeters,
        })
            .then((zones) => {
                if (cancelled) return;
                hiderInZones.set(zones);
                hiderInZoneFC.set(
                    zones.length > 0
                        ? {
                              type: "FeatureCollection",
                              features: zones.map((z) =>
                                  turfCircle(
                                      [z.lng, z.lat],
                                      radiusMeters / 1000,
                                      {
                                          steps: 128,
                                          units: "kilometers",
                                          properties: {
                                              name: z.name,
                                              stopId: String(z.id),
                                          },
                                      },
                                  ),
                              ),
                          }
                        : null,
                );
            })
            .catch(() => {
                // Keep the prior result on a transient failure; a later move
                // retries. Allow this anchor to be re-fetched.
                if (!cancelled) lastAnchorRef.current = null;
            });
        return () => {
            cancelled = true;
        };
    }, [active, $gps, $allowed, $gameSize]);

    return null;
}

export default HiderInZoneWatcher;
