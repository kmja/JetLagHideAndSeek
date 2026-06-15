import { useStore } from "@nanostores/react";
import { useEffect } from "react";

import {
    gameStartCelebrationAt,
    gameStartFiredFor,
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
    const $firedFor = useStore(gameStartFiredFor);

    useEffect(() => {
        // v245: switched from a useRef-based "was it null on the
        // previous render" to a persistent dedupe atom keyed on the
        // actual endsAt value. The ref approach re-fired the GoGoGo
        // overlay whenever a multiplayer snapshot wrote hidingPeriod
        // EndsAt through a null bounce (autohost self-heal, lobby
        // reopen). Persistent dedupe survives both that bounce and a
        // full reload, and roundActions clears it to null at every
        // new round so the next game still gets the celebration.
        if ($endsAt === null) return;
        if ($firedFor === $endsAt) return;
        // Claim the fire BEFORE any side effects so a paired mount
        // on the other route (e.g. SeekerPage + HiderPage both up
        // in one tab) doesn't double-fire on the same value.
        gameStartFiredFor.set($endsAt);
        if (gameStartCelebrationAt.get() === null) {
            gameStartCelebrationAt.set(Date.now());
        }
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
    }, [$endsAt, $firedFor]);

    return null;
}

export default GameStartWatcher;
