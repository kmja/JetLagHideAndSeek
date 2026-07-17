import { useStore } from "@nanostores/react";

import { useWakeLock } from "@/hooks/useWakeLock";
import { hidingPeriodEndsAt } from "@/lib/gameSetup";
import { roundFoundAt } from "@/lib/hiderRole";

/**
 * Holds a Screen Wake Lock for the whole of an active round (v938) — from
 * the moment the hiding clock is armed until the round ends. Keeps the app
 * alive while it's foregrounded so a seeker's live location (and the map /
 * countdowns) don't die the instant the screen would otherwise sleep. Both
 * roles benefit; the seeker's GPS is the load-bearing case. Mounted once at
 * the app level so it spans the seeker↔hider route swap. Renders nothing.
 *
 * (v945: the one-time "keep the app open" seeker toast was removed — it read
 * as nagging; seekers notice on their own that GPS needs the app foregrounded.)
 */
export function WakeLockController() {
    const $endsAt = useStore(hidingPeriodEndsAt);
    const $found = useStore(roundFoundAt);
    const inActiveRound = Number.isFinite($endsAt) && $found == null;
    useWakeLock(inActiveRound);

    return null;
}

export default WakeLockController;
