import { persistentAtom } from "@nanostores/persistent";
import type { WritableAtom } from "nanostores";

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
