/**
 * Manual game pause (rulebook "General Tips": "You always have the option
 * to pause the game… the hider's timer and any other in-game timers stop.
 * When resumed, all players must be in the same spot where the game was
 * originally paused.").
 *
 * Implemented by FREEZING every in-game clock for the paused span and
 * repaying it on resume:
 *   - Scored hidden time freezes live via `effectiveHiddenDebitMs` (which
 *     already folds in `manualPausedAt`), then is repaid either by a
 *     `hidingPeriodEndsAt` shift (paused during the hiding period → the
 *     countdown resumes where it stopped) or by banking into
 *     `hiddenDebitMs` (paused during seeking → scored time froze).
 *   - Pending answer-window countdowns are shifted forward (each inbox
 *     entry's `arrivedAt`), so a question's 5-min timer doesn't tick
 *     while paused.
 *   - An active Move freeze (`seekersFrozenUntil`) is shifted forward.
 *
 * Local-scoped for now: it freezes THIS device's clocks. Multiplayer
 * peers aren't auto-frozen (a synced pause would ride `SetupState`); the
 * physical rule — everyone stays put — is enforced by the players, and
 * the paused overlay tells them the game is halted.
 */

import {
    hiddenDebitMs,
    hidingPeriodEndsAt,
    manualPausedAt,
    manualPauseWasHiding,
    seekersFrozenUntil,
} from "@/lib/gameSetup";
import { hiderInbox } from "@/lib/hiderRole";
import { multiplayerEnabled } from "@/lib/multiplayer/session";
import { sendSetPause } from "@/lib/multiplayer/store";

/** True while the game is manually paused on this device. */
export function isGamePaused(): boolean {
    return manualPausedAt.get() != null;
}

/** Pause the game: stamp the pause start and record the phase so resume
 *  can repay it correctly. No-op if already paused. */
export function pauseGame(): void {
    if (manualPausedAt.get() != null) return;
    const now = Date.now();
    const endsAt = hidingPeriodEndsAt.get();
    // "During the hiding period" = clock exists and hasn't lapsed yet.
    const wasHiding = endsAt != null && now < endsAt;
    manualPauseWasHiding.set(wasHiding);
    manualPausedAt.set(now);
    // v1112: sync the pause to the WHOLE room so every device freezes (a
    // no-op solo). The confirming setupChanged re-applies the same value.
    sendSetPause(true, wasHiding);
}

/** Resume the game: repay the paused span across every frozen clock. */
export function resumeGame(): void {
    const pausedAt = manualPausedAt.get();
    if (pausedAt == null) return;
    // v1112: in multiplayer the SERVER repays the shared clocks
    // (`hidingPeriodEndsAt`/`seekersFrozenUntil`) authoritatively and the
    // hider's answer-windows + seeking-debit are repaid by
    // `applyPauseFromSetup` on the resume transition — so just send the resume
    // and let the synced setupChanged clear the freeze everywhere. (No local
    // clock math here, or it would double-shift the synced values.)
    if (multiplayerEnabled.get()) {
        sendSetPause(false);
        return;
    }
    const now = Date.now();
    const pausedMs = Math.max(0, now - pausedAt);
    const wasHiding = manualPauseWasHiding.get();

    // Clear the pause flags FIRST so the live `effectiveHiddenDebitMs`
    // term stops before we bank the fixed amount (no double count).
    manualPausedAt.set(null);
    manualPauseWasHiding.set(false);

    if (pausedMs > 0) {
        if (wasHiding) {
            // Hiding-period pause → push the hiding deadline out so the
            // countdown resumes where it stopped (no scored-time impact:
            // seeking simply starts later).
            const endsAt = hidingPeriodEndsAt.get();
            if (endsAt != null) hidingPeriodEndsAt.set(endsAt + pausedMs);
        } else {
            // Seeking pause → permanently subtract the frozen span from
            // the hider's scored hidden time.
            hiddenDebitMs.set(hiddenDebitMs.get() + pausedMs);
        }

        // Answer windows: shift every pending question's arrival forward
        // so its 5-min (photo 10/20) timer didn't tick during the pause.
        const inbox = hiderInbox.get();
        let changed = false;
        const shifted = inbox.map((e) => {
            if (e.repliedAt === undefined) {
                changed = true;
                return { ...e, arrivedAt: e.arrivedAt + pausedMs };
            }
            return e;
        });
        if (changed) hiderInbox.set(shifted);

        // An active Move freeze shifts forward too.
        const frozen = seekersFrozenUntil.get();
        if (frozen != null && frozen > now) {
            seekersFrozenUntil.set(frozen + pausedMs);
        }
    }
}
