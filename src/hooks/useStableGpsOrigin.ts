import { useEffect, useState } from "react";

import { haversineMeters } from "@/lib/geo";

/**
 * Default movement threshold (metres) for trip re-planning. A standing
 * phone's GPS drifts ~10–40 m every few seconds; 150 m comfortably clears
 * that jitter while still re-planning once the seeker/hider has genuinely
 * moved a block or two (which can change the nearest stop / fastest route).
 */
export const TRIP_REPLAN_THRESHOLD_M = 150;

export interface LatLng {
    lat: number;
    lng: number;
}

/**
 * Hysteresis over a live GPS position: returns a "settled" origin that
 * only updates once the device has moved more than `thresholdM` from the
 * last settled point. Trip planners gate their plan effect on THIS value
 * (not the raw fix) so a few metres of jitter doesn't re-run the effect —
 * which previously aborted the in-flight route request on every tick and
 * made the card reload constantly. Only a real move past the threshold
 * (or an explicit Refresh) re-plans.
 */
export function useStableGpsOrigin(
    gps: LatLng | null | undefined,
    thresholdM: number = TRIP_REPLAN_THRESHOLD_M,
): LatLng | null {
    const [origin, setOrigin] = useState<LatLng | null>(
        gps ? { lat: gps.lat, lng: gps.lng } : null,
    );
    useEffect(() => {
        if (!gps) return;
        setOrigin((prev) => {
            if (!prev) return { lat: gps.lat, lng: gps.lng };
            const moved = haversineMeters(
                prev.lat,
                prev.lng,
                gps.lat,
                gps.lng,
            );
            return moved > thresholdM ? { lat: gps.lat, lng: gps.lng } : prev;
        });
    }, [gps?.lat, gps?.lng, thresholdM]);
    return origin;
}
