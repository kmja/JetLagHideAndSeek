/**
 * The per-round state reset, shared by ALL three round-transition paths:
 *   - `startNewRound` / `startNewGame` (`roundActions.ts`) — the host /
 *     solo device that initiates the transition, and
 *   - `applyRoundStarted` (`multiplayer/store.ts`) — every GUEST device
 *     reacting to the server's `roundStarted` broadcast.
 *
 * v670: this used to be duplicated inline in each path, and the guest
 * copy had silently drifted — it reset only ~9 of the ~15 per-round
 * atoms, leaving stale curses / freeze / credit-debit / spotty-memory /
 * celebration-dedupe on guest devices across rounds (and NONE of those
 * ride `SetupState`, so `setupChanged` / the welcome snapshot couldn't
 * fix them either). Centralising the reset here is the single-source fix
 * so the three paths can never diverge again.
 *
 * This module deliberately imports ONLY atom modules (context / gameSetup
 * / hiderRole / curseEnforcement / seekerInbound) — never `store` or
 * `roundActions` — so it introduces no import cycle.
 */

import {
    disabledStations,
    permanentOverlay,
    questionModified,
    questions,
} from "@/lib/context";
import {
    activeBlockingCurse,
    seekerOnTransit,
    spottyMemoryCategory,
} from "@/lib/curseEnforcement";
import {
    closingInWarningLevel,
    endgameConfirmedAt,
    endgameStartedAt,
    endOfRoundDialogOpen,
    gamePausedForLocationAt,
    gameStartFiredFor,
    gameStartPosition,
    hiddenCreditMs,
    hiddenDebitMs,
    hidingPeriodEndsAt,
    locationGraceStartedAt,
    manualPausedAt,
    manualPauseWasHiding,
    resetMapOverlays,
    seekersFrozenUntil,
    seekingStartFiredFor,
} from "@/lib/gameSetup";
import { resetHiderRoundState, roundFoundAt } from "@/lib/hiderRole";
import { receivedCurses } from "@/lib/seekerInbound";

/**
 * Reset every atom that is scoped to a single round. Does NOT touch:
 *   - persistent game config (play area, transit, size) — that survives
 *     a round and is cleared only by `startNewGame`;
 *   - the rolling `roundLog` leaderboard — survives rounds, cleared by
 *     `startNewGame`;
 *   - the hiding-period clock STAGING (`pendingHidingDurationMin`) — the
 *     initiator stages it in `startNewRound`; guests receive the armed
 *     `hidingPeriodEndsAt` over `setupChanged`. This function only nulls
 *     the live clock so it can't carry over.
 *
 * Callers layer their path-specific extras around this (leaderboard
 * append, roster application, clock staging, host push).
 */
/**
 * Clear every curse-derived atom. Curses are per-round AND per-game — the
 * seeker's received-curse inbox plus the enforcement state derived from it
 * (Spotty Memory roll, Urban Explorer on-transit flag, Drained-Brain
 * blocking). Split out of `resetSharedRoundState` (v701) so game-BOOT paths
 * can clear curses too, not just round transitions: these atoms are all
 * `persistentAtom`s (localStorage), so without a boot-time clear a curse from
 * a PREVIOUS game reappears the instant `CurseInbox` mounts in the next one
 * (the "two curses firing right away" demo bug).
 */
export function resetCurseState(): void {
    receivedCurses.set([]);
    spottyMemoryCategory.set(null);
    seekerOnTransit.set(false);
    activeBlockingCurse.set(null);
}

export function resetSharedRoundState(): void {
    // Seeker-side question stack.
    questions.set([]);
    questionModified();
    disabledStations.set([]);
    permanentOverlay.set(null);

    // Curses are per-round — clear any the seeker was still under, plus
    // the enforcement state derived from them (Spotty Memory roll, Urban
    // Explorer on-transit flag).
    resetCurseState();

    // Hider-side: inbox, hand, deck, discard, hand limit, pending draw,
    // hiding zone/spot, found-at, forfeit flag, chalice charges.
    resetHiderRoundState();
    roundFoundAt.set(null);

    // Map overlays revert to their default OFF state for the new round.
    resetMapOverlays();

    // Live hiding-period clock + start/seeking celebration dedupe keys.
    hidingPeriodEndsAt.set(null);
    gameStartPosition.set(null);
    seekingStartFiredFor.set(null);
    gameStartFiredFor.set(null);
    closingInWarningLevel.set(0);

    // Move-powerup freeze + scoring credit/debit + location-pause state.
    seekersFrozenUntil.set(null);
    hiddenCreditMs.set(0);
    hiddenDebitMs.set(0);
    locationGraceStartedAt.set(null);
    gamePausedForLocationAt.set(null);
    // Manual pause is per-round too (a paused round shouldn't resume
    // paused into the next).
    manualPausedAt.set(null);
    manualPauseWasHiding.set(false);

    // Endgame handshake — per-round; clear both the seeker's claim and
    // the hider's confirmation so the new round can't open mid-endgame.
    endgameStartedAt.set(null);
    endgameConfirmedAt.set(null);

    // Close the end-of-round celebration if it was up.
    endOfRoundDialogOpen.set(false);
}
