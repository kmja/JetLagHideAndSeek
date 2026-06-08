import { persistentAtom } from "@nanostores/persistent";
import { atom } from "nanostores";

import type { GameSize } from "./gameSetup";
import { type Card,shuffledDeck } from "./hiderDeck";

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
    if (!g[key])
        g[key] = persistentAtom<T>(storageKey, initial, { encode, decode });
    // ReturnType<typeof persistentAtom<T>> can't be expressed because
    // the @nanostores overloads constrain T to string|undefined for
    // the default-codec overload. The encoded overload accepts any T
    // but TS can't pick it generically — just cast back to the atom
    // shape we know we constructed.
    return g[key] as ReturnType<typeof atom<T>>;
};

/* ────────────────── Role selection ────────────────── */

export type PlayerRole = "seeker" | "hider" | "coHider" | null;

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
    (v) =>
        v === "seeker" || v === "hider" || v === "coHider" ? v : null,
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

/**
 * Grace window after the hiding period ends for a hider who hasn't
 * committed a zone yet. House rule (per the user's table ruling):
 * if the hiding clock runs out with no zone chosen, the game is
 * paused and locked for 5 minutes, during which the hider MUST pick
 * a station from their *current* location. If they still haven't
 * picked when the grace window closes, they forfeit the round.
 */
export const ZONE_GRACE_MS = 5 * 60 * 1000;

/**
 * Set true when a hider lets the grace window close without ever
 * committing a hiding zone — they lose the round (rulebook requires
 * the zone be centered on a station before play begins; this is the
 * enforcement of that). Persistent so a reload during the forfeit
 * screen doesn't resurrect the round. Cleared on every new round.
 */
export const hiderForfeited = __globalPersistent<boolean>(
    "__jlhs_hiderForfeited",
    "hiderForfeited",
    false,
    (v) => (v ? "1" : ""),
    (v) => v === "1",
);

/* ────────────────── Round end / score ────────────────── */

/**
 * Unix ms when the seeker declared the hider found (rulebook p7). On the
 * hider side this stops the elapsed timer and freezes the time-bonus
 * tally for scoring. Persistent so a reload doesn't lose the round
 * result.
 *
 * Set locally when either side taps "Hider found" / "We were found",
 * and also when the hider opens a `?f=` share-link the seeker sent.
 */
export const roundFoundAt = __globalPersistent<number | null>(
    "__jlhs_roundFoundAt",
    "roundFoundAt",
    null,
    (v) => (v === null ? "" : String(v)),
    (v) => (v ? Number(v) : null),
);

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

/* ────────────────── Pending-draw choice ────────────────── */

/**
 * Holds the result of a "draw N, keep K" reward in flight. When the
 * seeker answers a question, the hider draws N cards. If K < N, the
 * hider must pick K to keep — the rest go to discard. While the choice
 * is open, this atom is non-null and a modal blocks until the hider
 * picks. If K == N (photo: draw 1 keep 1) the draw is auto-resolved
 * straight into the hand and this atom stays null.
 */
export interface PendingDraw {
    /** The N drawn cards still up for selection. */
    cards: Card[];
    /** How many of `cards` the hider keeps; the rest are discarded. */
    keep: number;
    /** Which category triggered the draw (display only). */
    sourceCategory: string;
    /** Question key (for idempotency hint in the toast). */
    sourceQuestionKey: number;
}

/**
 * Persistent so a page reload mid-pick doesn't drop the cards on the
 * floor. The seeker won't notice; the hider just gets to resume picking.
 */
export const pendingDraw = __globalPersistent<PendingDraw | null>(
    "__jlhs_pendingDraw",
    "pendingDraw",
    null,
    JSON.stringify,
    (v) => {
        try {
            return JSON.parse(v) as PendingDraw | null;
        } catch {
            return null;
        }
    },
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
    pendingDraw.set(null);
    roundFoundAt.set(null);
    hiderForfeited.set(false);
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
 * Internal: lift `n` cards from the top of the deck and return them. The
 * cards leave the deck but aren't yet attached to hand/discard — the
 * caller decides what to do with them.
 */
function liftFromDeck(n: number): Card[] {
    ensureDeckReady();
    const deck = [...hiderDeck.get()];
    const lifted: Card[] = [];
    for (let i = 0; i < n; i++) {
        const card = deck.pop();
        if (!card) break;
        lifted.push(card);
    }
    if (lifted.length > 0) hiderDeck.set(deck);
    return lifted;
}

/**
 * Reward draw from answering a question: draw `n`, keep `k`. Per the
 * rulebook (p16–37) each category has a different budget — matching/
 * measuring are 3/1, radar/thermometer 2/1, photo 1/1, tentacle 4/2.
 *
 *   - When `k === n` (photo, or when there aren't enough cards left to
 *     even reach `k`), this auto-resolves straight into the hand.
 *   - When `k < n`, this stashes the cards on `pendingDraw` and the
 *     DrawPickerDialog modal blocks until the hider picks K of N.
 *
 * Returns true if the draw was auto-resolved, false if it's waiting on
 * the picker.
 */
export function presentDraw(
    n: number,
    k: number,
    sourceCategory: string,
    sourceQuestionKey: number,
): boolean {
    const drawn = liftFromDeck(n);
    if (drawn.length === 0) return true;
    const keep = Math.min(k, drawn.length);
    if (keep >= drawn.length) {
        // Auto-keep — no choice to make
        hiderHand.set([...hiderHand.get(), ...drawn]);
        return true;
    }
    pendingDraw.set({
        cards: drawn,
        keep,
        sourceCategory,
        sourceQuestionKey,
    });
    return false;
}

/**
 * Resolve the pending draw: move the `keepIds` cards into the hand and
 * the rest into discard. Clears `pendingDraw` on success.
 */
export function resolvePendingDraw(keepIds: string[]): void {
    const current = pendingDraw.get();
    if (!current) return;
    if (keepIds.length !== current.keep) return;
    const kept: Card[] = [];
    const discarded: Card[] = [];
    for (const c of current.cards) {
        if (keepIds.includes(c.id)) kept.push(c);
        else discarded.push(c);
    }
    if (kept.length > 0) hiderHand.set([...hiderHand.get(), ...kept]);
    if (discarded.length > 0)
        hiderDiscard.set([...hiderDiscard.get(), ...discarded]);
    pendingDraw.set(null);
}

/**
 * Direct hand-pile draw (used by powerups like Discard 1 Draw 2 / Draw 1
 * Expand Hand — those don't go through the keep-K picker, they always
 * add to the hand). Returns the drawn cards for callers to display.
 */
export function drawCards(n: number): Card[] {
    const drawn = liftFromDeck(n);
    if (drawn.length > 0) {
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

/**
 * Resolve a photo question from the photo card (the hider's answer
 * surface for photos — the dedicated `/h?q=` answer view doesn't
 * handle photos). Stamps the inbox entry's `repliedAt` so
 * HiderHome's "waiting" filter clears and scoring sees the question
 * as answered, then awards the photo card-draw (1/1, auto-resolves
 * into the hand). Per the rulebook the hider draws a card even when
 * they answer "I cannot answer the question" during the end game
 * (p7), so this fires for both attach and decline.
 *
 * Idempotent: if the inbox entry is already `repliedAt`, it skips the
 * draw so re-attaching / replacing a photo can't farm extra cards.
 * Returns true if a card was newly drawn.
 */
export function recordPhotoAnswerDraw(
    key: number,
    reply?: Record<string, unknown>,
): boolean {
    const inbox = hiderInbox.get();
    const existing = inbox.find((e) => e.key === key);
    if (existing?.repliedAt) return false; // already answered — no double draw
    hiderInbox.set(
        inbox.map((e) =>
            e.key === key
                ? { ...e, repliedAt: Date.now(), reply: reply ?? e.reply }
                : e,
        ),
    );
    const budget = QUESTION_DRAW_BUDGET.photo;
    presentDraw(budget.draw, budget.keep, "photo", key);
    return true;
}
