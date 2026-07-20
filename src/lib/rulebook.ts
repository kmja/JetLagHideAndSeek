import { atom } from "nanostores";

/**
 * Deep-link target for the in-app rulebook (v1044). Any surface can send the
 * reader straight to a rule — e.g. a "learn more" link on a question card, or a
 * `rulebook pNN` reference — by calling `openRulebookAt(anchor)`. `RulebookSheet`
 * subscribes: a non-null value opens the sheet and jumps to that section anchor,
 * then clears the atom. `null` closes / no pending jump. `""` opens at the top.
 */
export const rulebookTarget = atom<string | null>(null);

/** Open the rulebook, optionally jumping to a section anchor (slug). */
export function openRulebookAt(anchor = ""): void {
    rulebookTarget.set(anchor);
}

/**
 * Canonical rulebook section anchors (the slugified `###` headings in
 * `src/content/rulebook.md`). One source so every deep-link site + the sheet's
 * own quick-reference agree — if a heading is renamed, fix it here.
 */
export const RULEBOOK_ANCHORS = {
    // Question types (keyed by the schema category id).
    matching: "matching-questions",
    measuring: "measuring-questions",
    radius: "radar-questions",
    thermometer: "thermometer-questions",
    tentacles: "tentacle-questions",
    photo: "photo-questions",
    // Hider deck.
    deck: "the-hider-deck-2",
    powerups: "powerups",
    curses: "curses",
    timeBonuses: "time-bonuses",
    // Phases.
    hiding: "hiding",
    seeking: "seeking",
    endgame: "the-end-game",
    setup: "setting-up-your-map",
} as const;

/** Anchor for a question category id, if the rulebook has a dedicated section. */
export function rulebookAnchorForCategory(id: string): string | undefined {
    return (RULEBOOK_ANCHORS as Record<string, string>)[id];
}
