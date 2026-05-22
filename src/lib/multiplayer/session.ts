/**
 * Session + identity state for the multiplayer client.
 *
 * Most of this is persistent (`@nanostores/persistent`) so a page
 * reload mid-game silently resumes — the WebSocket comes back up,
 * the server validates the sessionToken via the `resume` message,
 * and the user never sees a "rejoin" prompt.
 *
 *   - `deviceId`            — per-device random UUID. Stable across
 *                              sessions. The server uses this to
 *                              match resumes when the sessionToken
 *                              has aged out.
 *   - `displayName`         — per-device, what other participants
 *                              see.
 *   - `multiplayerEnabled`  — top-level switch: am I in online mode?
 *   - `currentGameCode`     — the 6-char code of the room we're
 *                              currently connected to (or trying to
 *                              connect to).
 *   - `sessionToken`        — server-issued auth blob. Resume relies
 *                              on it, regenerated on every join.
 *   - `selfParticipantId`   — server-assigned id for *this* device's
 *                              participant within the room. Useful
 *                              for "is this message about me?" UI.
 */

import { persistentAtom } from "@nanostores/persistent";
import { atom } from "nanostores";

import type { Participant, TransportStatus } from "./types";

/**
 * Per-device stable identity. Generated lazily on first read so we
 * don't write to localStorage during SSR / build.
 */
function ensureDeviceId(): string {
    if (typeof window === "undefined") return "";
    const KEY = "jlhs:deviceId";
    let existing: string | null = null;
    try {
        existing = localStorage.getItem(KEY);
    } catch {
        /* private mode etc. */
    }
    if (existing && /^[0-9a-f-]{20,}$/i.test(existing)) return existing;
    const fresh = crypto.randomUUID();
    try {
        localStorage.setItem(KEY, fresh);
    } catch {
        /* ignore */
    }
    return fresh;
}

/** Cached at module load to avoid touching localStorage per read. */
let _deviceIdCache: string | null = null;
export function getDeviceId(): string {
    if (_deviceIdCache) return _deviceIdCache;
    _deviceIdCache = ensureDeviceId();
    return _deviceIdCache;
}

/** What other participants see. Editable in the join/host dialogs. */
export const displayName = persistentAtom<string>(
    "jlhs:displayName",
    "",
    { encode: (v) => v, decode: (v) => v },
);

/**
 * Master switch for the multiplayer feature. When false (default),
 * none of the bridge plumbing fires and the app runs in its old
 * local-only mode. When true, the bridge layer routes seeker /
 * hider actions through the transport.
 */
export const multiplayerEnabled = persistentAtom<boolean>(
    "jlhs:multiplayerEnabled",
    false,
    { encode: JSON.stringify, decode: JSON.parse },
);

/** Current room code, if any. Persistent so reload mid-game resumes. */
export const currentGameCode = persistentAtom<string | null>(
    "jlhs:currentGameCode",
    null,
    { encode: JSON.stringify, decode: JSON.parse },
);

/** Server-issued auth blob. Used for `resume` messages. */
export const sessionToken = persistentAtom<string | null>(
    "jlhs:sessionToken",
    null,
    { encode: JSON.stringify, decode: JSON.parse },
);

/** Server-assigned participant id for *this* device in the current room. */
export const selfParticipantId = persistentAtom<string | null>(
    "jlhs:selfParticipantId",
    null,
    { encode: JSON.stringify, decode: JSON.parse },
);

/* ────────────────── Runtime-only atoms ────────────────── */

/** Current transport state (no persistence — it derives from the live socket). */
export const transportStatus = atom<TransportStatus>("idle");

/** Full participant roster as the server last reported it. */
export const participants = atom<Participant[]>([]);

/** Surface error to the UI ("room full" / "version mismatch" etc.). */
export const multiplayerError = atom<{
    code: string;
    message: string;
} | null>(null);

/* ────────────────── Reset helper ────────────────── */

/**
 * Wipe all session-scoped state. Called when:
 *   - The user explicitly disconnects (e.g. "Leave game" button).
 *   - A new local game is set up (the new-game flow nukes everything).
 *   - The server rejects a `resume` with `session_invalid` and the
 *     client decides to drop back to local mode rather than rejoin.
 */
export function resetMultiplayerSession() {
    multiplayerEnabled.set(false);
    currentGameCode.set(null);
    sessionToken.set(null);
    selfParticipantId.set(null);
    transportStatus.set("idle");
    participants.set([]);
    multiplayerError.set(null);
}
