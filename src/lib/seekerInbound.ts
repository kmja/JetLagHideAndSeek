import { persistentAtom } from "@nanostores/persistent";

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

export const receivedCurses = g[KEY] as ReturnType<
    typeof persistentAtom<ReceivedCurse[]>
>;
