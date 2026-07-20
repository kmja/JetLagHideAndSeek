import {
    additionalMapGeoLocations,
    mapGeoJSON,
    polyGeoJSON,
} from "@/lib/context";
import {
    closingInWarningLevel,
    endgameStartedAt,
    gameSize,
    gameStartFiredFor,
    effectiveHiddenDebitMs,
    HIDING_PERIOD_MINUTES,
    hiddenCreditMs,
    hidingPeriodEndsAt,
    locationTrackingExternal,
    MOVE_PERIOD_MINUTES,
    pendingHidingDurationMin,
    planningWindowEndsAt,
    preloadBucketTimestamps,
    roundEndBaseMs,
    roundEndBonusPieces,
    revealedStation,
    roundEndHiderName,
    seekersFrozenUntil,
    seekingStartFiredFor,
    setupCompleted,
    welcomeSeen,
} from "@/lib/gameSetup";
import { tallyTimeBonusMinutes } from "@/lib/hiderDeck";
import {
    hiderHand,
    hidingSpot,
    hidingZone,
    playerRole,
    roundFoundAt,
    roundLog,
} from "@/lib/hiderRole";
import {
    displayName as displayNameAtom,
    participants,
} from "@/lib/multiplayer/session";
import { hostPushSetup, leaveGame } from "@/lib/multiplayer/store";
import { appendRoundResult } from "@/lib/roundLeaderboard";
import { resetSharedRoundState } from "@/lib/roundReset";

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
    // v318: before wiping the previous round's state, append a result to the
    // rolling leaderboard if the hider was actually found. v1023: the append
    // is a shared, IDEMPOTENT helper called here AND from the guest path
    // (`applyRoundStarted`), so every device records the round — not just the
    // one that pressed "New round".
    // Capture whether the round completed BEFORE the reset nulls it (drives
    // the planning-window grant below).
    const prevFoundAt = roundFoundAt.get();
    appendRoundResult();
    // Wipe all per-round state (questions, curses, hider hand/deck,
    // endgame stamps, credit/debit, freeze, celebration dedupe, …) via
    // the shared reset so this path and the multiplayer guest path
    // (`applyRoundStarted`) can never diverge. mapGeoJSON / polyGeoJSON
    // intentionally stay — the play area didn't change, no refetch.
    resetSharedRoundState();
    // Stage the hiding-period clock to restart from now: the shared
    // reset already nulled the live timer, so GameStartWatcher re-arms it
    // once the map is ready (usually immediately on a continuing game).
    const minutes = HIDING_PERIOD_MINUTES[gameSize.get()];
    pendingHidingDurationMin.set(minutes);
    // v970 (rulebook audit B): between rounds the NEW hider gets "up to
    // 10 minutes for any final planning before their hiding period
    // begins" (rulebook p81) — surface it as a lobby countdown. Only
    // after a COMPLETED round (a fresh game's first round has no
    // previous hider to hand over from).
    if (prevFoundAt !== null) {
        planningWindowEndsAt.set(Date.now() + 10 * 60_000);
    }
}

/**
 * Play the Move powerup (rulebook: hider deck). Discards the hand
 * (done by the caller), banks the time survived so far, re-anchors the
 * hider with a fresh, shorter hiding period (10/20/60 min by size),
 * and freezes the seekers until it ends. Cannot be played in the
 * endgame. Returns false (and no-ops) if there's no running clock or
 * the endgame has already begun.
 *
 * The caller is responsible for discarding the hand; this handles the
 * timer/freeze/re-anchor state AND reveals the current station to the
 * seekers (`revealedStation`, synced via `hostPushSetup`) so both hand
 * UIs (fan + panel) stay in sync and Move is fully automatic.
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

    // Reveal the CURRENT station to the seekers (Move's defining mechanic:
    // "send the seekers the location of your transit station") — captured
    // BEFORE we clear the zone. Synced to seekers via hostPushSetup below.
    const oldZone = hidingZone.get();
    revealedStation.set(
        oldZone
            ? {
                  lat: oldZone.stationLat,
                  lng: oldZone.stationLng,
                  name: oldZone.stationName,
              }
            : null,
    );

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
    // Same per-round wipe as a new round…
    resetSharedRoundState();
    pendingHidingDurationMin.set(null);
    // …PLUS the game-scoped state a new round keeps:
    // v318: fresh game = fresh leaderboard. `startNewRound` does
    // NOT clear this so the rolling tally survives across rounds
    // within one game's settings.
    roundLog.set([]);
    // Wipe play area state — a fresh game starts from scratch.
    mapGeoJSON.set(null);
    polyGeoJSON.set(null);
    additionalMapGeoLocations.set([]);
    // (resetSharedRoundState already reverted map overlays to OFF.)
    // Clear preload timestamps — the new game may have a different play
    // area so cached Overpass / transit data from the previous game is
    // no longer valid (or at least we can't assume it is).
    preloadBucketTimestamps.set({ map: null, references: null, transit: null });
    // v940: a brand-new game re-enables location enforcement (the external-
    // tracking opt-out is a per-game decision, like allowedTransit).
    locationTrackingExternal.set(false);
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
