import { useStore } from "@nanostores/react";
import { useEffect } from "react";
import { toast } from "react-toastify";

import { useWakeLock } from "@/hooks/useWakeLock";
import { hidingPeriodEndsAt } from "@/lib/gameSetup";
import { playerRole, roundFoundAt } from "@/lib/hiderRole";
import {
    keepAppOpenHintSeen,
    multiplayerEnabled,
} from "@/lib/multiplayer/session";

/**
 * Holds a Screen Wake Lock for the whole of an active round (v938) — from
 * the moment the hiding clock is armed until the round ends. Keeps the app
 * alive while it's foregrounded so a seeker's live location (and the map /
 * countdowns) don't die the instant the screen would otherwise sleep. Both
 * roles benefit; the seeker's GPS is the load-bearing case. Mounted once at
 * the app level so it spans the seeker↔hider route swap. Renders nothing.
 *
 * Also shows the one-time "keep the app open" hint to seekers, since the web
 * platform can't track location once the app is closed/backgrounded.
 */
export function WakeLockController() {
    const $endsAt = useStore(hidingPeriodEndsAt);
    const $found = useStore(roundFoundAt);
    const $role = useStore(playerRole);
    const $mp = useStore(multiplayerEnabled);
    const inActiveRound = Number.isFinite($endsAt) && $found == null;
    useWakeLock(inActiveRound);

    useEffect(() => {
        if (!inActiveRound || !$mp || $role !== "seeker") return;
        if (keepAppOpenHintSeen.get()) return;
        keepAppOpenHintSeen.set(true);
        toast.info(
            "Keep the app open so the hider sees your live location — phones stop sharing GPS in the background.",
            { autoClose: 8000 },
        );
    }, [inActiveRound, $mp, $role]);

    return null;
}

export default WakeLockController;
