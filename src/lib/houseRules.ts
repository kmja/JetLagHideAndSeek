import { persistentAtom } from "@nanostores/persistent";

/**
 * House-rule toggles (Settings → House rules). Each one shifts a
 * single mechanic AWAY from the printed rulebook, so the default is
 * the rulebook value and turning the toggle ON gives the table a
 * stricter / different feel.
 *
 *   • alternateQuestionTypes — RULEBOOK off: the seeker can ask two
 *     questions of the same category in a row. House rule ON: the
 *     v395 alternation gate (you must alternate types — no "back-to-
 *     back" same category). Useful for tables that want more variety
 *     in the question stream than the rulebook requires.
 *
 *   • askOncePerQuestion — RULEBOOK off: a question can be asked
 *     again at increased cost (2×, 3×, … per rulebook p65 — the
 *     hider runs the draw-keep cycle that many times in a row).
 *     House rule ON: each question / subtype / preset can only be
 *     asked once per game. This was the previous app behaviour;
 *     some groups prefer it because it forces topic variety and
 *     prevents an aggressive seeker from grinding the same question
 *     for cards.
 *
 * Persistent so the table's preference survives reloads; not synced
 * over multiplayer — the host's setting governs the room because the
 * picker UI lives on the seeker device, but the hider's draw multi-
 * plier is derived locally from the inbox.
 */
export const alternateQuestionTypes = persistentAtom<boolean>(
    "houseRule:alternateQuestionTypes",
    false,
    {
        encode: (v) => (v ? "1" : ""),
        decode: (v) => v === "1",
    },
);

export const askOncePerQuestion = persistentAtom<boolean>(
    "houseRule:askOncePerQuestion",
    false,
    {
        encode: (v) => (v ? "1" : ""),
        decode: (v) => v === "1",
    },
);
