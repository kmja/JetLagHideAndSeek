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
    HidingZoneShare,
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
 * Round-rotation: pick the next hider out of the room. The sender
 * does NOT need any special privilege — anyone can trigger a
 * rotation. In practice this is fired from the "Start new round"
 * dialog on the seeker (or current hider) side after they pick a
 * new hider out of the participant list.
 *
 * Server behaviour:
 *   - Validates `to` is an online participant in the room.
 *   - Clears the current hider's role to seeker (if anyone holds
 *     it) so the "max 1 hider" invariant survives.
 *   - Sets the target participant's role to hider.
 *   - Broadcasts a fresh `presence` event — each client picks up
 *     its new role from there and reconciles its local
 *     `playerRole` atom in the bridge layer.
 */
export interface CMsgRotateHider {
    t: "rotateHider";
    /** Participant id of the player who should become the new hider. */
    to: string;
}

/**
 * The primary hider pushes their committed hiding zone (or null when
 * cleared / reset). The server stores it and fans it out to the hide
 * team — co-hiders — only. Seekers never receive it; the zone is the
 * secret they're trying to deduce.
 */
export interface CMsgSetHideZone {
    t: "setHideZone";
    zone: HidingZoneShare | null;
}

/**
 * The primary hider hands the seat off to a co-hider. The server
 * swaps the two roles: the sender (must currently be the hider)
 * becomes a co-hider, the target (must currently be a co-hider)
 * becomes the hider. Other co-hiders and seekers are untouched —
 * unlike `rotateHider`, this is a within-the-hide-team promotion,
 * not a round-end role reset. Broadcast as a fresh presence so
 * every client reconciles its local `playerRole`.
 */
export interface CMsgPromoteCoHider {
    t: "promoteCoHider";
    /** Participant id of the co-hider being promoted to main hider. */
    to: string;
}

/**
 * Seeker triggers the endgame phase ("I'm close — lock your spot
 * down"). The server stamps `setup.endgameStartedAt` and broadcasts
 * a setupChanged so every client surfaces the transition. Idempotent:
 * resending after a stamp is a no-op so the seeker can re-trigger
 * the banner without re-arming the clock. `at` is the seeker's local
 * clock at the moment of trigger so the hider sees the right elapsed.
 */
export interface CMsgStartEndgame {
    t: "startEndgame";
    at: number;
}

/**
 * Seeker → server: live location update. Per rulebook p5, every
 * seeker is expected to share their location with the hider for the
 * duration of the round. The app broadcasts the seeker's watchPosition
 * stream rather than punting to Apple "Find My" / Google live-share.
 * The server forwards only to the hide team (hider + co-hiders);
 * other seekers never receive their teammates' locations through
 * this path (they coordinate out-of-band).
 *
 * `ts` is the seeker's local clock at the moment of the GPS fix so
 * the receiver can show a meaningful "last seen N s ago". Coords are
 * lat / lng in WGS-84. `accuracy` is the GPS reported accuracy in
 * meters (lower is better).
 */
export interface CMsgSeekerLocation {
    t: "loc";
    lat: number;
    lng: number;
    accuracy: number;
    ts: number;
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

/** Hider casts a curse on seekers over the WebSocket wire. */
export interface CMsgCastCurse {
    t: "castCurse";
    curse: CursePayload;
}

/** Client registers its Web Push subscription so the server can notify it offline. */
export interface CMsgSubscribePush {
    t: "subscribePush";
    subscription: PushSubscriptionData;
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
    | CMsgRotateHider
    | CMsgPromoteCoHider
    | CMsgSetHideZone
    | CMsgStartEndgame
    | CMsgSeekerLocation
    | CMsgPing
    | CMsgCastCurse
    | CMsgSubscribePush;

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

/**
 * Broadcast when a new round begins (hider rotation / "Start new
 * round"). Carries the post-rotation roster so every client applies
 * the new role assignments, and signals a full per-device round
 * reset: the question log, the hider's inbox / hand / deck / hiding
 * zone, and the round-found marker all clear. Only the core setup
 * (play area, transit, game size) survives.
 *
 * Deliberately distinct from `snapshot`: a snapshot means "sync to
 * the current state" and is also sent on reconnect, where wiping
 * round state would be wrong. `roundStarted` is the discrete "a new
 * round just began" event — receiving it is the unambiguous trigger
 * to reset round-scoped local state, including for a hider who kept
 * their role (no role transition to key off otherwise).
 */
export interface SMsgRoundStarted {
    t: "roundStarted";
    participants: GameState["participants"];
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

/**
 * Delivered to hide-team connections (the primary hider + co-hiders)
 * when the hider commits or clears their hiding zone. Never sent to
 * seekers. `null` clears the local zone (round reset / hider cleared
 * it).
 */
export interface SMsgHideZone {
    t: "hideZone";
    zone: HidingZoneShare | null;
}

/**
 * Server → hide team: a seeker's live location. Forwarded only to
 * participants whose role is hider or coHider — other seekers don't
 * see their teammates this way. The `participantId` lets the hider
 * disambiguate when multiple seekers are pinned on the map.
 */
export interface SMsgSeekerLocation {
    t: "loc";
    participantId: string;
    lat: number;
    lng: number;
    accuracy: number;
    ts: number;
}

/** Keep-alive response. */
export interface SMsgPong {
    t: "pong";
    ts: number;
}

/** Delivered to every seeker when the hider casts a curse. */
export interface SMsgCurseReceived {
    t: "curseReceived";
    curse: CursePayload;
}

export type ServerMessage =
    | SMsgWelcome
    | SMsgSnapshot
    | SMsgQuestionAdded
    | SMsgQuestionUpdated
    | SMsgQuestionAnswered
    | SMsgRoundEnded
    | SMsgRoundStarted
    | SMsgPresence
    | SMsgSetupChanged
    | SMsgHideZone
    | SMsgSeekerLocation
    | SMsgError
    | SMsgPong
    | SMsgCurseReceived;

/* ────────────────── Shared payload types ────────────────── */

/** Curse payload — mirrors the encodeCurseLink shape. */
export interface CursePayload {
    name: string;
    description: string;
    castingCost: string | null;
}

/** Push subscription stored by the client for server-side delivery. */
export interface PushSubscriptionData {
    endpoint: string;
    expirationTime: number | null;
    keys: { p256dh: string; auth: string };
}

/* ────────────────── Re-exports for ergonomic imports ────────────────── */

export type { GameSize, TransitMode, Role, GameState, SetupState };
