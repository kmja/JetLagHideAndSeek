import { useEffect, useState } from "react";

import { lastKnownPosition } from "@/lib/context";

export interface SelfPosition {
    lat: number;
    lng: number;
}

/**
 * Shared "you are here" geolocation watch for BOTH the seeker (`Map`)
 * and hider (`HiderBackgroundMap`) maps.
 *
 * Runs `navigator.geolocation.watchPosition` for the whole session,
 * writes every fix to the `lastKnownPosition` atom (so question pickers,
 * trip-plan and reach features all read the player's real position), and
 * returns the latest fix for the caller's own marker / follow-me logic.
 * Errors are silent — a denied or unavailable fix just means no dot, no
 * toast spam on every load.
 *
 * Previously this watch was inline in `Map.tsx` only, so the hider map
 * never populated `lastKnownPosition` and the hider's own GPS dot never
 * appeared (fixed v498). Extracted here so the two maps share one watch.
 */
export function useSelfPositionWatch(): SelfPosition | null {
    const [position, setPosition] = useState<SelfPosition | null>(null);

    useEffect(() => {
        if (typeof navigator === "undefined" || !navigator.geolocation) {
            return;
        }
        const id = navigator.geolocation.watchPosition(
            (pos) => {
                const next = {
                    lat: pos.coords.latitude,
                    lng: pos.coords.longitude,
                };
                setPosition(next);
                lastKnownPosition.set(next);
            },
            () => {
                // Stay quiet — no dot is the correct degraded state.
            },
            { enableHighAccuracy: true, maximumAge: 10_000, timeout: 20_000 },
        );
        return () => {
            navigator.geolocation.clearWatch(id);
        };
    }, []);

    return position;
}
