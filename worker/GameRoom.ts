/**
 * GameRoom — one Durable Object per active multiplayer game.
 *
 * Fans out WebSocket events to every connected participant.
 * Server-authoritative for transport invariants:
 *
 *   - Max participants (`MAX_PARTICIPANTS`)
 *   - At most one hider per room
 *   - Session-token-based reconnect to recover identity
 *   - Idle-eviction alarm clears the room after `IDLE_EVICTION_MS`
 *     with zero connections
 *
 * PERSISTENCE (v932): the room state (game, tokens, device map, hide-team
 * secrets, push subs) is MIRRORED to Durable Object storage after every
 * mutation and restored in the constructor via `blockConcurrencyWhile`.
 * A DO is evicted from memory shortly after its last WebSocket drops — so
 * without this, a host who merely closed the app for a few seconds lost
 * the whole room: on reopen, `resume` woke a FRESH isolate with empty
 * maps → `session_invalid` → the client `leaveGame()`d and the player was
 * kicked out of their own lobby (the reported "thrown out of the lobby"
 * bug). With storage backing, a re-instantiated isolate reloads the room
 * and resume reattaches cleanly. The idle-eviction alarm still deletes the
 * persisted state after `IDLE_EVICTION_MS`, so a genuinely abandoned room
 * is reclaimed — the alarm is stored server-side and fires even across an
 * eviction, so the lifetime cap is unaffected.
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
    type DeckStateShare,
    type GameState,
    type HidingZoneShare,
    type Participant,
    type PushSubscriptionData,
    type Role,
    type RoundProgressShare,
    type ServerMessage,
    type SetupState,
} from "@protocol/index";
import { parseVapidKeys, sendWebPush } from "./webpush";

/* ────────────────── Helpers ────────────────── */

/**
 * `found` proximity soft-check tuning. The seeker must be physically with the
 * hider (rulebook p43). GPS is noisy in the dense cores this game is played
 * in, so the threshold is generous — it stops an across-the-block/city
 * declaration, not a face-to-face one. A soft warning, not a hard block:
 * past this, the server asks the seeker "are you sure?" and they can force it.
 */
const FOUND_PROXIMITY_METERS = 50;
/** Only trust a position fresher than this for the check (else can't verify). */
const FOUND_POS_STALE_MS = 3 * 60_000;

/**
 * v940: seeker-location reminder thresholds (stale time → push). KEEP IN SYNC
 * with the client's `LOCATION_REMINDER_1_MS` / `LOCATION_REMINDER_2_MS`
 * (`src/lib/gameSetup.ts`), which drive the matching banner + the 15-min
 * client-side pause. The worker can't import client code, so these are a
 * small hand-mirror.
 */
const LOC_REMINDER_1_MS = 5 * 60_000;
const LOC_REMINDER_2_MS = 10 * 60_000;
/** How often the DO wakes itself during the SEEKING phase to run the
 *  location-reminder escalation — so it fires even when every player's app is
 *  backgrounded/closed (no message activity to piggyback on). v940. */
const ALARM_TICK_MS = 60_000;

/** Great-circle distance in metres (server-side; no turf dependency). */
function haversineMetersServer(
    lat1: number,
    lng1: number,
    lat2: number,
    lng2: number,
): number {
    const R = 6371000;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) *
            Math.cos(toRad(lat2)) *
            Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

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

/* ────────────────── Persistence ────────────────── */

/** Single storage key holding the whole serializable room snapshot. */
const STATE_STORAGE_KEY = "room:v1";

/**
 * The room state mirrored to Durable Object storage (v932). Maps are stored
 * as entry arrays so the blob is plain JSON. Live sockets (`conns`) and
 * ephemeral proximity data (`lastPos`) are deliberately excluded — they
 * re-establish when clients reconnect.
 */
interface PersistedRoom {
    game: GameState;
    tokens: [string, { participantId: string; deviceId: string }][];
    deviceToParticipant: [string, string][];
    hidingZone: HidingZoneShare | null;
    deckState: DeckStateShare | null;
    roundProgress?: RoundProgressShare | null;
    pushSubscriptions: [string, PushSubscriptionData][];
    /** When the room last went idle (0 conns) — persisted so eviction timing
     *  survives a DO memory eviction between alarm ticks. */
    idleSince?: number | null;
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

    /**
     * The hide team's SHARED card economy (v831 Track 2). Like `hidingZone`,
     * held OUTSIDE `this.game` — it's a secret from seekers, delivered only
     * to hide-team connections and never in the wholesale snapshot. Any
     * hider may push a new state (they all share one deck); the server
     * relays it to the other hiders. Cleared on each new round.
     */
    private deckState: DeckStateShare | null = null;

    /**
     * v942 (durability): the HIDER's scored-time ledger + pause-clock state.
     * Held OUTSIDE `GameState` like `deckState` — the hider owns it and pushes
     * on every change; relayed to the OTHER hiders + persisted, so the running
     * SCORE survives that hider's device dying. Cleared each round.
     */
    private roundProgress: RoundProgressShare | null = null;

    /** Per-participant Web Push subscriptions. Keyed by participant id. */
    private pushSubscriptions: Map<string, PushSubscriptionData> = new Map();

    /**
     * Unix ms the room last went to ZERO connections (null while someone is
     * connected). Drives idle eviction — persisted so it survives the DO
     * being evicted from memory between alarm ticks (otherwise it reset to
     * "now" on every re-instantiation and the room never evicted). v940.
     */
    private idleSince: number | null = null;

    /** True once the persisted snapshot has been restored (or confirmed
     *  absent) — set inside the constructor's blockConcurrencyWhile so no
     *  request is served against un-hydrated state. */
    private hydrated = false;

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
        // v932: restore the room from Durable Object storage BEFORE any
        // request runs. `blockConcurrencyWhile` gates the input so a
        // resume/host/join can't race the load. A DO can be evicted from
        // memory seconds after its last socket closes; this is what lets a
        // room survive the host briefly backgrounding/closing the app.
        this.state.blockConcurrencyWhile(async () => {
            await this.hydrateFromStorage();
        });
    }

    /**
     * Load the persisted room snapshot into memory. No-op (fresh room) when
     * nothing is stored yet. Live sockets can't be restored — every
     * participant is marked offline until it reconnects.
     */
    private async hydrateFromStorage() {
        try {
            const stored = await this.state.storage.get<PersistedRoom>(
                STATE_STORAGE_KEY,
            );
            if (stored && stored.game) {
                this.game = stored.game;
                this.tokens = new Map(stored.tokens ?? []);
                this.deviceToParticipant = new Map(
                    stored.deviceToParticipant ?? [],
                );
                this.hidingZone = stored.hidingZone ?? null;
                this.deckState = stored.deckState ?? null;
                this.roundProgress = stored.roundProgress ?? null;
                this.pushSubscriptions = new Map(
                    stored.pushSubscriptions ?? [],
                );
                this.idleSince = stored.idleSince ?? null;
                // A cold isolate has no live sockets — everyone is offline
                // until their client reconnects and re-attaches.
                for (const p of this.game.participants) p.online = false;
            }
        } catch (e) {
            console.error("[GameRoom] hydrate failed", e);
        } finally {
            this.hydrated = true;
        }
    }

    /**
     * Mirror the current room state to Durable Object storage. Fire-and-
     * forget is safe: the DO output gate keeps the isolate alive until the
     * write flushes, so a `void this.persist()` after a mutation is durable
     * even if the socket closes immediately after. Wrapped in try/catch so a
     * storage hiccup degrades to in-memory-only rather than breaking the
     * game. `conns`/`lastPos` are intentionally NOT persisted (live sockets
     * + ephemeral proximity data — both re-establish on reconnect).
     */
    private async persist() {
        if (!this.hydrated) return;
        try {
            const snapshot: PersistedRoom = {
                game: this.game,
                tokens: [...this.tokens],
                deviceToParticipant: [...this.deviceToParticipant],
                hidingZone: this.hidingZone,
                deckState: this.deckState,
                roundProgress: this.roundProgress,
                pushSubscriptions: [...this.pushSubscriptions],
                idleSince: this.idleSince,
            };
            await this.state.storage.put(STATE_STORAGE_KEY, snapshot);
        } catch (e) {
            console.error("[GameRoom] persist failed", e);
        }
    }

    /** Wipe the persisted snapshot (room ended / idle-evicted). */
    private async clearPersisted() {
        try {
            await this.state.storage.delete(STATE_STORAGE_KEY);
        } catch {
            /* ignore */
        }
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

        // A socket is connecting — clear the idle marker and (re)schedule
        // the alarm for whatever the room now needs.
        this.idleSince = null;
        await this.scheduleAlarm();

        return new Response(null, { status: 101, webSocket: client });
    }

    /* ────────────────── Alarm: location ticks + idle eviction ────────── */

    /** True while a round is LIVE (clock armed, not yet found). */
    private roomIsActive(): boolean {
        const endsAt = this.game.setup.hidingPeriodEndsAt;
        return (
            endsAt != null &&
            Number.isFinite(endsAt) &&
            this.game.roundFoundAt == null
        );
    }

    /**
     * Set the DO alarm to the SOONER of two needs (v940):
     *   - The seeking-phase location tick — so reminders escalate even when
     *     every player's app is closed (no message activity to ride on).
     *     Before seeking starts it's a single alarm at the seeking-start
     *     instant; during seeking it re-arms every ALARM_TICK_MS.
     *   - Idle eviction — `idleSince + IDLE_EVICTION_MS` while nobody's
     *     connected.
     * Deletes the alarm when neither applies. Idempotent; called on every
     * connection change + state-changing message, and re-called by `alarm()`.
     */
    private async scheduleAlarm() {
        const now = Date.now();
        const times: number[] = [];
        if (this.roomIsActive()) {
            const endsAt = this.game.setup.hidingPeriodEndsAt as number;
            times.push(now >= endsAt ? now + ALARM_TICK_MS : endsAt);
        }
        if (this.conns.size === 0) {
            times.push((this.idleSince ?? now) + IDLE_EVICTION_MS);
        }
        if (times.length === 0) {
            await this.state.storage.deleteAlarm();
            return;
        }
        await this.state.storage.setAlarm(Math.min(...times));
    }

    async alarm() {
        const now = Date.now();
        // Escalate seeker-location reminders (no-op outside seeking). This is
        // the whole point of the alarm-driven check: it fires even when every
        // player is offline, so a pocketed seeker still gets pushed.
        this.checkLocationReminders();
        // Idle for the full window with nobody connected → tear the room down
        // and drop its persisted snapshot so a late stray connection can't
        // resurrect a dead room.
        if (
            this.conns.size === 0 &&
            now - (this.idleSince ?? now) >= IDLE_EVICTION_MS
        ) {
            this.game.participants = [];
            this.tokens.clear();
            this.deviceToParticipant.clear();
            this.hidingZone = null;
            this.deckState = null;
            this.roundProgress = null;
            this.pushSubscriptions.clear();
            this.locLastAt.clear();
            this.locReminderSent.clear();
            await this.clearPersisted();
            await this.state.storage.deleteAlarm();
            return;
        }
        // Keep the schedule alive for the next tick / eviction deadline.
        await this.scheduleAlarm();
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
        this.game.setup.hidingPeriodEndsAt = null;
        this.locLastAt.clear();
        this.locReminderSent.clear();
        void this.clearPersisted();
        // Room is dead — stop the alarm from ticking an empty room.
        void this.state.storage.deleteAlarm();
    }

    /**
     * Messages that don't change persisted room state — high-frequency
     * heartbeats and ephemeral proximity pings. Everything else mutates the
     * roster / setup / questions / secrets and triggers a storage write.
     */
    private static readonly EPHEMERAL_MSG = new Set<ClientMessage["t"]>([
        "ping",
        "loc",
        "hiderLoc",
    ]);

    private dispatch(socket: WebSocket, msg: ClientMessage) {
        this.dispatchInner(socket, msg);
        // v932: persist after any state-changing message so the room
        // survives a memory eviction. Fire-and-forget (output-gate-safe).
        // v940: also re-schedule the alarm — a state change (game armed,
        // round found/rotated) shifts what the alarm needs to do next.
        if (!GameRoom.EPHEMERAL_MSG.has(msg.t)) {
            void this.persist();
            void this.scheduleAlarm();
        }
        // v940: opportunistically escalate seeker-location reminders on
        // message activity too (belt-and-braces with the alarm tick).
        this.checkLocationReminders();
    }

    private dispatchInner(socket: WebSocket, msg: ClientMessage) {
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
                return this.handleMarkFound(socket, msg.foundAt, msg.force);
            case "roundSummary":
                return this.handleRoundSummary(
                    socket,
                    msg.baseMs,
                    msg.bonusPieces,
                );
            case "rotateHider":
                return this.handleRotateHider(socket, msg.to, msg.coHiders);
            case "setHideZone":
                return this.handleSetHideZone(socket, msg.zone);
            case "setDeck":
                return this.handleSetDeck(socket, msg.deck);
            case "setRoundProgress":
                return this.handleSetRoundProgress(socket, msg.progress);
            case "setName":
                return this.handleSetName(socket, msg.displayName);
            case "setLocationTracking":
                return this.handleSetLocationTracking(socket, msg.external);
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
            case "hiderLoc":
                return this.handleHiderLocation(
                    socket,
                    msg.lat,
                    msg.lng,
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
        // reconnecting hider, otherwise a hider who reloads or drops
        // connection loses the zone view for the rest of the round (it's
        // only otherwise pushed on a fresh role claim / commit).
        if (existing && existing.role === "hider") {
            this.sendTo(socket, { t: "hideZone", zone: this.hidingZone });
            this.sendTo(socket, { t: "deck", deck: this.deckState });
            this.sendTo(socket, {
                t: "roundProgress",
                progress: this.roundProgress,
            });
        }
        this.broadcastPresence();
    }

    private handleSetRole(socket: WebSocket, role: Role | null) {
        const conn = this.lookupConn(socket);
        if (!conn) return;
        const p = this.game.participants.find((q) => q.id === conn.participantId);
        if (!p) return;
        // v829: the hide team is a unit of equal `hider`s — no more "max 1
        // hider" limit and no `coHider` role. Coerce a stale client still
        // sending "coHider" (deploy-window race) to "hider".
        const effRole: Role | null =
            (role as string) === "coHider" ? "hider" : role;
        p.role = effRole;
        this.broadcastPresence();
        // A freshly-claimed hider joins the hide team mid-round — hand them
        // the current zone so they can watch/act on the hide right away
        // (the inbox rebuilds from the snapshot they already got).
        if (effRole === "hider") {
            this.sendTo(socket, { t: "hideZone", zone: this.hidingZone });
            this.sendTo(socket, { t: "deck", deck: this.deckState });
            this.sendTo(socket, {
                t: "roundProgress",
                progress: this.roundProgress,
            });
        }
    }

    private handleSetHideZone(
        socket: WebSocket,
        zone: HidingZoneShare | null,
    ) {
        const conn = this.lookupConn(socket);
        if (!conn) return;
        const p = this.game.participants.find((q) => q.id === conn.participantId);
        // v829: ANY hider may commit/change the zone (the hide team is one
        // unit). Ignore seekers so they can't spoof the hide.
        if (!p || p.role !== "hider") return;
        this.hidingZone = zone;
        // Fan out to every OTHER hider — never to seekers (the zone is the
        // secret they're deducing) and not back to the sender (that would
        // echo their own commit, risking a client-side sync loop; the
        // sender already has the value locally).
        for (const [pid, c] of this.conns.entries()) {
            if (pid === conn.participantId) continue;
            const cp = this.game.participants.find((q) => q.id === pid);
            if (cp?.role === "hider") {
                this.sendTo(c.socket, { t: "hideZone", zone });
            }
        }
    }

    /**
     * A hider pushed the shared card economy (v831 Track 2). Store it and
     * fan it to every OTHER hider — never to seekers (the hand is secret),
     * and not back to the sender (they already hold it locally; echoing
     * would risk a client sync loop). Mirrors `handleSetHideZone`.
     */
    private handleSetDeck(socket: WebSocket, deck: DeckStateShare) {
        const conn = this.lookupConn(socket);
        if (!conn) return;
        const p = this.game.participants.find(
            (q) => q.id === conn.participantId,
        );
        if (!p || p.role !== "hider") return;
        this.deckState = deck;
        for (const [pid, c] of this.conns.entries()) {
            if (pid === conn.participantId) continue;
            const cp = this.game.participants.find((q) => q.id === pid);
            if (cp?.role === "hider") {
                this.sendTo(c.socket, { t: "deck", deck });
            }
        }
    }

    /**
     * A hider pushed their scored-time ledger + pause state (v942). Store it,
     * persist it, and fan it to every OTHER hider — never to seekers. This is
     * what makes the running SCORE durable against that hider's device dying.
     * Mirrors `handleSetDeck`.
     */
    private handleSetRoundProgress(
        socket: WebSocket,
        progress: RoundProgressShare,
    ) {
        const conn = this.lookupConn(socket);
        if (!conn) return;
        const p = this.game.participants.find(
            (q) => q.id === conn.participantId,
        );
        if (!p || p.role !== "hider") return;
        if (!progress || typeof progress !== "object") return;
        this.roundProgress = progress;
        for (const [pid, c] of this.conns.entries()) {
            if (pid === conn.participantId) continue;
            const cp = this.game.participants.find((q) => q.id === pid);
            if (cp?.role === "hider") {
                this.sendTo(c.socket, { t: "roundProgress", progress });
            }
        }
    }

    /** A participant renamed themselves. De-dupe against the roster and
     *  broadcast presence so every device shows the new name. */
    private handleSetName(socket: WebSocket, displayName: string) {
        const conn = this.lookupConn(socket);
        if (!conn) return;
        const p = this.game.participants.find(
            (q) => q.id === conn.participantId,
        );
        if (!p) return;
        const trimmed = (displayName ?? "").trim();
        if (!trimmed) return;
        p.displayName = this.uniqueDisplayName(trimmed, p.id);
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
        // v935: Web Push any OFFLINE seeker so a locked/backgrounded phone
        // learns the answer arrived. The in-app `qAnswered` → notify() only
        // fires when the tab is visible, so without this a seeker with the
        // screen off got nothing (the reported bug). Mirrors the hide-team
        // push on a new question.
        this.state.waitUntil(
            this.pushToOfflineRole("seeker", {
                title: "Answer received",
                body: "The hider answered your question — open the app to see the result.",
                tag: `answer-${key}`,
            }),
        );
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

    private handleMarkFound(
        socket: WebSocket,
        foundAt: number,
        force?: boolean,
    ) {
        const conn = this.lookupConn(socket);
        if (!conn) return;
        // First-write-wins: don't allow the seeker to move the
        // round-end timestamp after the hider has acknowledged it.
        if (this.game.roundFoundAt !== null) return;
        // Proximity soft-check (rulebook p43 — the seeker must physically be
        // with the hider). Unless forced (the seeker already dismissed the
        // "are you sure?" warning), if the marker's last GPS is well away from
        // the NEAREST hider's last GPS, don't end — reply `foundFar` so the
        // seeker gets a soft warning and re-sends with force. Degrades to
        // "allow" whenever either side's position is missing/stale (can't
        // verify → don't block; friends game). The hider's coordinate never
        // leaves the server, so no distance is leaked to the seeker.
        if (!force && this.markFoundIsTooFar(conn.participantId)) {
            return this.sendTo(socket, { t: "foundFar", foundAt });
        }
        this.game.roundFoundAt = foundAt;
        this.broadcast({ t: "ended", foundAt });
    }

    /**
     * True only when we can AFFIRMATIVELY tell the marking seeker is far from
     * every hider: the seeker has a fresh position, at least one hider has a
     * fresh position, and the seeker is farther than the threshold from the
     * nearest hider. Missing/stale data on either side returns false (allow).
     */
    private markFoundIsTooFar(seekerId: string): boolean {
        const now = Date.now();
        const seeker = this.lastPos.get(seekerId);
        if (!seeker || now - seeker.ts > FOUND_POS_STALE_MS) return false;
        let sawFreshHider = false;
        let nearest = Infinity;
        for (const p of this.game.participants) {
            if (p.role !== "hider") continue;
            const hp = this.lastPos.get(p.id);
            if (!hp || now - hp.ts > FOUND_POS_STALE_MS) continue;
            sawFreshHider = true;
            const d = haversineMetersServer(
                seeker.lat,
                seeker.lng,
                hp.lat,
                hp.lng,
            );
            if (d < nearest) nearest = d;
        }
        if (!sawFreshHider) return false; // can't verify → allow
        return nearest > FOUND_PROXIMITY_METERS;
    }

    /**
     * Hider → server ONLY: store the hider's live GPS for the `found`
     * proximity check. NEVER fanned to anyone (the position is the game's
     * secret); it only feeds `markFoundIsTooFar`.
     */
    private handleHiderLocation(
        socket: WebSocket,
        lat: number,
        lng: number,
        ts: number,
    ) {
        const conn = this.lookupConn(socket);
        if (!conn) return;
        const p = this.game.participants.find(
            (q) => q.id === conn.participantId,
        );
        if (!p || p.role !== "hider") return;
        if (
            typeof lat !== "number" ||
            typeof lng !== "number" ||
            typeof ts !== "number" ||
            !Number.isFinite(lat) ||
            !Number.isFinite(lng) ||
            !Number.isFinite(ts)
        ) {
            return;
        }
        const prev = this.lastLocTs.get(conn.participantId) ?? 0;
        if (ts <= prev) return;
        this.lastLocTs.set(conn.participantId, ts);
        this.lastPos.set(conn.participantId, { lat, lng, ts });
    }

    /**
     * A hider published its authoritative round result (base + in-hand
     * bonus). Fan it to everyone ELSE so the seeker's end-of-round dialog +
     * leaderboard match and the bonus tallies up. Hider-only (the value is
     * meaningless from a seeker); not persisted — it's a per-round display
     * relay, cleared implicitly on the next round.
     */
    private handleRoundSummary(
        socket: WebSocket,
        baseMs: number,
        bonusPieces: number[],
    ) {
        const conn = this.lookupConn(socket);
        if (!conn) return;
        const p = this.game.participants.find(
            (q) => q.id === conn.participantId,
        );
        if (!p || p.role !== "hider") return;
        if (!Number.isFinite(baseMs) || !Array.isArray(bonusPieces)) return;
        const pieces = bonusPieces
            .filter((n) => Number.isFinite(n) && n > 0)
            .slice(0, 32);
        for (const [pid, c] of this.conns.entries()) {
            if (pid === conn.participantId) continue;
            this.sendTo(c.socket, {
                t: "roundSummary",
                baseMs,
                bonusPieces: pieces,
            });
        }
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
        if (!sender || (sender.role !== "hider"))
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
        if (!sender || (sender.role !== "hider"))
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
        return this.pushToOfflineRole("hider", payload);
    }

    /**
     * v940: seeker-location freshness escalation. Called opportunistically on
     * message activity (the hider's ~25 s ping keeps it running while the
     * game is live). During the SEEKING phase, for each seeker that's gone
     * stale (no `loc` for 5 / 10 min) AND is offline, push a reminder so a
     * backgrounded phone gets nudged. The eventual PAUSE is client-side on the
     * hider (`LocationPauseWatcher`, 15 min); this only handles the pushes,
     * which the hider's device can't send. Synchronous; schedules each push
     * via `waitUntil`. No-op outside seeking.
     */
    /**
     * Any participant toggles "seekers are tracking location externally"
     * (v940). Stands down the location-freshness enforcement room-wide: the
     * server stops sending reminders (gated in `checkLocationReminders`) and
     * every client drops the banner + clock pause off the synced setup flag.
     */
    private handleSetLocationTracking(socket: WebSocket, external: boolean) {
        const conn = this.lookupConn(socket);
        if (!conn) return;
        if (typeof external !== "boolean") return;
        this.game.setup.locationTrackingExternal = external;
        // Turning it back ON re-arms a clean slate so reminders don't
        // immediately re-fire off the pre-existing staleness.
        if (!external) {
            this.locReminderSent.clear();
            const now = Date.now();
            for (const p of this.game.participants) {
                if (p.role === "seeker") this.locLastAt.set(p.id, now);
            }
        }
        this.broadcast({ t: "setupChanged", setup: this.game.setup });
    }

    private checkLocationReminders() {
        // Stood down — the seekers are tracking location by other means.
        if (this.game.setup.locationTrackingExternal) return;
        const endsAt = this.game.setup.hidingPeriodEndsAt;
        if (endsAt == null || !Number.isFinite(endsAt)) return;
        const now = Date.now();
        if (now < endsAt) return; // still in the hiding period
        if (this.game.roundFoundAt != null) return; // round already over
        for (const p of this.game.participants) {
            if (p.role !== "seeker") continue;
            // Only nudge a seeker who's actually AWAY (offline). An online
            // seeker sees the in-app banner; a backgrounded PWA drops to
            // offline within seconds, so by 5 min stale a pocketed phone is
            // offline here.
            if (p.online) continue;
            // Staleness baseline: last loc we received, or seeking-start
            // (endsAt) if this seeker never shared — so a seeker who never
            // turns location on still escalates.
            const baseline = Math.max(this.locLastAt.get(p.id) ?? 0, endsAt);
            const stale = now - baseline;
            if (stale < LOC_REMINDER_1_MS) continue;
            const sent = this.locReminderSent.get(p.id) ?? {
                r1: false,
                r2: false,
            };
            if (stale >= LOC_REMINDER_2_MS && !sent.r2) {
                sent.r1 = true;
                sent.r2 = true;
                this.locReminderSent.set(p.id, sent);
                this.state.waitUntil(
                    this.pushToParticipant(p.id, {
                        title: "Share your location",
                        body: "The hider still can't see you — open the app now, or the game pauses in 5 minutes.",
                        tag: "loc-reminder",
                    }),
                );
            } else if (stale >= LOC_REMINDER_1_MS && !sent.r1) {
                sent.r1 = true;
                this.locReminderSent.set(p.id, sent);
                this.state.waitUntil(
                    this.pushToParticipant(p.id, {
                        title: "Share your location",
                        body: "The hider can't see your location — open the app to keep sharing.",
                        tag: "loc-reminder",
                    }),
                );
            }
        }
    }

    /** Web Push to ONE participant (if offline with a stored subscription).
     *  Used by the location-freshness reminders. */
    private async pushToParticipant(
        pid: string,
        payload: { title: string; body: string; tag: string },
    ) {
        const sub = this.pushSubscriptions.get(pid);
        if (!sub) return;
        const vapidKeysStr = (this.env as { VAPID_KEYS?: string }).VAPID_KEYS;
        const vapidPublicKey = (this.env as { VAPID_PUBLIC_KEY?: string })
            .VAPID_PUBLIC_KEY;
        if (!vapidKeysStr || !vapidPublicKey) return;
        const vapidKeys = parseVapidKeys(vapidKeysStr);
        if (!vapidKeys) return;
        const result = await sendWebPush(
            sub,
            payload,
            vapidKeys,
            vapidPublicKey,
            "mailto:karl.mj.andersson@gmail.com",
        );
        if (result === "gone") this.pushSubscriptions.delete(pid);
    }

    /** Web Push `payload` to every OFFLINE participant with the given role
     *  (a role's online members already got the WebSocket broadcast). The
     *  seeker variant (v935) is what notifies a locked/backgrounded seeker
     *  that the hider answered their question — the in-app `notify()` only
     *  fires when the tab is visible, so without this a seeker with the phone
     *  in their pocket got nothing when the answer arrived. */
    private async pushToOfflineRole(
        roleWanted: Role,
        payload: { title: string; body: string; tag: string },
    ) {
        const vapidKeysStr = (this.env as { VAPID_KEYS?: string }).VAPID_KEYS;
        const vapidPublicKey = (this.env as { VAPID_PUBLIC_KEY?: string })
            .VAPID_PUBLIC_KEY;
        if (!vapidKeysStr || !vapidPublicKey) return;
        const vapidKeys = parseVapidKeys(vapidKeysStr);
        if (!vapidKeys) return;
        for (const [pid, sub] of this.pushSubscriptions.entries()) {
            const p = this.game.participants.find((q) => q.id === pid);
            if (!p || p.role !== roleWanted || p.online) continue;
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

    /**
     * Last known position per participant (seekers via `loc`, hiders via the
     * private `hiderLoc`). Feeds ONLY the `found` proximity soft-check
     * (`markFoundIsTooFar`); hider entries are never fanned anywhere.
     */
    private lastPos: Map<string, { lat: number; lng: number; ts: number }> =
        new Map();

    /**
     * v940: seeker-location freshness escalation. `locLastAt` is the SERVER's
     * receive time of each seeker's last `loc` (skew-immune); `locReminderSent`
     * tracks which of the two reminder pushes we've already sent this stale
     * episode. Once a seeker goes stale (no `loc`), the server pushes a
     * reminder at 5 min and again at 10 min so a BACKGROUNDED phone actually
     * gets nudged (the in-app banner can't reach a suspended page). The
     * eventual PAUSE stays client-authoritative on the hider (15 min). Both
     * maps are ephemeral (reset on reload / round rotate), like `lastPos`.
     */
    private locLastAt: Map<string, number> = new Map();
    private locReminderSent: Map<string, { r1: boolean; r2: boolean }> =
        new Map();
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
        // Remember the position for the `found` proximity check (the seeker's
        // side of it). Fanned to the hide team below as usual.
        this.lastPos.set(conn.participantId, { lat, lng, ts });
        // v940: this seeker is fresh again — reset the freshness clock (server
        // receive time) + clear any reminders sent this stale episode.
        this.locLastAt.set(conn.participantId, Date.now());
        this.locReminderSent.delete(conn.participantId);
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
            if (p.role !== "hider") continue;
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
    private handleRotateHider(
        socket: WebSocket,
        toId: string,
        coHiderIds?: string[],
    ) {
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
        // Assign roles for the new round: the target is the PRIMARY hider,
        // any additional selected members become co-hiders (v826 multi-hider
        // support), and everyone else seeks. This covers the old hider
        // (demoted), any racing second hider, and anyone still unassigned
        // (role null) — the whole picked set hides, everyone else seeks, in
        // a single pass. v829: every picked member is an equal `hider` (no
        // more main/co distinction); `to` + `coHiders` are unioned.
        const hiders = new Set<string>([toId, ...(coHiderIds ?? [])]);
        for (const p of this.game.participants) {
            p.role = hiders.has(p.id) ? "hider" : "seeker";
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
        // New round → fresh shared deck; the hide team reshuffles locally
        // (roundStarted → resetHiderRoundState) and pushes it as they draw.
        this.deckState = null;
        // v942: fresh round → drop the scored-time ledger; the new hider's
        // client resets it and pushes as it accrues.
        this.roundProgress = null;
        // Per-participant location-update timestamps are per-round
        // (the next round's clocks restart). Without clearing, a
        // stale prev > new ts could swallow the new round's first
        // GPS broadcast.
        this.lastLocTs.clear();
        this.lastPos.clear();
        // v940: reset the location-reminder escalation for the new round.
        this.locLastAt.clear();
        this.locReminderSent.clear();
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
            // Mark idle so the alarm can eventually evict; tokens stay around
            // until then so a quick reconnect can reattach. Persist the
            // marker so eviction timing survives the DO being evicted from
            // memory between alarm ticks.
            this.idleSince = Date.now();
            void this.persist();
        }
        // (Re)schedule the alarm for whatever the room needs next — during
        // an active round it keeps ticking for location reminders even with
        // everyone now offline; otherwise it counts down to eviction.
        void this.scheduleAlarm();
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
