import { persistentAtom } from "@nanostores/persistent";
import { atom } from "nanostores";

import type { GameSize } from "./gameSetup";
import { shuffledDeck, type Card } from "./hiderDeck";

/**
 * Hider-side state. Lives on the hider's device, separate from the seeker's
 * state — the two communicate via share-links (the existing
 * `encodeQuestionForHider` / `encodeAnswerForSeeker` round-trip).
 *
 * Atoms are bound to globalThis so Vite HMR re-imports don't clone the
 * instance and silently break cross-island propagation. Same pattern we
 * use in `src/lib/context.ts` for `questionsDrawerOpen`.
 */

const __globalAtom = <T>(key: string, initial: T) => {
    const g = globalThis as Record<string, unknown>;
    if (!g[key]) g[key] = atom<T>(initial);
    return g[key] as ReturnType<typeof atom<T>>;
};

const __globalPersistent = <T>(
    key: string,
    storageKey: string,
    initial: T,
    encode: (v: T) => string,
    decode: (v: string) => T,
) => {
    const g = globalThis as Record<string, unknown>;
    if (!g[key]) g[key] = persistentAtom<T>(storageKey, initial, { encode, decode });
    return g[key] as ReturnType<typeof persistentAtom<T>>;
};

/* ────────────────── Role selection ────────────────── */

export type PlayerRole = "seeker" | "hider" | null;

/**
 * Which side of the game this device is playing. `null` means the user
 * hasn't picked yet — surfaces the role-picker overlay on first load.
 *
 * Stored as plain string in localStorage for clarity ("seeker" / "hider").
 */
export const playerRole = __globalPersistent<PlayerRole>(
    "__jlhs_playerRole",
    "playerRole",
    null,
    (v) => (v === null ? "" : v),
    (v) => (v === "seeker" || v === "hider" ? v : null),
);

/* ────────────────── Hiding zone ────────────────── */

/**
 * The hider's chosen hiding zone — a circle centered on a transit station
 * within the game map (rulebook p41–42).
 *
 *   - 500 m radius for Small + Medium games
 *   - 1 km radius for Large games
 *
 * The hider stays inside this circle for the entire round. The seeker is
 * trying to deduce this exact circle via questions. Stored on the hider's
 * device only; only revealed to the seeker post-game (or once they walk
 * into it and the end-game starts).
 */
export interface HidingZone {
    /** Display name of the transit station the zone is centered on. */
    stationName: string;
    stationLat: number;
    stationLng: number;
    /** Effective radius in meters (derived from game size at pick-time). */
    radiusMeters: number;
    /** Unix ms when the hider committed to this zone. */
    committedAt: number;
}

export const hidingZone = __globalPersistent<HidingZone | null>(
    "__jlhs_hidingZone",
    "hidingZone",
    null,
    JSON.stringify,
    (v) => {
        try {
            return JSON.parse(v) as HidingZone | null;
        } catch {
            return null;
        }
    },
);

export function radiusForGameSize(size: GameSize): number {
    // Rulebook p5 / p42: small + medium = 500m, large = 1km.
    return size === "large" ? 1000 : 500;
}

/* ────────────────── Hiding spot ────────────────── */

/**
 * The hider's final committed hiding spot (rulebook p43). Set at the
 * moment the end-game starts — after that, the hider can't move.
 *
 * Must be publicly accessible during all game hours and within 3m of a
 * marked path/road on the map app. We don't enforce that geometrically
 * yet — the hider self-declares.
 */
export interface HidingSpot {
    lat: number;
    lng: number;
    /** Hider's freeform description ("by the bench in front of the library") */
    description?: string;
    /** When end-game started and the spot was locked. */
    lockedAt: number;
}

export const hidingSpot = __globalPersistent<HidingSpot | null>(
    "__jlhs_hidingSpot",
    "hidingSpot",
    null,
    JSON.stringify,
    (v) => {
        try {
            return JSON.parse(v) as HidingSpot | null;
        } catch {
            return null;
        }
    },
);

/* ────────────────── Hider's question inbox ────────────────── */

/**
 * The hider accumulates seeker-questions in their own inbox as the seeker
 * keeps sending them. Each entry preserves the original question + the
 * hider's eventual reply.
 *
 * Adds a stable `arrivedAt` timestamp so we can render the inbox newest-
 * first, and a `replied` flag so the hider has a clear "still to answer"
 * vs "done" partition.
 */
export interface InboxEntry {
    /** Stable key — matches the seeker's question.key. */
    key: number;
    /** Question id ("radius", "matching", ...) for category coloring. */
    id: string;
    /** Question data verbatim from the share-link. */
    data: Record<string, unknown>;
    /** Unix ms when the link was opened on the hider's device. */
    arrivedAt: number;
    /** Unix ms when the hider sent an answer back, if they have. */
    repliedAt?: number;
    /** The answer the hider sent (partial data merge). */
    reply?: Record<string, unknown>;
}

export const hiderInbox = __globalPersistent<InboxEntry[]>(
    "__jlhs_hiderInbox",
    "hiderInbox",
    [],
    JSON.stringify,
    (v) => {
        try {
            const parsed = JSON.parse(v);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    },
);

/* ────────────────── Hider deck ────────────────── */

/**
 * Hand and deck state. The deck initialises to a freshly shuffled 60-card
 * deck on first round; subsequent answer draws move cards from `hiderDeck`
 * into `hiderHand`. Cards leave the hand via `hiderDiscard` (powerup
 * played, manual discard, hand-cap eviction).
 */
export const hiderHand = __globalPersistent<Card[]>(
    "__jlhs_hiderHand",
    "hiderHand",
    [],
    JSON.stringify,
    (v) => {
        try {
            const parsed = JSON.parse(v);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    },
);

/** Remaining cards in the draw pile, in order (next-to-draw at the end). */
export const hiderDeck = __globalPersistent<Card[]>(
    "__jlhs_hiderDeck",
    "hiderDeck",
    [],
    JSON.stringify,
    (v) => {
        try {
            const parsed = JSON.parse(v);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    },
);

/** Cards discarded this round. Not used yet but kept around for reshuffle. */
export const hiderDiscard = __globalPersistent<Card[]>(
    "__jlhs_hiderDiscard",
    "hiderDiscard",
    [],
    JSON.stringify,
    (v) => {
        try {
            const parsed = JSON.parse(v);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    },
);

/**
 * Per the rulebook (p44): hider hand cap is 6 cards by default, expandable
 * via the "Draw 1, expand maximum hand size by 1" powerup. Atom rather
 * than constant so the limit can grow when those powerups land.
 */
export const hiderHandLimit = __globalPersistent<number>(
    "__jlhs_hiderHandLimit",
    "hiderHandLimit",
    6,
    String,
    (v) => Number(v) || 6,
);

/* ────────────────── Volatile: role-picker open flag ────────────────── */

/** Non-persistent: shown when the user lands on the app with no role set. */
export const rolePickerOpen = __globalAtom<boolean>(
    "__jlhs_rolePickerOpen",
    false,
);

/* ────────────────── Helpers ────────────────── */

/**
 * Reset hider-side state for a fresh round. Called when the hider starts a
 * new hide (deck reshuffled, inbox cleared, zone re-picked, etc.). The
 * `playerRole` is intentionally preserved — switching roles is its own
 * separate action.
 */
export function resetHiderRoundState() {
    hidingZone.set(null);
    hidingSpot.set(null);
    hiderInbox.set([]);
    hiderHand.set([]);
    hiderDeck.set([]);
    hiderDiscard.set([]);
    hiderHandLimit.set(6);
}

/**
 * Ensure the draw pile has been shuffled for this round. Called lazily
 * the first time we need to draw. Returns the deck for chaining.
 */
export function ensureDeckReady(): Card[] {
    const current = hiderDeck.get();
    if (current.length > 0) return current;
    const fresh = shuffledDeck();
    hiderDeck.set(fresh);
    return fresh;
}

/**
 * Draw `n` cards from the top of the deck into the hand. If the deck runs
 * out, we silently keep going — game proceeds without drawing the rest.
 * Returns the cards that were drawn (so the caller can show them).
 *
 * Hand-cap enforcement is the caller's responsibility (rulebook p44: if
 * hand exceeds cap, hider must discard until at cap before drawing more).
 */
export function drawCards(n: number): Card[] {
    ensureDeckReady();
    const deck = [...hiderDeck.get()];
    const drawn: Card[] = [];
    for (let i = 0; i < n; i++) {
        const card = deck.pop();
        if (!card) break;
        drawn.push(card);
    }
    if (drawn.length > 0) {
        hiderDeck.set(deck);
        hiderHand.set([...hiderHand.get(), ...drawn]);
    }
    return drawn;
}

/**
 * Discard a card from the hand into the discard pile. Returns true if
 * the card was found and discarded, false otherwise.
 */
export function discardCard(cardId: string): boolean {
    const hand = hiderHand.get();
    const idx = hand.findIndex((c) => c.id === cardId);
    if (idx < 0) return false;
    const [card] = hand.splice(idx, 1);
    hiderHand.set([...hand]);
    hiderDiscard.set([...hiderDiscard.get(), card]);
    return true;
}

/**
 * Card-draw budget per question category, from the rulebook (p16–37).
 * The hider draws N cards, keeps K. Photo questions are draw-1-keep-1.
 */
export const QUESTION_DRAW_BUDGET: Record<
    string,
    { draw: number; keep: number }
> = {
    matching: { draw: 3, keep: 1 },
    measuring: { draw: 3, keep: 1 },
    radius: { draw: 2, keep: 1 }, // Radar — internal id is still "radius"
    thermometer: { draw: 2, keep: 1 },
    photo: { draw: 1, keep: 1 },
    tentacles: { draw: 4, keep: 2 },
};
