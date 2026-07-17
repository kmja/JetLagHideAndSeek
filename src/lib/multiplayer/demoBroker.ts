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
import { mapGeoLocation, questions } from "@/lib/context";
import {
    allowedTransit,
    gameSize,
    hidingPeriodEndsAt,
    playArea,
} from "@/lib/gameSetup";
import { playerRole } from "@/lib/hiderRole";
import { resetCurseState } from "@/lib/roundReset";

/* ────────────────── Tunables ────────────────── */

const DEMO_GAME_CODE = "DEMO00";
const HIDER_ANSWER_DELAY_MS = 1500;
const SEEKER_LOC_INTERVAL_MS = 10_000;

// Bot names are picked at boot from the shared Jet Lag roster via
// pickUniqueName(), so they never collide with each other or with the
// human player's chosen name.

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
    // Mirror the player's ACTUAL wizard choices (like `hostPushSetup`
    // does) — NOT a hardcoded default. The old hardcoded
    // `["bus","train","tram","subway"]` + `"medium"` clobbered the
    // wizard's transit/size the instant the demo's `welcome` snapshot was
    // applied, so e.g. a New York game whose wizard set train+subway+tram
    // gained bus the moment it started.
    return {
        playArea: playArea.get() ?? null,
        allowedTransit: allowedTransit.get(),
        gameSize: gameSize.get(),
        hidingPeriodEndsAt: hidingPeriodEndsAt.get(),
        endgameStartedAt: null,
        endgameConfirmedAt: null,
        mapGeoLocation: mapGeoLocation.get(),
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
    /**
     * Resume an existing demo after an auto-update reload (v777): seed the
     * rebuilt broker's questions from the persisted `questions` atom (so the
     * welcome snapshot doesn't wipe them via applySnapshot) instead of
     * starting empty. Set only by `resumeDemoGameIfPersisted`.
     */
    resume?: boolean;
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
        // On resume, carry the persisted questions so the welcome snapshot
        // (applySnapshot does `questions.set(incoming)`) restores them
        // instead of wiping them — and so the bots know about pending ones.
        questions: opts.resume
            ? (questions.get() as unknown as GameState["questions"])
            : [],
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

/**
 * Rebuild an in-progress demo after an auto-update reload (v777). The bot
 * broker + roster live only in memory, so a reload drops them; but the game
 * itself (play area, role, questions, hiding clock, curses) is in persistent
 * atoms. If `demoMode` is persisted true and the demo isn't already running,
 * re-arm the broker + bots from that state (`resume:true` seeds the persisted
 * questions so the welcome snapshot doesn't wipe them). Returns true if a
 * demo was (or already is) active. If the persisted state is too incomplete
 * to resume (no role / no play area), it clears `demoMode` so the app doesn't
 * sit in a broken "demo flag on, no transport" state.
 */
export function resumeDemoGameIfPersisted(): boolean {
    if (isDemoActive()) return true;
    if (!demoMode.get()) return false;
    const role = playerRole.get();
    const area = playArea.get();
    if (!role || !area) {
        stopDemoGame();
        return false;
    }
    const asRole: "seeker" | "hider" =
        role === "hider" ? "hider" : "seeker";
    startDemoGame({ asRole, resume: true });
    return true;
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
            // v829: the hide team is a unit of equal hiders — no "max 1
            // hider" demotion anymore. Coerce a stale "coHider" to "hider".
            if (me) {
                me.role =
                    (msg.role as string) === "coHider"
                        ? "hider"
                        : msg.role;
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

        case "setDeck": {
            // v831 Track 2: the shared hider deck. In the demo the user is
            // the only hider, so there's no teammate to fan it to — nothing
            // to echo. Accepting the message keeps the broker from logging
            // an "unknown message" and mirrors the real worker's store-only
            // behaviour for a single-hider room.
            return;
        }

        case "roundSummary": {
            // v851: the hider's authoritative base+bonus round result. In the
            // demo the user is the only hider, so there's no seeker to relay
            // it to — the local device already set its own atoms. Store-only
            // no-op, matching the real worker's "fan to others" behaviour.
            return;
        }

        case "setName": {
            // The local player renamed themselves. Update the demo roster
            // + echo presence so the lobby reflects the new name.
            const trimmed = (msg.displayName ?? "").trim();
            if (trimmed) {
                const me = s.state.participants.find(
                    (p) => p.id === s.userId,
                );
                if (me) me.displayName = trimmed;
                broadcastPresence();
            }
            return;
        }

        case "setLocationTracking":
            // v940: the local atom was already flipped by
            // `setLocationTrackingExternal` before the send; single-device
            // demo has no peers to relay to, so nothing else to do.
            return;

        case "castCurse": {
            // Hider cast a curse from the local app — echo it as the
            // broker would (every seeker would receive it). The user
            // is the only seeker on this device, so the local notify()
            // path runs through the inbound curseReceived handler.
            if (msg.curse) inject({ t: "curseReceived", curse: msg.curse });
            return;
        }

        case "rotateHider": {
            // Apply the role reassignment so the demo reflects the new
            // round's hide team, then broadcast presence so the bridge
            // reconciles the local role. v829: the whole picked set
            // (`to` + `coHiders`) are equal hiders; everyone else seeks.
            const hiders = new Set<string>([
                msg.to,
                ...(msg.coHiders ?? []),
            ]);
            for (const p of s.state.participants) {
                p.role = hiders.has(p.id) ? "hider" : "seeker";
            }
            // Reset the per-round SERVER state so the NEXT round can end.
            // Without this, `s.state.roundFoundAt` kept round 1's timestamp,
            // so round 2's `found` hit the `roundFoundAt === null` guard,
            // never injected `ended`, and the timer ticked forever (the
            // "can't mark found on round 2" bug). Mirror the fields a real
            // round-rotate clears.
            s.state.roundFoundAt = null;
            s.state.setup.endgameStartedAt = null;
            s.state.setup.endgameConfirmedAt = null;
            broadcastPresence();
            return;
        }

        case "loc":
        case "hiderLoc":
        case "ping":
        case "subscribePush":
            // Acknowledged silently. The demo doesn't need any of
            // these to drive a useful test surface. (`hiderLoc` feeds the
            // real server's found proximity check; the single-hider demo has
            // no seeker to range-check, so it's a no-op — `found` just ends.)
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

    // (Removed v747) The bot hider no longer auto-casts curses on a loop —
    // it spammed the seeker during demos. To exercise the curse UI, use the
    // debug panel's "Cast test curse" action (DebugPhaseControls), which
    // injects a curse into `receivedCurses` on demand.
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
