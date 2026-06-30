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
    endgameConfirmedAt,
    endgameStartedAt,
    gameSize,
    gameStartFiredFor,
    gameStartPosition,
    effectiveHiddenDebitMs,
    gamePausedForLocationAt,
    HIDING_PERIOD_MINUTES,
    hiddenCreditMs,
    hiddenDebitMs,
    hidingPeriodEndsAt,
    locationGraceStartedAt,
    MOVE_PERIOD_MINUTES,
    pendingHidingDurationMin,
    preloadBucketTimestamps,
    resetMapOverlays,
    seekersFrozenUntil,
    seekingStartFiredFor,
    setupCompleted,
    welcomeSeen,
} from "@/lib/gameSetup";
import {
    hidingSpot,
    hidingZone,
    playerRole,
    resetHiderRoundState,
    roundFoundAt,
    roundLog,
} from "@/lib/hiderRole";
import {
    displayName as displayNameAtom,
    participants,
} from "@/lib/multiplayer/session";
import { hostPushSetup, leaveGame } from "@/lib/multiplayer/store";
import { receivedCurses } from "@/lib/seekerInbound";

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
    // v318: before wiping the previous round's state, append a
    // result to the rolling leaderboard if the hider was actually
    // found. Skip incomplete rounds (no found-at timestamp) —
    // those weren't finished, just abandoned.
    const prevFoundAt = roundFoundAt.get();
    const prevEndsAt = hidingPeriodEndsAt.get();
    if (prevFoundAt !== null && prevEndsAt !== null) {
        // Add any time banked by a Move powerup, and subtract any time
        // the clock was paused for overdue answers (rulebook p61), so
        // re-anchors pause rather than discard time and stalls don't
        // pay out.
        const hidingMs = Math.max(
            0,
            Math.max(0, prevFoundAt - prevEndsAt) +
                hiddenCreditMs.get() -
                effectiveHiddenDebitMs(prevFoundAt),
        );
        // Resolve the hider's name: multiplayer participant if we
        // have one, otherwise the local display-name (solo plays
        // through the seeker chrome, single device).
        const ps = participants.get();
        const hiderEntry = ps.find((p) => p.role === "hider");
        const hiderName =
            hiderEntry?.displayName?.trim() ||
            displayNameAtom.get()?.trim() ||
            "Hider";
        const existing = roundLog.get();
        roundLog.set([
            ...existing,
            {
                roundNumber: existing.length + 1,
                hiderName,
                hidingMs,
                foundAt: prevFoundAt,
            },
        ]);
    }
    // Wipe seeker-side question stack so the new round starts
    // empty. mapGeoJSON / polyGeoJSON intentionally stay — the
    // play area didn't change, no need to refetch.
    questions.set([]);
    disabledStations.set([]);
    permanentOverlay.set(null);
    // Curses are per-round — clear any the seeker was still under so they
    // don't carry into the new round.
    receivedCurses.set([]);
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
    gameStartFiredFor.set(null);
    closingInWarningLevel.set(0);
    seekersFrozenUntil.set(null);
    hiddenCreditMs.set(0);
    hiddenDebitMs.set(0);
    locationGraceStartedAt.set(null);
    gamePausedForLocationAt.set(null);
    // Endgame is per-round — clear both the seeker's claim and the
    // hider's confirmation so the new round doesn't open mid-endgame.
    endgameStartedAt.set(null);
    endgameConfirmedAt.set(null);
}

/**
 * Play the Move powerup (rulebook: hider deck). Discards the hand
 * (done by the caller), banks the time survived so far, re-anchors the
 * hider with a fresh, shorter hiding period (10/20/60 min by size),
 * and freezes the seekers until it ends. Cannot be played in the
 * endgame. Returns false (and no-ops) if there's no running clock or
 * the endgame has already begun.
 *
 * The caller is responsible for discarding the hand and telling the
 * seekers the current station — this handles only the timer/freeze/
 * re-anchor state so both hand UIs (fan + panel) stay in sync.
 */
export function playMovePowerup(): boolean {
    const endsAt = hidingPeriodEndsAt.get();
    if (endsAt === null) return false;
    if (endgameStartedAt.get() !== null) return false;

    const now = Date.now();
    // Bank time already survived (only counts once the initial hiding
    // period has elapsed and seeking actually began).
    if (now > endsAt) {
        hiddenCreditMs.set(hiddenCreditMs.get() + (now - endsAt));
    }

    // Re-anchor: the old zone/spot no longer apply — the hider picks a
    // new station during the fresh hiding period.
    hidingZone.set(null);
    hidingSpot.set(null);

    const minutes = MOVE_PERIOD_MINUTES[gameSize.get()];
    const freshEnd = now + minutes * 60_000;
    hidingPeriodEndsAt.set(freshEnd);
    seekersFrozenUntil.set(freshEnd);

    // Let the start/seeking celebrations re-fire for the new period.
    seekingStartFiredFor.set(null);
    gameStartFiredFor.set(null);
    closingInWarningLevel.set(0);

    hostPushSetup();
    return true;
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
    receivedCurses.set([]);
    resetHiderRoundState();
    roundFoundAt.set(null);
    // v318: fresh game = fresh leaderboard. `startNewRound` does
    // NOT clear this so the rolling tally survives across rounds
    // within one game's settings.
    roundLog.set([]);
    hidingPeriodEndsAt.set(null);
    pendingHidingDurationMin.set(null);
    gameStartPosition.set(null);
    seekingStartFiredFor.set(null);
    gameStartFiredFor.set(null);
    closingInWarningLevel.set(0);
    seekersFrozenUntil.set(null);
    hiddenCreditMs.set(0);
    hiddenDebitMs.set(0);
    locationGraceStartedAt.set(null);
    gamePausedForLocationAt.set(null);
    endgameStartedAt.set(null);
    endgameConfirmedAt.set(null);
    // Wipe play area state — a fresh game starts from scratch.
    mapGeoJSON.set(null);
    polyGeoJSON.set(null);
    additionalMapGeoLocations.set([]);
    resetMapOverlays();
    // Clear preload timestamps — the new game may have a different play
    // area so cached Overpass / transit data from the previous game is
    // no longer valid (or at least we can't assume it is).
    preloadBucketTimestamps.set({ map: null, references: null, transit: null });
    setupCompleted.set(false);
    // v252: no manual dialog-open — the route guard in
    // SeekerPage/HiderPage redirects to /setup the moment
    // setupCompleted flips false above.
}

/**
 * Leave any current multiplayer room and reset the local app all the
 * way back to the landing screen. Used by both the inline InvitePanel
 * "Leave online game" button and the bigger GameLobbyDialog's "Leave
 * game" button — historically each called `leaveGame()` and tinkered
 * with a different subset of atoms, which is why the user could end
 * up on a half-empty seeker view with the lobby gone instead of back
 * at the start/join landing.
 *
 * Wipes round state via `startNewGame()` (clears questions, hiding
 * period, map polygon, …), then deliberately closes the setup wizard
 * and flips `welcomeSeen` off + `playerRole` to null so that on the
 * next render Welcome takes the foreground. Finally navigates to `/`
 * so the hider's `/h` URL doesn't keep them on the read-only hider
 * surface.
 */
export function returnToLandingPage(): void {
    leaveGame();
    startNewGame();
    welcomeSeen.set(false);
    playerRole.set(null);
    if (typeof window !== "undefined") {
        // Force a navigation rather than a soft route — multiplayer
        // listeners + persisted shadow atoms are easier to reason
        // about after a fresh boot than after a half-cleanup race.
        // Going via "/" also drops out of /setup if the user was
        // already mid-wizard when they tapped "Leave game".
        window.location.assign("/");
    }
}
