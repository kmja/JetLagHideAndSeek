/**
 * Wire-protocol messages. Discriminated union on `t` (type). Same
 * shape on both sides of the wire — client and server import this
 * file so the compiler enforces parity.
 *
 * Conventions:
 *   - `t` is short to keep payloads small over slow mobile networks.
 *   - Client messages are *requests*; server replies are either
 *     `Welcome` (initial join/resume) or specific event broadcasts.
 *   - Fields that mirror existing client state names (e.g.
 *     `questions`, `hidingPeriodEndsAt`) keep the local naming so the
 *     bridge layer doesn't have to translate field-by-field.
 *
 * The server treats question payloads as opaque JSON — see
 * `./state.ts` for the rationale.
 */

import type {
    GameSize,
    GameState,
    Role,
    SetupState,
    TransitMode,
} from "./state";

/* ────────────────── Client → Server ────────────────── */

/** First message the host sends; opens a brand-new room. */
export interface CMsgHostGame {
    t: "host";
    /** Protocol version the client speaks. */
    v: number;
    deviceId: string;
    displayName: string;
}

/** First message a guest sends to a room created by a host. */
export interface CMsgJoinGame {
    t: "join";
    v: number;
    code: string;
    deviceId: string;
    displayName: string;
}

/** Reconnect with a previously-issued session token. */
export interface CMsgResume {
    t: "resume";
    v: number;
    code: string;
    deviceId: string;
    sessionToken: string;
}

/** Pick a role. Server enforces: at most one hider per room. */
export interface CMsgSetRole {
    t: "role";
    role: Role | null;
}

/**
 * Host pushes the setup details after completing the local setup
 * wizard. Optional fields may be null while pre-game (e.g. before
 * the host has chosen a play area).
 */
export interface CMsgStartGame {
    t: "start";
    setup: SetupState;
}

/**
 * Seeker pushes a new question. The server doesn't parse the
 * question; it just stores it as opaque JSON and broadcasts to
 * other participants.
 */
export interface CMsgAddQuestion {
    t: "addQ";
    question: unknown;
}

/**
 * Hider replies to a question with an answer payload. The server
 * locates the question by `key` and merges the answer into its
 * `data`, marking `drag` false (consistent with existing client
 * semantics).
 */
export interface CMsgAnswerQuestion {
    t: "answerQ";
    /** `key` from the original question. Numeric per the zod schema. */
    key: number;
    /**
     * Partial-data shape from the share-link answer flow
     * (e.g. `{ within: true }` for radius). Merged onto the
     * question's `data` field server-side.
     */
    answer: Record<string, unknown>;
}

/**
 * Seeker marks the hider as found. Round-end ping.
 */
export interface CMsgMarkFound {
    t: "found";
    foundAt: number;
}

/**
 * Update a previously-asked question's data (in-place edit). Used
 * for thermometer finishing flow and any other "mutate existing
 * question" path that the seeker triggers locally.
 */
export interface CMsgUpdateQuestion {
    t: "updateQ";
    key: number;
    /** Partial data merged onto the existing question's `data`. */
    data: Record<string, unknown>;
}

/**
 * Keep-alive — sent periodically by the client. Server responds with
 * `pong`. Used to detect dead connections behind NATs that don't
 * close them cleanly.
 */
export interface CMsgPing {
    t: "ping";
    ts: number;
}

export type ClientMessage =
    | CMsgHostGame
    | CMsgJoinGame
    | CMsgResume
    | CMsgSetRole
    | CMsgStartGame
    | CMsgAddQuestion
    | CMsgAnswerQuestion
    | CMsgUpdateQuestion
    | CMsgMarkFound
    | CMsgPing;

/* ────────────────── Server → Client ────────────────── */

/**
 * Server's first reply after host/join/resume. Includes the
 * session token (for reconnect) and the canonical state snapshot.
 */
export interface SMsgWelcome {
    t: "welcome";
    sessionToken: string;
    self: { id: string };
    state: GameState;
}

/** Full state replay. Server may send this proactively after
 *  significant state mutations to keep clients in sync. */
export interface SMsgSnapshot {
    t: "snapshot";
    state: GameState;
}

/** Broadcast when a new question is added. */
export interface SMsgQuestionAdded {
    t: "qAdded";
    question: unknown;
}

/** Broadcast when an existing question is mutated in place. */
export interface SMsgQuestionUpdated {
    t: "qUpdated";
    key: number;
    /** The *full* updated question payload, server-merged. */
    question: unknown;
}

/** Broadcast when a question is answered (drag→false + answer merged). */
export interface SMsgQuestionAnswered {
    t: "qAnswered";
    key: number;
    /** The full updated question payload, server-merged. */
    question: unknown;
}

/** Broadcast when the round ends. */
export interface SMsgRoundEnded {
    t: "ended";
    foundAt: number;
}

/** Broadcast when participants join, leave, change role, or
 *  toggle online. Always sends the full participants array. */
export interface SMsgPresence {
    t: "presence";
    participants: GameState["participants"];
}

/** Broadcast when the setup state changes (host finishes wizard, etc.). */
export interface SMsgSetupChanged {
    t: "setupChanged";
    setup: SetupState;
}

/** Error from the server. `code` is machine-readable. */
export interface SMsgError {
    t: "error";
    code:
        | "unknown_room"
        | "room_full"
        | "bad_message"
        | "version_mismatch"
        | "not_host"
        | "role_taken"
        | "session_invalid"
        | "internal";
    message: string;
}

/** Keep-alive response. */
export interface SMsgPong {
    t: "pong";
    ts: number;
}

export type ServerMessage =
    | SMsgWelcome
    | SMsgSnapshot
    | SMsgQuestionAdded
    | SMsgQuestionUpdated
    | SMsgQuestionAnswered
    | SMsgRoundEnded
    | SMsgPresence
    | SMsgSetupChanged
    | SMsgError
    | SMsgPong;

/* ────────────────── Re-exports for ergonomic imports ────────────────── */

export type { GameSize, TransitMode, Role, GameState, SetupState };
