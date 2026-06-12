/**
 * Hider deck data model + deck-composition helpers.
 *
 * Canonical composition (taken card-by-card from the physical deck):
 *
 *   Time bonuses — 55 cards
 *     Tier S=2  / M=3  / L=5  min  × 25
 *     Tier S=4  / M=6  / L=10 min  × 15
 *     Tier S=6  / M=9  / L=15 min  × 10
 *     Tier S=8  / M=12 / L=20 min  × 3
 *     Tier S=12 / M=18 / L=30 min  × 2
 *
 *   Powerups — 21 cards
 *     Discard 2, Draw 3      × 4
 *     Discard 1, Draw 2      × 4
 *     Veto Question          × 4
 *     Randomize Question     × 4
 *     Duplicate Another Card × 2
 *     Draw 1, Expand 1       × 2
 *     Move                   × 1
 *
 *   Curses — TBD (still using paraphrased templates pending an exact
 *   tally from the physical deck).
 *
 * Powerup descriptions are copied verbatim from the physical cards
 * (each is short and functional — not creative prose). Curse
 * descriptions remain paraphrased pending verification.
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

/** One entry per distinct tier shown on the physical cards. `copies`
 *  is how many of that tier appear in a full deck. Total here = 55. */
interface TimeBonusTier {
    template: Omit<TimeBonusCard, "id">;
    copies: number;
}

const TIME_BONUS_TIERS: TimeBonusTier[] = [
    {
        template: {
            kind: "time-bonus",
            name: "Time bonus · 5",
            description:
                "Add to your final hiding time: 2 min (S) / 3 min (M) / 5 min (L).",
            minutes: { small: 2, medium: 3, large: 5 },
        },
        copies: 25,
    },
    {
        template: {
            kind: "time-bonus",
            name: "Time bonus · 10",
            description:
                "Add to your final hiding time: 4 min (S) / 6 min (M) / 10 min (L).",
            minutes: { small: 4, medium: 6, large: 10 },
        },
        copies: 15,
    },
    {
        template: {
            kind: "time-bonus",
            name: "Time bonus · 15",
            description:
                "Add to your final hiding time: 6 min (S) / 9 min (M) / 15 min (L).",
            minutes: { small: 6, medium: 9, large: 15 },
        },
        copies: 10,
    },
    {
        template: {
            kind: "time-bonus",
            name: "Time bonus · 20",
            description:
                "Add to your final hiding time: 8 min (S) / 12 min (M) / 20 min (L).",
            minutes: { small: 8, medium: 12, large: 20 },
        },
        copies: 3,
    },
    {
        template: {
            kind: "time-bonus",
            name: "Time bonus · 30",
            description:
                "Add to your final hiding time: 12 min (S) / 18 min (M) / 30 min (L).",
            minutes: { small: 12, medium: 18, large: 30 },
        },
        copies: 2,
    },
];

/* ─────────────────────────── Powerups ─────────────────────────── */

/** One entry per distinct powerup card with the count printed on
 *  the deck-composition reference card. Total = 21. */
interface PowerupSlot {
    template: Omit<PowerupCard, "id">;
    copies: number;
}

const POWERUP_SLOTS: PowerupSlot[] = [
    {
        template: {
            kind: "powerup",
            powerup: "discard2draw3",
            name: "Discard 2, Draw 3",
            description:
                "Discard two other cards from your hand. Then, draw and keep three cards from the hider deck.",
        },
        copies: 4,
    },
    {
        template: {
            kind: "powerup",
            powerup: "discard1draw2",
            name: "Discard 1, Draw 2",
            description:
                "Discard one other card from your hand. Then, draw and keep two cards from the hider deck.",
        },
        copies: 4,
    },
    {
        template: {
            kind: "powerup",
            powerup: "veto",
            name: "Veto Question",
            description:
                "Play instead of answering a question. No answer is given and no reward is earned.",
        },
        copies: 4,
    },
    {
        template: {
            kind: "powerup",
            powerup: "randomize",
            name: "Randomize Question",
            description:
                "Play instead of answering a question. A new unasked question from the same category is chosen, at random, which you answer instead.",
        },
        copies: 4,
    },
    {
        template: {
            kind: "powerup",
            powerup: "duplicate",
            name: "Duplicate Another Card",
            description:
                "Play this card as a copy of any other card in your hand. This may be used to duplicate a time bonus at the end of your round.",
        },
        copies: 2,
    },
    {
        template: {
            kind: "powerup",
            powerup: "draw1expand",
            name: "Draw 1, Expand 1",
            description:
                "Draw one card from the hider deck. For the rest of the round, you can hold one additional card in your hand.",
        },
        copies: 2,
    },
    {
        template: {
            kind: "powerup",
            powerup: "move",
            name: "Move",
            description:
                "Discard your hand and send the hiders the location of your transit station. This card grants a 10-minute (S) / 20-minute (M) / 60-minute (L) period to establish a new hiding zone somewhere else on the game map. The seekers are frozen and your hiding timer is paused until this new hiding period has concluded. This card cannot be played during the endgame.",
        },
        copies: 1,
    },
];

/* ─────────────────────────── Curses ─────────────────────────── */

/** One entry per distinct curse card with the count printed on the
 *  deck-composition reference card. Descriptions are verbatim from
 *  the physical cards. S / M / L scaled values are inlined into the
 *  description text for now; future work will lift them to a
 *  structured field so the UI can render the right value per game
 *  size automatically. */
interface CurseSlot {
    template: Omit<CurseCard, "id">;
    copies: number;
}

const CURSE_SLOTS: CurseSlot[] = [
    {
        template: {
            kind: "curse",
            name: "Curse of the Unguided Tourist",
            description:
                "Send the seekers an unzoomed Google Street View image from a street within 150 meters of where they are now. The shot has to be parallel to the horizon and include at least one human-built structure other than a road. Without using the internet for research, they must find what you sent them in real life before they can use transportation or ask another question. They must send a picture to the hider for verification.",
            castingCost: "Seekers must be outside.",
        },
        copies: 1,
    },
    {
        template: {
            kind: "curse",
            name: "Curse of the Ransom Note",
            description:
                "The next question that the seekers ask must be composed of words and letters cut out of any printed material. The question must be coherent and include at least 5 words.",
            castingCost:
                "Spell out “ransom note” as a ransom note (without using this card).",
        },
        copies: 1,
    },
    {
        template: {
            kind: "curse",
            name: "Curse of the Mediocre Travel Agent",
            description:
                "Choose any publicly-accessible place within 0.5 km (S) / 0.5 km (M) / 1 km (L) of the seekers' current location. They cannot currently be on transit. They must go there, and spend at least 5 min (S) / 5 min (M) / 10 min (L) there, before asking another question. They must send you at least three photos of them enjoying their vacation, and procure an object to bring you as a souvenir. If this souvenir is lost before they can give it to you, you are awarded an extra 30 min (S) / 45 min (M) / 60 min (L).",
            castingCost:
                "Their vacation destination must be further from you than their current location.",
        },
        copies: 1,
    },
    {
        template: {
            kind: "curse",
            name: "Curse of the Distant Cuisine",
            description:
                "Find a restaurant within your zone that explicitly serves food from a specific foreign country. The seekers must visit a restaurant serving food from a country that is an equal or greater distance away before asking another question.",
            castingCost: "You must be at the restaurant.",
        },
        copies: 1,
    },
    {
        template: {
            kind: "curse",
            name: "Curse of the Jammed Door",
            description:
                "For the next 0.5 h (S) / 1 h (M) / 3 h (L), whenever the seekers want to pass through a doorway into a building, business, train, or other vehicle, they must first roll 2 dice. If they do not roll a 7 or higher, they cannot enter that space (including through other doorways.) Any given doorway can be re-attempted after 5 min (S) / 10 min (M) / 15 min (L).",
            castingCost: "Discard two cards.",
        },
        copies: 1,
    },
    {
        template: {
            kind: "curse",
            name: "Curse of Spotty Memory",
            description:
                "For the rest of your run, one random category of questions will be disabled at all times. After this curse is played, seekers must roll a die to determine the category of questions to be disabled. This category remains disabled until the next question is asked, at which point a die is rolled again to choose a new category. The same category can be disabled multiple times in a row.",
            castingCost: "Discard a time bonus.",
        },
        copies: 1,
    },
    {
        template: {
            kind: "curse",
            name: "Curse of the Bird Guide",
            description:
                "You have one chance to film a bird for as long as possible, up to 5 min (S) / 10 min (M) / 15 min (L) straight. If, at any point, the bird leaves the frame, your timer is stopped. The seekers must then film a bird for the same amount of time or longer before asking another question.",
            castingCost: "Film a bird.",
        },
        copies: 1,
    },
    {
        template: {
            kind: "curse",
            name: "Curse of the Cairn",
            description:
                "You have one attempt to stack as many rocks on top of each other as you can in a freestanding tower. Each rock may only touch one other rock. Once you have added a rock to the tower, it may not be removed. Before adding another rock, the tower must stand for at least five seconds. If at any point, any rock other than the base rock touches the ground, your tower has fallen. Once your tower falls, tell the seekers how many rocks high your tower was when it last stood for five seconds. The seekers must then construct a rock tower of the same number of rocks, under the same parameters, before asking another question. If their tower falls, they must restart. The rocks must be found in nature, and both teams must disperse the rocks after building.",
            castingCost: "Build a rock tower.",
        },
        copies: 1,
    },
    {
        template: {
            kind: "curse",
            name: "Curse of Water Weight",
            description:
                "The seekers must acquire and carry at least 2 liters of liquid per seeker for the rest of your run. They cannot ask another question until they have acquired the liquid. The water may be distributed between seekers as they see fit. If the liquid is lost or abandoned at any point after acquisition, the hider is awarded a 30 min (S) / 30 min (M) / 60 min (L) bonus.",
            castingCost:
                "Seekers must be within 300 meters of a body of water.",
        },
        copies: 1,
    },
    {
        template: {
            kind: "curse",
            name: "Curse of the Zoologist",
            description:
                "Take a photo of a wild fish, bird, mammal, reptile, amphibian, or bug. The seekers must take a picture of a wild animal in the same category before asking another question.",
            castingCost: "A photo of an animal.",
        },
        copies: 1,
    },
    {
        template: {
            kind: "curse",
            name: "Curse of the Egg Partner",
            description:
                "The seekers must acquire an egg before asking another question. This egg is now treated as an official team member of the seekers. If any team members are abandoned or killed (defined as any crack, in the egg's case) before the end of your run, you are awarded an extra 30 min (S) / 45 min (M) / 60 min (L). This curse cannot be played during the endgame.",
            castingCost: "Discard two cards.",
        },
        copies: 1,
    },
    {
        template: {
            kind: "curse",
            name: "Curse of the U-Turn",
            description:
                "The seekers must disembark their current mode of transportation at the next station (as long as that station is serviced by another form of transit in the next 0.5 h (S) / 0.5 h (M) / 1 h (L).)",
            castingCost:
                "Seekers must be heading the wrong way. (Their next station is further from you than they are.)",
        },
        copies: 1,
    },
    {
        template: {
            kind: "curse",
            name: "Curse of the Bridge Troll",
            description:
                "The seekers must ask their next question from under a bridge.",
            castingCost:
                "Seekers must be at least 2 km (S) / 10 km (M) / 50 km (L) from you.",
        },
        copies: 1,
    },
    {
        template: {
            kind: "curse",
            name: "Curse of the Luxury Car",
            description:
                "Take a photo of a car. The seekers must take a photo of a more expensive car before asking another question.",
            castingCost: "A photo of a car.",
        },
        copies: 1,
    },
    {
        template: {
            kind: "curse",
            name: "Curse of the Drained Brain",
            description:
                "Choose three questions in different categories. The seekers cannot ask those questions for the rest of your run.",
            castingCost: "Discard your hand.",
        },
        copies: 1,
    },
    {
        template: {
            kind: "curse",
            name: "Curse of the Impressionable Consumer",
            description:
                "Seekers must enter and gain admission (if applicable) to a location or buy a product that they saw an advertisement for before asking another question. This advertisement must be found out in the world, not on a seeker's device, and must be at least 30 meters from the product or location itself.",
            castingCost: "The seekers' next question is free.",
        },
        copies: 1,
    },
    {
        template: {
            kind: "curse",
            name: "Curse of the Endless Tumble",
            description:
                "Seekers must roll a die at least 30 meters and have it land on a 5 or a 6 before they can ask another question. The die must roll the full distance, unaided, using only the momentum from the initial throw and gravity to travel the 30 meters. If the seekers accidentally hit someone with a die, you are awarded a 10 min (S) / 20 min (M) / 30 min (L) bonus.",
            castingCost:
                "Roll a die. If it's a 5 or a 6, this card has no effect.",
        },
        copies: 1,
    },
    {
        template: {
            kind: "curse",
            name: "Curse of the Labyrinth",
            description:
                "Spend up to 10 min (S) / 20 min (M) / 30 min (L) drawing a solvable maze and send a photo of it to the seekers. You cannot use the internet to research maze designs. The seekers must solve the maze before asking another question.",
            castingCost: "Draw a maze.",
        },
        copies: 1,
    },
    {
        template: {
            kind: "curse",
            name: "Curse of the Hidden Hangman",
            description:
                "Before asking another question or boarding another form of transportation, seekers must beat the hider in a game of hangman. To play, the hider chooses a 5 letter word, and the game ends after either a correct word guess or 7 wrong letter guesses (head, body, two arms, two legs, and a hat). The hider must respond to all queries within 30 seconds. The seekers cannot challenge the hider for 10 minutes after a loss. After 1 (S) / 2 (M) / 3 (L) losses, the seekers must wait 10 more minutes and then the curse is cleared.",
            castingCost: "Discard 2 cards.",
        },
        copies: 1,
    },
    {
        template: {
            kind: "curse",
            name: "Curse of the Overflowing Chalice",
            description:
                "For the next three questions, you may draw (not keep) an additional card when drawing from the hider deck.",
            castingCost: "Discard a card.",
        },
        copies: 1,
    },
    {
        template: {
            kind: "curse",
            name: "Curse of the Gambler's Feet",
            description:
                "For the next 20 min (S) / 40 min (M) / 60 min (L), seekers must roll a die before they take any steps in any direction. They may take that many steps before rolling again.",
            castingCost:
                "Roll a die. If it's an even number, this curse has no effect.",
        },
        copies: 1,
    },
    {
        template: {
            kind: "curse",
            name: "Curse of the Urban Explorer",
            description:
                "For the rest of your run, seekers cannot ask questions when they are on transit or in a transit station.",
            castingCost: "Discard 2 cards.",
        },
        copies: 1,
    },
    {
        template: {
            kind: "curse",
            name: "Curse of the Lemon Phylactery",
            description:
                "Before asking another question, the seekers must each find a lemon and affix it to the outermost layer of their clothes or skin. If, at any point, one of these lemons is no longer touching a seeker, you are awarded an extra 30 min (S) / 45 min (M) / 60 min (L). This curse cannot be played during the endgame.",
            castingCost: "Discard a powerup.",
        },
        copies: 1,
    },
    {
        template: {
            kind: "curse",
            name: "Curse of the Right Turn",
            description:
                "For the next 20 min (S) / 40 min (M) / 60 min (L), the seekers can only turn right at any street intersection. If, at any point, they find themselves in a dead end where they cannot continue forward or turn right for another 300 meters, they may do a full 180. A right turn is defined as a road at any angle that veers to the right of the seekers.",
            castingCost: "Discard a card.",
        },
        copies: 1,
    },
];

/* ─────────────────────────── Composition + shuffling ─────────────────────────── */

/**
 * Build the canonical deck for a new round. Time bonuses (55) and
 * powerups (21) follow the exact card-counts taken from the physical
 * deck. Curses are still TBD — for now we sample one of each
 * paraphrased template so the engine has something to work with;
 * once we have authoritative curse counts we'll wire them up the
 * same way as the powerups above.
 */
function makeDeck(): Card[] {
    const out: Card[] = [];

    // Time bonuses — 55 cards
    for (const tier of TIME_BONUS_TIERS) {
        for (let j = 0; j < tier.copies; j++) {
            out.push({ ...tier.template, id: makeId() });
        }
    }

    // Powerups — 21 cards
    for (const slot of POWERUP_SLOTS) {
        for (let j = 0; j < slot.copies; j++) {
            out.push({ ...slot.template, id: makeId() });
        }
    }

    // Curses — by the slot's `copies` count. So far we've transcribed
    // 16 curses at 1 copy each; future batches will extend this list
    // and/or bump some counts.
    for (const slot of CURSE_SLOTS) {
        for (let j = 0; j < slot.copies; j++) {
            out.push({ ...slot.template, id: makeId() });
        }
    }

    return out;
}

export function shuffledDeck(): Card[] {
    const deck = makeDeck();
    shuffleInPlace(deck);
    return deck;
}

/**
 * One instance of every distinct card template in the hider deck —
 * 5 time-bonus tiers + 7 powerup slots + N curse slots. Each carries
 * a fresh id so they can be rendered alongside real hand cards
 * without key collisions. Used by the developer card-gallery page;
 * keep in sync with `makeDeck` by sourcing from the same tier/slot
 * arrays.
 */
export function uniqueCardTemplates(): Card[] {
    const out: Card[] = [];
    for (const tier of TIME_BONUS_TIERS) {
        out.push({ ...tier.template, id: makeId() });
    }
    for (const slot of POWERUP_SLOTS) {
        out.push({ ...slot.template, id: makeId() });
    }
    for (const slot of CURSE_SLOTS) {
        out.push({ ...slot.template, id: makeId() });
    }
    return out;
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
