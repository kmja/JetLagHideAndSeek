/**
 * Hider deck data model + deck-composition helpers.
 *
 * The rulebook (p44) describes the deck as ~50% time bonuses, ~25% powerups,
 * ~25% curses. We build a single canonical deck definition the app shuffles
 * from on each round. Per-card mechanics are tagged with structured `effect`
 * values so the engine can dispatch on them without parsing prose.
 *
 * Curse and time-bonus values are paraphrased in our own words — the
 * rulebook text itself is copyrighted by Wendover Productions. Players
 * should still keep the physical cards handy for the canonical wording.
 */

import type { GameSize } from "./gameSetup";

export type CardKind = "time-bonus" | "powerup" | "curse";

export type PowerupKind =
    | "veto"
    | "randomize"
    | "discard1draw2"
    | "discard2draw3"
    | "draw1expand"
    | "duplicate"
    | "move";

interface BaseCard {
    /** Stable per-card-instance id, assigned at deck-shuffle time. */
    id: string;
    kind: CardKind;
    /** Display name (e.g. "Curse of the Bridge Troll"). */
    name: string;
    /** Short summary in our own words; the physical card is canonical. */
    description: string;
}

export interface TimeBonusCard extends BaseCard {
    kind: "time-bonus";
    /** Minutes added to final hiding time, scaled per game size. */
    minutes: Record<GameSize, number>;
}

export interface PowerupCard extends BaseCard {
    kind: "powerup";
    powerup: PowerupKind;
}

export interface CurseCard extends BaseCard {
    kind: "curse";
    /** Casting requirement (in our words). null if the curse has no cost. */
    castingCost: string | null;
}

export type Card = TimeBonusCard | PowerupCard | CurseCard;

/* ─────────────────────────── Time bonus templates ─────────────────────────── */

// Eight time-bonus tiers, copied twice or thrice for the right ratio.
// Total: 30 time-bonus cards in a 60-card deck.
const TIME_BONUS_TEMPLATES: Omit<TimeBonusCard, "id">[] = [
    {
        kind: "time-bonus",
        name: "+1 min",
        description:
            "Tiny time bonus — add 1 / 2 / 4 minutes to your final hiding time.",
        minutes: { small: 1, medium: 2, large: 4 },
    },
    {
        kind: "time-bonus",
        name: "+2 min",
        description:
            "Time bonus — add 2 / 3 / 6 minutes to your final hiding time.",
        minutes: { small: 2, medium: 3, large: 6 },
    },
    {
        kind: "time-bonus",
        name: "+4 min",
        description:
            "Time bonus — add 4 / 6 / 10 minutes to your final hiding time.",
        minutes: { small: 4, medium: 6, large: 10 },
    },
    {
        kind: "time-bonus",
        name: "+6 min",
        description:
            "Time bonus — add 6 / 9 / 15 minutes to your final hiding time.",
        minutes: { small: 6, medium: 9, large: 15 },
    },
    {
        kind: "time-bonus",
        name: "+8 min",
        description:
            "Time bonus — add 8 / 12 / 20 minutes to your final hiding time.",
        minutes: { small: 8, medium: 12, large: 20 },
    },
    {
        kind: "time-bonus",
        name: "+12 min",
        description:
            "Time bonus — add 12 / 18 / 30 minutes to your final hiding time.",
        minutes: { small: 12, medium: 18, large: 30 },
    },
    {
        kind: "time-bonus",
        name: "+15 min",
        description:
            "Big time bonus — add 15 / 22 / 40 minutes to your final hiding time.",
        minutes: { small: 15, medium: 22, large: 40 },
    },
    {
        kind: "time-bonus",
        name: "+20 min",
        description:
            "Big time bonus — add 20 / 30 / 60 minutes to your final hiding time.",
        minutes: { small: 20, medium: 30, large: 60 },
    },
];

/* ─────────────────────────── Powerups ─────────────────────────── */

const POWERUP_TEMPLATES: Omit<PowerupCard, "id">[] = [
    {
        kind: "powerup",
        powerup: "veto",
        name: "Veto",
        description:
            "Play in response to any question instead of answering. " +
            "The question still counts as asked — repeats cost extra — and " +
            "you draw no cards.",
    },
    {
        kind: "powerup",
        powerup: "randomize",
        name: "Randomize",
        description:
            "After a question is asked, swap it for a different random " +
            "question from the same category. Roll dice or use a random " +
            "number generator to pick.",
    },
    {
        kind: "powerup",
        powerup: "discard1draw2",
        name: "Discard 1, draw 2",
        description:
            "Pick one card to discard, then draw two new ones from the " +
            "top of the deck. Net +1 hand size.",
    },
    {
        kind: "powerup",
        powerup: "discard2draw3",
        name: "Discard 2, draw 3",
        description:
            "Pick two cards to discard, then draw three new ones. Net +1 " +
            "hand size. Needs at least two other cards in hand.",
    },
    {
        kind: "powerup",
        powerup: "draw1expand",
        name: "Draw 1, expand hand",
        description:
            "Draw 1 card and permanently raise your hand cap by 1 for the " +
            "rest of the round. Stackable.",
    },
    {
        kind: "powerup",
        powerup: "duplicate",
        name: "Duplicate",
        description:
            "Play as an exact copy of any other card in your hand — even " +
            "another curse or time bonus. The original stays in hand.",
    },
    {
        kind: "powerup",
        powerup: "move",
        name: "Move",
        description:
            "Pause the game and travel to a new hiding zone via transit. " +
            "Severe cost: discard your entire hand and reveal your original " +
            "station to the seekers.",
    },
];

/* ─────────────────────────── Curses ─────────────────────────── */

// All curse names match the rulebook; descriptions and casting costs are
// paraphrased in our own words so we're not reproducing the rulebook text.
const CURSE_TEMPLATES: Omit<CurseCard, "id">[] = [
    {
        kind: "curse",
        name: "Curse of the Luxury Car",
        description:
            "Seekers find a luxury car in their immediate area whose MSRP " +
            "is at least the cost of the car you photograph and send them.",
        castingCost:
            "Send a photo of a car. Use real-world MSRP for comparison.",
    },
    {
        kind: "curse",
        name: "Curse of the Bridge Troll",
        description:
            "Seekers must ask their next question from under a bridge.",
        castingCost:
            "Seekers must be at least 1 / 5 / 30 km from your station " +
            "(scales by game size).",
    },
    {
        kind: "curse",
        name: "Curse of the Drained Brain",
        description:
            "Played between question and answer. Lets you discard your hand " +
            "before drawing your reward — but you don't get to ban the " +
            "current question.",
        castingCost: null,
    },
    {
        kind: "curse",
        name: "Curse of the Water Weight",
        description:
            "Each seeker must acquire and carry 2 L of liquid for the rest " +
            "of the run. Lose it all and you get a time bonus.",
        castingCost:
            "Seekers must be within 1,000 ft (300 m) of a body of water.",
    },
    {
        kind: "curse",
        name: "Curse of the Zoologist",
        description:
            "Seekers must photograph and send you a wild bug from each of " +
            "three categories before asking another question.",
        castingCost: null,
    },
    {
        kind: "curse",
        name: "Curse of the Egg Partner",
        description:
            "Seekers must acquire a real egg and carry it for the rest of " +
            "the run. If it cracks, you get a time bonus.",
        castingCost: null,
    },
    {
        kind: "curse",
        name: "Curse of the Jammed Door",
        description:
            "For the next 30 minutes, seekers must roll 2d6 to enter any " +
            "doorway they encounter — a 2 or higher passes.",
        castingCost: null,
    },
    {
        kind: "curse",
        name: "Curse of the Spotty Memory",
        description:
            "Seekers roll a d6 to determine the category of their next " +
            "question. They must ask from whichever category the die picks.",
        castingCost: null,
    },
    {
        kind: "curse",
        name: "Curse of the Bird Guide",
        description:
            "Seekers must film a 5-second video of a bird (any species) " +
            "before asking their next question.",
        castingCost: null,
    },
    {
        kind: "curse",
        name: "Curse of the Unguided Tourist",
        description:
            "Seekers must walk to a nearby human-built structure they've " +
            "never seen before and photograph it.",
        castingCost: null,
    },
    {
        kind: "curse",
        name: "Curse of the Ransom Note",
        description:
            "Seekers' next question must be sent as a ransom-note collage " +
            "of letters cut from real magazines / newspapers / signs.",
        castingCost:
            "You can only play this if you're otherwise unable to play " +
            "any other curse.",
    },
    {
        kind: "curse",
        name: "Curse of the Mediocre Travel Agent",
        description:
            "Send seekers to a publicly accessible destination of your " +
            "choosing — they must reach it and bring back a physical " +
            "souvenir before asking another question.",
        castingCost: null,
    },
    {
        kind: "curse",
        name: "Curse of the Impressionable Consumer",
        description:
            "Seekers must engage with the next advertisement they see — " +
            "pay for the service or visit the location it advertises.",
        castingCost: null,
    },
    {
        kind: "curse",
        name: "Curse of the U-Turn",
        description:
            "Seekers can't board the next transit they were going to take. " +
            "They must wait for the next vehicle on the opposite line.",
        castingCost: null,
    },
    {
        kind: "curse",
        name: "Curse of the Cairn",
        description:
            "Seekers must build a small cairn (~5 stacked rocks) in nature " +
            "and photograph it before asking another question.",
        castingCost:
            "You can only play this if you're otherwise unable to play " +
            "any other curse.",
    },
    {
        kind: "curse",
        name: "Curse of the Distant Cuisine",
        description:
            "Seekers must travel to and eat at a restaurant whose cuisine " +
            "is from the furthest country they can reach.",
        castingCost: null,
    },
    {
        kind: "curse",
        name: "Curse of the Lemon Phylactery",
        description:
            "Each seeker must affix a real lemon to themselves and keep it " +
            "touching skin or clothing for the rest of the round. Drop it, " +
            "you get a time bonus.",
        castingCost: null,
    },
    {
        kind: "curse",
        name: "Curse of the Gambler's Feet",
        description:
            "Seekers roll a d6 every N steps — only on the rolled number " +
            "may they take the next step.",
        castingCost: null,
    },
    {
        kind: "curse",
        name: "Curse of the Urban Explorer",
        description:
            "Seekers may not ask questions while inside any transit station " +
            "platform or building for the next 30 minutes.",
        castingCost: null,
    },
    {
        kind: "curse",
        name: "Curse of the Overflowing Chalice",
        description:
            "For the next two questions, the hider draws an extra card on " +
            "each category — matching becomes draw 4 / keep 1, radar 3 / 1, " +
            "and so on.",
        castingCost: null,
    },
    {
        kind: "curse",
        name: "Curse of the Labyrinth",
        description:
            "Seekers must draw a solvable maze by hand within a time limit " +
            "before they can ask another question.",
        castingCost: null,
    },
    {
        kind: "curse",
        name: "Curse of the Hidden Hangman",
        description:
            "You pick a five-letter word. Seekers must guess it via hangman " +
            "before asking another question.",
        castingCost: null,
    },
    {
        kind: "curse",
        name: "Curse of the Endless Tumble",
        description:
            "Roll a d6. Seekers must move 30 m parallel to the ground " +
            "(downhill if possible) for each point rolled.",
        castingCost: null,
    },
    {
        kind: "curse",
        name: "Curse of the Right Turn",
        description:
            "Seekers must take only right turns at every street intersection " +
            "for the next 15 minutes.",
        castingCost: null,
    },
];

/* ─────────────────────────── Composition + shuffling ─────────────────────────── */

/**
 * Build the canonical deck for a new round: 60 cards, ~50% time bonuses
 * (we use 30), ~25% powerups (we use 15), ~25% curses (the remaining 15).
 *
 * Time bonuses repeat templates in roughly the rulebook's mix: 8 unique
 * tiers, each repeated 3-4 times.
 *
 * Powerups duplicate the more common ones (veto / discard / draw1expand)
 * a couple of times to land at 15.
 *
 * Curses are sampled from CURSE_TEMPLATES (24 entries) without replacement
 * to fill the remaining 15 slots.
 */
function makeDeck(): Card[] {
    const out: Card[] = [];

    // Time bonuses — repeat templates to land near 30
    for (let i = 0; i < TIME_BONUS_TEMPLATES.length; i++) {
        const template = TIME_BONUS_TEMPLATES[i];
        // 4 copies of the smaller tiers, 3 of the larger ones
        const count = i < 4 ? 4 : 3;
        for (let j = 0; j < count; j++) {
            out.push({ ...template, id: makeId() });
        }
    }

    // Powerups — duplicate Veto, Discard1Draw2 and Draw1Expand a couple times
    const powerupCounts: Record<PowerupKind, number> = {
        veto: 3,
        randomize: 2,
        discard1draw2: 3,
        discard2draw3: 1,
        draw1expand: 3,
        duplicate: 2,
        move: 1,
    };
    for (const template of POWERUP_TEMPLATES) {
        const n = powerupCounts[template.powerup] ?? 1;
        for (let j = 0; j < n; j++) {
            out.push({ ...template, id: makeId() });
        }
    }

    // Curses — sample 15 from the 24 templates without replacement
    const curseTemplates = [...CURSE_TEMPLATES];
    shuffleInPlace(curseTemplates);
    for (let i = 0; i < 15; i++) {
        const template = curseTemplates[i % curseTemplates.length];
        out.push({ ...template, id: makeId() });
    }

    return out;
}

export function shuffledDeck(): Card[] {
    const deck = makeDeck();
    shuffleInPlace(deck);
    return deck;
}

/** Fisher-Yates in-place shuffle. */
function shuffleInPlace<T>(arr: T[]): void {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
}

/** Random hex id. crypto.randomUUID if available, else a fallback. */
function makeId(): string {
    if (
        typeof crypto !== "undefined" &&
        typeof (crypto as any).randomUUID === "function"
    ) {
        return (crypto as any).randomUUID();
    }
    return Math.random().toString(36).slice(2, 10);
}

/* ─────────────────────────── Time-bonus tally ─────────────────────────── */

/** Sum the minute values of all time-bonus cards currently in hand,
 *  scaled to the given game size. Used for the projected-total display. */
export function tallyTimeBonusMinutes(
    hand: Card[],
    size: GameSize,
): number {
    let total = 0;
    for (const card of hand) {
        if (card.kind === "time-bonus") {
            total += card.minutes[size] ?? 0;
        }
    }
    return total;
}
