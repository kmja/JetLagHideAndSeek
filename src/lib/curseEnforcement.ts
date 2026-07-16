import { persistentAtom } from "@nanostores/persistent";

import type { CategoryId } from "@/lib/categories";
import type { ReceivedCurse } from "@/lib/seekerInbound";

/**
 * In-app enforcement for the curses whose effect is "block the seekers
 * from asking certain (or all) questions". Most curses are real-world
 * tasks the app can only display; these three actually gate the
 * question UI:
 *
 *   • Drained Brain   — hider picks 3 categories at cast time; those
 *                       stay disabled for the rest of the run.
 *   • Spotty Memory   — one RANDOM category is disabled, re-rolled (by
 *                       the seekers, on a d6) after every question.
 *   • Urban Explorer  — no asking at all while the seekers are on
 *                       transit or in a transit station (the seeker
 *                       self-declares this with a toggle, since the app
 *                       has no reliable on-transit signal).
 *
 * The dice/movement curses (Jammed Door, Gambler's Feet, Endless
 * Tumble, Right Turn) are real-world actions — the app's only role is
 * the dice roller (see `curseMeta.curseRequiresDice` + `CurseInbox`),
 * there's nothing to block in the UI.
 */

export const CURSE_DRAINED_BRAIN = "Curse of the Drained Brain";
export const CURSE_SPOTTY_MEMORY = "Curse of Spotty Memory";
export const CURSE_URBAN_EXPLORER = "Curse of the Urban Explorer";

/**
 * The curses the app enforces as "prevents the seekers from asking".
 * Rulebook p386: there can't be more than one active curse preventing
 * asking (or taking transit) at a time — the hider must wait for the
 * active one to be cleared before playing another. We enforce this
 * mutual-exclusion at cast time for exactly the curses the app models as
 * ask-blockers (the real-world transit-blockers the app can't detect are
 * left to the players, as with all real-world curse effects).
 */
export const CURSE_ASK_BLOCKERS: ReadonlySet<string> = new Set([
    CURSE_DRAINED_BRAIN,
    CURSE_SPOTTY_MEMORY,
    CURSE_URBAN_EXPLORER,
]);

/** Whether a curse (by name) is one the app enforces as an ask-blocker. */
export function curseBlocksAsking(name: string): boolean {
    return CURSE_ASK_BLOCKERS.has(name);
}

/**
 * The name of the ask-blocking curse the HIDER has cast that is still
 * active on the seekers, or null. Set when the hider casts an ask-blocker
 * and cleared when the hider marks it cleared (the seekers must tell them,
 * per rulebook p386) — or automatically at round end via
 * `resetSharedRoundState`. Used by `CastCurseDialog` to block casting a
 * SECOND ask-blocker while one is still active. Hider-side + persistent so
 * a reload mid-curse keeps the constraint.
 */
export const activeBlockingCurse = persistentAtom<string | null>(
    "jlhs:activeBlockingCurse",
    null,
    { encode: (v) => v ?? "", decode: (v) => v || null },
);

/**
 * d6 → category mapping for Spotty Memory (6 categories, one per face).
 * Order is fixed so a given roll always maps to the same category.
 */
export const SPOTTY_DIE_CATEGORIES: CategoryId[] = [
    "matching",
    "measuring",
    "radius",
    "thermometer",
    "tentacles",
    "photo",
];

/**
 * Seeker self-declared "I'm on transit / in a station" flag, for Urban
 * Explorer enforcement. Persisted so a reload mid-curse keeps it; reset
 * per round in `roundActions`. The seeker toggles it from the curse
 * card — we trust their word, the same way we trust them to clear
 * real-world curses.
 */
export const seekerOnTransit = persistentAtom<boolean>(
    "seekerOnTransit",
    false,
    { encode: String, decode: (v) => v === "true" },
);

/**
 * The category currently disabled by a Spotty Memory die roll, or null
 * before the seekers have rolled (or right after they've asked a
 * question, which forces a fresh roll). Persisted; reset per round.
 */
export const spottyMemoryCategory = persistentAtom<CategoryId | null>(
    "spottyMemoryCategory",
    null,
    {
        encode: (v) => v ?? "",
        decode: (v) => ((v || null) as CategoryId | null),
    },
);

/** A curse still in effect = received and not yet cleared/dismissed. */
function activeCurses(curses: ReceivedCurse[]): ReceivedCurse[] {
    return curses.filter((c) => !c.dismissed);
}

export interface AskingRestrictions {
    /** Categories the seekers currently can't ask (partial block). */
    disabledCategories: Set<CategoryId>;
    /**
     * Specific SUBTYPE questions the seekers can't ask (Drained Brain, v907),
     * as `"<category>/<subtype>"` ids. The whole category stays askable — only
     * these exact questions are off. (Category-level Drained Brain picks —
     * radar/thermometer/photo — go into `disabledCategories` instead, since
     * those categories are a single question.)
     */
    disabledSubtypes: Set<string>;
    /** True when asking is blocked entirely (no category is allowed). */
    blockedAll: boolean;
    /** Human-readable reason for a full block (for tooltips/notices). */
    reason?: string;
    /** True when a Spotty Memory curse is active but unrolled — the
     *  seekers must roll the d6 (in the curse card) before they can ask. */
    needsSpottyRoll: boolean;
}

const ALL_CATEGORIES: CategoryId[] = [
    "matching",
    "measuring",
    "radius",
    "thermometer",
    "tentacles",
    "photo",
];

/**
 * Compute which categories (or all asking) are blocked by the seeker's
 * active curses. Pure — takes the live atoms' values so callers stay
 * reactive via `useStore`.
 */
export function computeAskingRestrictions(
    curses: ReceivedCurse[],
    opts: { onTransit: boolean; spottyCategory: CategoryId | null },
): AskingRestrictions {
    const active = activeCurses(curses);
    const disabledCategories = new Set<CategoryId>();
    const disabledSubtypes = new Set<string>();
    let blockedAll = false;
    let reason: string | undefined;
    let needsSpottyRoll = false;

    const drained = active.find((c) => c.name === CURSE_DRAINED_BRAIN);
    if (drained) {
        // v907: 3 specific questions. A bare category id (radar/thermometer/
        // photo) blocks the whole category; a "<cat>/<subtype>" blocks that
        // one question. Falls back to the legacy `disabledCategories` (whole-
        // category) field for a curse cast by an older client.
        const questions = drained.disabledQuestions;
        if (questions && questions.length > 0) {
            for (const q of questions) {
                if (q.includes("/")) disabledSubtypes.add(q);
                else disabledCategories.add(q as CategoryId);
            }
        } else if (drained.disabledCategories) {
            for (const id of drained.disabledCategories) {
                disabledCategories.add(id as CategoryId);
            }
        }
    }

    const spotty = active.find((c) => c.name === CURSE_SPOTTY_MEMORY);
    if (spotty) {
        if (opts.spottyCategory) {
            disabledCategories.add(opts.spottyCategory);
        } else {
            // Unrolled: the seekers must roll before they can ask at all
            // (the roll picks which category is off for the next one).
            needsSpottyRoll = true;
            blockedAll = true;
            reason =
                "Spotty Memory: roll the die in the curse card to see which category is disabled for your next question.";
        }
    }

    const urban = active.find((c) => c.name === CURSE_URBAN_EXPLORER);
    if (urban && opts.onTransit) {
        blockedAll = true;
        reason =
            "Urban Explorer: you can't ask questions while on transit or in a transit station.";
    }

    // If every category ended up disabled, surface it as a full block so
    // the New-question button reflects reality.
    if (
        !blockedAll &&
        ALL_CATEGORIES.every((c) => disabledCategories.has(c))
    ) {
        blockedAll = true;
        reason = "Every question category is disabled by an active curse.";
    }

    return {
        disabledCategories,
        disabledSubtypes,
        blockedAll,
        reason,
        needsSpottyRoll,
    };
}
