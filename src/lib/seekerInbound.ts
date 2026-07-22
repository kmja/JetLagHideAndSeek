import { persistentAtom } from "@nanostores/persistent";
import { atom, type WritableAtom } from "nanostores";

import type { SharedCursePayload } from "./shareLinks";

/**
 * Curses the seeker has received from the hider via `/?c=…` links.
 * Persisted so reloading the page doesn't lose track of active curses.
 * Each entry includes its arrival timestamp so the UI can show "X
 * minutes ago".
 *
 * `globalThis` binding for HMR stability — same pattern as everywhere
 * else in the codebase.
 */

export interface ReceivedCurse extends SharedCursePayload {
    /** Unix ms when the seeker opened the curse link. */
    receivedAt: number;
    /** Has the seeker dismissed the curse notification? */
    acknowledged: boolean;
    /**
     * True once the seeker marks the curse as expired/over. Hides it
     * from the active-curse overlay entirely. Separate from `acknowledged`
     * so the overlay stays visible (for dice access) between "I understand"
     * and when the curse actually ends.
     */
    dismissed?: boolean;
    /**
     * Server-assigned monotonic id for a curse cast over the wire (v943
     * durability). Lets the multiplayer bridge dedup a re-delivered
     * `curseBacklog` against curses already held, so a device that survived
     * (localStorage intact) doesn't double them while a fresh device
     * recovers the full active-curse set. Absent on the `?c=` share-link path.
     */
    castId?: number;
    /**
     * v1079: URL of the seekers' VERIFICATION photo sent back to the hider
     * (Curse of the Unguided Tourist — the seekers must find the sent Street
     * View spot in real life and send a picture to the hider). Set on the
     * hider's `castCurses` entry when the seeker's `curseProof` arrives.
     */
    seekerProofUrl?: string;
}

const KEY = "__jlhs_receivedCurses";

const g = globalThis as Record<string, unknown>;
if (!g[KEY]) {
    g[KEY] = persistentAtom<ReceivedCurse[]>("receivedCurses", [], {
        encode: JSON.stringify,
        decode: (v) => {
            try {
                const parsed = JSON.parse(v);
                return Array.isArray(parsed) ? parsed : [];
            } catch {
                return [];
            }
        },
    });
}

// Bound to the encoded persistentAtom built above; cast to a plain
// WritableAtom because TS can't pick the encoded overload of
// persistentAtom<T> generically (its default overload constrains T to
// string | undefined, which we're deliberately bypassing via JSON
// encode/decode).
export const receivedCurses = g[KEY] as WritableAtom<ReceivedCurse[]>;

/**
 * Curses the HIDER has CAST this round (v906) — the hider's mirror of the
 * seeker's `receivedCurses`, so the hider can see which curses are active on
 * the seekers. The hider knows what they cast; clears are a real-world action
 * (the seekers tell the hider), so the hider clears an entry manually (or it
 * resets at round end). Reuses the same `ReceivedCurse` shape (payload +
 * `receivedAt` = cast time + `dismissed` = the hider marked it cleared).
 */
const CAST_KEY = "__jlhs_castCurses";
if (!g[CAST_KEY]) {
    g[CAST_KEY] = persistentAtom<ReceivedCurse[]>("castCurses", [], {
        encode: JSON.stringify,
        decode: (v) => {
            try {
                const parsed = JSON.parse(v);
                return Array.isArray(parsed) ? parsed : [];
            } catch {
                return [];
            }
        },
    });
}
export const castCurses = g[CAST_KEY] as WritableAtom<ReceivedCurse[]>;

/**
 * v1087: SERVER-shared per-curse cooldowns (Curse of the Jammed Door — after a
 * failed 2d6 doorway roll the seekers can't re-roll for 5/10/15 min). Keyed by
 * the curse's `castId` → Unix ms the cooldown ends. The SERVER stamps the end
 * time (its own clock) and broadcasts it to every seeker + re-delivers active
 * cooldowns on rejoin, so the wait is SHARED across seeker devices and can't be
 * reset by restarting the app. Persisted so a reload doesn't lose it; reset per
 * round in `resetCurseState`.
 */
const COOLDOWN_KEY = "__jlhs_curseCooldownUntil";
if (!g[COOLDOWN_KEY]) {
    g[COOLDOWN_KEY] = persistentAtom<Record<string, number>>(
        "curseCooldownUntil",
        {},
        {
            encode: JSON.stringify,
            decode: (v) => {
                try {
                    const parsed = JSON.parse(v);
                    return parsed && typeof parsed === "object" ? parsed : {};
                } catch {
                    return {};
                }
            },
        },
    );
}
export const curseCooldownUntil = g[COOLDOWN_KEY] as WritableAtom<
    Record<string, number>
>;

/** Set (or clear, with until<=0) a curse's shared cooldown end time. */
export function setCurseCooldown(castId: number, until: number): void {
    const next = { ...curseCooldownUntil.get() };
    if (until > Date.now()) next[String(castId)] = until;
    else delete next[String(castId)];
    curseCooldownUntil.set(next);
}

/**
 * v1096: server-adjudicated Hidden Hangman game state, keyed by curse `castId`.
 * The word is NEVER here — only the revealed `pattern` + guess/loss bookkeeping.
 * Ephemeral (re-delivered by the server on rejoin), so a plain atom; cleared per
 * round in `resetCurseState`.
 */
export interface HangmanState {
    pattern: string[];
    guessed: string[];
    wrong: number;
    maxWrong: number;
    losses: number;
    maxLosses: number;
    status: "awaiting-word" | "ready" | "playing" | "lost" | "cleared";
    /** A seeker's guess awaiting the hider's reveal, else absent. */
    pending?: string;
    cooldownUntil?: number;
    final?: boolean;
    won?: boolean;
}
const HANGMAN_KEY = "__jlhs_hangmanGames";
if (!g[HANGMAN_KEY]) {
    g[HANGMAN_KEY] = atom<Record<string, HangmanState>>({});
}
export const hangmanGames = g[HANGMAN_KEY] as WritableAtom<
    Record<string, HangmanState>
>;

/** Apply a server hangman-state update (drops the entry once cleared). */
export function setHangmanState(castId: number, state: HangmanState): void {
    const next = { ...hangmanGames.get() };
    if (state.status === "cleared") delete next[String(castId)];
    else next[String(castId)] = state;
    hangmanGames.set(next);
}

/** Record a curse the hider just cast so it shows in the hider's active-curse
 *  list. Payload is the same shape sent to the seekers. */
export function recordCastCurse(payload: SharedCursePayload): void {
    castCurses.set([
        ...castCurses.get(),
        { ...payload, receivedAt: Date.now(), acknowledged: true },
    ]);
}
