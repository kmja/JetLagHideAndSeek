/**
 * In-browser mock GameRoom + scripted bots for the demo-game mode.
 *
 * The real multiplayer transport is replaced by an in-memory broker so
 * the developer can exercise host-join-question-answer-curse flows on a
 * single device without running the worker. The broker mirrors just
 * enough of `worker/GameRoom.ts` to drive the client correctly:
 *
 *   - A roster of synthetic participants (1 bot hider + 2 bot seekers
 *     by default; the user takes whichever role they pick).
 *   - A questions array, mutated by `addQ` / `updateQ` / `answerQ`.
 *   - Setup state from the host's `start` message.
 *   - Welcome / snapshot / qAdded / qAnswered / presence / loc /
 *     curseReceived broadcasts.
 *
 * Scripted bot behaviour:
 *   - **Bot hider**: auto-answers every seeker question after a small
 *     delay by stamping `drag:false` on the question's data. Casts a
 *     curse on the seekers every ~90 s.
 *   - **Bot seekers**: send a `loc` update every ~10 s (jittered
 *     around a fixed point near the play area) so the hider's
 *     "seeker positions" UI lights up.
 *
 * Everything routes through `transport.attachMock` + `transport.inject`,
 * so the bridge layer (`store.ts`) sees the demo as an open WebSocket
 * with a friendly server on the other end.
 */

import { pickUniqueName } from "@protocol/index";
import type {
    ClientMessage,
    CursePayload,
    GameState,
    Participant,
    ServerMessage,
    SetupState,
} from "@protocol/index";

import { getTransport } from "./transport";
import {
    currentGameCode,
    demoMode,
    displayName,
    multiplayerEnabled,
    participants as participantsAtom,
    selfParticipantId,
    sessionToken,
} from "./session";
import { playArea } from "@/lib/gameSetup";
import { playerRole } from "@/lib/hiderRole";
import { resetCurseState } from "@/lib/roundReset";

/* ────────────────── Tunables ────────────────── */

const DEMO_GAME_CODE = "DEMO00";
const HIDER_ANSWER_DELAY_MS = 1500;
const SEEKER_LOC_INTERVAL_MS = 10_000;
const CURSE_INTERVAL_MS = 90_000;

// Bot names are picked at boot from the shared Jet Lag roster via
// pickUniqueName(), so they never collide with each other or with the
// human player's chosen name.

const SAMPLE_CURSES: CursePayload[] = [
    {
        name: "Curse of the Polyglot",
        description:
            "For the next 10 minutes, every seeker must speak only in a language they don't fluently know.",
        castingCost: "Discard 2 cards",
    },
    {
        name: "Curse of the Tourist",
        description:
            "Each seeker must take a selfie at the nearest tourist landmark before they may continue.",
        castingCost: "Discard 1 card",
    },
    {
        name: "Curse of the Carb Master",
        description:
            "Seekers must consume a carb-heavy meal (>500 cal) before the next question.",
        castingCost: "Discard 1 card",
    },
];

/* ────────────────── Broker state ────────────────── */

interface BrokerState {
    userId: string;
    hiderId: string;
    seekerIds: string[];
    state: GameState;
    /** Roster snapshot; ids → role/online for fast lookups. */
    timers: number[];
    /** Pending answer schedules so we can cancel on teardown. */
    answerTimers: Map<number, number>;
}

let _state: BrokerState | null = null;

function uid(): string {
    return crypto.randomUUID();
}

function defaultSetup(): SetupState {
    const area = playArea.get();
    return {
        playArea: area ?? null,
        allowedTransit: ["bus", "train", "tram", "subway"],
        gameSize: "medium",
        hidingPeriodEndsAt: null,
        endgameStartedAt: null,
        endgameConfirmedAt: null,
        mapGeoLocation: null,
    };
}

/* ────────────────── Public entry points ────────────────── */

export interface StartDemoOptions {
    /**
     * Role the user wants to play. The bots fill the others — pick
     * `seeker` (default) and a bot hider awaits your questions; pick
     * `hider` and bot seekers will ping locations + ask questions.
     */
    asRole: "seeker" | "hider";
    /** Display name shown in the roster. Defaults to the persistent atom. */
    userName?: string;
}

/**
 * Boot a demo game. Replaces the real transport with the in-memory
 * broker, builds the roster, and starts the bot loops. Idempotent —
 * a second call tears down the prior demo first.
 */
export function startDemoGame(opts: StartDemoOptions) {
    stopDemoGame();
    // v701: a fresh demo game must start curse-free. The curse atoms are
    // persistent (localStorage), and the demo boot path never went through
    // `resetSharedRoundState`, so curses from a PREVIOUS game reappeared the
    // instant `CurseInbox` mounted ("two curses firing right away").
    resetCurseState();
    const transport = getTransport();
    const name = (opts.userName ?? displayName.get() ?? "").trim() || "You";

    const userId = uid();
    const hiderId = uid();
    // Two bot seekers fill out the roster alongside the bot hider.
    const seekerIds = [uid(), uid()];

    const now = Date.now();
    const userRole = opts.asRole;
    const botHiderRole = userRole === "hider" ? "seeker" : "hider";

    // Assign unique cast names to every bot, avoiding the human's name
    // and each other — no two participants share a name in the roster.
    const taken: string[] = [name];
    const nextBotName = () => {
        const n = pickUniqueName(taken);
        taken.push(n);
        return n;
    };
    const hiderName = nextBotName();
    const seekerNames = seekerIds.map(() => nextBotName());

    const roster: Participant[] = [
        {
            id: userId,
            displayName: name,
            role: userRole,
            joinedAt: now,
            online: true,
        },
        {
            id: hiderId,
            displayName: hiderName,
            role: botHiderRole,
            joinedAt: now + 1,
            online: true,
        },
        ...seekerIds.map<Participant>((id, i) => ({
            id,
            displayName: seekerNames[i],
            role: "seeker",
            joinedAt: now + 2 + i,
            online: true,
        })),
    ];

    const gameState: GameState = {
        code: DEMO_GAME_CODE,
        createdAt: now,
        setup: defaultSetup(),
        questions: [],
        roundFoundAt: null,
        participants: roster,
    };

    _state = {
        userId,
        hiderId,
        seekerIds,
        state: gameState,
        timers: [],
        answerTimers: new Map(),
    };

    demoMode.set(true);
    multiplayerEnabled.set(true);
    currentGameCode.set(DEMO_GAME_CODE);
    displayName.set(name);
    sessionToken.set(`demo-${userId}`);
    // Pre-set the local role to the demo role so the bridge's
    // reconciliation on welcome sees `prev === me.role` and skips
    // the navigation / reset path.
    playerRole.set(userRole);

    transport.attachMock(handleClientMessage);

    // Issue the welcome message synchronously — the bridge layer
    // reacts as if a real server had just confirmed the join.
    queueMicrotask(() => {
        transport.inject({
            t: "welcome",
            sessionToken: `demo-${userId}`,
            self: { id: userId },
            state: gameState,
        });
        // Bot hider's first curse — give the user a beat to settle in.
        scheduleBotLoops();
    });
}

/** Tear down the demo, restoring a clean offline state. */
export function stopDemoGame() {
    if (!_state) return;
    for (const id of _state.timers) window.clearInterval(id);
    for (const id of _state.answerTimers.values()) window.clearTimeout(id);
    _state = null;
    const transport = getTransport();
    transport.detachMock();
    demoMode.set(false);
    multiplayerEnabled.set(false);
    currentGameCode.set(null);
    sessionToken.set(null);
    selfParticipantId.set(null);
    participantsAtom.set([]);
    // Leaving the demo clears its curses too, so a subsequent real game
    // doesn't inherit them from the persistent atoms.
    resetCurseState();
}

/** True if the demo broker is currently driving the transport. */
export function isDemoActive(): boolean {
    return _state !== null;
}

/* ────────────────── Client → broker dispatch ────────────────── */

function handleClientMessage(msg: ClientMessage) {
    const s = _state;
    if (!s) return;

    switch (msg.t) {
        case "host":
        case "join":
        case "resume":
            // Already welcomed at startup; ignore replays.
            return;

        case "role": {
            const me = s.state.participants.find((p) => p.id === s.userId);
            if (me) me.role = msg.role;
            // If the user just took the hider seat, demote the bot hider
            // to seeker so the "max 1 hider" invariant holds.
            if (msg.role === "hider") {
                const bot = s.state.participants.find((p) => p.id === s.hiderId);
                if (bot && bot.role === "hider") bot.role = "seeker";
            }
            broadcastPresence();
            return;
        }

        case "start": {
            s.state.setup = msg.setup;
            inject({ t: "setupChanged", setup: msg.setup });
            return;
        }

        case "addQ": {
            // Seeker-side question. Echo it as `qAdded` (the bridge layer
            // expects the same broadcast even for its own sends, but its
            // merge is idempotent so this is a no-op there), then schedule
            // the bot hider's auto-answer.
            const q = msg.question as { key?: number; id?: string; data?: Record<string, unknown> };
            if (typeof q?.key !== "number") return;
            // UPSERT by key — matches the real worker's handleAddQuestion.
            // A re-send (e.g. a thermometer going started → finished) must
            // REPLACE the stored copy, not push a duplicate. The old push
            // left two same-key entries; the bot then auto-answered the
            // FIRST (stale "started") one, reverting the question to an
            // "active, completed" thermometer.
            const exIdx = s.state.questions.findIndex(
                (raw) => (raw as { key?: number })?.key === q.key,
            );
            if (exIdx >= 0) s.state.questions[exIdx] = msg.question;
            else s.state.questions.push(msg.question);
            inject({ t: "qAdded", question: msg.question });
            // Don't auto-answer a thermometer that's still running — it
            // isn't a real question until the seeker finishes the move.
            const isStartedTherm =
                q?.id === "thermometer" &&
                (q.data as { status?: string })?.status === "started";
            if (!isStartedTherm) scheduleBotAnswer(q.key);
            return;
        }

        case "updateQ": {
            const idx = s.state.questions.findIndex(
                (raw) => (raw as { key?: number })?.key === msg.key,
            );
            if (idx < 0) return;
            const merged = mergeQuestionData(s.state.questions[idx], msg.data);
            s.state.questions[idx] = merged;
            inject({ t: "qUpdated", key: msg.key, question: merged });
            return;
        }

        case "answerQ": {
            const idx = s.state.questions.findIndex(
                (raw) => (raw as { key?: number })?.key === msg.key,
            );
            if (idx < 0) return;
            const merged = mergeQuestionData(s.state.questions[idx], {
                ...msg.answer,
                drag: false,
            });
            s.state.questions[idx] = merged;
            inject({ t: "qAnswered", key: msg.key, question: merged });
            return;
        }

        case "found": {
            if (s.state.roundFoundAt === null) {
                s.state.roundFoundAt = msg.foundAt;
                inject({ t: "ended", foundAt: msg.foundAt });
            }
            return;
        }

        case "startEndgame": {
            if (s.state.setup.endgameStartedAt === null) {
                s.state.setup.endgameStartedAt = msg.at;
                s.state.setup.endgameConfirmedAt = null;
                inject({ t: "setupChanged", setup: s.state.setup });
            }
            return;
        }

        case "cancelEndgame": {
            if (s.state.setup.endgameStartedAt !== null) {
                s.state.setup.endgameStartedAt = null;
                s.state.setup.endgameConfirmedAt = null;
                inject({ t: "setupChanged", setup: s.state.setup });
            }
            return;
        }

        case "confirmEndgame": {
            if (
                s.state.setup.endgameStartedAt !== null &&
                s.state.setup.endgameConfirmedAt == null
            ) {
                s.state.setup.endgameConfirmedAt = Date.now();
                inject({ t: "setupChanged", setup: s.state.setup });
            }
            return;
        }

        case "setHideZone": {
            // Hider committed a zone. In the real worker this fans out
            // to co-hiders only; in the demo we have no co-hiders, so
            // we just echo the broker's awareness via a presence ping
            // (so the user-as-hider UI confirms the round is "armed").
            broadcastPresence();
            return;
        }

        case "castCurse": {
            // Hider cast a curse from the local app — echo it as the
            // broker would (every seeker would receive it). The user
            // is the only seeker on this device, so the local notify()
            // path runs through the inbound curseReceived handler.
            if (msg.curse) inject({ t: "curseReceived", curse: msg.curse });
            return;
        }

        case "loc":
        case "ping":
        case "subscribePush":
        case "rotateHider":
        case "promoteCoHider":
            // Acknowledged silently. The demo doesn't need any of
            // these to drive a useful test surface.
            return;
    }
}

/* ────────────────── Bot loops ────────────────── */

function scheduleBotLoops() {
    const s = _state;
    if (!s) return;
    const me = s.state.participants.find((p) => p.id === s.userId);
    if (!me) return;

    // Bot seekers ping their location periodically. Only meaningful
    // when the user is a hider (they're the recipient of `loc`
    // broadcasts) but harmless otherwise — the bridge layer's `loc`
    // handler just updates the seekerLocations atom either way.
    const area = s.state.setup.playArea;
    if (area) {
        const tick = () => {
            const state = _state;
            if (!state) return;
            for (let i = 0; i < state.seekerIds.length; i++) {
                const id = state.seekerIds[i];
                const jitter = 0.0025 * (i + 1);
                inject({
                    t: "loc",
                    participantId: id,
                    lat: area.lat + (Math.random() - 0.5) * jitter,
                    lng: area.lng + (Math.random() - 0.5) * jitter,
                    accuracy: 15 + Math.random() * 20,
                    ts: Date.now(),
                });
            }
        };
        // Immediate first tick + interval.
        tick();
        s.timers.push(window.setInterval(tick, SEEKER_LOC_INTERVAL_MS));
    }

    // Bot hider casts a curse on a slow loop. Only fires when the
    // user is a seeker (otherwise the hider seat is held by the user,
    // not the bot, and the curse path runs through the user's local
    // CastCurseDialog instead).
    if (me.role === "seeker") {
        let curseIdx = 0;
        const id = window.setInterval(() => {
            if (!_state) return;
            const curse = SAMPLE_CURSES[curseIdx % SAMPLE_CURSES.length];
            curseIdx++;
            inject({ t: "curseReceived", curse });
        }, CURSE_INTERVAL_MS);
        s.timers.push(id);
    }
}

function scheduleBotAnswer(key: number) {
    const s = _state;
    if (!s) return;
    const me = s.state.participants.find((p) => p.id === s.userId);
    if (!me || me.role !== "seeker") return; // Only auto-answer for the user as seeker.

    const existing = s.answerTimers.get(key);
    if (existing) window.clearTimeout(existing);
    const timer = window.setTimeout(() => {
        const state = _state;
        if (!state) return;
        const idx = state.state.questions.findIndex(
            (raw) => (raw as { key?: number })?.key === key,
        );
        if (idx < 0) return;
        // Guard: never auto-answer a thermometer still in its "started"
        // phase (its finished re-send hasn't landed yet) — answering it
        // would revert it to an "active, completed" thermometer.
        const cur = state.state.questions[idx] as {
            id?: string;
            data?: { status?: string };
        };
        if (
            cur?.id === "thermometer" &&
            cur.data?.status === "started"
        ) {
            state.answerTimers.delete(key);
            return;
        }
        const merged = mergeQuestionData(state.state.questions[idx], {
            drag: false,
        });
        state.state.questions[idx] = merged;
        inject({ t: "qAnswered", key, question: merged });
        state.answerTimers.delete(key);
    }, HIDER_ANSWER_DELAY_MS);
    s.answerTimers.set(key, timer);
}

/* ────────────────── Helpers ────────────────── */

function mergeQuestionData(raw: unknown, patch: Record<string, unknown>): unknown {
    if (raw === null || typeof raw !== "object") return raw;
    const q = raw as { data?: Record<string, unknown> } & Record<string, unknown>;
    return {
        ...q,
        data: { ...(q.data ?? {}), ...patch },
    };
}

function broadcastPresence() {
    const s = _state;
    if (!s) return;
    inject({ t: "presence", participants: [...s.state.participants] });
}

function inject(msg: ServerMessage) {
    getTransport().inject(msg);
}
