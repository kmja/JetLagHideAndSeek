import { useStore } from "@nanostores/react";
import { useEffect, useRef } from "react";

import { hidingPeriodEndsAt } from "@/lib/gameSetup";
import { playerRole } from "@/lib/hiderRole";
import { multiplayerEnabled } from "@/lib/multiplayer/session";
import { hiderPushLocation } from "@/lib/multiplayer/store";

/**
 * The hider's counterpart to `useSeekerLocationBroadcast` (v853). Pushes the
 * hider's live GPS to the SERVER ONLY — it is never fanned to seekers (unlike
 * the seeker `loc`, which the hide team sees). Its sole purpose is to let the
 * server range-check a `found` claim (rulebook p43 — the seeker must be
 * physically with the hider) without ever revealing the hider's position.
 *
 * Gates (no-op until all true; cleans up when any go false):
 *   - Local role is "hider" (only the hide team can be found).
 *   - Multiplayer enabled (nowhere to push otherwise).
 *   - `hidingPeriodEndsAt` set (the game is live).
 *
 * No user toggle: the position is server-only + ephemeral (dropped on round
 * reset / disconnect) and exists purely for the found check, so unlike the
 * seeker's shared pin there's nothing revealed to opt out of.
 */
const MIN_BROADCAST_GAP_MS = 5_000;
const HEARTBEAT_MS = 30_000;

export function useHiderLocationBroadcast() {
    const $role = useStore(playerRole);
    const $mp = useStore(multiplayerEnabled);
    const $endsAt = useStore(hidingPeriodEndsAt);

    const lastSentRef = useRef<{
        lat: number;
        lng: number;
        accuracy: number;
        ts: number;
    } | null>(null);

    const active = $role === "hider" && $mp && $endsAt !== null;

    useEffect(() => {
        if (!active) return;
        if (typeof navigator === "undefined" || !navigator.geolocation) {
            return;
        }

        const maybeSend = (lat: number, lng: number, accuracy: number) => {
            const now = Date.now();
            const last = lastSentRef.current;
            if (last && now - last.ts < MIN_BROADCAST_GAP_MS) return;
            lastSentRef.current = { lat, lng, accuracy, ts: now };
            hiderPushLocation(lat, lng, accuracy);
        };

        const watchId = navigator.geolocation.watchPosition(
            (pos) =>
                maybeSend(
                    pos.coords.latitude,
                    pos.coords.longitude,
                    pos.coords.accuracy,
                ),
            (err) => {
                // Permission denied / unavailable — silently stop. The found
                // proximity check simply can't verify and degrades to "allow".
                console.warn(
                    "[hider location] watchPosition error:",
                    err.message,
                );
            },
            { enableHighAccuracy: true, maximumAge: 5000 },
        );

        // Heartbeat: re-push the last fix so a stationary hider's position
        // stays fresh enough for the found check's staleness window.
        const heartbeat = window.setInterval(() => {
            const last = lastSentRef.current;
            if (!last) return;
            if (Date.now() - last.ts < HEARTBEAT_MS) return;
            const t = Date.now();
            lastSentRef.current = { ...last, ts: t };
            hiderPushLocation(last.lat, last.lng, last.accuracy);
        }, HEARTBEAT_MS / 2);

        return () => {
            navigator.geolocation.clearWatch(watchId);
            window.clearInterval(heartbeat);
        };
    }, [active]);
}
