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
    type ClientMessage,
    type GameState,
    type Participant,
    type Role,
    type ServerMessage,
    type SetupState,
} from "@protocol/index";

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
        // accepted them by creating the DO). Same-device "rehost"
        // case: replace any existing record with this device id.
        const existing = this.game.participants.find(
            (p) => this.tokens.get(this.findTokenForParticipant(p.id) ?? "")?.deviceId === deviceId,
        );
        const participantId = existing?.id ?? crypto.randomUUID();
        const sessionToken = makeSessionToken();

        const participant: Participant = {
            id: participantId,
            displayName: displayName || "Host",
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

        // Reconnect-shaped flow: same deviceId already a member? Replace
        // their session token, keep the participantId.
        const existingByDevice = [...this.tokens.entries()].find(
            ([, v]) => v.deviceId === deviceId,
        );
        let participantId: string;
        if (existingByDevice) {
            participantId = existingByDevice[1].participantId;
            const existingP = this.game.participants.find((p) => p.id === participantId);
            if (existingP) {
                existingP.displayName = displayName || existingP.displayName;
                existingP.online = true;
            }
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
                displayName: displayName || "Player",
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
        const entry = this.tokens.get(sessionToken);
        if (!entry || entry.deviceId !== deviceId) {
            return this.sendTo(socket, {
                t: "error",
                code: "session_invalid",
                message: "Resume token unrecognized; rejoin with code.",
            });
        }
        // Drop any prior connection for this participant — only one
        // socket per participant at a time.
        const prior = this.conns.get(entry.participantId);
        if (prior && prior.socket !== socket) {
            try {
                prior.socket.close(1000, "superseded");
            } catch {
                /* ignore */
            }
        }
        const existing = this.game.participants.find(
            (p) => p.id === entry.participantId,
        );
        if (existing) existing.online = true;

        this.attachConnection(socket, {
            participantId: entry.participantId,
            sessionToken,
            deviceId,
        });
        this.sendTo(socket, {
            t: "welcome",
            sessionToken,
            self: { id: entry.participantId },
            state: this.game,
        });
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
        // Idempotency: if a question with the same key already
        // exists, treat as an update (covers the seeker's local
        // re-add after a network blip).
        const existingIdx = this.game.questions.findIndex(
            (q) => isQuestionLike(q) && q.key === question.key,
        );
        if (existingIdx >= 0) {
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
        }
        this.broadcast({ t: "qAdded", question });
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
    }

    private lookupConn(socket: WebSocket): ConnInfo | undefined {
        const pid = (socket as unknown as { __participantId?: string })
            .__participantId;
        if (!pid) return undefined;
        return this.conns.get(pid);
    }

    private findTokenForParticipant(pid: string): string | null {
        for (const [token, v] of this.tokens.entries()) {
            if (v.participantId === pid) return token;
        }
        return null;
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
}
