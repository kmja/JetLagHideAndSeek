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

import { PROTOCOL_VERSION } from "@protocol/index";
import type { CursePayload } from "@protocol/index";

import { getStoredPushSubscription, notify } from "@/lib/notifications";

import { CATEGORIES } from "@/lib/categories";
import {
    addQuestion as localAddQuestion,
    additionalMapGeoLocations,
    disabledStations,
    mapGeoLocation,
    permanentOverlay,
    questionModified,
    questions,
} from "@/lib/context";
import type { OpenStreetMap } from "@/maps/api";
import {
    allowedTransit,
    gameSize,
    endgameConfirmedAt,
    endgameStartedAt,
    hidingPeriodEndsAt,
    playArea,
    resetMapOverlays,
} from "@/lib/gameSetup";
import {
    hiderInbox,
    hidingZone,
    playerRole,
    resetHiderRoundState,
    roundFoundAt,
} from "@/lib/hiderRole";
import {
    alternateQuestionTypes,
    askOncePerQuestion,
    zoneRadiusBuffer,
} from "@/lib/houseRules";
import { receivedCurses } from "@/lib/seekerInbound";
import {
    type Question,
    type Questions,
    questionSchema,
} from "@/maps/schema";

import {
    currentGameCode,
    demoMode,
    displayName,
    getDeviceId,
    localIsHost,
    multiplayerEnabled,
    multiplayerError,
    participants,
    seekerLocations,
    selfParticipantId,
    sessionToken,
    transportStatus,
} from "./session";
import { getTransport } from "./transport";
import { stopDemoGame } from "./demoBroker";
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

/**
 * True iff we're in an online game AND a participant with the
 * `hider` role is currently connected. Used by the seeker's share
 * flow to decide between sending via WebSocket (the hider will see
 * the question instantly) vs falling back to a share-link.
 *
 * Returns `false` when offline, when no hider has joined yet, or
 * when the hider joined but is currently disconnected — share-link
 * fallback covers all those cases.
 */
export function isHiderConnected(): boolean {
    if (!multiplayerEnabled.get()) return false;
    if (!currentGameCode.get()) return false;
    return participants
        .get()
        .some((p) => p.role === "hider" && p.online === true);
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
    // The bridge must be wired BEFORE we open the socket, otherwise the
    // transport's status/message events have no listener and the UI
    // never learns we connected. MultiplayerBoot installs it on the
    // seeker/hider routes, but the host/join flows can fire from the
    // /welcome route too (no MultiplayerBoot there) — so self-install
    // defensively. Idempotent.
    installMultiplayerBridge();
    displayName.set(name);
    multiplayerError.set(null);
    currentGameCode.set(code);
    multiplayerEnabled.set(true);
    // This device owns the room — the settings-edit authority. Survives
    // a server-side participant-id desync (see localIsHost docs).
    localIsHost.set(true);
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
    // Self-install the bridge first — the guest join flow lives on the
    // /welcome route, which doesn't mount MultiplayerBoot. Without this
    // the transport connects but its status/message events go nowhere:
    // the role-picker spinner sticks on "Working…" forever and the
    // server's welcome/snapshot/presence are all dropped. Idempotent.
    installMultiplayerBridge();
    displayName.set(name);
    multiplayerError.set(null);
    currentGameCode.set(code);
    multiplayerEnabled.set(true);
    // Guests are not the settings authority.
    localIsHost.set(false);
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
    // A LIVE demo is runtime-only but still writes the persistent
    // code/token atoms while it runs. MultiplayerBoot calls this on every
    // page mount, so navigating into the seeker/hider shell mid-demo would
    // otherwise hit the stale-demo wipe below and silently flip
    // `multiplayerEnabled` off — dropping the player back to offline send
    // (clipboard share, no bot answers). If the broker is still attached
    // (demoMode true), the demo is live: leave it completely alone. Only a
    // demo whose atoms survived a reload (demoMode false) is stale.
    if (demoMode.get()) return;
    const code = currentGameCode.get();
    const token = sessionToken.get();
    if (!code || !token) return;
    if (!multiplayerEnabled.get()) return;
    // Ensure the bridge is wired before reconnecting (it normally is —
    // MultiplayerBoot calls this AFTER installMultiplayerBridge — but
    // self-install keeps the invariant local to the connect verbs).
    installMultiplayerBridge();
    // Demo mode is runtime-only; a refreshed tab has no live broker to
    // resume against. Wipe the stale persistent atoms so the user lands
    // on the offline screen instead of bouncing off the real worker
    // with a fake "DEMO00" room code.
    if (token.startsWith("demo-") || code === "DEMO00") {
        multiplayerEnabled.set(false);
        currentGameCode.set(null);
        sessionToken.set(null);
        selfParticipantId.set(null);
        localIsHost.set(false);
        return;
    }
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
    // Demo broker owns its own timers; routing the teardown through it
    // ensures the bot loops stop alongside the transport.
    if (demoMode.get()) {
        stopDemoGame();
        return;
    }
    const transport = getTransport();
    transport.close();
    multiplayerEnabled.set(false);
    currentGameCode.set(null);
    sessionToken.set(null);
    selfParticipantId.set(null);
    localIsHost.set(false);
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
 * Re-push an EXISTING question to the multiplayer server (v347). The
 * server is idempotent by key (per seekerAddQuestion's comment) so
 * re-sending the same question is safe — a hider who didn't receive
 * the first `addQ` (offline at send time, app backgrounded mid-fetch,
 * etc.) gets a fresh copy on the next message. Returns true when the
 * resend was actually sent over the wire; false when multiplayer
 * isn't enabled or the question wasn't found locally.
 */
export function seekerResendQuestion(key: number): boolean {
    if (!multiplayerEnabled.get()) return false;
    const q = questions.get().find((x) => x.key === key);
    if (!q) return false;
    getTransport().send({ t: "addQ", question: q });
    return true;
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

/**
 * Upload a hider photo answer to the game's R2-backed store and return
 * its public URL. The image travels over HTTP (not the WebSocket), so it
 * can be multiple megabytes — full detail for the seekers — while only
 * the short URL rides the socket in the `answerQ` message. Throws on any
 * failure so the caller can fall back to an inline thumbnail.
 */
export async function uploadGamePhoto(blob: Blob): Promise<string> {
    const code = currentGameCode.get();
    if (!code) throw new Error("No active game to attach a photo to.");
    const origin = getMultiplayerOrigin();
    const resp = await fetch(`${origin}/games/${code}/photo`, {
        method: "POST",
        headers: { "content-type": blob.type || "image/jpeg" },
        body: blob,
    });
    if (resp.status === 413) {
        throw new Error("Photo too large to upload.");
    }
    if (!resp.ok) {
        throw new Error(`Photo upload failed (HTTP ${resp.status}).`);
    }
    const data = (await resp.json()) as { url?: string };
    if (!data?.url) throw new Error("Server didn't return a photo URL.");
    return data.url;
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
        endgameStartedAt: endgameStartedAt.get(),
        endgameConfirmedAt: endgameConfirmedAt.get(),
        // Ship the full Photon OSM feature so the hide team's
        // settings dialog can show the host's area instead of
        // its persisted Japan default. Half a KB on the wire,
        // sent on host-finished and on edit-saves only.
        mapGeoLocation: mapGeoLocation.get(),
        // Adjacent areas folded into the play area, so the hide team's
        // boundary matches the host's instead of being primary-only.
        adjacentLocations: additionalMapGeoLocations.get(),
        // Table-wide house rules — host-authoritative, so the whole room
        // plays by the same deviations (edited from the lobby).
        houseRules: {
            alternateQuestionTypes: alternateQuestionTypes.get(),
            askOncePerQuestion: askOncePerQuestion.get(),
            zoneRadiusBuffer: zoneRadiusBuffer.get(),
        },
    };
    getTransport().send({ t: "start", setup });
}

/**
 * Seeker → room: trigger the endgame phase (rulebook p43, "lock
 * down"). Stamps the local atom and pushes a wire message — the
 * server idempotently sets the canonical timestamp and broadcasts
 * setupChanged so hide-team devices surface the banner. Solo /
 * offline play just flips the local atom and relies on the
 * persistent store to keep the banner across reloads.
 */
export function seekerStartEndgame() {
    if (endgameStartedAt.get() !== null) return;
    const at = Date.now();
    endgameStartedAt.set(at);
    // A fresh claim starts unconfirmed — the hider responds next.
    endgameConfirmedAt.set(null);
    if (!multiplayerEnabled.get()) return;
    getTransport().send({ t: "startEndgame", at });
}

/**
 * Hider → room: confirm a seeker's endgame claim ("yes, you're in my
 * zone"). Stamps the local confirmed atom and tells the server, which
 * broadcasts so the seekers flip from "waiting" to "you're in the right
 * zone — find them". Solo / offline just flips the local atom (the
 * seeker is the same device, so this is mostly a no-op there).
 */
export function hiderConfirmEndgame() {
    if (endgameStartedAt.get() === null) return;
    if (endgameConfirmedAt.get() != null) return;
    endgameConfirmedAt.set(Date.now());
    if (!multiplayerEnabled.get()) return;
    getTransport().send({ t: "confirmEndgame" });
}

/**
 * Hider → room: refute a wrong endgame claim (rulebook p43 — the
 * endgame only begins when the seekers are actually in the hider's
 * zone, and the hider is the authority on that). Clears the local
 * stamp and tells the server, which resets the canonical timestamp
 * and broadcasts so the seekers' "endgame armed" UI reverts and they
 * keep searching. Solo / offline just flips the local atom back.
 */
export function hiderCancelEndgame() {
    if (endgameStartedAt.get() === null) return;
    endgameStartedAt.set(null);
    endgameConfirmedAt.set(null);
    if (!multiplayerEnabled.get()) return;
    getTransport().send({ t: "cancelEndgame" });
}

/**
 * Push the local seeker's GPS fix to the room. Per rulebook p5 the
 * hider sees every seeker's live location for the round; this is the
 * outbound side of that. The server forwards only to hide-team
 * participants. Fire-and-forget — no ack needed and a missed
 * broadcast just costs one stale "last seen" tick on the receiver.
 *
 * Caller is expected to be the seeker side (the `useSeekerLocation
 * Broadcast` hook checks `playerRole` and the user-facing share
 * toggle before invoking).
 */
export function seekerPushLocation(
    lat: number,
    lng: number,
    accuracy: number,
) {
    if (!multiplayerEnabled.get()) return;
    getTransport().send({
        t: "loc",
        lat,
        lng,
        accuracy,
        ts: Date.now(),
    });
}

/** Pick a role for *this* device within the current room. */
export function setOnlineRole(role: "seeker" | "hider" | null) {
    if (!multiplayerEnabled.get()) return;
    getTransport().send({ t: "role", role });
}

/**
 * Round-rotation: tell the server who the new hider should be. The
 * server clears the current hider's role and assigns hider to the
 * target participant, then broadcasts the new presence. Each
 * connected client's bridge picks up the role change on the
 * `presence` event and reconciles their local `playerRole` atom
 * via {@link reconcileLocalRoleFromPresence}, so the hider's app
 * automatically becomes the seeker's app (and vice versa) without
 * any extra client coordination.
 *
 * No-op offline — the dialog short-circuits to the local "Start
 * new round" path in that case.
 */
export function seekerRotateHider(toParticipantId: string) {
    if (!multiplayerEnabled.get()) return;
    getTransport().send({ t: "rotateHider", to: toParticipantId });
}

/**
 * Hand the main-hider seat to a co-hider. Sender must currently be
 * the hider; target must be a co-hider. Server validates both and
 * rejects with `bad_message` otherwise. On success, the next
 * presence broadcast carries the swapped roles and every client
 * reconciles its local `playerRole` from there.
 */
export function promoteCoHider(toParticipantId: string) {
    if (!multiplayerEnabled.get()) return;
    getTransport().send({ t: "promoteCoHider", to: toParticipantId });
}

/** Hider broadcasts a curse to all seekers in the room. */
export function hiderCastCurse(curse: CursePayload) {
    if (!multiplayerEnabled.get()) return;
    getTransport().send({ t: "castCurse", curse });
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
    const dat = parsed.data as Record<string, unknown>;
    if (dat.randomized === true && dat.randomizedAway !== true && idx >= 0) {
        // Randomize SPLIT (v597): the hider overwrote the original question
        // in place with the auto-answered substitute. Present BOTH in the
        // seeker's list: keep the ORIGINAL as asked (redirected away, no
        // answer, eliminates nothing) and add the SUBSTITUTE as a separate
        // answered entry. Idempotent — re-running on a re-send / snapshot
        // upserts the same two keys. Only possible while we still hold the
        // original locally (its subtype is gone from the wire payload); a
        // fresh reconnect with no local original falls through to the
        // single-entry behaviour below.
        const localOrig = current[idx];
        const subKey = parsed.key + 1000; // real keys ∈ [0,1) → no collision
        const originalEntry = {
            ...localOrig,
            data: {
                ...(localOrig.data as Record<string, unknown>),
                drag: false,
                randomized: true,
                randomizedAway: true,
            },
        } as Question;
        const subData = { ...dat };
        const fromLabel = subData.randomizedFrom;
        delete subData.randomized;
        delete subData.randomizedFrom;
        const substituteEntry = {
            ...parsed,
            key: subKey,
            data: {
                ...subData,
                randomized: false,
                ...(typeof fromLabel === "string"
                    ? { substituteFor: fromLabel }
                    : {}),
            },
        } as Question;
        const next: Questions = [...current];
        next[idx] = originalEntry;
        const subIdx = next.findIndex((q) => q.key === subKey);
        if (subIdx >= 0) next[subIdx] = substituteEntry;
        else next.push(substituteEntry);
        questions.set(next);
    } else if (idx >= 0) {
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

/**
 * Pull our local `playerRole` atom in line with what the server
 * thinks our role is. Called every time we receive a fresh
 * participants list (presence + snapshot + welcome). Without this
 * reconciliation, a server-initiated rotation (another player
 * promoted us, or demoted us) wouldn't show up in the local UI —
 * the role atom is what drives whether this device sees the seeker
 * map vs the hider home.
 *
 * Skips entirely if there's no selfId yet (pre-welcome) or if the
 * server doesn't know about us (transient drift right after a
 * resume — the next presence will fix it).
 */
function reconcileLocalRoleFromPresence(roster: GameState["participants"]) {
    const selfId = selfParticipantId.get();
    if (!selfId) return;
    const me = roster.find((p) => p.id === selfId);
    if (!me) return;
    // Server's authoritative role for us. `null` means "no role
    // assigned" — we don't override the local atom for that case;
    // the user might be in the role-picker UI deciding.
    if (me.role === null) return;
    const prev = playerRole.get();
    if (prev === me.role) return;
    // Role TRANSITION — fresh round elsewhere just promoted /
    // demoted us. Wipe per-device hider-side state (hiding zone,
    // hand, deck, discard, inbox, pendingDraw, roundFoundAt) so
    // a player switching out of the hider seat doesn't leave
    // stale data lying around AND a player switching INTO the
    // seat lands on a clean slate. Skip this on first role assignment
    // (prev === null) — that's the role-picker landing case.
    // Reset on any transition into OR out of a hide-team seat (hider or
    // coHider), so a demoted co-hider doesn't keep a stale hiding zone /
    // inbox and a freshly-promoted one lands clean — not just on hider
    // transitions.
    const wasHideTeam = prev === "hider" || prev === "coHider";
    const nowHideTeam = me.role === "hider" || me.role === "coHider";
    if (prev !== null && (wasHideTeam || nowHideTeam)) {
        resetHiderRoundState();
    }
    playerRole.set(me.role);
    // Navigate the affected device to the correct page. The seeker
    // app lives on `/`; the hider home on `/h`. Skip the navigation
    // on first role assignment (prev === null) — that path is the
    // initial RolePicker landing which already steers the user.
    if (prev !== null && typeof window !== "undefined") {
        const path = window.location.pathname;
        const onHider = path === "/h" || path.startsWith("/h/");
        const onSeeker =
            path === "/" || (!onHider && !path.startsWith("/h"));
        // Hider and co-hider both live on the hider surface (/h); the
        // co-hider just renders the read-only companion view there.
        if ((me.role === "hider" || me.role === "coHider") && !onHider) {
            window.location.assign("/h");
        } else if (me.role === "seeker" && !onSeeker) {
            window.location.assign("/");
        }
    }
}

/**
 * A new round began (server broadcast a `roundStarted`). Wipe every
 * round-scoped store on this device, regardless of whether our role
 * changed — this is the one signal a hider who keeps their role gets
 * that the round flipped. Core setup (play area, transit, game size)
 * is intentionally left untouched; it lives in the setup atoms and
 * carries across rounds.
 *
 * Distinct from `applySnapshot`, which also runs on reconnect: we
 * must NOT reset round state just because we reconnected, so the
 * reset lives here on the discrete round-start event only.
 */
function applyRoundStarted(roster: GameState["participants"]) {
    // Seeker-side round state.
    questions.set([]);
    questionModified();
    disabledStations.set([]);
    permanentOverlay.set(null);
    // Hider-side round state: hiding zone, spot, inbox, hand, deck,
    // discard, hand limit, pending draw, and the round-found marker.
    resetHiderRoundState();
    // Map overlays revert to default OFF for the new round.
    resetMapOverlays();
    // The hiding-period clock restarts per round; the seeker re-arms
    // it via the GO GO GO flow and pushes it back over `setupChanged`.
    hidingPeriodEndsAt.set(null);
    // Endgame flags are per-round — clear them so the new round doesn't
    // open with last round's lockdown banner stuck on.
    endgameStartedAt.set(null);
    endgameConfirmedAt.set(null);
    // Per-seeker live positions are scoped to the previous round —
    // the new round restarts the broadcast.
    seekerLocations.set({});
    // Apply the new roster + role assignments. Role-changers get
    // navigated to the right surface; same-role players are no-ops
    // here (we already reset their round state above).
    participants.set(roster);
    reconcileLocalRoleFromPresence(roster);
}

/**
 * Mirror the host's table-wide house rules onto the local toggle atoms.
 * Host-authoritative: a received setup overwrites whatever this device
 * had so the whole room plays by the same rules. No-op when the setup
 * predates house-rule sync (older deployments) — the device keeps its
 * local values.
 */
function applyHouseRules(hr: SetupState["houseRules"]) {
    if (!hr) return;
    alternateQuestionTypes.set(hr.alternateQuestionTypes);
    askOncePerQuestion.set(hr.askOncePerQuestion);
    zoneRadiusBuffer.set(hr.zoneRadiusBuffer);
}

/** Apply a server snapshot wholesale to the local stores. */
function applySnapshot(state: GameState) {
    // Setup
    if (state.setup.playArea) playArea.set(state.setup.playArea);
    allowedTransit.set(state.setup.allowedTransit);
    gameSize.set(state.setup.gameSize);
    hidingPeriodEndsAt.set(state.setup.hidingPeriodEndsAt);
    endgameStartedAt.set(state.setup.endgameStartedAt);
    endgameConfirmedAt.set(state.setup.endgameConfirmedAt ?? null);
    if (state.setup.mapGeoLocation) {
        mapGeoLocation.set(
            state.setup.mapGeoLocation as OpenStreetMap,
        );
    }
    if (Array.isArray(state.setup.adjacentLocations)) {
        // Mirror the host's folded-in neighbours so the hide team's
        // boundary covers the same area (not primary-only).
        additionalMapGeoLocations.set(
            state.setup
                .adjacentLocations as ReturnType<
                typeof additionalMapGeoLocations.get
            >,
        );
    }
    applyHouseRules(state.setup.houseRules);
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
    // Sync local role from server canonical roster — covers
    // rotation-initiated-elsewhere ("you are now the hider"),
    // initial welcome (server may know our prior role from a
    // resume), and snapshot replays.
    reconcileLocalRoleFromPresence(state.participants);
}

/** Dispatch a single inbound message. */
function handleServerMessage(msg: ServerMessage) {
    switch (msg.t) {
        case "welcome":
            sessionToken.set(msg.sessionToken);
            selfParticipantId.set(msg.self.id);
            applySnapshot(msg.state);
            // Claim our local role on the server side. The server
            // enforces "max 1 hider" — if the hider slot is already
            // taken our claim is rejected via `error: role_taken`
            // (handled in this same switch below) and we drop back
            // to seeker locally.
            {
                const local = playerRole.get();
                if (
                    local === "seeker" ||
                    local === "hider" ||
                    local === "coHider"
                ) {
                    getTransport().send({ t: "role", role: local });
                }
            }
            // Register push subscription so the server can reach us
            // when our tab is closed or suspended.
            {
                const sub = getStoredPushSubscription();
                if (
                    sub &&
                    typeof sub.endpoint === "string" &&
                    sub.keys &&
                    typeof sub.keys.p256dh === "string" &&
                    typeof sub.keys.auth === "string"
                ) {
                    getTransport().send({
                        t: "subscribePush",
                        subscription: {
                            endpoint: sub.endpoint,
                            expirationTime: sub.expirationTime ?? null,
                            keys: {
                                p256dh: sub.keys.p256dh,
                                auth: sub.keys.auth,
                            },
                        },
                    });
                }
            }
            return;
        case "snapshot":
            applySnapshot(msg.state);
            return;
        case "qAdded":
        case "qUpdated":
        case "qAnswered": {
            mergeIncomingQuestion(msg.question);
            // Heads-up to the user when something they care about
            // happened off-screen. `notify` self-gates on document
            // visibility, permission state, and the user opt-in,
            // so the calls below are safe even when the tab is
            // focused — they just no-op.
            const role = playerRole.get();
            const q = msg.question as { id?: string } | null;
            const label =
                (q && q.id && CATEGORIES[q.id as keyof typeof CATEGORIES]?.label) ||
                "question";
            if (msg.t === "qAdded" && (role === "hider" || role === "coHider")) {
                notify({
                    title: "New question",
                    body: `The seeker asked a ${label.toLowerCase()} question.`,
                    tag: "q-added",
                });
            } else if (msg.t === "qAnswered" && role === "seeker") {
                // Distinguish a Veto / Randomize from a normal answer so
                // the seeker knows what happened to their question.
                const qd = (
                    msg.question as {
                        data?: { vetoed?: boolean; randomized?: boolean };
                    } | null
                )?.data;
                if (qd?.vetoed) {
                    notify({
                        title: "Question vetoed",
                        body: `The hider vetoed your ${label.toLowerCase()} question — no answer is coming, but you can ask another.`,
                        tag: "q-answered",
                    });
                } else if (qd?.randomized) {
                    notify({
                        title: "Question randomized",
                        body: `The hider randomized your ${label.toLowerCase()} question and answered a different one of the same category.`,
                        tag: "q-answered",
                    });
                } else {
                    notify({
                        title: "Hider answered",
                        body: `Your ${label.toLowerCase()} question got an answer.`,
                        tag: "q-answered",
                    });
                }
            }
            return;
        }
        case "ended":
            if (roundFoundAt.get() === null) {
                roundFoundAt.set(msg.foundAt);
                notify({
                    title: "Round over",
                    body:
                        playerRole.get() === "hider" ||
                        playerRole.get() === "coHider"
                            ? "The seeker marked you as found."
                            : "The hider was found.",
                    tag: "round-ended",
                });
            }
            return;
        case "roundStarted":
            applyRoundStarted(msg.participants);
            return;
        case "presence":
            participants.set(msg.participants);
            // Live role updates land here (rotation, other player's
            // role claim, etc.) — pull the local role in line so
            // the seeker map / hider home swaps without a reload.
            reconcileLocalRoleFromPresence(msg.participants);
            return;
        case "hideZone":
            // Hide-team sync: the primary hider's committed zone, or
            // null on clear / new round. Co-hiders mirror it locally
            // so the companion view can render it. The hider is the
            // source and never receives this (server excludes them),
            // so this only ever lands on a co-hider.
            hidingZone.set(msg.zone);
            return;
        case "setupChanged": {
            if (msg.setup.playArea) playArea.set(msg.setup.playArea);
            allowedTransit.set(msg.setup.allowedTransit);
            gameSize.set(msg.setup.gameSize);
            const prevHidingEndsAt = hidingPeriodEndsAt.get();
            hidingPeriodEndsAt.set(msg.setup.hidingPeriodEndsAt);
            const prevEndgameAt = endgameStartedAt.get();
            endgameStartedAt.set(msg.setup.endgameStartedAt);
            const prevEndgameConfirmedAt = endgameConfirmedAt.get();
            endgameConfirmedAt.set(msg.setup.endgameConfirmedAt ?? null);
            if (msg.setup.mapGeoLocation) {
                mapGeoLocation.set(
                    msg.setup.mapGeoLocation as OpenStreetMap,
                );
            }
            if (Array.isArray(msg.setup.adjacentLocations)) {
                // Keep the hide team's folded-in neighbours in sync with
                // the host so both see the same play-area boundary.
                additionalMapGeoLocations.set(
                    msg.setup.adjacentLocations as ReturnType<
                        typeof additionalMapGeoLocations.get
                    >,
                );
            }
            applyHouseRules(msg.setup.houseRules);
            // Endgame just got armed (null → number). Hider needs to
            // know immediately — rulebook p43 says they lock down to
            // a final spot the instant this fires.
            if (
                prevEndgameAt === null &&
                msg.setup.endgameStartedAt !== null
            ) {
                const role = playerRole.get();
                if (role === "hider" || role === "coHider") {
                    notify({
                        title: "Endgame — lock down",
                        body: "The seeker says they're in your zone. Commit to a final spot — or refute it if they're wrong.",
                        tag: "endgame",
                    });
                }
            }
            // Endgame got refuted (number → null) mid-round: the hider
            // told the room the seekers aren't actually in their zone.
            // Let the seekers know so they keep searching instead of
            // standing around an armed-but-now-cleared endgame UI. (A
            // new round/game clears endgame via different paths, so this
            // only fires on a genuine in-round cancel.)
            if (
                prevEndgameAt !== null &&
                msg.setup.endgameStartedAt === null &&
                msg.setup.hidingPeriodEndsAt !== null
            ) {
                const role = playerRole.get();
                if (role === "seeker") {
                    notify({
                        title: "Not the right zone",
                        body: "The hider says you haven't reached their zone yet. Keep searching.",
                        tag: "endgame",
                    });
                }
            }
            // Hider confirmed the claim (confirmed null → number) — tell
            // the seekers they're in the right zone so they switch from
            // "waiting on the hider" to actively hunting the final spot.
            if (
                prevEndgameConfirmedAt == null &&
                msg.setup.endgameConfirmedAt != null
            ) {
                const role = playerRole.get();
                if (role === "seeker") {
                    notify({
                        title: "You're in the zone",
                        body: "The hider has locked down — you're in the right zone. Find them!",
                        tag: "endgame",
                    });
                }
            }
            // Hiding period just ended via host action (snap to now /
            // past). Only the hider cares — for seekers the timer
            // ending IS the trigger to start asking questions and they
            // were probably the ones who tapped it.
            if (
                prevHidingEndsAt !== null &&
                msg.setup.hidingPeriodEndsAt !== null &&
                prevHidingEndsAt > Date.now() &&
                msg.setup.hidingPeriodEndsAt <= Date.now()
            ) {
                const role = playerRole.get();
                if (role === "hider" || role === "coHider") {
                    notify({
                        title: "Hiding period over",
                        body: "The seeker can start asking questions now.",
                        tag: "hiding-ended",
                    });
                }
            }
            return;
        }
        case "loc": {
            // Per-seeker GPS update fanned out by the server. Hide
            // team only — the server gates this, so we just trust it.
            const curr = seekerLocations.get();
            seekerLocations.set({
                ...curr,
                [msg.participantId]: {
                    lat: msg.lat,
                    lng: msg.lng,
                    accuracy: msg.accuracy,
                    ts: msg.ts,
                },
            });
            return;
        }
        case "error":
            console.warn("[multiplayer] server error", msg);
            multiplayerError.set({ code: msg.code, message: msg.message });
            if (msg.code === "session_invalid") {
                // Drop back to local mode rather than spam reconnects.
                leaveGame();
            }
            if (msg.code === "role_taken") {
                // Server rejected our hider claim — someone else has
                // the slot. Flip locally to seeker so the UI matches
                // and the user isn't stuck believing they're the
                // hider for this room. (Their local-only hider state
                // — inbox, hand, etc. — stays around in case they
                // leave this room and play offline as hider.)
                if (playerRole.get() === "hider") {
                    playerRole.set("seeker");
                }
            }
            return;
        case "curseReceived":
            // Surface the curse in the seeker's CurseInbox overlay, not
            // just as an OS notification. The wire path previously only
            // notified, so opening the app showed nothing — mirror the
            // share-link path (AnswerLinkReader) and append to
            // `receivedCurses` (the atom CurseInbox renders from). The
            // hider never receives their own cast (server excludes the
            // caster), and CurseInbox only mounts on the seeker surface.
            receivedCurses.set([
                ...receivedCurses.get(),
                {
                    name: msg.curse.name,
                    description: msg.curse.description,
                    castingCost: msg.curse.castingCost,
                    receivedAt: Date.now(),
                    acknowledged: false,
                },
            ]);
            notify({
                title: msg.curse.name,
                body: msg.curse.description,
                tag: "curse",
            });
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
 *
 * Also subscribes to local `playerRole` changes and forwards them
 * to the server when we're in a room — so the "Switch to hider"
 * button propagates to peers without any extra plumbing at the
 * call sites.
 */
let _installed = false;
export function installMultiplayerBridge() {
    if (_installed) return;
    _installed = true;
    const t = getTransport();
    t.on("message", handleServerMessage);
    t.on("status", (status) => transportStatus.set(status));

    // After any auto-reconnect the transport opens a brand-new
    // WebSocket. The server won't know who we are until we re-send
    // an auth message. `setReconnectHandshake` registers a callback
    // that the transport calls — before draining any queued game
    // messages — so the server re-registers us immediately.
    t.setReconnectHandshake(() => {
        const token = sessionToken.get();
        const code = currentGameCode.get();
        if (!token || !code || !multiplayerEnabled.get()) return null;
        return {
            t: "resume",
            v: PROTOCOL_VERSION,
            code,
            deviceId: getDeviceId(),
            sessionToken: token,
        };
    });

    // Forward local role changes to the server while we're in a
    // room. Skip the initial nanostores fire (which would race the
    // connect handshake) — initial role claim is handled by the
    // `welcome` server message above, so this subscription only
    // matters for LIVE changes (e.g. tapping "Switch to hider").
    let firstFire = true;
    playerRole.subscribe((role) => {
        if (firstFire) {
            firstFire = false;
            return;
        }
        if (!multiplayerEnabled.get()) return;
        if (!currentGameCode.get()) return;
        if (transportStatus.get() !== "open") return;
        if (role === "seeker" || role === "hider" || role === "coHider") {
            getTransport().send({ t: "role", role });
        }
    });

    // Forward the primary hider's committed hiding zone to the server
    // so it can fan out to co-hiders. Only the hider pushes — co-hiders
    // mirror it inbound, and pushing from them would loop. Skip the
    // initial nanostores fire (stale value from a prior session).
    let firstZoneFire = true;
    hidingZone.subscribe((zone) => {
        if (firstZoneFire) {
            firstZoneFire = false;
            return;
        }
        if (!multiplayerEnabled.get()) return;
        if (!currentGameCode.get()) return;
        if (transportStatus.get() !== "open") return;
        if (playerRole.get() !== "hider") return;
        getTransport().send({ t: "setHideZone", zone: zone ?? null });
    });
}
