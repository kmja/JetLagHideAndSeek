import { useStore } from "@nanostores/react";
import { useEffect, useRef } from "react";

import {
    gameStartCelebrationAt,
    hidingPeriodEndsAt,
} from "@/lib/gameSetup";

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
    }, [$endsAt]);

    return null;
}

export default GameStartWatcher;
