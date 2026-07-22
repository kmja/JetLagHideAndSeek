import { useStore } from "@nanostores/react";
import { useEffect, useState } from "react";

import { hidingPeriodEndsAt } from "@/lib/gameSetup";

export interface HidingPhase {
    /** The hiding period is running now (`hidingPeriodEndsAt` set and future). */
    inHidingPeriod: boolean;
    /** The hiding period has ELAPSED (set and past) — seeking is underway.
     *  NOT simply `!inHidingPeriod`: both are false when there's no clock. */
    seekingStarted: boolean;
}

function computePhase(endsAt: number | null): HidingPhase {
    if (endsAt == null) return { inHidingPeriod: false, seekingStarted: false };
    const running = Date.now() < endsAt;
    return { inHidingPeriod: running, seekingStarted: !running };
}

/**
 * Single source for "are we in the hiding period vs seeking" — flips exactly at
 * `hidingPeriodEndsAt` via a ONE-SHOT timeout (no per-second tick). v1120:
 * replaces three hand-copied useState+useEffect blocks (`Map.tsx`,
 * `SeekerPage.tsx`, and the inverted `seekingStarted` in `HiderBackgroundMap`).
 */
export function useHidingPhase(): HidingPhase {
    const endsAt = useStore(hidingPeriodEndsAt);
    const [phase, setPhase] = useState<HidingPhase>(() => computePhase(endsAt));
    useEffect(() => {
        setPhase(computePhase(endsAt));
        if (endsAt == null) return;
        const ms = endsAt - Date.now();
        if (ms <= 0) return; // already elapsed — state is already correct
        const t = window.setTimeout(
            () => setPhase({ inHidingPeriod: false, seekingStarted: true }),
            ms,
        );
        return () => window.clearTimeout(t);
    }, [endsAt]);
    return phase;
}
