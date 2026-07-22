import { persistentAtom } from "@nanostores/persistent";

import type { GameSize } from "./gameSetup";

/**
 * Curse END-OF-ROUND / self-report BONUS system (v1087).
 *
 * Several curses award the HIDER extra hidden-time if the seekers fail to keep
 * up a task by the end of the round (rulebook "you are awarded an extra N min"):
 *   - Mediocre Travel Agent — lose the souvenir.
 *   - Water Weight — lose/abandon the liquid.
 *   - Egg Partner — the egg cracks.
 *   - Lemon Phylactery — a lemon comes off.
 *   - Endless Tumble — hit someone with a die (mid-round only, no end prompt).
 *
 * Two paths award the bonus (both funnel through `store.awardCurseBonus`):
 *   1. Mid-round: the seekers self-report the loss from their curse card
 *      (honor system) → a `curseFail` wire message → the hider awards it.
 *   2. End of round: the hider is prompted per active bonus-curse ("did the
 *      seekers still have their egg?") in the EndOfRoundDialog; a "No" awards it.
 *
 * `curseBonusResolved` (per-round, keyed by the curse's `castId`) records which
 * bonus curses are already settled ("lost" = awarded, "kept" = no bonus) so the
 * end-of-round prompt doesn't re-ask and the award can't double-count.
 */

export interface CurseBonusDef {
    /** Exact curse name in the deck. */
    name: string;
    /** Minutes awarded to the hider per game size when the seekers fail. */
    minutes: Record<GameSize, number>;
    /** Seeker-side self-report button label (mid-round honor report). */
    reportLabel: string;
    /** Hider end-of-round prompt, or null for a mid-round-only curse
     *  (Endless Tumble — no lasting obligation to check at round end). */
    endPrompt: string | null;
    /** Short noun for toasts/messages. */
    noun: string;
}

export const CURSE_BONUSES: CurseBonusDef[] = [
    {
        name: "Curse of the Mediocre Travel Agent",
        minutes: { small: 30, medium: 45, large: 60 },
        reportLabel: "We lost the souvenir",
        endPrompt: "Did the seekers bring you a souvenir from the destination?",
        noun: "souvenir",
    },
    {
        name: "Curse of Water Weight",
        minutes: { small: 30, medium: 30, large: 60 },
        reportLabel: "We lost the water",
        endPrompt: "Did the seekers still have their water weight?",
        noun: "water weight",
    },
    {
        name: "Curse of the Egg Partner",
        minutes: { small: 30, medium: 45, large: 60 },
        reportLabel: "The egg cracked",
        endPrompt: "Did the seekers still have their egg partner?",
        noun: "egg partner",
    },
    {
        name: "Curse of the Lemon Phylactery",
        minutes: { small: 30, medium: 45, large: 60 },
        reportLabel: "We lost a lemon",
        endPrompt: "Did the seekers still have their lemon phylactery?",
        noun: "lemon phylactery",
    },
    {
        name: "Curse of the Endless Tumble",
        minutes: { small: 10, medium: 20, large: 30 },
        reportLabel: "We hit someone with a die",
        // Mid-round only: hitting someone is a one-off event, not an
        // end-of-round "did you keep it?" check.
        endPrompt: null,
        noun: "die hit",
    },
];

const BY_NAME = new Map(CURSE_BONUSES.map((b) => [b.name, b]));

/** The bonus definition for a curse name, or null if it has no bonus. */
export function curseBonusFor(name: string | null | undefined): CurseBonusDef | null {
    return (name && BY_NAME.get(name)) || null;
}

/** Minutes the hider is awarded for a curse-bonus loss at the given size. */
export function curseBonusMinutes(
    name: string | null | undefined,
    size: GameSize,
): number {
    return curseBonusFor(name)?.minutes[size] ?? 0;
}

/**
 * Per-round settlement of each bonus curse, keyed by its `castId` (stringified).
 * "lost" = the seekers failed → the hider was awarded the bonus; "kept" = the
 * hider confirmed no bonus. Absent = not yet resolved (still promptable).
 * Reset each round in `roundReset`.
 */
export const curseBonusResolved = persistentAtom<Record<string, "kept" | "lost">>(
    "curseBonusResolved",
    {},
    {
        encode: JSON.stringify,
        decode: (v) => {
            try {
                const parsed = JSON.parse(v);
                return parsed && typeof parsed === "object" ? parsed : {};
            } catch {
                return {};
            }
        },
    },
);

/** Mark a bonus curse settled. `castId` undefined (link/solo curses) is a no-op. */
export function setCurseBonusResolved(
    castId: number | undefined,
    outcome: "kept" | "lost",
): void {
    if (castId == null) return;
    curseBonusResolved.set({ ...curseBonusResolved.get(), [String(castId)]: outcome });
}

/** Whether a bonus curse (by castId) is still awaiting resolution. */
export function isCurseBonusUnresolved(castId: number | undefined): boolean {
    if (castId == null) return false;
    return curseBonusResolved.get()[String(castId)] === undefined;
}
