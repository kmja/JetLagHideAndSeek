/**
 * GameRoom — one Durable Object per active multiplayer game.
 *
 * Holds in-memory game state (no durable storage; rooms evict on
 * idle) and fans out WebSocket events to every connected
 * participant. Server-authoritative for transport invariants:
 *
 *   - Max participants (`MAX_PARTICIPANTS`)
 *   - At most one hider per room
 *   - Session-token-based reconnect to recover identity
 *   - Idle-eviction alarm clears the room after `IDLE_EVICTION_MS`
 *     with zero connections
 *
 * Game-rule enforcement (radius bounds, question categories, deck
 * limits, etc.) stays on the client — the worker treats question
 * payloads as opaque JSON and just relays them.
 */

import {
    IDLE_EVICTION_MS,
    MAX_MESSAGE_BYTES,
    MAX_PARTICIPANTS,
    MAX_QUESTIONS_PER_ROOM,
    MAX_ROOM_LIFETIME_MS,
    PROTOCOL_VERSION,
    resolveUniqueDisplayName,
    type ClientMessage,
    type CursePayload,
    type GameState,
    type HidingZoneShare,
    type Participant,
    type PushSubscriptionData,
    type Role,
    type ServerMessage,
    type SetupState,
} from "@protocol/index";
import { parseVapidKeys, sendWebPush } from "./webpush";

/* ────────────────── Helpers ────────────────── */

/** Cryptographically-random session token. Hex-encoded, 24 bytes. */
function makeSessionToken(): string {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Default empty setup so the snapshot is well-formed before host start. */
function emptySetup(): SetupState {
    return {
        playArea: null,
        allowedTransit: [],
        gameSize: "medium",
        hidingPeriodEndsAt: null,
        endgameStartedAt: null,
        endgameConfirmedAt: null,
        mapGeoLocation: null,
    };
}

/* ────────────────── Connection bookkeeping ────────────────── */

interface ConnInfo {
    socket: WebSocket;
    /** Server-issued session token for resume. */
    sessionToken: string;
    /** Stable identity within this room. */
    participantId: string;
    /** Device-supplied UUID. Used to match resumes to existing rosters. */
    deviceId: string;
}

/* ────────────────── The Durable Object ────────────────── */

export class GameRoom {
    private state: DurableObjectState;
    private env: Env;

    /** The actual game state we mirror on every client. */
    private game: GameState;

    /** Tokens we have outstanding, keyed by sessionToken. */
    private tokens: Map<string, { participantId: string; deviceId: string }> =
        new Map();

    /** Live socket connections. Keyed by participant id. */
    private conns: Map<string, ConnInfo> = new Map();

    /**
     * Device → participant identity map. The authoritative key for
     * reclaiming identity across reconnect / re-host / re-join: a
     * returning device (same `deviceId`) is re-bound to its EXISTING
     * participant rather than minting a duplicate.
     *
     * Shares the in-memory lifetime of `participants` (cleared together
     * on room teardown), so it never holds a binding to a participant
     * that's no longer in the roster — individual participants are never
     * removed, only the whole room. Held server-side only; deviceIds are
     * NEVER broadcast in the participant snapshot.
     */
    private deviceToParticipant: Map<string, string> = new Map();

    /**
     * The hider's committed hiding zone. Held OUTSIDE `this.game` on
     * purpose — it's a secret from seekers, so it must never enter the
     * wholesale snapshot. Delivered only to hide-team connections
     * (the hider + co-hiders). Cleared on each new round.
     */
    private hidingZone: HidingZoneShare | null = null;

    /** Per-participant Web Push subscriptions. Keyed by participant id. */
    private pushSubscriptions: Map<string, PushSubscriptionData> = new Map();

    /** Idle-eviction wake handle. */
    private evictionAlarmSet = false;

    constructor(state: DurableObjectState, env: Env) {
        this.state = state;
        this.env = env;
        // Code is filled in by the first host message — we don't
        // know it from the DO's own identifier.
        this.game = {
            code: "",
            createdAt: Date.now(),
            setup: emptySetup(),
            questions: [],
            roundFoundAt: null,
            participants: [],
        };
    }

    /* ────────────────── Public fetch entry ────────────────── */

    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);

        // The router only sends us /ws here; everything else is 404.
        if (url.pathname !== "/ws") {
            return new Response("not found", { status: 404 });
        }

        if (request.headers.get("Upgrade") !== "websocket") {
            return new Response("expected websocket", { status: 400 });
        }

        // The router passes the game code as a header so the DO can
        // imprint itself on the first connection.
        const code = request.headers.get("x-game-code") ?? "";
        if (!this.game.code && code) this.game.code = code;

        const { 0: client, 1: server } = new WebSocketPair();
        server.accept();

        // Pre-handshake: we don't know the participant yet; they
        // identify themselves with their first message (host / join /
        // resume).
        server.addEventListener("message", (evt) =>
            this.handleSocketMessage(server, evt),
        );
        server.addEventListener("close", () =>
            this.handleSocketClose(server),
        );
        server.addEventListener("error", () =>
            this.handleSocketClose(server),
        );

        // Cancel any pending eviction now that we have a fresh
        // connection. We'll re-arm when conns go to zero again.
        await this.cancelEviction();

        return new Response(null, { status: 101, webSocket: client });
    }

    /* ────────────────── Idle eviction ────────────────── */

    /**
     * Wakes the DO with no connections so it can decide whether to
     * tear down. We just check the conns map — if empty, we close
     * the DO context by setting `evictionAlarmSet = false` and
     * letting Cloudflare reclaim the instance once it idles.
     */
    async alarm() {
        this.evictionAlarmSet = false;
        if (this.conns.size === 0) {
            // No-op: the DO has no live sockets; Cloudflare will
            // reclaim the instance when the request queue empties.
            this.game.participants = [];
            this.tokens.clear();
            this.deviceToParticipant.clear();
        } else {
            // A new connection arrived in the meantime; re-arm.
            await this.armEviction();
        }
    }

    private async armEviction() {
        if (this.evictionAlarmSet) return;
        this.evictionAlarmSet = true;
        await this.state.storage.setAlarm(Date.now() + IDLE_EVICTION_MS);
    }

    private async cancelEviction() {
        if (!this.evictionAlarmSet) return;
        this.evictionAlarmSet = false;
        await this.state.storage.deleteAlarm();
    }

    /* ────────────────── Message dispatch ────────────────── */

    private handleSocketMessage(socket: WebSocket, evt: MessageEvent) {
        // Hard cap on the room's wall-clock lifetime. Cheaper to
        // check at message arrival than via a separate timer alarm,
        // and it doesn't matter if a stale message slips through —
        // the next one will trigger the close.
        if (Date.now() - this.game.createdAt > MAX_ROOM_LIFETIME_MS) {
            this.forceCloseRoom("Room reached its max lifetime.");
            return;
        }

        // Size guard. evt.data could be a String or ArrayBuffer; in
        // either case the byte count is an order-of-magnitude check
        // that drops obvious amplification attempts before we
        // bother JSON-parsing.
        const byteSize =
            typeof evt.data === "string"
                ? evt.data.length // JS strings are UTF-16 — generous overestimate vs UTF-8 bytes, which is what we want
                : (evt.data as ArrayBuffer).byteLength;
        if (byteSize > MAX_MESSAGE_BYTES) {
            this.sendTo(socket, {
                t: "error",
                code: "bad_message",
                message: "Message too large.",
            });
            return;
        }

        let raw: ClientMessage;
        try {
            raw = JSON.parse(
                typeof evt.data === "string"
                    ? evt.data
                    : new TextDecoder().decode(evt.data as ArrayBuffer),
            ) as ClientMessage;
        } catch {
            this.sendTo(socket, {
                t: "error",
                code: "bad_message",
                message: "Malformed JSON.",
            });
            return;
        }

        try {
            this.dispatch(socket, raw);
        } catch (e) {
            // Log the real error server-side for debugging via the
            // Cloudflare dashboard, but never leak internals (stack
            // traces, file paths, etc.) to clients. The generic
            // message keeps abuse-feedback channels closed.
            console.error("[GameRoom] dispatch threw", e);
            this.sendTo(socket, {
                t: "error",
                code: "internal",
                message: "Internal server error.",
            });
        }
    }

    /**
     * Broadcast a final "room ended" snapshot, close all open
     * sockets, and clear our state. Called when the room hits its
     * max wall-clock lifetime.
     */
    private forceCloseRoom(reason: string) {
        this.broadcast({
            t: "error",
            code: "internal",
            message: reason,
        });
        for (const conn of this.conns.values()) {
            try {
                conn.socket.close(1000, "room closed");
            } catch {
                /* ignore */
            }
        }
        this.conns.clear();
        this.tokens.clear();
        this.deviceToParticipant.clear();
        this.game.participants = [];
        this.game.questions = [];
    }

    private dispatch(socket: WebSocket, msg: ClientMessage) {
        switch (msg.t) {
            case "host":
                return this.handleHost(socket, msg.v, msg.deviceId, msg.displayName);
            case "join":
                return this.handleJoin(
                    socket,
                    msg.v,
                    msg.code,
                    msg.deviceId,
                    msg.displayName,
                );
            case "resume":
                return this.handleResume(
                    socket,
                    msg.v,
                    msg.code,
                    msg.deviceId,
                    msg.sessionToken,
                );
            case "role":
                return this.handleSetRole(socket, msg.role);
            case "start":
                return this.handleStart(socket, msg.setup);
            case "addQ":
                return this.handleAddQuestion(socket, msg.question);
            case "answerQ":
                return this.handleAnswerQuestion(socket, msg.key, msg.answer);
            case "updateQ":
                return this.handleUpdateQuestion(socket, msg.key, msg.data);
            case "found":
                return this.handleMarkFound(socket, msg.foundAt);
            case "rotateHider":
                return this.handleRotateHider(socket, msg.to);
            case "promoteCoHider":
                return this.handlePromoteCoHider(socket, msg.to);
            case "setHideZone":
                return this.handleSetHideZone(socket, msg.zone);
            case "startEndgame":
                return this.handleStartEndgame(socket, msg.at);
            case "cancelEndgame":
                return this.handleCancelEndgame(socket);
            case "confirmEndgame":
                return this.handleConfirmEndgame(socket);
            case "loc":
                return this.handleSeekerLocation(
                    socket,
                    msg.lat,
                    msg.lng,
                    msg.accuracy,
                    msg.ts,
                );
            case "castCurse":
                return this.handleCastCurse(socket, msg.curse);
            case "subscribePush":
                return this.handleSubscribePush(socket, msg.subscription);
            case "ping":
                return this.sendTo(socket, { t: "pong", ts: msg.ts });
            default: {
                const _exhaustive: never = msg;
                void _exhaustive;
                this.sendTo(socket, {
                    t: "error",
                    code: "bad_message",
                    message: "Unknown message type.",
                });
            }
        }
    }

    /* ────────────────── Handlers ────────────────── */

    /**
     * Resolve a requested display name to one unique within the room.
     * Empty requests (the common case — the client sends "" when the
     * player didn't type a name) get an assigned Jet Lag cast name;
     * a typed name is kept if free, else reassigned. `excludeId` omits
     * the participant's own current record so a reconnecting player
     * doesn't collide with themselves.
     */
    private uniqueDisplayName(requested: string, excludeId?: string): string {
        const taken = this.game.participants
            .filter((p) => p.id !== excludeId)
            .map((p) => p.displayName);
        return resolveUniqueDisplayName(requested, taken);
    }

    private handleHost(
        socket: WebSocket,
        version: number,
        deviceId: string,
        displayName: string,
    ) {
        if (version !== PROTOCOL_VERSION) {
            return this.sendTo(socket, {
                t: "error",
                code: "version_mismatch",
                message: `Server expects protocol v${PROTOCOL_VERSION}.`,
            });
        }
        // Host is always the first participant in the room (server
        // accepted them by creating the DO). Same-device "rehost" case:
        // reclaim this device's EXISTING participant (preserving its id +
        // joinedAt) rather than minting a duplicate that would orphan the
        // original host entry. Keyed off the authoritative device map.
        const existing = this.participantForDevice(deviceId);
        const participantId = existing?.id ?? crypto.randomUUID();
        const sessionToken = makeSessionToken();

        const participant: Participant = {
            id: participantId,
            displayName: this.uniqueDisplayName(displayName, participantId),
            // Host doesn't pre-commit a role — leaves room to be either
            // seeker or hider depending on the local setup.
            role: existing?.role ?? null,
            joinedAt: existing?.joinedAt ?? Date.now(),
            online: true,
        };
        this.game.participants = [
            participant,
            ...this.game.participants.filter((p) => p.id !== participantId),
        ];
        this.tokens.set(sessionToken, { participantId, deviceId });

        this.attachConnection(socket, { participantId, sessionToken, deviceId });
        this.sendTo(socket, {
            t: "welcome",
            sessionToken,
            self: { id: participantId },
            state: this.game,
        });
        this.broadcastPresence();
    }

    private handleJoin(
        socket: WebSocket,
        version: number,
        code: string,
        deviceId: string,
        displayName: string,
    ) {
        if (version !== PROTOCOL_VERSION) {
            return this.sendTo(socket, {
                t: "error",
                code: "version_mismatch",
                message: `Server expects protocol v${PROTOCOL_VERSION}.`,
            });
        }
        if (code && this.game.code && code !== this.game.code) {
            // The router routes by code, so this should only fire on
            // a misrouted join. Defensive only.
            return this.sendTo(socket, {
                t: "error",
                code: "unknown_room",
                message: "Game code doesn't match this room.",
            });
        }

        // Reconnect-shaped flow: same deviceId already a member? Reclaim
        // their existing participant (keep the id), just refresh the
        // session token. Keyed off the authoritative device map so a
        // returning device never spawns a duplicate.
        const existingP = this.participantForDevice(deviceId);
        let participantId: string;
        if (existingP) {
            participantId = existingP.id;
            // Keep their existing name on reconnect unless they sent
            // a new non-empty one; either way ensure it's unique
            // against the rest of the room.
            const requested = displayName.trim() || existingP.displayName;
            existingP.displayName = this.uniqueDisplayName(
                requested,
                participantId,
            );
            existingP.online = true;
        } else {
            if (this.game.participants.length >= MAX_PARTICIPANTS) {
                return this.sendTo(socket, {
                    t: "error",
                    code: "room_full",
                    message: `Room is full (max ${MAX_PARTICIPANTS}).`,
                });
            }
            participantId = crypto.randomUUID();
            this.game.participants.push({
                id: participantId,
                displayName: this.uniqueDisplayName(displayName, participantId),
                role: null,
                joinedAt: Date.now(),
                online: true,
            });
        }

        const sessionToken = makeSessionToken();
        this.tokens.set(sessionToken, { participantId, deviceId });
        this.attachConnection(socket, { participantId, sessionToken, deviceId });
        this.sendTo(socket, {
            t: "welcome",
            sessionToken,
            self: { id: participantId },
            state: this.game,
        });
        this.broadcastPresence();
    }

    private handleResume(
        socket: WebSocket,
        version: number,
        code: string,
        deviceId: string,
        sessionToken: string,
    ) {
        if (version !== PROTOCOL_VERSION) {
            return this.sendTo(socket, {
                t: "error",
                code: "version_mismatch",
                message: `Server expects protocol v${PROTOCOL_VERSION}.`,
            });
        }
        if (code && this.game.code && code !== this.game.code) {
            return this.sendTo(socket, {
                t: "error",
                code: "unknown_room",
                message: "Game code doesn't match this room.",
            });
        }
        // Resolve identity. Fast path: the session token is known and
        // belongs to this device. Fallback: the token is unknown (e.g.
        // issued by an isolate that has since been recycled, or simply
        // stale) — recover by DEVICE instead of erroring, so a returning
        // device reclaims its existing participant rather than being
        // bounced to the lobby and (worse) re-joining as a duplicate.
        // Only when the device has no participant at all do we reject.
        const entry = this.tokens.get(sessionToken);
        let participantId: string;
        if (entry && entry.deviceId === deviceId) {
            participantId = entry.participantId;
        } else {
            const byDevice = this.participantForDevice(deviceId);
            if (!byDevice) {
                return this.sendTo(socket, {
                    t: "error",
                    code: "session_invalid",
                    message: "Resume token unrecognized; rejoin with code.",
                });
            }
            participantId = byDevice.id;
        }
        // Always issue a fresh token on resume — the presented one may be
        // stale (recovered-by-device path) and a new one keeps the
        // tokens map authoritative for this live connection. Drop the
        // presented token so the map doesn't accumulate dead entries
        // across a long string of reconnects.
        this.tokens.delete(sessionToken);
        const freshToken = makeSessionToken();
        this.tokens.set(freshToken, { participantId, deviceId });
        // Drop any prior connection for this participant — only one
        // socket per participant at a time.
        const prior = this.conns.get(participantId);
        if (prior && prior.socket !== socket) {
            try {
                prior.socket.close(1000, "superseded");
            } catch {
                /* ignore */
            }
        }
        const existing = this.game.participants.find(
            (p) => p.id === participantId,
        );
        if (existing) existing.online = true;

        this.attachConnection(socket, {
            participantId,
            sessionToken: freshToken,
            deviceId,
        });
        this.sendTo(socket, {
            t: "welcome",
            sessionToken: freshToken,
            self: { id: participantId },
            state: this.game,
        });
        // The hiding zone lives outside GameState (it's secret from
        // seekers) so it isn't in the welcome snapshot. Re-deliver it to a
        // reconnecting hide-team member, otherwise a co-hider who reloads
        // or drops connection loses the zone view for the rest of the
        // round (it's only otherwise pushed on a fresh role claim).
        if (
            existing &&
            (existing.role === "coHider" || existing.role === "hider")
        ) {
            this.sendTo(socket, { t: "hideZone", zone: this.hidingZone });
        }
        this.broadcastPresence();
    }

    private handleSetRole(socket: WebSocket, role: Role | null) {
        const conn = this.lookupConn(socket);
        if (!conn) return;
        const p = this.game.participants.find((q) => q.id === conn.participantId);
        if (!p) return;
        if (
            role === "hider" &&
            this.game.participants.some(
                (q) => q.role === "hider" && q.id !== conn.participantId,
            )
        ) {
            return this.sendTo(socket, {
                t: "error",
                code: "role_taken",
                message: "Another participant is already the hider.",
            });
        }
        p.role = role;
        this.broadcastPresence();
        // A freshly-minted co-hider joins the hide team mid-round —
        // hand them the current zone so they can watch the hide right
        // away (the inbox rebuilds from the snapshot they already got).
        if (role === "coHider") {
            this.sendTo(socket, { t: "hideZone", zone: this.hidingZone });
        }
    }

    private handleSetHideZone(
        socket: WebSocket,
        zone: HidingZoneShare | null,
    ) {
        const conn = this.lookupConn(socket);
        if (!conn) return;
        const p = this.game.participants.find((q) => q.id === conn.participantId);
        // Only the primary hider owns the zone. Ignore anyone else so
        // a co-hider (read-only) or a seeker can't spoof the hide.
        if (!p || p.role !== "hider") return;
        this.hidingZone = zone;
        // Fan out to co-hiders only — never to seekers (the zone is
        // the secret they're deducing) and not back to the hider (we'd
        // just echo their own commit, risking a sync loop client-side).
        for (const [pid, c] of this.conns.entries()) {
            const cp = this.game.participants.find((q) => q.id === pid);
            if (cp?.role === "coHider") {
                this.sendTo(c.socket, { t: "hideZone", zone });
            }
        }
    }

    /**
     * Host's setup-finished message. We trust the host (client-
     * authoritative for game-rule details) but invariant-check that
     * the sender is a participant.
     */
    private handleStart(socket: WebSocket, setup: SetupState) {
        const conn = this.lookupConn(socket);
        if (!conn) return;
        this.game.setup = setup;
        this.broadcastSetupChanged();
    }

    private handleAddQuestion(socket: WebSocket, question: unknown) {
        const conn = this.lookupConn(socket);
        if (!conn) return;
        if (!isQuestionLike(question)) {
            return this.sendTo(socket, {
                t: "error",
                code: "bad_message",
                message: "Question payload missing id / key / data.",
            });
        }
        // Peek at the thermometer lifecycle status (payloads are otherwise
        // opaque): a `started` thermometer isn't answerable yet, so it must
        // not push; its FINISH arrives as a re-add of the same key with the
        // status flipped, and THAT is the hider's "answer me now" moment.
        const statusOf = (q: unknown): unknown =>
            (q as { data?: { status?: unknown } })?.data?.status;
        const incomingStatus = statusOf(question);
        // Idempotency: if a question with the same key already
        // exists, treat as an update (covers the seeker's local
        // re-add after a network blip).
        const existingIdx = this.game.questions.findIndex(
            (q) => isQuestionLike(q) && q.key === question.key,
        );
        let notifyHider = false;
        if (existingIdx >= 0) {
            // Re-add: only the started→finished thermometer transition is
            // a fresh "answer me" signal; a plain network-blip re-add
            // (status unchanged) must not re-notify.
            notifyHider =
                statusOf(this.game.questions[existingIdx]) === "started" &&
                incomingStatus !== "started";
            this.game.questions[existingIdx] = question;
        } else {
            // Hard cap on questions per room. A normal game has
            // well under 30; 200 is a defense against an abusive
            // client trying to balloon the room's broadcast cost.
            if (this.game.questions.length >= MAX_QUESTIONS_PER_ROOM) {
                return this.sendTo(socket, {
                    t: "error",
                    code: "bad_message",
                    message: "Room has reached its question cap.",
                });
            }
            this.game.questions.push(question);
            notifyHider = incomingStatus !== "started";
        }
        this.broadcast({ t: "qAdded", question });
        // The hider's answer window is TIMED, and they're the player most
        // likely to have the app backgrounded (riding transit) — Web Push
        // any offline hide-team member so the question reaches them the
        // moment it's asked (mirrors the curse + endgame push paths).
        if (notifyHider) {
            this.state.waitUntil(
                this.pushToOfflineHideTeam({
                    title: "New question",
                    body: "The seekers asked a question — open the app to answer it before the window closes.",
                    tag: `question-${question.key}`,
                }),
            );
        }
    }

    private handleAnswerQuestion(
        socket: WebSocket,
        key: number,
        answer: Record<string, unknown>,
    ) {
        const conn = this.lookupConn(socket);
        if (!conn) return;
        const idx = this.game.questions.findIndex(
            (q) => isQuestionLike(q) && q.key === key,
        );
        if (idx < 0) {
            return this.sendTo(socket, {
                t: "error",
                code: "bad_message",
                message: `No question with key ${key}.`,
            });
        }
        const q = this.game.questions[idx] as QuestionShape;
        const merged: QuestionShape = {
            ...q,
            data: { ...q.data, ...answer, drag: false },
        };
        this.game.questions[idx] = merged;
        this.broadcast({ t: "qAnswered", key, question: merged });
    }

    private handleUpdateQuestion(
        socket: WebSocket,
        key: number,
        data: Record<string, unknown>,
    ) {
        const conn = this.lookupConn(socket);
        if (!conn) return;
        const idx = this.game.questions.findIndex(
            (q) => isQuestionLike(q) && q.key === key,
        );
        if (idx < 0) return;
        const q = this.game.questions[idx] as QuestionShape;
        const merged: QuestionShape = { ...q, data: { ...q.data, ...data } };
        this.game.questions[idx] = merged;
        this.broadcast({ t: "qUpdated", key, question: merged });
    }

    private handleMarkFound(socket: WebSocket, foundAt: number) {
        const conn = this.lookupConn(socket);
        if (!conn) return;
        // First-write-wins: don't allow the seeker to move the
        // round-end timestamp after the hider has acknowledged it.
        if (this.game.roundFoundAt !== null) return;
        this.game.roundFoundAt = foundAt;
        this.broadcast({ t: "ended", foundAt });
    }

    /**
     * Seeker → room: trigger the endgame phase. Idempotent: re-triggering
     * after the stamp is a no-op so the seeker can re-tap without
     * scrubbing the original timestamp the hider sees. Broadcasts via
     * setupChanged so every client reconciles their endgame banner from
     * the canonical timestamp.
     */
    private handleStartEndgame(socket: WebSocket, at: number) {
        const conn = this.lookupConn(socket);
        if (!conn) return;
        if (this.game.setup.endgameStartedAt !== null) return;
        if (typeof at !== "number" || !Number.isFinite(at)) return;
        this.game.setup.endgameStartedAt = at;
        // A fresh claim starts unconfirmed — the hider responds next.
        this.game.setup.endgameConfirmedAt = null;
        this.broadcast({ t: "setupChanged", setup: this.game.setup });
        // The hider may be on a train with the app backgrounded — the
        // socket broadcast alone won't surface anything. Push to any
        // offline hide-team member so they get the lock-down signal the
        // instant it's claimed (mirrors the curse push path).
        this.state.waitUntil(this.pushEndgameToOfflineHideTeam());
    }

    /**
     * Hider confirms the seekers really are in their zone (positive
     * response to the claim). Stamps `endgameConfirmedAt` so the
     * seekers' UI flips from "waiting" to "you're in the right zone".
     * Hide-team only; requires an active claim.
     */
    private handleConfirmEndgame(socket: WebSocket) {
        const conn = this.lookupConn(socket);
        if (!conn) return;
        const sender = this.game.participants.find(
            (p) => p.id === conn.participantId,
        );
        if (!sender || (sender.role !== "hider" && sender.role !== "coHider"))
            return;
        if (this.game.setup.endgameStartedAt === null) return;
        if (this.game.setup.endgameConfirmedAt != null) return;
        this.game.setup.endgameConfirmedAt = Date.now();
        this.broadcast({ t: "setupChanged", setup: this.game.setup });
    }

    /**
     * Hider refutes a wrong endgame claim (seekers went to the wrong
     * zone). Reset both stamps and broadcast so the seekers' "endgame
     * armed" UI reverts. Hide-team only — a seeker can't cancel their
     * own claim this way (they'd just not have triggered it).
     */
    private handleCancelEndgame(socket: WebSocket) {
        const conn = this.lookupConn(socket);
        if (!conn) return;
        const sender = this.game.participants.find(
            (p) => p.id === conn.participantId,
        );
        if (!sender || (sender.role !== "hider" && sender.role !== "coHider"))
            return;
        if (this.game.setup.endgameStartedAt === null) return;
        this.game.setup.endgameStartedAt = null;
        this.game.setup.endgameConfirmedAt = null;
        this.broadcast({ t: "setupChanged", setup: this.game.setup });
    }

    private async pushEndgameToOfflineHideTeam() {
        return this.pushToOfflineHideTeam({
            title: "Endgame — lock down",
            body: "The seeker says they're in your zone. Commit to a final spot, or open the app to refute it.",
            tag: "endgame",
        });
    }

    /** Web Push `payload` to every OFFLINE hide-team member with a stored
     *  subscription (an online client gets the WebSocket broadcast — the
     *  push is only for the backgrounded phone on a train). Shared by the
     *  endgame claim + new-question paths; mirrors the curse push. */
    private async pushToOfflineHideTeam(payload: {
        title: string;
        body: string;
        tag: string;
    }) {
        const vapidKeysStr = (this.env as { VAPID_KEYS?: string }).VAPID_KEYS;
        const vapidPublicKey = (this.env as { VAPID_PUBLIC_KEY?: string })
            .VAPID_PUBLIC_KEY;
        if (!vapidKeysStr || !vapidPublicKey) return;
        const vapidKeys = parseVapidKeys(vapidKeysStr);
        if (!vapidKeys) return;
        for (const [pid, sub] of this.pushSubscriptions.entries()) {
            const p = this.game.participants.find((q) => q.id === pid);
            if (!p || (p.role !== "hider" && p.role !== "coHider") || p.online)
                continue;
            const result = await sendWebPush(
                sub,
                payload,
                vapidKeys,
                vapidPublicKey,
                "mailto:karl.mj.andersson@gmail.com",
            );
            if (result === "gone") this.pushSubscriptions.delete(pid);
        }
    }

    /**
     * Forward a seeker's live GPS to the hide team only. Per rulebook
     * p5, every seeker shares their location with the hider for the
     * duration of the round. Seekers don't see each other's locations
     * through this path (they coordinate out-of-band), so this is a
     * tightly-scoped fan-out: hider + coHiders only.
     *
     * Transient: not stored in GameState, so a hide-team member who
     * joins after the fact only sees the next position broadcast (not
     * a backfill). That matches the "live" intent — a several-minutes-
     * old "last seen" pin from before they connected would be
     * misleading. A 30 s heartbeat on the seeker side bounds the gap.
     *
     * Lightweight rate limit: drop messages whose ts isn't strictly
     * after the participant's last accepted ts. Combined with the
     * client-side throttle this caps fan-out at ~1 msg / 5 s / seeker.
     */
    private lastLocTs: Map<string, number> = new Map();
    private handleSeekerLocation(
        socket: WebSocket,
        lat: number,
        lng: number,
        accuracy: number,
        ts: number,
    ) {
        const conn = this.lookupConn(socket);
        if (!conn) return;
        if (
            typeof lat !== "number" ||
            typeof lng !== "number" ||
            typeof accuracy !== "number" ||
            typeof ts !== "number" ||
            !Number.isFinite(lat) ||
            !Number.isFinite(lng) ||
            !Number.isFinite(accuracy) ||
            !Number.isFinite(ts)
        ) {
            return;
        }
        // Drop out-of-order updates (the client may have ticked a new
        // fix in parallel with a queued one).
        const prev = this.lastLocTs.get(conn.participantId) ?? 0;
        if (ts <= prev) return;
        this.lastLocTs.set(conn.participantId, ts);
        const msg: ServerMessage = {
            t: "loc",
            participantId: conn.participantId,
            lat,
            lng,
            accuracy,
            ts,
        };
        const payload = JSON.stringify(msg);
        for (const p of this.game.participants) {
            if (p.role !== "hider" && p.role !== "coHider") continue;
            const c = this.conns.get(p.id);
            if (!c) continue;
            try {
                c.socket.send(payload);
            } catch {
                /* ignore */
            }
        }
    }

    /**
     * Round-rotation: assign the hider role to a different
     * participant. Any participant in the room can trigger this —
     * the UI restricts the call site to the "Start new round"
     * dialog, where the seeker (or hider) picks the next hider out
     * of the room.
     *
     * Server enforces:
     *   - Sender is in the room (any role; presence is enough).
     *   - Target participant exists.
     *   - Result still satisfies "max 1 hider": we zero out any
     *     existing hider role before promoting the target.
     *
     * Also clears `roundFoundAt` so the round resets cleanly — the
     * GO GO GO gate on the seeker side is what re-arms the hiding
     * period clock, so we don't touch `hidingPeriodEndsAt` here.
     */
    private handleRotateHider(socket: WebSocket, toId: string) {
        const conn = this.lookupConn(socket);
        if (!conn) return;
        const target = this.game.participants.find((q) => q.id === toId);
        if (!target) {
            return this.sendTo(socket, {
                t: "error",
                code: "bad_message",
                message: "Unknown participant for hider rotation.",
            });
        }
        // Assign roles for the new round: the target hides, everyone
        // else seeks. This covers the old hider (demoted), any racing
        // second hider, and anyone still unassigned (role null) — one
        // hider, everyone else a seeker, in a single pass.
        for (const p of this.game.participants) {
            p.role = p.id === toId ? "hider" : "seeker";
        }
        // Round boundary: clear the round-end marker and the question
        // log so the new round starts clean. The initiator's local
        // startNewRound() clears these too, but the canonical state
        // must match so a later snapshot / a late joiner doesn't
        // replay last round's questions.
        this.game.roundFoundAt = null;
        this.game.questions = [];
        // Clear endgame-started too so the new round doesn't open
        // with last round's "endgame in progress" banner already
        // armed on the hider's screen.
        this.game.setup.endgameStartedAt = null;
        this.game.setup.endgameConfirmedAt = null;
        // New round, new hide — drop the old zone secret. The new
        // hider will push a fresh one once they commit it.
        this.hidingZone = null;
        // Per-participant location-update timestamps are per-round
        // (the next round's clocks restart). Without clearing, a
        // stale prev > new ts could swallow the new round's first
        // GPS broadcast.
        this.lastLocTs.clear();
        // Announce the new round. Clients apply the roster (role
        // swaps) AND wipe round-scoped local state on this event —
        // see SMsgRoundStarted. A plain snapshot wouldn't do: it also
        // fires on reconnect, where resetting would be wrong, and it
        // can't reset a hider who kept their role (no transition).
        this.broadcast({
            t: "roundStarted",
            participants: this.game.participants,
        });
    }

    /**
     * Hand off the main hider seat to a co-hider mid-game. Sender
     * must be the current hider; target must currently be a
     * coHider. Swap is in-place: sender becomes coHider, target
     * becomes hider; other coHiders / seekers untouched. We
     * deliberately do NOT reset round state (no roundStarted
     * broadcast) — the hide team's view continues with the
     * questions, deck, and hiding zone they already share.
     */
    private handlePromoteCoHider(socket: WebSocket, toId: string) {
        const conn = this.lookupConn(socket);
        if (!conn) return;
        const sender = this.game.participants.find(
            (q) => q.id === conn.participantId,
        );
        if (!sender || sender.role !== "hider") {
            return this.sendTo(socket, {
                t: "error",
                code: "bad_message",
                message:
                    "Only the current main hider can promote a co-hider.",
            });
        }
        const target = this.game.participants.find((q) => q.id === toId);
        if (!target || target.role !== "coHider") {
            return this.sendTo(socket, {
                t: "error",
                code: "bad_message",
                message: "Target must be a current co-hider.",
            });
        }
        sender.role = "coHider";
        target.role = "hider";
        // Broadcast the new roster via presence — clients reconcile
        // their local playerRole atoms from this.
        this.broadcastPresence();
    }

    private handleCastCurse(socket: WebSocket, curse: CursePayload) {
        const conn = this.lookupConn(socket);
        if (!conn) return;
        const sender = this.game.participants.find((p) => p.id === conn.participantId);
        if (!sender || sender.role !== "hider") return;
        // Fan out to all online seekers.
        for (const [pid, c] of this.conns.entries()) {
            const cp = this.game.participants.find((q) => q.id === pid);
            if (cp?.role === "seeker") {
                this.sendTo(c.socket, { t: "curseReceived", curse });
            }
        }
        // Push to offline seekers via Web Push.
        this.state.waitUntil(this.pushCurseToOfflineSeekers(curse));
    }

    private handleSubscribePush(socket: WebSocket, subscription: PushSubscriptionData) {
        const conn = this.lookupConn(socket);
        if (!conn) return;
        this.pushSubscriptions.set(conn.participantId, subscription);
    }

    private async pushCurseToOfflineSeekers(curse: CursePayload) {
        const vapidKeysStr = (this.env as { VAPID_KEYS?: string }).VAPID_KEYS;
        const vapidPublicKey = (this.env as { VAPID_PUBLIC_KEY?: string }).VAPID_PUBLIC_KEY;
        if (!vapidKeysStr || !vapidPublicKey) return;
        const vapidKeys = parseVapidKeys(vapidKeysStr);
        if (!vapidKeys) return;
        for (const [pid, sub] of this.pushSubscriptions.entries()) {
            const p = this.game.participants.find((q) => q.id === pid);
            if (!p || p.role !== "seeker" || p.online) continue;
            const result = await sendWebPush(
                sub,
                { title: curse.name, body: curse.description, tag: "curse" },
                vapidKeys,
                vapidPublicKey,
                "mailto:karl.mj.andersson@gmail.com",
            );
            if (result === "gone") this.pushSubscriptions.delete(pid);
        }
    }

    /* ────────────────── Socket housekeeping ────────────────── */

    private handleSocketClose(socket: WebSocket) {
        const conn = this.lookupConn(socket);
        if (!conn) return;
        this.conns.delete(conn.participantId);
        const p = this.game.participants.find(
            (q) => q.id === conn.participantId,
        );
        if (p) p.online = false;
        this.broadcastPresence();
        if (this.conns.size === 0) {
            // Arm idle eviction. Tokens stay around until the alarm
            // fires so a quick reconnect can reattach.
            void this.armEviction();
        }
    }

    private attachConnection(socket: WebSocket, conn: Omit<ConnInfo, "socket">) {
        // Tag the socket with the participant id so close handlers
        // can find their owner.
        (socket as unknown as { __participantId: string }).__participantId =
            conn.participantId;
        this.conns.set(conn.participantId, { socket, ...conn });
        // Authoritative device→participant binding for identity recovery.
        // Centralised here so every attach path (host/join/resume) keeps
        // it current without each remembering to.
        this.deviceToParticipant.set(conn.deviceId, conn.participantId);
    }

    /**
     * The live participant currently bound to a device, if any. Validated
     * against the roster so a stale binding (shouldn't happen — see the
     * map's docs) resolves to undefined rather than a dangling id.
     */
    private participantForDevice(deviceId: string): Participant | undefined {
        const pid = this.deviceToParticipant.get(deviceId);
        if (!pid) return undefined;
        return this.game.participants.find((p) => p.id === pid);
    }

    private lookupConn(socket: WebSocket): ConnInfo | undefined {
        const pid = (socket as unknown as { __participantId?: string })
            .__participantId;
        if (!pid) return undefined;
        return this.conns.get(pid);
    }

    /* ────────────────── Broadcast helpers ────────────────── */

    private sendTo(socket: WebSocket, msg: ServerMessage) {
        try {
            socket.send(JSON.stringify(msg));
        } catch {
            /* socket likely closed mid-send; close handler will clean up */
        }
    }

    private broadcast(msg: ServerMessage, exceptId?: string) {
        const payload = JSON.stringify(msg);
        for (const [pid, conn] of this.conns.entries()) {
            if (pid === exceptId) continue;
            try {
                conn.socket.send(payload);
            } catch {
                /* ignore */
            }
        }
    }

    private broadcastPresence() {
        this.broadcast({
            t: "presence",
            participants: this.game.participants,
        });
    }

    private broadcastSetupChanged() {
        this.broadcast({ t: "setupChanged", setup: this.game.setup });
    }
}

/* ────────────────── Question-shape sanity check ────────────────── */

interface QuestionShape {
    id: string;
    key: number;
    data: Record<string, unknown>;
}

function isQuestionLike(x: unknown): x is QuestionShape {
    if (!x || typeof x !== "object") return false;
    const o = x as Record<string, unknown>;
    return (
        typeof o.id === "string" &&
        typeof o.key === "number" &&
        typeof o.data === "object" &&
        o.data !== null
    );
}

/* ────────────────── Env shape ────────────────── */

interface Env {
    GAME_ROOM: DurableObjectNamespace;
    ALLOWED_ORIGINS?: string;
    VAPID_PUBLIC_KEY?: string;
    VAPID_KEYS?: string;
}
