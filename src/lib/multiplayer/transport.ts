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
    /** When true, manual close — don't auto-reconnect. */
    private closedByUser = false;
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
     * Open the connection. If the transport is already open or
     * connecting, this becomes a no-op (call `close()` first to
     * point it at a different URL).
     */
    connect(url: string): void {
        if (this.socket && (this.status === "open" || this.status === "connecting")) {
            if (this.url === url) return;
            this.close();
        }
        this.url = url;
        this.closedByUser = false;
        this.openSocket();
    }

    /** Send a message. Queues if the socket isn't ready. */
    send(msg: ClientMessage): void {
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
        if (this.socket) {
            try {
                this.socket.close(1000, "client closing");
            } catch {
                /* ignore */
            }
            this.socket = null;
        }
        this.setStatus("closed");
        this.outbox = [];
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

    /* ────────────────── Internals ────────────────── */

    private openSocket() {
        if (!this.url) return;
        this.setStatus(
            this.reconnectAttempt > 0 ? "reconnecting" : "connecting",
        );
        try {
            this.socket = new WebSocket(this.url);
        } catch (e) {
            console.warn("[multiplayer] WebSocket constructor failed", e);
            this.scheduleReconnect();
            return;
        }
        this.socket.addEventListener("open", () => this.handleOpen());
        this.socket.addEventListener("message", (evt) => this.handleMessage(evt));
        this.socket.addEventListener("close", () => this.handleClose());
        this.socket.addEventListener("error", () => this.handleClose());
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
        const wasOpen = this.status === "open" || this.status === "connecting";
        this.socket = null;
        if (this.closedByUser) {
            this.setStatus("closed");
            return;
        }
        if (wasOpen) this.scheduleReconnect();
        else this.setStatus("closed");
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
            try {
                this.socket?.send(
                    JSON.stringify({ t: "ping", ts: Date.now() } as ClientMessage),
                );
            } catch {
                /* ignore — close handler will retry */
            }
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
