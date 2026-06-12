import { useStore } from "@nanostores/react";
import { useEffect, useRef } from "react";

import {
    gameStartCelebrationAt,
    gameStartPosition,
    hidingPeriodEndsAt,
} from "@/lib/gameSetup";
import { playerRole } from "@/lib/hiderRole";
import { preloadDuringHidingPeriod } from "@/lib/preload";

/**
 * Mount-only watcher. Opens the GoGoGoOverlay celebration the
 * moment the hiding period actually starts — i.e. when
 * `hidingPeriodEndsAt` transitions from null to a non-null
 * timestamp. That single trigger covers both:
 *
 *  - Host devices, where the GameLobbyDialog's Start button sets
 *    hidingPeriodEndsAt directly.
 *  - Guest devices, where the host's setupChanged push propagates
 *    a freshly-set hidingPeriodEndsAt over the multiplayer
 *    transport, which then writes the local atom.
 *
 * We only react to null→non-null transitions, never to mid-game
 * updates (e.g. peers refreshing the timer), so the celebration
 * doesn't pop back up after the user dismissed it.
 *
 * Also captures the device's GPS at game start and stores it as
 * `gameStartPosition` — the shared departure point used by the
 * travel-times overlay to compute which stations the hider could
 * reach during the hiding period.
 *
 * Mounted on both /index.astro (seeker) and /h.astro (hider) so
 * the celebration appears whichever side is loaded.
 */
export function GameStartWatcher() {
    const $endsAt = useStore(hidingPeriodEndsAt);
    const prev = useRef<number | null>($endsAt);

    useEffect(() => {
        const wasNull = prev.current === null;
        const isSet = $endsAt !== null;
        prev.current = $endsAt;
        if (!wasNull || !isSet) return;
        // Only fire if the celebration isn't already open (we don't
        // want to re-pop on a dismiss-then-mount cycle).
        if (gameStartCelebrationAt.get() !== null) return;
        gameStartCelebrationAt.set(Date.now());
        // Capture GPS as the travel-times departure anchor. Non-
        // blocking: if the user denies location, the overlay simply
        // won't activate (it gates on gameStartPosition being set).
        if (typeof navigator !== "undefined" && navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(
                (pos) =>
                    gameStartPosition.set({
                        lat: pos.coords.latitude,
                        lng: pos.coords.longitude,
                    }),
                () => {
                    /* denied or unavailable — travel times won't have an anchor */
                },
                { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 },
            );
        }
        // Hiding period just started — seekers can't ask questions
        // yet, so this is the ideal window to warm the Overpass cache
        // for every matching/measuring query they're likely to ask.
        // Skip on the hider's device: they don't ask questions, and
        // running the same fetches on every device just multiplies
        // load on the mirrors for no gain.
        if (playerRole.get() !== "hider") {
            preloadDuringHidingPeriod();
        }
    }, [$endsAt]);

    return null;
}

export default GameStartWatcher;
