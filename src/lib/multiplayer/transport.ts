/**
 * WebSocket transport for the multiplayer backend.
 *
 * Responsibilities:
 *
 *   - Open a connection to the GameRoom DO via /games/:code/ws.
 *   - Auto-reconnect with exponential backoff (250 ms → 8 s, capped).
 *   - Queue outbound messages while disconnected; flush on connect.
 *   - Surface inbound messages as typed events to subscribers.
 *   - 25 s ping cadence to keep middleboxes (mobile NAT, Cloudflare
 *     idle timeouts) from dropping the connection.
 *
 * Stays deliberately UI-agnostic — `session.ts` and `store.ts`
 * compose the higher-level "join a game" / "answer a question" verbs
 * on top.
 */

import type { ClientMessage, ServerMessage } from "@protocol/index";

export type TransportStatus = "idle" | "connecting" | "open" | "reconnecting" | "closed";

export interface TransportEvents {
    message: (msg: ServerMessage) => void;
    status: (status: TransportStatus) => void;
}

const PING_INTERVAL_MS = 25_000;
const RECONNECT_BASE_MS = 250;
const RECONNECT_MAX_MS = 8_000;
/**
 * After the tab resumes, a socket that still reads `readyState === OPEN` may
 * actually be a ZOMBIE — the OS killed it while backgrounded without firing a
 * `close` event, so the cached status stays "open" and nothing reconnects
 * (the reported "opened the app, won't reconnect"). On resume we send a ping
 * and, if no inbound traffic (the server's pong or anything else) arrives
 * within this window, treat the socket as dead and force a fresh connect.
 */
const LIVENESS_PROBE_MS = 4_000;

export class MultiplayerTransport {
    private url: string | null = null;
    private socket: WebSocket | null = null;
    private status: TransportStatus = "idle";
    private outbox: ClientMessage[] = [];

    private listeners: Map<
        keyof TransportEvents,
        Set<TransportEvents[keyof TransportEvents]>
    > = new Map();

    private reconnectAttempt = 0;
    private reconnectTimer: number | null = null;
    private pingTimer: number | null = null;
    /** Epoch ms of the last inbound message — the liveness signal a resume
     *  probe checks to unmask a zombie socket. */
    private lastInboundAt = 0;
    /** True while a resume liveness probe is awaiting its deadline, so
     *  repeated visibility events don't stack probes / double-reconnect. */
    private livenessProbePending = false;
    /** When true, manual close — don't auto-reconnect. */
    private closedByUser = false;
    /**
     * Demo / mock seam. When set, `connect()` skips the real WebSocket
     * and `send()` routes every outbound message to this callback
     * instead. Inbound messages are injected by the demo broker via
     * `inject()`. Used exclusively by the in-browser demo-game mode
     * (`src/lib/multiplayer/demoBroker.ts`) — production WebSocket
     * traffic never touches this path.
     */
    private mockSend: ((msg: ClientMessage) => void) | null = null;
    /**
     * Called on every auto-reconnect (not the first connect) to
     * produce the auth handshake that must go out before any queued
     * game messages. The store layer sets this to return a `resume`
     * message using the persisted session token. Without it, the
     * server sees game messages from an unidentified socket and
     * silently ignores them — the participant stays "offline" on
     * all other devices even after the socket reconnects.
     */
    private reconnectHandshake: (() => ClientMessage | null) | null = null;
    /**
     * Lifecycle listeners registered when a connection is active. We
     * cancel pending backoff and reconnect immediately whenever the
     * tab regains focus or the network comes back, since the
     * exponential backoff alone can leave a tab feeling "dropped"
     * for several seconds after the user returns from another app.
     */
    private lifecycleHandler: (() => void) | null = null;

    /**
     * Open the connection. If the transport is already open or
     * connecting, this becomes a no-op (call `close()` first to
     * point it at a different URL).
     */
    connect(url: string): void {
        // Demo mode: a broker has installed a mock sender; skip the
        // real WebSocket entirely and present as already-open.
        if (this.mockSend) {
            this.url = url;
            this.closedByUser = false;
            this.setStatus("open");
            return;
        }
        if (this.socket && (this.status === "open" || this.status === "connecting")) {
            if (this.url === url) return;
            this.close();
        }
        this.url = url;
        this.closedByUser = false;
        this.attachLifecycleListeners();
        this.openSocket();
    }

    /** Send a message. Queues if the socket isn't ready. */
    send(msg: ClientMessage): void {
        if (this.mockSend) {
            try {
                this.mockSend(msg);
            } catch (e) {
                console.warn("[multiplayer] mock sender threw", e);
            }
            return;
        }
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            try {
                this.socket.send(JSON.stringify(msg));
                return;
            } catch {
                /* fall through to enqueue */
            }
        }
        this.outbox.push(msg);
    }

    /** Manual close. Stops auto-reconnect until the next `connect()`. */
    close(): void {
        this.closedByUser = true;
        this.clearTimers();
        this.detachLifecycleListeners();
        if (this.socket) {
            try {
                this.socket.close(1000, "client closing");
            } catch {
                /* ignore */
            }
            this.socket = null;
        }
        if (this.mockSend) this.mockSend = null;
        this.setStatus("closed");
        this.outbox = [];
    }

    /* ────────────────── Demo / mock seam ────────────────── */

    /**
     * Install a mock sender. From now on `connect()` is a no-op (status
     * jumps straight to "open"), `send()` routes to `onSend` instead
     * of the wire, and `inject()` can be used to feed synthetic server
     * messages back through the same `message` event the bridge layer
     * already listens to. Used only by the demo-game mode.
     */
    attachMock(onSend: (msg: ClientMessage) => void): void {
        if (this.socket) {
            try {
                this.socket.close(1000, "demo mode");
            } catch {
                /* ignore */
            }
            this.socket = null;
        }
        this.clearTimers();
        this.outbox = [];
        this.mockSend = onSend;
        this.closedByUser = false;
        this.setStatus("open");
    }

    /** Tear down the mock seam. Status drops to closed. */
    detachMock(): void {
        if (!this.mockSend) return;
        this.mockSend = null;
        this.setStatus("closed");
    }

    /** Inject a synthetic server message into the bridge layer. */
    inject(msg: ServerMessage): void {
        this.emit("message", msg);
    }

    /** Register a callback that yields the re-auth message to send
     *  at the start of every auto-reconnect. Must be set before
     *  the first connect. Pass null to disable. */
    setReconnectHandshake(fn: (() => ClientMessage | null) | null): void {
        this.reconnectHandshake = fn;
    }

    /** Subscribe to a transport event. Returns an unsubscribe fn. */
    on<K extends keyof TransportEvents>(
        event: K,
        listener: TransportEvents[K],
    ): () => void {
        let set = this.listeners.get(event);
        if (!set) {
            set = new Set();
            this.listeners.set(event, set);
        }
        set.add(listener);
        return () => set?.delete(listener);
    }

    getStatus(): TransportStatus {
        return this.status;
    }

    /** Public "retry now" — force a fresh connection regardless of the
     *  cached status (used by the Reconnecting banner's manual button and
     *  any caller that wants to skip the backoff wait). */
    reconnect(): void {
        this.forceReconnect();
    }

    /* ────────────────── Internals ────────────────── */

    private openSocket() {
        if (!this.url) return;
        this.setStatus(
            this.reconnectAttempt > 0 ? "reconnecting" : "connecting",
        );
        let socket: WebSocket;
        try {
            socket = new WebSocket(this.url);
        } catch (e) {
            console.warn("[multiplayer] WebSocket constructor failed", e);
            this.scheduleReconnect();
            return;
        }
        this.socket = socket;
        // Generation guard: only the CURRENT socket's events act. Without
        // this, a superseded socket (closed by forceReconnect while a fresh
        // one is already connecting — e.g. the "Retry now" button firing
        // mid-connect) fires its delayed `close` and runs handleClose, which
        // nulls `this.socket` (now the NEW socket) and schedules a spurious
        // reconnect. The new socket then opens with `this.socket === null`, so
        // handleOpen's `this.socket?.send(resume)` is a NO-OP — the connection
        // opens (status flips to "open", banner hides) but the server never
        // gets the resume, so the device stays "offline" on every peer. (The
        // reported "Retry now → looks connected but shown offline" bug.)
        socket.addEventListener("open", () => {
            if (this.socket === socket) this.handleOpen();
        });
        socket.addEventListener("message", (evt) => {
            if (this.socket === socket) this.handleMessage(evt);
        });
        socket.addEventListener("close", () => {
            if (this.socket === socket) this.handleClose();
        });
        socket.addEventListener("error", () => {
            if (this.socket === socket) this.handleClose();
        });
    }

    private handleOpen() {
        const isReconnect = this.reconnectAttempt > 0;
        this.reconnectAttempt = 0;
        this.setStatus("open");
        // On auto-reconnect, the server doesn't know who we are yet
        // (the WebSocket is a new connection). Re-authenticate first
        // so the server re-registers us before any queued game
        // messages arrive. On the first connect the outbox already
        // contains the host/join/resume message, so no special case.
        const pending = [...this.outbox];
        this.outbox = [];
        if (isReconnect && this.reconnectHandshake) {
            const auth = this.reconnectHandshake();
            if (auth) {
                try {
                    this.socket?.send(JSON.stringify(auth));
                } catch {
                    /* ignore — close handler will retry */
                }
            }
        }
        for (const msg of pending) {
            try {
                this.socket?.send(JSON.stringify(msg));
            } catch {
                this.outbox.push(msg);
            }
        }
        // Start ping cadence so we notice silent NAT drops.
        this.startPings();
    }

    private handleMessage(evt: MessageEvent) {
        // Any inbound byte proves the socket is alive — the liveness probe
        // reads this to tell a real connection from a resumed zombie.
        this.lastInboundAt = Date.now();
        let msg: ServerMessage;
        try {
            const raw =
                typeof evt.data === "string"
                    ? evt.data
                    : new TextDecoder().decode(evt.data as ArrayBuffer);
            msg = JSON.parse(raw) as ServerMessage;
        } catch (e) {
            console.warn("[multiplayer] malformed message", e);
            return;
        }
        this.emit("message", msg);
    }

    private handleClose() {
        this.clearPings();
        this.socket = null;
        if (this.closedByUser) {
            this.setStatus("closed");
            return;
        }
        // Any close that wasn't user-initiated should keep retrying. The
        // old guard only rescheduled from "open"/"connecting", so a failed
        // RETRY (status "reconnecting") fell through to "closed" and the
        // exponential backoff died after attempt 1 — a >1 s blip stranded
        // the client offline until a visibility/online event happened to
        // fire reconnectNow(). scheduleReconnect() owns the backoff cap.
        this.scheduleReconnect();
    }

    /**
     * Cancel any pending backoff timer and reconnect immediately.
     * No-op if the socket is already open or if the user closed
     * the connection manually. Used by the visibility / online
     * listeners so a tab that's been backgrounded for minutes
     * doesn't have to wait through a full 8 s backoff window
     * before catching back up.
     */
    private reconnectNow(): void {
        if (this.closedByUser) return;
        if (this.status === "open" || this.status === "connecting") return;
        if (!this.url) return;
        // A connect attempt is already in flight (openSocket assigned
        // this.socket and is mid-handshake, status "reconnecting" with no
        // pending backoff timer). Opening another socket here would orphan
        // the first — its four listeners stay live and keep mutating shared
        // state. During the backoff WAIT this.socket is null, so we still
        // fall through and connect immediately, skipping the wait.
        if (this.socket !== null) return;
        if (this.reconnectTimer !== null) {
            window.clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        // Keep `reconnectAttempt > 0` so handleOpen treats this as a
        // reconnect (re-sends the handshake). Don't reset to 0.
        if (this.reconnectAttempt === 0) this.reconnectAttempt = 1;
        this.openSocket();
    }

    /**
     * Called when the tab resumes (visibility / online / pageshow). Ensures
     * we actually have a LIVE connection, not a zombie that reads OPEN but
     * was silently killed while backgrounded:
     *   - Not OPEN (null / connecting-stuck / closing / closed) → reconnect
     *     immediately (skips any backoff wait).
     *   - OPEN → send a ping and, if no inbound traffic arrives within
     *     LIVENESS_PROBE_MS, force a fresh connect. A real socket answers
     *     with a pong in well under that; a zombie never does.
     */
    private ensureLive(): void {
        if (this.closedByUser || !this.url) return;
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            // During a backoff WAIT this.socket is null → reconnect now.
            this.reconnectNow();
            return;
        }
        if (this.livenessProbePending) return;
        const probeAt = Date.now();
        try {
            this.socket.send(
                JSON.stringify({ t: "ping", ts: probeAt } as ClientMessage),
            );
        } catch {
            this.forceReconnect();
            return;
        }
        this.livenessProbePending = true;
        window.setTimeout(() => {
            this.livenessProbePending = false;
            if (this.closedByUser) return;
            // No inbound message since we probed → the socket is a zombie.
            if (this.lastInboundAt < probeAt) this.forceReconnect();
        }, LIVENESS_PROBE_MS);
    }

    /**
     * Drop the current socket (however it reads) and open a fresh one
     * immediately, preserving reconnect semantics so the re-auth handshake
     * is re-sent. Used when a resumed socket is proven dead.
     */
    private forceReconnect(): void {
        if (this.closedByUser || !this.url) return;
        if (this.socket) {
            try {
                this.socket.close(1000, "stale socket");
            } catch {
                /* ignore */
            }
            this.socket = null;
        }
        this.clearTimers();
        // Keep it a "reconnect" so handleOpen re-sends the resume handshake.
        if (this.reconnectAttempt === 0) this.reconnectAttempt = 1;
        this.openSocket();
    }

    private attachLifecycleListeners(): void {
        if (this.lifecycleHandler !== null) return;
        if (typeof window === "undefined") return;
        const handler = () => {
            // Visibility: only kick when the page comes BACK into focus.
            // Online: network just came back — reconnect even if hidden.
            if (
                document.visibilityState === "visible" ||
                (typeof navigator !== "undefined" && navigator.onLine)
            ) {
                this.ensureLive();
            }
        };
        this.lifecycleHandler = handler;
        document.addEventListener("visibilitychange", handler);
        window.addEventListener("online", handler);
        // `pageshow` covers bfcache restoration on mobile Safari,
        // which doesn't always fire visibilitychange.
        window.addEventListener("pageshow", handler);
    }

    private detachLifecycleListeners(): void {
        if (this.lifecycleHandler === null) return;
        if (typeof window === "undefined") return;
        document.removeEventListener("visibilitychange", this.lifecycleHandler);
        window.removeEventListener("online", this.lifecycleHandler);
        window.removeEventListener("pageshow", this.lifecycleHandler);
        this.lifecycleHandler = null;
    }

    private scheduleReconnect() {
        this.clearTimers();
        const attempt = ++this.reconnectAttempt;
        // 250 ms × 2^(attempt-1), capped, plus jitter to avoid
        // thundering-herd reconnects after a Worker hiccup.
        const exp = Math.min(
            RECONNECT_BASE_MS * 2 ** (attempt - 1),
            RECONNECT_MAX_MS,
        );
        const jitter = Math.random() * 250;
        const delay = exp + jitter;
        this.setStatus("reconnecting");
        this.reconnectTimer = window.setTimeout(() => {
            this.reconnectTimer = null;
            this.openSocket();
        }, delay);
    }

    private startPings() {
        this.clearPings();
        this.pingTimer = window.setInterval(() => {
            const now = Date.now();
            try {
                this.socket?.send(
                    JSON.stringify({ t: "ping", ts: now } as ClientMessage),
                );
            } catch {
                // Send threw → socket is dead. Force a fresh connect rather
                // than waiting for a `close` event that may never fire.
                this.forceReconnect();
                return;
            }
            // HEARTBEAT liveness (not just on resume): the server pongs every
            // ping, so if NO inbound arrives within the probe window the
            // socket is a ZOMBIE — reads OPEN but was silently killed (an iOS
            // background kill, or the DO evicted+reloaded and severed us
            // without firing `close`). Without this, a socket that dies while
            // the app stays FOREGROUNDED is never noticed (visibility/online
            // events don't fire), so we miss every broadcast — presence
            // updates AND questions — the reported "peer reconnected but this
            // device never sees it" desync. `ensureLive` covers the resume
            // case; this covers the always-foreground case.
            if (this.livenessProbePending) return;
            this.livenessProbePending = true;
            window.setTimeout(() => {
                this.livenessProbePending = false;
                if (this.closedByUser) return;
                if (
                    !this.socket ||
                    this.socket.readyState !== WebSocket.OPEN
                )
                    return;
                if (this.lastInboundAt < now) this.forceReconnect();
            }, LIVENESS_PROBE_MS);
        }, PING_INTERVAL_MS);
    }

    private clearPings() {
        if (this.pingTimer !== null) {
            window.clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
    }

    private clearTimers() {
        this.clearPings();
        if (this.reconnectTimer !== null) {
            window.clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    private setStatus(next: TransportStatus) {
        if (this.status === next) return;
        this.status = next;
        this.emit("status", next);
    }

    private emit<K extends keyof TransportEvents>(
        event: K,
        ...args: Parameters<TransportEvents[K]>
    ) {
        const set = this.listeners.get(event);
        if (!set) return;
        for (const l of set) {
            try {
                (l as (...a: typeof args) => void)(...args);
            } catch (e) {
                console.warn("[multiplayer] listener threw", e);
            }
        }
    }
}

/* ────────────────── Singleton ────────────────── */

/**
 * Module-level singleton — only one connection per browser tab. The
 * store / session layers above reach for this rather than newing up
 * their own.
 */
let _instance: MultiplayerTransport | null = null;
export function getTransport(): MultiplayerTransport {
    if (!_instance) _instance = new MultiplayerTransport();
    return _instance;
}
