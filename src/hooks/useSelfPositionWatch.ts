import { useEffect, useRef, useState } from "react";

import { lastKnownPosition } from "@/lib/context";

export interface SelfPosition {
    lat: number;
    lng: number;
}

/** Metres between two lng/lat points (haversine). */
function metersBetween(a: SelfPosition, b: SelfPosition): number {
    const R = 6371000;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const s =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(a.lat)) *
            Math.cos(toRad(b.lat)) *
            Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// Only propagate a fix that MOVED at least this far — cuts the re-render
// fan-out from stationary GPS jitter (a fix arrives ~1/sec whether you moved
// or not, and both whole map subtrees + every `lastKnownPosition` subscriber
// re-render per fix). A time cap still lets a slow drift through.
const MIN_MOVE_M = 6;
const MAX_STALE_MS = 4000;

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
    const lastRef = useRef<{ pos: SelfPosition; t: number } | null>(null);

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
                const now = Date.now();
                const prev = lastRef.current;
                // Skip a fix that barely moved (unless it's been a while) so
                // GPS jitter doesn't force a re-render of both maps every tick.
                if (
                    prev &&
                    metersBetween(prev.pos, next) < MIN_MOVE_M &&
                    now - prev.t < MAX_STALE_MS
                ) {
                    return;
                }
                lastRef.current = { pos: next, t: now };
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
