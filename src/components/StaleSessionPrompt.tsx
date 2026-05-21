import { useStore } from "@nanostores/react";
import { useState } from "react";

import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
    hidingPeriodEndsAt,
    setupCompleted,
    setupDialogOpen,
} from "@/lib/gameSetup";
import {
    playerRole,
    resetHiderRoundState,
    roundFoundAt,
} from "@/lib/hiderRole";

/**
 * Auto-detects an abandoned game session on app load and offers to
 * reset. If the hiding period ended more than 12 hours ago and the
 * round wasn't closed cleanly (no `roundFoundAt`), the persisted state
 * is almost certainly left over from yesterday's game — the seeker
 * forgot to tap "New game" before closing the tab.
 *
 * Mounted on both `/` (seeker) and `/h` (hider). Behavior branches on
 * `playerRole`:
 *
 *   • Seeker → "Start new game" clears `setupCompleted` + the timer
 *     and re-opens the wizard.
 *   • Hider  → "Start new game" calls `resetHiderRoundState` and
 *     clears the timer; the next question link the seeker shares will
 *     start a fresh inbox.
 *
 * Dismissal is in-memory (`useState`), so the prompt won't keep popping
 * up the rest of the session if the user picks "Continue this game".
 * Reloading re-evaluates against the same persisted state.
 */

const STALE_THRESHOLD_MS = 12 * 60 * 60 * 1000;

export function StaleSessionPrompt() {
    const $setupCompleted = useStore(setupCompleted);
    const $hidingEndsAt = useStore(hidingPeriodEndsAt);
    const $foundAt = useStore(roundFoundAt);
    const $role = useStore(playerRole);

    const [dismissed, setDismissed] = useState(false);

    const isStale = (() => {
        if (!$hidingEndsAt) return false;
        if ($foundAt !== null) return false; // round closed cleanly
        // The seeker also needs setupCompleted before we treat their
        // device as "had a real game". The hider may never have run
        // the wizard, so we don't gate on setupCompleted there.
        if ($role !== "hider" && !$setupCompleted) return false;
        return Date.now() - $hidingEndsAt > STALE_THRESHOLD_MS;
    })();

    const open = isStale && !dismissed;
    const isHider = $role === "hider";

    const handleNewGame = () => {
        hidingPeriodEndsAt.set(null);
        roundFoundAt.set(null);
        if (isHider) {
            resetHiderRoundState();
        } else {
            setupCompleted.set(false);
            setupDialogOpen.set(true);
        }
        setDismissed(true);
    };

    const handleContinue = () => {
        setDismissed(true);
    };

    return (
        <AlertDialog open={open}>
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>
                        Looks like an old game is still running
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                        {describeStale($hidingEndsAt, isHider)}
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel onClick={handleContinue}>
                        Continue this game
                    </AlertDialogCancel>
                    <AlertDialogAction onClick={handleNewGame}>
                        Start a new game
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}

function describeStale(hidingEndsAt: number | null, isHider: boolean): string {
    if (!hidingEndsAt) return "";
    const elapsedMs = Date.now() - hidingEndsAt;
    const hours = Math.floor(elapsedMs / (60 * 60 * 1000));
    const ago =
        hours >= 48
            ? `${Math.floor(hours / 24)} days ago`
            : hours >= 24
              ? "more than a day ago"
              : `${hours} hours ago`;

    if (isHider) {
        return (
            `The seeker started seeking ${ago} on this device. ` +
            "If you've moved on to a new game, start fresh to clear your " +
            "hiding zone, inbox, and deck."
        );
    }
    return (
        `Your last hiding period ended ${ago}. ` +
        "If this round is over, start a new game to wipe the play area " +
        "settings and bring back the setup wizard."
    );
}

export default StaleSessionPrompt;
