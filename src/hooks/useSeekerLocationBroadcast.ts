import { useStore } from "@nanostores/react";
import { useEffect, useRef } from "react";

import { hidingPeriodEndsAt } from "@/lib/gameSetup";
import { playerRole } from "@/lib/hiderRole";
import {
    multiplayerEnabled,
    seekerLocationSharing,
} from "@/lib/multiplayer/session";
import { seekerPushLocation } from "@/lib/multiplayer/store";

/**
 * Per rulebook p5, every seeker shares their live location with the
 * hider for the duration of the round. This hook owns that broadcast
 * from the seeker's device:
 *
 *   - watchPosition listens for native GPS updates and pushes each
 *     fix over the multiplayer transport.
 *   - A 30 s heartbeat re-pushes the most recent fix even when the
 *     seeker hasn't moved — keeps the hider's "last seen" pin from
 *     going stale on a stationary seeker.
 *   - A 5 s minimum gap between broadcasts caps bandwidth and
 *     dovetails with the server's monotonic-ts drop.
 *
 * Gates:
 *   - Local role must be "seeker". Hide-team devices don't broadcast.
 *   - Multiplayer must be enabled (otherwise there's nowhere to push).
 *   - The user-facing `seekerLocationSharing` toggle must be true —
 *     defaults on (rulebook expectation) but exposed so a player can
 *     opt out for privacy / debugging.
 *   - `hidingPeriodEndsAt` must be set, i.e. the game is live. We
 *     don't broadcast during pre-game setup.
 *
 * No-op until all four are true; flips back to inactive cleanly when
 * any of them go false (clears the watch + heartbeat).
 */
const MIN_BROADCAST_GAP_MS = 5_000;
const HEARTBEAT_MS = 30_000;

export function useSeekerLocationBroadcast() {
    const $role = useStore(playerRole);
    const $mp = useStore(multiplayerEnabled);
    const $sharing = useStore(seekerLocationSharing);
    const $endsAt = useStore(hidingPeriodEndsAt);

    const lastSentRef = useRef<{
        lat: number;
        lng: number;
        accuracy: number;
        ts: number;
    } | null>(null);

    const active =
        $role === "seeker" && $mp && $sharing && $endsAt !== null;

    useEffect(() => {
        if (!active) return;
        if (typeof navigator === "undefined" || !navigator.geolocation) {
            return;
        }

        const maybeSend = (
            lat: number,
            lng: number,
            accuracy: number,
        ) => {
            const now = Date.now();
            const last = lastSentRef.current;
            if (last && now - last.ts < MIN_BROADCAST_GAP_MS) return;
            lastSentRef.current = { lat, lng, accuracy, ts: now };
            seekerPushLocation(lat, lng, accuracy);
        };

        const watchId = navigator.geolocation.watchPosition(
            (pos) =>
                maybeSend(
                    pos.coords.latitude,
                    pos.coords.longitude,
                    pos.coords.accuracy,
                ),
            (err) => {
                // Permission denied / unavailable — silently stop.
                // The seeker can still play; the hider just won't see
                // their pin until they grant location.
                console.warn(
                    "[seeker location] watchPosition error:",
                    err.message,
                );
            },
            { enableHighAccuracy: true, maximumAge: 5000 },
        );

        // Heartbeat: if we haven't broadcast in HEARTBEAT_MS, resend
        // the last fix (or fall through to no-op if we never got one).
        const heartbeat = window.setInterval(() => {
            const last = lastSentRef.current;
            if (!last) return;
            if (Date.now() - last.ts < HEARTBEAT_MS) return;
            lastSentRef.current = { ...last, ts: Date.now() };
            seekerPushLocation(last.lat, last.lng, last.accuracy);
        }, HEARTBEAT_MS / 2);

        return () => {
            navigator.geolocation.clearWatch(watchId);
            window.clearInterval(heartbeat);
        };
    }, [active]);
}
