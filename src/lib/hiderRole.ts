import { persistentAtom } from "@nanostores/persistent";
import { atom } from "nanostores";
import { toast } from "react-toastify";

import type { DeckStateShare } from "@protocol/index";

import type { Question } from "@/maps/schema";

import {
    answerWindowMs,
    type GameSize,
    gameSize,
    hiddenDebitMs,
    type TransitMode,
} from "./gameSetup";
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

export type PlayerRole = "seeker" | "hider" | null;

/**
 * Which side of the game this device is playing. `null` means the user
 * hasn't picked yet — surfaces the role-picker overlay on first load.
 *
 * Stored as plain string in localStorage for clarity ("seeker" / "hider").
 * v829: the `coHider` role was removed — the hide team is a unit of equal
 * hiders. A persisted `"coHider"` (from before the collapse) decodes to
 * `"hider"` so a returning teammate stays on the hide team.
 */
export const playerRole = __globalPersistent<PlayerRole>(
    "__jlhs_playerRole",
    "playerRole",
    null,
    (v) => (v === null ? "" : v),
    (v) =>
        v === "seeker" || v === "hider"
            ? v
            : v === "coHider"
              ? "hider"
              : null,
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
    /** Transit modes serving the committed station (for the zone card's
     *  glyphs). Optional — a map-picked zone has no station modes. */
    modes?: TransitMode[];
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
 * Hider's window to answer an incoming question. Rulebook gives the
 * hider 5 minutes from receipt; past that the seeker can re-ask or
 * pressure the hider. The unanswered-question overlay surfaces a
 * live countdown so the hider knows how much they have left.
 */
export const ANSWER_WINDOW_MS = 5 * 60 * 1000;

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

/**
 * v318: per-round leaderboard. Each completed round in the current
 * game appends an entry here; the lobby surfaces it as a
 * "Leaderboard" section once at least one round has finished.
 *
 *   hiderName   — the hider's display name at the time the round
 *                 ran (so a swap mid-game still attributes
 *                 historical rounds to the right person).
 *   hidingMs    — the wall-clock the hider stayed hidden after
 *                 the hiding period ended (foundAt - hidingEndsAt).
 *                 The headline scoring metric the rulebook uses.
 *   foundAt     — Unix ms the seeker(s) declared the hider found.
 *   roundNumber — 1-indexed within the game.
 *
 * Reset by `startNewGame()` (new settings = new game = new
 * leaderboard); `startNewRound()` LEAVES it alone so the running
 * tally survives across rounds.
 */
export interface RoundResult {
    roundNumber: number;
    hiderName: string;
    hidingMs: number;
    foundAt: number;
}
export const roundLog = __globalPersistent<RoundResult[]>(
    "__jlhs_roundLog",
    "roundLog",
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

/**
 * Hider's scouted-spot list — places they've passed during the
 * hiding period and want to remember as potential final spots.
 * Persistent so a phone-lock or PWA close doesn't lose them.
 * Distinct from `hidingSpot` (the committed final spot) and
 * `hidingZone` (the 500m-radius station boundary).
 */
export interface ScoutedSpot {
    id: string;
    lat: number;
    lng: number;
    /** Hider's freeform label ("by the bench", "alley between blocks"). */
    label?: string;
    savedAt: number;
}

export const scoutedSpots = __globalPersistent<ScoutedSpot[]>(
    "__jlhs_scoutedSpots",
    "scoutedSpots",
    [],
    JSON.stringify,
    (v) => {
        try {
            const arr = JSON.parse(v);
            return Array.isArray(arr) ? (arr as ScoutedSpot[]) : [];
        } catch {
            return [];
        }
    },
);

export function addScoutedSpot(
    spot: Omit<ScoutedSpot, "id" | "savedAt">,
): void {
    scoutedSpots.set([
        ...scoutedSpots.get(),
        {
            ...spot,
            id: `spot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            savedAt: Date.now(),
        },
    ]);
}

export function removeScoutedSpot(id: string): void {
    scoutedSpots.set(scoutedSpots.get().filter((s) => s.id !== id));
}

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

/**
 * v301: the "answer this question" flow used to be its own page at
 * `/h?q=…`. It's now a dialog that opens from any entry point —
 * tapping the unanswered-question banner, tapping a row in the
 * inbox sheet, or landing on `/h?q=…` (URL still works for share-
 * links from devices that aren't on the multiplayer transport).
 * Setting this atom opens the dialog with the given question;
 * clearing it (or sending the answer) closes the dialog.
 *
 * In-memory only — the URL / inbox is the source of truth for
 * which questions exist; the atom just controls modal visibility.
 */
export const answeringQuestion = atom<Question | null>(null);

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

/* ────────────────── Curse of the Overflowing Chalice ────────────────── */

/**
 * Number of upcoming question-reward draws still boosted by an active
 * Curse of the Overflowing Chalice (rulebook: "For the next three
 * questions, you may draw — but not keep — an additional card").
 *
 * Set to 3 when the curse is cast; decremented by one each time a
 * question reward is drawn (in `presentDraw`). While > 0 every reward
 * draws one extra card (keep count unchanged), so the per-category
 * budget effectively becomes Matching/Measuring 4-keep-1,
 * Thermometer/Radar 3-keep-1, Photo 2-keep-1, Tentacle 5-keep-2.
 *
 * Persistent so a reload mid-effect doesn't drop the remaining boosts.
 * Reset to 0 at the start of every round.
 */
export const chaliceDrawsRemaining = __globalPersistent<number>(
    "__jlhs_chaliceDraws",
    "chaliceDraws",
    0,
    String,
    (v) => Number(v) || 0,
);

/**
 * Arm the Overflowing Chalice: the next three question rewards each
 * draw one extra card. Stacks additively if cast again before the
 * previous one expires (rare, but the rulebook doesn't forbid it).
 */
export function activateOverflowingChalice(): void {
    chaliceDrawsRemaining.set(chaliceDrawsRemaining.get() + 3);
}

/**
 * Curse of the Impressionable Consumer casting cost: "the seekers' next
 * question is free" — the hider forfeits the card draw for the NEXT question
 * they answer. Counter (persistent, reset per round) consumed in
 * `presentDraw`. Additive if cast twice before the next answer.
 */
export const freeQuestionDraws = __globalPersistent<number>(
    "__jlhs_freeQuestionDraws",
    "freeQuestionDraws",
    0,
    String,
    (v) => Number(v) || 0,
);

/** Arm one "next question is free" (no card draw for the hider). */
export function armFreeQuestion(): void {
    freeQuestionDraws.set(freeQuestionDraws.get() + 1);
}

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

/**
 * Backlog of pending draws waiting for the current `pendingDraw` pick
 * to resolve. Filled when a repeated question (rulebook p65) runs the
 * draw cycle more than once: cycle #1 lands in `pendingDraw`; cycles
 * #2+ queue here. `resolvePendingDraw` shifts the next entry into
 * `pendingDraw` so the picker re-opens for each cycle in turn.
 */
export const pendingDrawQueue = __globalPersistent<PendingDraw[]>(
    "__jlhs_pendingDrawQueue",
    "pendingDrawQueue",
    [],
    JSON.stringify,
    (v) => {
        try {
            const parsed = JSON.parse(v);
            return Array.isArray(parsed) ? (parsed as PendingDraw[]) : [];
        } catch {
            return [];
        }
    },
);

/**
 * v1043: cards auto-kept into the hand (a draw-1-keep-1 reward, e.g. answering
 * a photo question) with no picker — set here so a UI flourish can "fly" them
 * down to the hand fan, since the silent auto-add gave no visual feedback. The
 * `CardFlyToHand` overlay reads it, plays the animation, then clears it.
 * Volatile (a one-shot animation trigger).
 */
export const cardFlyToHand = __globalAtom<Card[] | null>(
    "__jlhs_cardFlyToHand",
    null,
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
    scoutedSpots.set([]);
    hiderInbox.set([]);
    hiderHand.set([]);
    hiderDeck.set([]);
    hiderDiscard.set([]);
    hiderHandLimit.set(6);
    pendingDraw.set(null);
    pendingDrawQueue.set([]);
    roundFoundAt.set(null);
    hiderForfeited.set(false);
    chaliceDrawsRemaining.set(0);
    freeQuestionDraws.set(0);
}

/* ────────────────── Shared hide-team deck sync (v831 Track 2) ──────────── *
 *
 * The whole hide team shares ONE card economy. The multiplayer bridge
 * (store.ts) syncs it as one out-of-band secret blob — like the hiding
 * zone — by reading the seven deck atoms into a `DeckStateShare` after any
 * local mutation and applying an inbound one from a teammate. Keeping the
 * bundle read/write here co-locates it with the atoms so the atom set stays
 * the single source of truth (add a field → touch it in both functions). */

/** Snapshot the seven deck atoms into a `DeckStateShare` for the wire. */
export function readSharedDeckState(): DeckStateShare {
    return {
        hand: hiderHand.get(),
        deck: hiderDeck.get(),
        discard: hiderDiscard.get(),
        handLimit: hiderHandLimit.get(),
        chalice: chaliceDrawsRemaining.get(),
        pending: pendingDraw.get(),
        pendingQueue: pendingDrawQueue.get(),
    };
}

/** Adopt a teammate's shared deck state into the seven atoms. `null` means
 *  "no shared deck yet this round" — keep the local (freshly-reset) state.
 *  The caller (store.ts) wraps this in an echo guard so the atom writes
 *  don't bounce straight back out to the server. */
export function applySharedDeckState(s: DeckStateShare | null): void {
    if (!s) return;
    hiderHand.set(Array.isArray(s.hand) ? (s.hand as Card[]) : []);
    hiderDeck.set(Array.isArray(s.deck) ? (s.deck as Card[]) : []);
    hiderDiscard.set(Array.isArray(s.discard) ? (s.discard as Card[]) : []);
    hiderHandLimit.set(Number.isFinite(s.handLimit) ? s.handLimit : 6);
    chaliceDrawsRemaining.set(Number.isFinite(s.chalice) ? s.chalice : 0);
    pendingDraw.set((s.pending as PendingDraw | null) ?? null);
    pendingDrawQueue.set(
        Array.isArray(s.pendingQueue) ? (s.pendingQueue as PendingDraw[]) : [],
    );
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
    // v1022: Curse of the Impressionable Consumer — its casting cost is "the
    // seekers' next question is free", i.e. the hider forfeits the draw for
    // the next question they answer. Consume one charge here (the single
    // reward chokepoint) and skip the draw entirely, explaining why.
    if (freeQuestionDraws.get() > 0) {
        freeQuestionDraws.set(freeQuestionDraws.get() - 1);
        toast.info(
            "Curse of the Impressionable Consumer: this question was free — no card draw this time.",
            { autoClose: 6000 },
        );
        return true;
    }
    // Curse of the Overflowing Chalice: while armed, every question
    // reward draws one extra card (keep count unchanged). Consume one
    // charge here — this is the single chokepoint all question-reward
    // draws pass through, so the boost can't double-apply.
    if (chaliceDrawsRemaining.get() > 0) {
        n += 1;
        chaliceDrawsRemaining.set(chaliceDrawsRemaining.get() - 1);
    }
    const drawn = liftFromDeck(n);
    if (drawn.length === 0) return true;
    const keep = Math.min(k, drawn.length);
    if (keep >= drawn.length) {
        // Auto-keep — no choice to make. Fly the card(s) down to the hand so
        // the silent add has a visible beat (v1043).
        hiderHand.set([...hiderHand.get(), ...drawn]);
        cardFlyToHand.set(drawn);
        return true;
    }
    const pending: PendingDraw = {
        cards: drawn,
        keep,
        sourceCategory,
        sourceQuestionKey,
    };
    // Rulebook p65 repeats: if a previous cycle's pick is still open,
    // queue this one behind it instead of clobbering. The resolver
    // shifts the next entry into `pendingDraw` once the active pick
    // is committed, so the hider works through every cycle in turn.
    if (pendingDraw.get() !== null) {
        pendingDrawQueue.set([...pendingDrawQueue.get(), pending]);
    } else {
        pendingDraw.set(pending);
    }
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
    // Advance to the next queued cycle (rulebook-repeat draws) if any,
    // so the picker re-opens for the next pick. Otherwise clear.
    const queue = pendingDrawQueue.get();
    if (queue.length > 0) {
        const [next, ...rest] = queue;
        pendingDrawQueue.set(rest);
        pendingDraw.set(next);
    } else {
        pendingDraw.set(null);
    }
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
 * Stable per-question "what was asked" identity used to count repeats
 * (rulebook p65 — repeating a question costs N×). Same identity →
 * "the same question", so a hider seeing the second arrival can run
 * the draw-keep budget twice.
 *
 *   - radius      → preset signature ("500m" / "1km" / "custom-…")
 *   - thermometer → preset signature (e.g. "2km")
 *   - matching    → subtype (`type`)
 *   - measuring   → subtype (`type`)
 *   - tentacles   → subtype (`locationType`)
 *   - photo       → subtype (`type`)
 *
 * Falls back to the bare category id when the question shape carries
 * no subtype/preset slot — better to undercount repeats than to throw.
 */
export function questionIdentity(id: string, data: unknown): string {
    const d = (data ?? {}) as Record<string, unknown>;
    if (id === "matching" || id === "measuring" || id === "photo") {
        const t = typeof d.type === "string" ? d.type : "";
        return `${id}:${t}`;
    }
    if (id === "tentacles") {
        const t = typeof d.locationType === "string" ? d.locationType : "";
        return `${id}:${t}`;
    }
    if (id === "radius") {
        const radius = typeof d.radius === "number" ? d.radius : "?";
        const unit = typeof d.unit === "string" ? d.unit : "?";
        const useCustom = d.useCustom === true;
        return `radius:${useCustom ? "custom" : `${radius}${unit}`}`;
    }
    if (id === "thermometer") {
        const sig = typeof d.targetSig === "string" ? d.targetSig : "";
        return `thermometer:${sig}`;
    }
    return id;
}

/**
 * How many times this question (by `questionIdentity`) has already
 * been answered in the hider's inbox, excluding the entry with `key`.
 * The seeker's N-th ask is the (N-1)-th prior answered entry, so the
 * draw multiplier per rulebook p65 is `priorAnswered + 1`.
 */
export function priorAnsweredCount(key: number, identity: string): number {
    return hiderInbox
        .get()
        .filter(
            (e) =>
                e.key !== key &&
                e.repliedAt !== undefined &&
                questionIdentity(e.id, e.data) === identity,
        ).length;
}

/**
 * Rulebook p61: a question not answered within its window pauses the
 * hider's time until they answer, and earns them NO cards. Call once,
 * in the not-yet-replied answer path, BEFORE drawing. Returns true if
 * the answer was late (caller should skip the card draw). Accrues the
 * overtime into `hiddenDebitMs` so scoring excludes the paused span.
 *
 * The window starts at the question's SYNCED `createdAt` (stamped by the
 * seeker at send) so it agrees with the seeker's deadline and survives a
 * hider reconnect; `arrivedAt` (local receive time) is only the fallback
 * when there's no createdAt (e.g. a stale share-link). Using `arrivedAt`
 * alone reset the window on every reconnect (v936).
 */
export function settleLateAnswer(key: number, category: string): boolean {
    const entry = hiderInbox.get().find((e) => e.key === key);
    if (!entry) return false;
    const windowMs = answerWindowMs(category, gameSize.get());
    const startMs =
        (entry.data as { createdAt?: number })?.createdAt ?? entry.arrivedAt;
    const overtime = Date.now() - startMs - windowMs;
    if (overtime <= 0) return false;
    hiddenDebitMs.set(hiddenDebitMs.get() + overtime);
    return true;
}

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
    // Rulebook p61: an overdue answer pauses the hider's clock and
    // earns no card. Settle the timing before stamping repliedAt.
    const late = settleLateAnswer(key, "photo");
    hiderInbox.set(
        inbox.map((e) =>
            e.key === key
                ? { ...e, repliedAt: Date.now(), reply: reply ?? e.reply }
                : e,
        ),
    );
    if (late) return false;
    const budget = QUESTION_DRAW_BUDGET.photo;
    // Rulebook p65: a repeated question pays its cost N×. Same identity
    // → same question; cycles = priorAnswered + 1. Photo's identity
    // includes the subtype so 2× "photo of a bench" is distinct from
    // 1× "photo of a bench" + 1× "photo of a fountain".
    const identity = questionIdentity("photo", existing?.data ?? {});
    const cycles = priorAnsweredCount(key, identity) + 1;
    for (let i = 0; i < cycles; i++) {
        presentDraw(budget.draw, budget.keep, "photo", key);
    }
    return true;
}
