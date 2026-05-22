import { useStore } from "@nanostores/react";
import { useEffect } from "react";

import { mapGeoJSON, polyGeoJSON } from "@/lib/context";
import {
    gameStartCelebrationAt,
    hidingPeriodEndsAt,
    pendingHidingDurationMin,
} from "@/lib/gameSetup";

/**
 * Mount-only watcher. When the wizard's `handleFinish` sets a
 * `pendingHidingDurationMin`, the hiding-period clock is deferred
 * — only this watcher actually starts it, after `mapGeoJSON` or
 * `polyGeoJSON` is populated (the boundary is rendered).
 *
 * That gating keeps a 30-second Sweden boundary load from eating
 * the first minute of the hider's window. It also drives the
 * GO GO GO celebration moment: setting `gameStartCelebrationAt`
 * here is what makes `GoGoGoOverlay` show the catchphrase banner.
 *
 * Mounted in both `index.astro` (seeker) and `h.astro` (hider) so
 * the start fires whichever side is loaded.
 */
export function GameStartWatcher() {
    const $pending = useStore(pendingHidingDurationMin);
    const $mapGeoJSON = useStore(mapGeoJSON);
    const $polyGeoJSON = useStore(polyGeoJSON);

    useEffect(() => {
        if ($pending === null || $pending <= 0) return;
        const boundaryReady = Boolean($mapGeoJSON || $polyGeoJSON);
        if (!boundaryReady) return;
        // Both conditions met — start the clock and fire the
        // celebration. Order matters: setting hidingPeriodEndsAt
        // FIRST means subscribers of the timer atom see the
        // running clock by the time the celebration renders.
        const minutes = $pending;
        hidingPeriodEndsAt.set(Date.now() + minutes * 60_000);
        pendingHidingDurationMin.set(null);
        gameStartCelebrationAt.set(Date.now());
    }, [$pending, $mapGeoJSON, $polyGeoJSON]);

    return null;
}

export default GameStartWatcher;
