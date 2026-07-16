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
    DeckStateShare,
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
 *
 * The server soft-validates proximity (rulebook p43 — the seeker must be
 * physically with the hider): if the seeker's last shared GPS is well away
 * from the nearest hider's last shared GPS, the server replies `foundFar`
 * instead of ending, and the seeker re-sends with `force:true` after the
 * soft "are you sure?" warning. When it can't verify (either side's position
 * is missing/stale), it ends normally. `force` skips the check.
 */
export interface CMsgMarkFound {
    t: "found";
    foundAt: number;
    force?: boolean;
}

/**
 * Hider → server ONLY: the hider's live GPS. Never fanned to anyone (unlike
 * the seeker `loc`, which the hide team sees) — it exists purely so the
 * server can range-check a `found` claim without ever revealing the hider's
 * position to seekers. Same shape as `loc`.
 */
export interface CMsgHiderLoc {
    t: "hiderLoc";
    lat: number;
    lng: number;
    accuracy: number;
    ts: number;
}

/**
 * The hider publishes its AUTHORITATIVE round result the instant the round
 * ends (received the `ended` broadcast). The seeker can't compute this — the
 * base clock's Move-credit / late-answer-debit and the in-hand time-bonus
 * cards are all hider-local. Relayed to the rest of the room so every
 * device's end-of-round dialog + leaderboard shows the same time, and the
 * seeker sees the bonus tally up. Milliseconds. `bonusMs` is the in-hand
 * time-bonus portion (for the tally); `baseMs` is the rest.
 */
export interface CMsgRoundSummary {
    t: "roundSummary";
    baseMs: number;
    /** Individual in-hand time-bonus contributions, in MINUTES (one per
     *  bonus card / duplicate) — so the seeker can pop a chip per piece. */
    bonusPieces: number[];
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
    /** Participant id of a player who should hide this round. */
    to: string;
    /**
     * Optional additional hide-team members (v826): the whole set
     * (`to` + `coHiders`) becomes equal `hider`s for the new round;
     * everyone else becomes a seeker (v829 — no more main/co distinction).
     * Omitted / empty = a single-hider round. `to` is included even if it
     * also appears here. (Field name kept for wire compatibility.)
     */
    coHiders?: string[];
}

/**
 * The primary hider pushes their committed hiding zone (or null when
 * cleared / reset). The server stores it and fans it out to the whole
 * hide team (every `hider`) except the sender. Seekers never receive it;
 * the zone is the secret they're trying to deduce. v829: any hider may
 * commit/change the zone (no more primary-only).
 */
export interface CMsgSetHideZone {
    t: "setHideZone";
    zone: HidingZoneShare | null;
}

/**
 * A hider pushes the whole hide team's shared card economy (v831 Track 2)
 * after a local mutation (draw / keep / discard / play / chalice). The
 * server stores it and fans it to every OTHER hider — never to seekers
 * (the hand is secret). The initiator's local deck IS the shared deck
 * (kept in sync), so it carries the authoritative post-mutation state;
 * concurrent edits degrade to last-write-wins, the same as `questions`.
 */
export interface CMsgSetDeck {
    t: "setDeck";
    deck: DeckStateShare;
}

/**
 * A participant renames themselves in the lobby. The server updates their
 * `displayName` (de-duped against the roster) and broadcasts presence so
 * every device sees the new name. Trimmed empty is ignored server-side.
 */
export interface CMsgSetName {
    t: "setName";
    displayName: string;
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
 * Hider → server: cancel a mistakenly-triggered endgame ("you're not
 * in my zone yet"). Per the rulebook (p43) the endgame only truly
 * begins when the seekers are physically inside the hider's ACTUAL
 * zone and off transit — a seeker's `startEndgame` is just a *claim*.
 * The hider, who alone knows their zone, can refute a wrong claim:
 * the server resets `setup.endgameStartedAt` to null and broadcasts a
 * setupChanged so the seekers' "endgame armed" UI reverts and they
 * keep searching, while the hider regains movement freedom. Only the
 * hide team may send this; idempotent if the endgame isn't armed.
 */
export interface CMsgCancelEndgame {
    t: "cancelEndgame";
}

/**
 * Hider → server: confirm a seeker's endgame claim ("yes, you're in my
 * zone"). The server stamps `setup.endgameConfirmedAt` and broadcasts a
 * setupChanged so the seekers flip from "waiting for the hider" to
 * "you're in the right zone — find them". The tabletop rules leave this
 * positive confirmation implicit; the app makes it explicit so a remote
 * seeker isn't left guessing what the hider's silence means. Hide-team
 * only; idempotent if there's no active claim or it's already confirmed.
 */
export interface CMsgConfirmEndgame {
    t: "confirmEndgame";
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
    | CMsgRoundSummary
    | CMsgRotateHider
    | CMsgSetHideZone
    | CMsgSetDeck
    | CMsgSetName
    | CMsgStartEndgame
    | CMsgCancelEndgame
    | CMsgConfirmEndgame
    | CMsgSeekerLocation
    | CMsgHiderLoc
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
 * Sent to the marking seeker ONLY (not a broadcast) when their `found`
 * claim's proximity check fails — their last GPS is well away from the
 * nearest hider's. The round does NOT end; the seeker shows a soft "are you
 * sure?" warning and, on confirm, re-sends `found` with `force:true`.
 * Carries the original `foundAt` so the forced re-send preserves the
 * declared moment. Deliberately leaks NO distance (the hider's position is
 * secret — the warning only says "GPS says you're pretty far").
 */
export interface SMsgFoundFar {
    t: "foundFar";
    foundAt: number;
}

/** Relay of the hider's authoritative round result (see CMsgRoundSummary),
 *  fanned to the rest of the room so the seeker's end-of-round dialog +
 *  leaderboard match and the bonus tallies up. */
export interface SMsgRoundSummary {
    t: "roundSummary";
    baseMs: number;
    bonusPieces: number[];
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
 * Delivered to hide-team connections when ANY hider mutates the shared
 * card economy, and to a hider on join/resume/role-claim so they adopt
 * the current shared deck. Never sent to seekers (the hand is secret).
 * `null` means "no shared deck yet this round" (nobody has drawn).
 */
export interface SMsgDeck {
    t: "deck";
    deck: DeckStateShare | null;
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
    | SMsgFoundFar
    | SMsgRoundSummary
    | SMsgRoundStarted
    | SMsgPresence
    | SMsgSetupChanged
    | SMsgHideZone
    | SMsgDeck
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
    /**
     * Curse-specific enforcement params chosen by the hider at cast time.
     * LEGACY Drained Brain field (pre-v907): 3 whole question-CATEGORY ids.
     * Superseded by `disabledQuestions` (3 specific questions), kept so an
     * older hider client's cast is still understood. Absent otherwise.
     */
    disabledCategories?: string[];
    /**
     * Drained Brain (v907): the 3 specific QUESTIONS the seekers can no
     * longer ask for the rest of the run (rulebook: "three questions in
     * different categories"). Each id is either a bare category id
     * (`"radius"`/`"thermometer"`/`"photo"` — those categories are a single
     * question) or `"<category>/<subtype>"` (a specific matching/measuring/
     * tentacles question). Absent for every other curse and older clients.
     */
    disabledQuestions?: string[];
    /**
     * Proof photo the hider attaches when a curse's casting cost is a
     * photo ("A photo of an animal / a car" — Zoologist, Luxury Car). An
     * R2 URL (uploaded via the game's photo endpoint), so it stays tiny
     * on the wire. Absent for every non-photo curse and older clients.
     */
    photoUrl?: string;
    /**
     * For a "film a duration" curse (Bird Guide), the number of SECONDS the
     * hider filmed — the target the seekers must beat. Absent otherwise.
     */
    filmSeconds?: number;
    /**
     * For a "build a tower" curse (Curse of the Cairn), the number of ROCKS
     * the hider's tower reached — the target the seekers must match. Absent
     * for every other curse and older clients.
     */
    rockCount?: number;
    /**
     * For Curse of the Mediocre Travel Agent, the place the hider chose for
     * the seekers to travel to (a free-text destination near the seekers).
     * Absent for every other curse and older clients.
     */
    travelDestination?: string;
}

/** Push subscription stored by the client for server-side delivery. */
export interface PushSubscriptionData {
    endpoint: string;
    expirationTime: number | null;
    keys: { p256dh: string; auth: string };
}

/* ────────────────── Re-exports for ergonomic imports ────────────────── */

export type { GameSize, TransitMode, Role, GameState, SetupState };
