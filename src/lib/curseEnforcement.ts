import { persistentAtom } from "@nanostores/persistent";

import type { CategoryId } from "@/lib/categories";
import { curseDurationMs } from "@/lib/curseMeta";
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
export const CURSE_JAMMED_DOOR = "Curse of the Jammed Door";
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
 * v1035: curses whose rulebook effect is a TASK the seekers must complete
 * "before asking another question" — a FULL ask-block until they finish the
 * real-world task and clear the curse. The app can't verify the task itself
 * (film a bird / build a cairn / find a lemon …), but it CAN stop the seekers
 * asking their next question until they mark the curse cleared, which is the
 * enforceable half of the effect.
 *
 * Distinct from:
 *   • the pure movement/transit blockers (Jammed Door, U-Turn, Gambler's Feet,
 *     Right Turn) — they block BOARDING, not asking, and the app has no transit
 *     signal, so they stay purely real-world;
 *   • the "next question must be asked a certain WAY/PLACE" constraints (Ransom
 *     Note = cut-out letters; Bridge Troll = from under a bridge) — the seekers
 *     CAN ask, just with a constraint they self-comply with, so those aren't a
 *     full block.
 */
const CURSE_ASK_UNTIL_DONE_BLOCKERS: ReadonlySet<string> = new Set([
    "Curse of the Unguided Tourist",
    "Curse of the Mediocre Travel Agent",
    "Curse of the Distant Cuisine",
    "Curse of the Bird Guide",
    "Curse of the Cairn",
    "Curse of Water Weight",
    "Curse of the Zoologist",
    "Curse of the Egg Partner",
    "Curse of the Luxury Car",
    "Curse of the Impressionable Consumer",
    "Curse of the Endless Tumble",
    "Curse of the Labyrinth",
    "Curse of the Hidden Hangman",
    "Curse of the Lemon Phylactery",
]);

/**
 * Whether an ACTIVE curse fully blocks the seekers' next question until they
 * clear it (a "before asking another question" task curse). Known names first;
 * an unknown (demo) curse falls back to the rulebook phrasing in its
 * description — but NOT the transit-only "before boarding", which isn't an
 * ask-block.
 */
export function curseBlocksAskingUntilCleared(curse: {
    name: string;
    description: string;
}): boolean {
    if (CURSE_ASK_UNTIL_DONE_BLOCKERS.has(curse.name)) return true;
    return /before asking (?:another|the next|a) question|(?:cannot|can't|can not) ask another question|until they have acquired/i.test(
        curse.description,
    );
}

/**
 * v970 (rulebook audit B): the rulebook's one-at-a-time limit covers EVERY
 * curse "actively preventing the seekers from asking questions or taking
 * transit" (p386) — not just the three the app enforces in the question UI.
 * That's the task-blocking curses (the seekers can't ask their next question
 * until the task is done) and the transit/movement blockers. The hider must
 * wait for the active one to be cleared before casting another.
 */
const CURSE_TASK_OR_TRANSIT_BLOCKERS: ReadonlySet<string> = new Set([
    // "before asking another question" task curses
    "Curse of the Unguided Tourist",
    "Curse of the Ransom Note",
    "Curse of the Mediocre Travel Agent",
    "Curse of the Distant Cuisine",
    "Curse of the Bird Guide",
    "Curse of the Cairn",
    "Curse of Water Weight",
    "Curse of the Zoologist",
    "Curse of the Egg Partner",
    "Curse of the Bridge Troll",
    "Curse of the Luxury Car",
    "Curse of the Impressionable Consumer",
    "Curse of the Endless Tumble",
    "Curse of the Labyrinth",
    "Curse of the Hidden Hangman",
    "Curse of the Lemon Phylactery",
    // transit / movement blockers
    "Curse of the Jammed Door",
    "Curse of the U-Turn",
    "Curse of the Gambler's Feet",
    "Curse of the Right Turn",
]);

/**
 * Whether casting this curse claims the rulebook's single
 * blocking-curse slot. Known names first; unknown (demo) curses fall
 * back to the description telling the seekers they can't ask/board
 * until something is done.
 */
export function cursePreventsAskingOrTransit(curse: {
    name: string;
    description: string;
}): boolean {
    if (CURSE_ASK_BLOCKERS.has(curse.name)) return true;
    if (CURSE_TASK_OR_TRANSIT_BLOCKERS.has(curse.name)) return true;
    return /before (?:asking|they can ask|boarding)|cannot ask another question/i.test(
        curse.description,
    );
}

/**
 * Whether the recorded active blocking curse has ALREADY run out on its
 * own — true only for the timed blockers (whose duration the app knows
 * via `curseDurationMs`); task blockers stay active until the hider
 * marks them cleared.
 */
export function blockingCurseExpired(
    name: string,
    castAt: number | null,
    size: "small" | "medium" | "large",
    now: number,
): boolean {
    if (castAt == null) return false;
    const dur = curseDurationMs({ name, description: "" }, size);
    return dur != null && now >= castAt + dur;
}

/**
 * Whether casting `curse` is blocked right now because ANOTHER ask/transit
 * blocking curse is still active (rulebook p386 — only one at a time). Shared
 * by `CastCurseDialog` (gates the cast) AND the hand (v1031 — the Play/Cast
 * button is disabled up-front so the block is visible before opening the
 * dialog). Returns false for a non-blocking curse or when the active blocker
 * is this same curse / has expired.
 */
export function curseBlockedByActive(
    curse: { name: string; description: string },
    activeBlocker: string | null,
    activeBlockerAt: number | null,
    size: "small" | "medium" | "large",
    now: number,
): boolean {
    if (!cursePreventsAskingOrTransit(curse)) return false;
    if (activeBlocker === null || activeBlocker === curse.name) return false;
    return !blockingCurseExpired(activeBlocker, activeBlockerAt, size, now);
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
 * Unix ms when the active blocking curse was cast (v970). Lets the cast
 * gate auto-expire a TIMED blocker (Jammed Door / Gambler's Feet / Right
 * Turn auto-clear on the seeker side after their duration), so the hider
 * isn't stuck manually clearing a curse that already ran out.
 */
export const activeBlockingCurseCastAt = persistentAtom<number | null>(
    "jlhs:activeBlockingCurseCastAt",
    null,
    {
        encode: (v) => (v == null ? "" : String(v)),
        decode: (v) => {
            const n = Number(v);
            return v && Number.isFinite(n) ? n : null;
        },
    },
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
 * v969 (rulebook audit A7): resolve a Spotty Memory d6 roll to a category,
 * game-size-aware. Rulebook p397: "For small-sized games, which only include
 * five categories of questions, a six would result in a reroll" — Small games
 * have no tentacles, so faces 1–5 map to the five Small categories and a 6
 * returns null (= reroll). Medium/Large use the fixed 6-face mapping.
 */
export function spottyCategoryForRoll(
    roll: number,
    size: "small" | "medium" | "large",
): CategoryId | null {
    if (size === "small") {
        if (roll === 6) return null; // reroll
        const smallCats = SPOTTY_DIE_CATEGORIES.filter(
            (c) => c !== "tentacles",
        );
        return smallCats[roll - 1] ?? null;
    }
    return SPOTTY_DIE_CATEGORIES[roll - 1] ?? null;
}

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

    // v1035: a "before asking another question" task curse (Bird Guide, Cairn,
    // Zoologist, Labyrinth, …) blocks ALL asking until the seekers complete the
    // task and clear the curse. The app can't verify the task, but it stops the
    // next question until the curse is marked cleared.
    if (!blockedAll) {
        const taskBlocker = active.find((c) => curseBlocksAskingUntilCleared(c));
        if (taskBlocker) {
            blockedAll = true;
            reason = `${taskBlocker.name}: finish the curse task, then clear the curse before asking your next question.`;
        }
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
