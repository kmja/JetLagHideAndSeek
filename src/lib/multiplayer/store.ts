/**
 * Bridge between the multiplayer transport and the existing local
 * nanostores (`questions`, `hiderInbox`, `roundFoundAt`, the setup
 * atoms). Two-directional:
 *
 *   1. **Outbound** — the seeker / hider verbs in the rest of the
 *      app keep using their existing entry points (`addQuestion`,
 *      etc.). The bridge module exposes thin wrappers
 *      (`seekerAddQuestion`, `hiderAnswerQuestion`, etc.) that
 *      *both* write the local store *and* send a wire message
 *      when `multiplayerEnabled` is true. The wrappers are no-ops
 *      on the wire when offline, so local-only games still work.
 *
 *   2. **Inbound** — the transport's `message` event drives store
 *      writes here. All merges are idempotent (keyed by
 *      `question.key` / `entry.key`), so a re-broadcast of a
 *      message we initiated locally doesn't double-apply.
 *
 * The bridge installs itself exactly once, lazily — see
 * `installMultiplayerBridge()` at the bottom.
 */

import { questions, addQuestion as localAddQuestion, questionModified } from "@/lib/context";
import {
    allowedTransit,
    gameSize,
    hidingPeriodEndsAt,
    playArea,
} from "@/lib/gameSetup";
import { hiderInbox, roundFoundAt } from "@/lib/hiderRole";
import {
    questionSchema,
    type Question,
    type Questions,
} from "@/maps/schema";

import { PROTOCOL_VERSION } from "@protocol/index";

import {
    currentGameCode,
    displayName,
    getDeviceId,
    multiplayerEnabled,
    multiplayerError,
    participants,
    selfParticipantId,
    sessionToken,
    transportStatus,
} from "./session";
import { getTransport } from "./transport";
import type { GameState, ServerMessage, SetupState } from "./types";

/* ────────────────── URL helpers ────────────────── */

/**
 * Resolve the multiplayer Worker URL from build-time env. Defaults
 * to the workers.dev subdomain the Wrangler config produces by
 * default; users can override via PUBLIC_MULTIPLAYER_URL in their
 * Astro env file.
 */
export function getMultiplayerOrigin(): string {
    // Vite exposes anything prefixed with PUBLIC_ — Astro convention.
    const fromEnv =
        (import.meta as { env?: Record<string, string | undefined> }).env
            ?.PUBLIC_MULTIPLAYER_URL ?? null;
    if (fromEnv && typeof fromEnv === "string" && fromEnv.length > 0) {
        return fromEnv.replace(/\/+$/, "");
    }
    // Production default for Kalle's deployed Worker. Overridable
    // via PUBLIC_MULTIPLAYER_URL (e.g. for local dev against
    // `wrangler dev`).
    return "https://jlhs-multiplayer.karl-mj-andersson.workers.dev";
}

function wsUrlForCode(code: string): string {
    const origin = getMultiplayerOrigin();
    // http(s) → ws(s)
    const ws = origin.replace(/^http/, "ws");
    return `${ws}/games/${code}/ws`;
}

/* ────────────────── Connection lifecycle ────────────────── */

/**
 * Create a brand-new room on the server. Returns the 6-char code on
 * success. The caller is expected to then call `joinAsHost(code)` to
 * actually connect (we keep the two steps separate so the UI can
 * surface the code briefly without committing to a connection).
 */
export async function createGame(): Promise<string> {
    const origin = getMultiplayerOrigin();
    const resp = await fetch(`${origin}/games`, { method: "POST" });
    if (resp.status === 429) {
        // Rate-limited by the Worker (per-IP cap on room creation).
        // Surface the server's friendly message if it provided one,
        // else fall back to a generic phrasing.
        let serverMessage: string | null = null;
        try {
            const data = (await resp.json()) as { message?: string };
            serverMessage = data?.message ?? null;
        } catch {
            /* ignore — body wasn't JSON */
        }
        throw new Error(
            serverMessage ??
                "Too many games created from this device. Try again in a minute.",
        );
    }
    if (!resp.ok) {
        throw new Error(`Server refused new game (HTTP ${resp.status}).`);
    }
    const data = (await resp.json()) as { code: string };
    if (!data?.code) throw new Error("Server didn't return a game code.");
    return data.code;
}

/** Connect as the host of an already-created game code. */
export function joinAsHost(code: string, name: string) {
    displayName.set(name);
    multiplayerError.set(null);
    currentGameCode.set(code);
    multiplayerEnabled.set(true);
    const transport = getTransport();
    transport.connect(wsUrlForCode(code));
    transport.send({
        t: "host",
        v: PROTOCOL_VERSION,
        deviceId: getDeviceId(),
        displayName: name,
    });
}

/** Connect as a guest joining an existing room. */
export function joinAsGuest(code: string, name: string) {
    displayName.set(name);
    multiplayerError.set(null);
    currentGameCode.set(code);
    multiplayerEnabled.set(true);
    const transport = getTransport();
    transport.connect(wsUrlForCode(code));
    transport.send({
        t: "join",
        v: PROTOCOL_VERSION,
        code,
        deviceId: getDeviceId(),
        displayName: name,
    });
}

/**
 * Reattach to a room from a previous session. Called on page load
 * when persistent state shows we were in the middle of a game.
 */
export function tryResumeFromPersistent() {
    const code = currentGameCode.get();
    const token = sessionToken.get();
    if (!code || !token) return;
    if (!multiplayerEnabled.get()) return;
    const transport = getTransport();
    transport.connect(wsUrlForCode(code));
    transport.send({
        t: "resume",
        v: PROTOCOL_VERSION,
        code,
        deviceId: getDeviceId(),
        sessionToken: token,
    });
}

/** Drop the connection and clear session state. */
export function leaveGame() {
    const transport = getTransport();
    transport.close();
    multiplayerEnabled.set(false);
    currentGameCode.set(null);
    sessionToken.set(null);
    selfParticipantId.set(null);
    transportStatus.set("closed");
    participants.set([]);
}

/* ────────────────── Outbound verbs ────────────────── */

/**
 * Seeker-side add. The local store is the source of truth for
 * display; the wire send is fire-and-forget. The server's
 * idempotency by key means we can re-send safely if we ever wire up
 * a queued resend on reconnect.
 */
export function seekerAddQuestion(partial: Parameters<typeof localAddQuestion>[0]) {
    // Run the local logic first so the seeker's UI updates instantly.
    localAddQuestion(partial);
    if (!multiplayerEnabled.get()) return;
    const latest = questions.get()[questions.get().length - 1];
    if (!latest) return;
    getTransport().send({ t: "addQ", question: latest });
}

/**
 * Seeker-side mutation of an existing question (e.g. thermometer
 * finish flow that updates the same question in place). Sends an
 * `updateQ` message with the merged data.
 */
export function seekerUpdateQuestion(key: number, data: Record<string, unknown>) {
    // The caller is expected to have already mutated the local
    // store (existing thermometer flow does so directly). We just
    // notify peers.
    if (!multiplayerEnabled.get()) return;
    getTransport().send({ t: "updateQ", key, data });
}

/**
 * Hider's answer. Locally, the existing `markRepliedInInbox` flow
 * stamps `repliedAt` on the inbox entry. This wrapper additionally
 * sends the answer to the server so the seeker's `questions` store
 * gets `drag:false + answer` merged in.
 */
export function hiderAnswerQuestion(key: number, answer: Record<string, unknown>) {
    if (!multiplayerEnabled.get()) return;
    getTransport().send({ t: "answerQ", key, answer });
}

/** Seeker marks the hider found. Round-end ping. */
export function seekerMarkFound(foundAt: number) {
    if (!multiplayerEnabled.get()) return;
    getTransport().send({ t: "found", foundAt });
}

/**
 * Host pushes the local setup to peers after the wizard. Called
 * once from `GameSetupDialog.handleFinish()` when online mode is on.
 */
export function hostPushSetup() {
    if (!multiplayerEnabled.get()) return;
    const setup: SetupState = {
        playArea: playArea.get(),
        allowedTransit: allowedTransit.get(),
        gameSize: gameSize.get(),
        hidingPeriodEndsAt: hidingPeriodEndsAt.get(),
    };
    getTransport().send({ t: "start", setup });
}

/** Pick a role for *this* device within the current room. */
export function setOnlineRole(role: "seeker" | "hider" | null) {
    if (!multiplayerEnabled.get()) return;
    getTransport().send({ t: "role", role });
}

/* ────────────────── Inbound dispatch ────────────────── */

/**
 * Merge a server-broadcast question (added or answered) into both
 * the seeker's `questions` store and the hider's `hiderInbox`.
 * Idempotent by key — re-broadcasts (e.g. from our own send) don't
 * double-apply.
 */
function mergeIncomingQuestion(raw: unknown) {
    let parsed: Question;
    try {
        parsed = questionSchema.parse(raw);
    } catch {
        return; // Server schema drift or malformed — drop.
    }
    // Seeker side: upsert into `questions`.
    const current = questions.get();
    const idx = current.findIndex((q) => q.key === parsed.key);
    if (idx >= 0) {
        const next: Questions = [...current];
        next[idx] = parsed;
        questions.set(next);
    } else {
        questions.set([...current, parsed]);
    }
    // Hider side: upsert into the inbox. If already there, refresh
    // the data; if it carries an answer (drag:false + reply fields),
    // also stamp repliedAt.
    const inbox = hiderInbox.get();
    const ie = inbox.findIndex((e) => e.key === parsed.key);
    if (ie >= 0) {
        const next = [...inbox];
        const existing = next[ie];
        const dragFalse = (parsed.data as { drag?: boolean }).drag === false;
        next[ie] = {
            ...existing,
            data: parsed.data as Record<string, unknown>,
            ...(dragFalse && !existing.repliedAt
                ? { repliedAt: Date.now() }
                : {}),
        };
        hiderInbox.set(next);
    } else {
        hiderInbox.set([
            ...inbox,
            {
                key: parsed.key,
                id: parsed.id,
                data: parsed.data as Record<string, unknown>,
                arrivedAt: Date.now(),
            },
        ]);
    }
    questionModified();
}

/** Apply a server snapshot wholesale to the local stores. */
function applySnapshot(state: GameState) {
    // Setup
    if (state.setup.playArea) playArea.set(state.setup.playArea);
    allowedTransit.set(state.setup.allowedTransit);
    gameSize.set(state.setup.gameSize);
    hidingPeriodEndsAt.set(state.setup.hidingPeriodEndsAt);
    // Questions — merge by key, replacing existing entries.
    const incomingQs: Question[] = [];
    for (const raw of state.questions) {
        try {
            incomingQs.push(questionSchema.parse(raw));
        } catch {
            /* skip malformed */
        }
    }
    questions.set(incomingQs);
    questionModified();
    // Hider inbox — rebuild from questions, preserving local arrival timestamps
    // when possible (so the hider's "received N min ago" UI stays sensible).
    const prevInbox = hiderInbox.get();
    const prevByKey = new Map(prevInbox.map((e) => [e.key, e]));
    const nextInbox = incomingQs.map((q) => {
        const prev = prevByKey.get(q.key);
        const dragFalse = (q.data as { drag?: boolean }).drag === false;
        return {
            key: q.key,
            id: q.id,
            data: q.data as Record<string, unknown>,
            arrivedAt: prev?.arrivedAt ?? Date.now(),
            ...(dragFalse
                ? { repliedAt: prev?.repliedAt ?? Date.now() }
                : {}),
            ...(prev?.reply ? { reply: prev.reply } : {}),
        };
    });
    hiderInbox.set(nextInbox);
    // Round end
    roundFoundAt.set(state.roundFoundAt);
    // Presence
    participants.set(state.participants);
}

/** Dispatch a single inbound message. */
function handleServerMessage(msg: ServerMessage) {
    switch (msg.t) {
        case "welcome":
            sessionToken.set(msg.sessionToken);
            selfParticipantId.set(msg.self.id);
            applySnapshot(msg.state);
            return;
        case "snapshot":
            applySnapshot(msg.state);
            return;
        case "qAdded":
        case "qUpdated":
        case "qAnswered":
            mergeIncomingQuestion(msg.question);
            return;
        case "ended":
            if (roundFoundAt.get() === null) roundFoundAt.set(msg.foundAt);
            return;
        case "presence":
            participants.set(msg.participants);
            return;
        case "setupChanged":
            if (msg.setup.playArea) playArea.set(msg.setup.playArea);
            allowedTransit.set(msg.setup.allowedTransit);
            gameSize.set(msg.setup.gameSize);
            hidingPeriodEndsAt.set(msg.setup.hidingPeriodEndsAt);
            return;
        case "error":
            console.warn("[multiplayer] server error", msg);
            multiplayerError.set({ code: msg.code, message: msg.message });
            if (msg.code === "session_invalid") {
                // Drop back to local mode rather than spam reconnects.
                leaveGame();
            }
            return;
        case "pong":
            // No-op; latency tracking can hook in here later.
            return;
        default: {
            const _exhaustive: never = msg;
            void _exhaustive;
            console.warn("[multiplayer] unknown server message", msg);
        }
    }
}

/* ────────────────── Install ────────────────── */

/**
 * Wire the transport's events to the bridge handlers. Idempotent —
 * safe to call multiple times (subsequent calls are no-ops).
 */
let _installed = false;
export function installMultiplayerBridge() {
    if (_installed) return;
    _installed = true;
    const t = getTransport();
    t.on("message", handleServerMessage);
    t.on("status", (status) => transportStatus.set(status));
}
