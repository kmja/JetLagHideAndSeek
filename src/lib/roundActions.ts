import {
    additionalMapGeoLocations,
    disabledStations,
    mapGeoJSON,
    permanentOverlay,
    polyGeoJSON,
    questions,
} from "@/lib/context";
import {
    closingInWarningLevel,
    gameSize,
    gameStartPosition,
    HIDING_PERIOD_MINUTES,
    hidingPeriodEndsAt,
    pendingHidingDurationMin,
    resetMapOverlays,
    seekingStartFiredFor,
    setupCompleted,
    setupDialogOpen,
} from "@/lib/gameSetup";
import { resetHiderRoundState, roundFoundAt } from "@/lib/hiderRole";
import { hostPushSetup } from "@/lib/multiplayer/store";

/**
 * Round / game lifecycle actions, shared by the seeker (BottomNav)
 * and hider (HiderHome) round-end surfaces.
 *
 * "Start new round"  — same setup, fresh round.
 *     Keeps: playArea, allowedTransit, gameSize, displayName,
 *            multiplayer room.
 *     Resets: questions, hider inbox/hand/discard, hiding zone,
 *             hiding spot, found-at timestamp; restarts the
 *             hiding-period clock from now.
 *
 * "Start new game" — full reset including play area.
 *     Drops setupCompleted so the wizard re-opens; the hider gets
 *     a fresh blank state too. The seeker callsite re-opens the
 *     wizard via `setupDialogOpen.set(true)`; the hider's wizard
 *     opens automatically the next time they're on the seeker
 *     page (or via "New game" in their toolbar).
 */
export function startNewRound() {
    // Wipe seeker-side question stack so the new round starts
    // empty. mapGeoJSON / polyGeoJSON intentionally stay — the
    // play area didn't change, no need to refetch.
    questions.set([]);
    disabledStations.set([]);
    permanentOverlay.set(null);
    // Hider-side: inbox, hand, discard, hiding zone, hiding spot,
    // found-at — all wiped.
    resetHiderRoundState();
    roundFoundAt.set(null);
    // Map overlays revert to their default OFF state for the new round.
    resetMapOverlays();
    // Restart the hiding-period clock from now.
    const minutes = HIDING_PERIOD_MINUTES[gameSize.get()];
    // Use the gated start: clear the live timer and stage the
    // duration so GameStartWatcher can re-arm it once the map is
    // ready (which it usually already is on a continuing game,
    // so the clock starts effectively immediately).
    hidingPeriodEndsAt.set(null);
    pendingHidingDurationMin.set(minutes);
    gameStartPosition.set(null);
    seekingStartFiredFor.set(null);
    closingInWarningLevel.set(0);
}

/**
 * Hard reset — full new-game flow. Clears the same stuff as
 * `startNewRound` PLUS the setup wizard's commitment, so the
 * wizard re-opens for play-area / transit / size selection.
 *
 * `additionalMapGeoLocations` is also cleared here because we no
 * longer trust the previous game's adjacent picks for whatever
 * area the user is about to choose.
 */
/**
 * End the current hiding period right now. Snaps
 * `hidingPeriodEndsAt` to `Date.now()` so the HiderTimer flips to
 * elapsed mode immediately, and broadcasts to connected peers so the
 * hider's clock matches (no-op offline). Guarded: if the timer has
 * already lapsed, do nothing — preserving the elapsed anchor that
 * scoring math reads.
 *
 * Per the rulebook + UX: only the hider should be able to trigger
 * this from the live game (their HiderHome surface). The seeker's
 * side keeps it in the debug panel for testing.
 */
export function endHidingPeriodEarly() {
    const existing = hidingPeriodEndsAt.get();
    if (existing === null) return;
    if (existing <= Date.now()) return;
    hidingPeriodEndsAt.set(Date.now());
    hostPushSetup();
}

export function startNewGame() {
    questions.set([]);
    disabledStations.set([]);
    permanentOverlay.set(null);
    resetHiderRoundState();
    roundFoundAt.set(null);
    hidingPeriodEndsAt.set(null);
    pendingHidingDurationMin.set(null);
    gameStartPosition.set(null);
    seekingStartFiredFor.set(null);
    closingInWarningLevel.set(0);
    // Wipe play area state — a fresh game starts from scratch.
    mapGeoJSON.set(null);
    polyGeoJSON.set(null);
    additionalMapGeoLocations.set([]);
    resetMapOverlays();
    setupCompleted.set(false);
    setupDialogOpen.set(true);
}
