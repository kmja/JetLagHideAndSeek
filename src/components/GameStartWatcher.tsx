import { useStore } from "@nanostores/react";
import { useEffect } from "react";

import { mapGeoJSON, polyGeoJSON } from "@/lib/context";
import {
    gameStartCelebrationAt,
    pendingHidingDurationMin,
} from "@/lib/gameSetup";

/**
 * Mount-only watcher. When the wizard's `handleFinish` queues a
 * `pendingHidingDurationMin`, this watcher waits for the play-area
 * boundary to actually finish loading (`mapGeoJSON` / `polyGeoJSON`)
 * and then **opens the GO GO GO dialog** by setting
 * `gameStartCelebrationAt`. The dialog itself owns the "Start"
 * button — the hiding-period clock only begins running once the
 * player actually taps that button.
 *
 * That two-step flow gives the player a conscious "the game is
 * about to begin" moment instead of an automatic clock kick-off
 * that might surprise them while the boundary is still painting.
 *
 * Mounted on both `index.astro` (seeker) and `h.astro` (hider) so
 * the celebration fires whichever side is loaded.
 */
export function GameStartWatcher() {
    const $pending = useStore(pendingHidingDurationMin);
    const $mapGeoJSON = useStore(mapGeoJSON);
    const $polyGeoJSON = useStore(polyGeoJSON);
    const $celebrationAt = useStore(gameStartCelebrationAt);

    useEffect(() => {
        if ($pending === null || $pending <= 0) return;
        const boundaryReady = Boolean($mapGeoJSON || $polyGeoJSON);
        if (!boundaryReady) return;
        // Already showing the dialog? Don't re-open on subsequent
        // boundary refreshes (e.g. re-fetches mid-game).
        if ($celebrationAt !== null) return;
        gameStartCelebrationAt.set(Date.now());
    }, [$pending, $mapGeoJSON, $polyGeoJSON, $celebrationAt]);

    return null;
}

export default GameStartWatcher;
