import type { GameSize } from "@/lib/gameSetup";

/**
 * Seeker-side curse metadata: which curses make the SEEKERS roll dice,
 * and which are time-limited (so the app can auto-clear them) vs. cleared
 * by completing a real-world task (manual clear).
 *
 * The wire/​link curse payload is only `{ name, description, castingCost }`,
 * so this derives everything the seeker UI needs from the name (+ a
 * description fallback for demo / unknown curses) — no protocol change.
 */

/** Curses that require the SEEKERS to roll a die/dice to comply. */
const DICE_CURSES = new Set<string>([
    "Curse of the Jammed Door", // roll 2d6 ≥ 7 to pass a doorway
    "Curse of Spotty Memory", // roll a die to pick the disabled category
    "Curse of the Endless Tumble", // roll a die 30 m, land 5/6
    "Curse of the Gambler's Feet", // roll a die before stepping
]);

/**
 * Does this curse require the seekers to roll dice? Known curses are
 * matched by name; for anything else (e.g. demo curses) we fall back to
 * the description actually telling the seekers to roll.
 */
export function curseRequiresDice(curse: {
    name: string;
    description: string;
}): boolean {
    if (DICE_CURSES.has(curse.name)) return true;
    const d = curse.description.toLowerCase();
    return /\broll(?:s|ing|ed)?\b/.test(d) && /\b(dice|die|d6|d20)\b/.test(d);
}

/**
 * How many d6 a dice curse rolls at once. The Curse of the Jammed Door
 * requires TWO dice per doorway (rulebook p396: "Seekers must roll two
 * d6 dice"); every other dice curse rolls one. v970 (rulebook audit B).
 */
export function curseDiceCount(curse: {
    name: string;
    description: string;
}): number {
    if (curse.name === "Curse of the Jammed Door") return 2;
    return /\btwo\s+d6\b/i.test(curse.description) ? 2 : 1;
}

/**
 * Curse of the Jammed Door: after a FAILED doorway roll (< 7 on 2d6), that
 * doorway can be re-attempted after 5 min (S) / 10 min (M) / 15 min (L)
 * (rulebook p396). Returns the cooldown in ms for the current game size.
 */
const JAMMED_DOOR_COOLDOWN_MIN: Record<GameSize, number> = {
    small: 5,
    medium: 10,
    large: 15,
};
export function jammedDoorCooldownMs(size: GameSize): number {
    return JAMMED_DOOR_COOLDOWN_MIN[size] * 60_000;
}

/**
 * Time-limited curses → duration in minutes per game size. Everything
 * not listed here clears when the seekers finish the curse's task (manual
 * clear) — including the "for the rest of your run" curses, which the
 * seeker clears at round end.
 */
const TIMED_CURSES: Record<string, Record<GameSize, number>> = {
    "Curse of the Jammed Door": { small: 30, medium: 60, large: 180 },
    "Curse of the Gambler's Feet": { small: 20, medium: 40, large: 60 },
    "Curse of the Right Turn": { small: 20, medium: 40, large: 60 },
};

/**
 * Duration (ms) of a time-limited curse for the current game size, or
 * `null` if the curse has no fixed timer (the seekers clear it by doing
 * something in the real world). Known curses come from `TIMED_CURSES`;
 * for unknown / demo curses we parse a plain "for the next N minutes /
 * hours" from the description (size-variant "(S)/(M)/(L)" descriptions
 * are table-driven only, never parsed, since the plain regex can't pick
 * the right variant).
 */
export function curseDurationMs(
    curse: { name: string; description: string },
    size: GameSize,
): number | null {
    const t = TIMED_CURSES[curse.name];
    if (t) return t[size] * 60_000;
    if (/\([SML]\)/.test(curse.description)) return null;
    const m = curse.description.match(
        /for the next\s+(\d+(?:\.\d+)?)\s*(seconds?|minutes?|min|hours?|hrs?|h)\b/i,
    );
    if (!m) return null;
    const n = parseFloat(m[1]);
    const unit = m[2].toLowerCase();
    const mult = unit.startsWith("s")
        ? 1000
        : unit.startsWith("h")
          ? 3_600_000
          : 60_000;
    return n * mult;
}

/** mm:ss for a curse countdown. Clamps at 0. */
export function formatCurseCountdown(ms: number): string {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
}
