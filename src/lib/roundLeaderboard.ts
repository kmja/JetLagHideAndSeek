/**
 * Shared, IDEMPOTENT append of a finished round to the rolling leaderboard
 * (`roundLog`). Called from BOTH round-transition paths so every device — not
 * just the one that pressed "New round" — records the result:
 *   - `startNewRound` (`roundActions.ts`, the initiator / solo), and
 *   - `applyRoundStarted` (`multiplayer/store.ts`, every guest reacting to the
 *     server's `roundStarted`).
 *
 * v1023 bug: the append lived only in `startNewRound`, so on a guest device the
 * previous round never entered its leaderboard — only the initiator saw it.
 *
 * Idempotent via the round's `foundAt` timestamp: both paths can run on the
 * initiator (a `roundStarted` broadcast echoes to the sender), so the guard
 * stops a double-append.
 *
 * Imports ONLY leaf atom/pure modules (no `store` / `roundActions`) so it can
 * be imported by both without a cycle.
 */

import {
    effectiveHiddenDebitMs,
    gameSize,
    hiddenCreditMs,
    hidingPeriodEndsAt,
    roundEndBaseMs,
    roundEndBonusPieces,
    roundEndHiderName,
} from "@/lib/gameSetup";
import { tallyTimeBonusMinutes } from "@/lib/hiderDeck";
import { hiderHand, roundFoundAt, roundLog } from "@/lib/hiderRole";
import {
    displayName as displayNameAtom,
    participants,
} from "@/lib/multiplayer/session";

/**
 * Append the just-finished round to `roundLog` if it completed (the hider was
 * found) and isn't already recorded. Reads the hider-authoritative
 * `roundEndBaseMs`/`roundEndBonusPieces` (synced via `roundSummary`) so a
 * SEEKER — which can't compute the hider-local Move credit / late debit / hand
 * bonus itself — records the same time everyone else does.
 */
export function appendRoundResult(): void {
    const prevFoundAt = roundFoundAt.get();
    const prevEndsAt = hidingPeriodEndsAt.get();
    if (prevFoundAt === null || prevEndsAt === null) return;

    const existing = roundLog.get();
    // Idempotent: don't record the same round twice.
    if (existing.some((r) => r.foundAt === prevFoundAt)) return;

    const localBaseMs = Math.max(
        0,
        Math.max(0, prevFoundAt - prevEndsAt) +
            hiddenCreditMs.get() -
            effectiveHiddenDebitMs(prevFoundAt),
    );
    const syncedBase = roundEndBaseMs.get();
    const syncedPieces = roundEndBonusPieces.get();
    const baseMs = syncedBase !== null ? syncedBase : localBaseMs;
    const bonusMs =
        syncedPieces !== null
            ? syncedPieces.reduce((a, b) => a + b, 0) * 60_000
            : tallyTimeBonusMinutes(hiderHand.get(), gameSize.get()) * 60_000;
    const hidingMs = baseMs + bonusMs;

    const ps = participants.get();
    const hiderEntry = ps.find((p) => p.role === "hider");
    const hiderName =
        roundEndHiderName.get()?.trim() ||
        hiderEntry?.displayName?.trim() ||
        displayNameAtom.get()?.trim() ||
        "Hider";

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
