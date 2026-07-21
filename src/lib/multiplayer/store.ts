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
import { toast } from "react-toastify";

import { getStoredPushSubscription, notify } from "@/lib/notifications";

import { appNavigate } from "@/lib/appNavigate";
import { CATEGORIES, type CategoryId } from "@/lib/categories";
import {
    addQuestion as localAddQuestion,
    additionalMapGeoLocations,
    mapGeoLocation,
    pendingRandomize,
    questionModified,
    questions,
} from "@/lib/context";
import type { OpenStreetMap } from "@/maps/api";
import {
    allowedTransit,
    applyRoundProgress,
    effectiveHiddenDebitMs,
    gamePausedForLocationAt,
    gameSize,
    gameStartCelebrationAt,
    gameStartFiredFor,
    gameStartOverLobby,
    seekingStartFiredFor,
    endgameConfirmedAt,
    endgameDeniedAt,
    endgameDeniedReason,
    endgameStartedAt,
    endgameSuccessAt,
    endgameZone,
    type EndgameZone,
    pendingEndgameZone,
    endOfRoundDialogOpen,
    hiddenCreditMs,
    hiddenDebitMs,
    hidingPeriodEndsAt,
    locationGraceStartedAt,
    locationTrackingExternal,
    manualPausedAt,
    manualPauseWasHiding,
    planningWindowEndsAt,
    playArea,
    readRoundProgress,
    revealedStation,
    roundEndBaseMs,
    roundEndBonusPieces,
    roundEndHiderName,
    seekersFrozenUntil,
} from "@/lib/gameSetup";
import { timeBonusPieces } from "@/lib/hiderDeck";
import {
    applySharedDeckState,
    chaliceDrawsRemaining,
    hiderDeck,
    hiderDiscard,
    hiderHand,
    hiderHandLimit,
    hiderInbox,
    hidingZone,
    pendingDraw,
    pendingDrawQueue,
    playerRole,
    readSharedDeckState,
    resetHiderRoundState,
    roundFoundAt,
    scoutedSpots,
    type ScoutedSpot,
} from "@/lib/hiderRole";
import { appConfirm } from "@/lib/confirm";
import {
    alternateQuestionTypes,
    askOncePerQuestion,
    zoneRadiusBuffer,
} from "@/lib/houseRules";
import { resetSharedRoundState } from "@/lib/roundReset";
import { triggerCurseReveal } from "@/lib/curseReveal";
import { appendRoundResult } from "@/lib/roundLeaderboard";
import { castCurses, receivedCurses } from "@/lib/seekerInbound";
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
    transportReconnectAttempt,
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
 * Hard client-side throttle on room creation (v817). A safety net
 * INDEPENDENT of any caller's own retry logic: no matter what triggers
 * `createGame`, it physically cannot fire more than once per this window.
 * This is what makes a create→fail→create loop (e.g. the lobby autohost
 * spinning against the Worker's 429 rate limit) unable to peg the main
 * thread / freeze the app even if a guard elsewhere regresses.
 */
const CREATE_GAME_MIN_INTERVAL_MS = 3000;
let lastCreateGameAttemptAt = 0;

/**
 * Create a brand-new room on the server. Returns the 6-char code on
 * success. The caller is expected to then call `joinAsHost(code)` to
 * actually connect (we keep the two steps separate so the UI can
 * surface the code briefly without committing to a connection).
 */
export async function createGame(): Promise<string> {
    const now = Date.now();
    if (now - lastCreateGameAttemptAt < CREATE_GAME_MIN_INTERVAL_MS) {
        // Refuse to hammer — the caller treats this like any other failure
        // (shows the retry card); it just can't loop.
        throw new Error("Slow down — wait a moment before creating a game.");
    }
    lastCreateGameAttemptAt = now;
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

/**
 * Force an immediate reconnect (skips the backoff wait). Used by the
 * Reconnecting banner's manual "Retry now" button. No-op if there's nothing
 * to reconnect to (not in a game) or in demo mode.
 */
export function reconnectNow() {
    if (demoMode.get()) return;
    if (!currentGameCode.get() || !sessionToken.get()) {
        // Nothing to resume — try a fresh resume from persistent state.
        tryResumeFromPersistent();
        return;
    }
    getTransport().reconnect();
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

/**
 * Seeker marks the hider found. Round-end ping. In multiplayer the server
 * soft-validates proximity (rulebook p43): it replies `foundFar` if the
 * seeker's last GPS is well away from the nearest hider, and only broadcasts
 * `ended` when close (or when it can't verify). Pass `force` to skip the
 * check after the seeker dismisses the "are you sure?" warning.
 */
export function seekerMarkFound(foundAt: number, force = false) {
    if (!multiplayerEnabled.get()) return;
    getTransport().send({ t: "found", foundAt, force });
}

/**
 * Hider → server ONLY: push the hider's live GPS so the server can range-check
 * a `found` claim. NEVER reaches seekers (unlike the seeker `loc`) — it's the
 * game's secret. Owned by `useHiderLocationBroadcast`, which gates on role +
 * multiplayer + a live game.
 */
export function hiderPushLocation(
    lat: number,
    lng: number,
    accuracy: number,
) {
    if (!multiplayerEnabled.get()) return;
    getTransport().send({
        t: "hiderLoc",
        lat,
        lng,
        accuracy,
        ts: Date.now(),
    });
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
        // Move powerup: sync the seeker freeze + the revealed station so the
        // seeker device shows the frozen banner + a "hider was here" marker.
        seekersFrozenUntil: seekersFrozenUntil.get(),
        revealedStation: revealedStation.get(),
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
        locationTrackingExternal: locationTrackingExternal.get(),
    };
    getTransport().send({ t: "start", setup });
}

/**
 * v940: toggle "seekers are tracking location externally" for the whole room.
 * Sets the local atom immediately and syncs via a dedicated `setLocationTracking`
 * message (any participant may send it — unlike the host-only `hostPushSetup`).
 * Solo/offline just flips the atom.
 */
export function setLocationTrackingExternal(external: boolean) {
    locationTrackingExternal.set(external);
    if (!multiplayerEnabled.get()) return;
    getTransport().send({ t: "setLocationTracking", external });
}

/**
 * Seeker → room: trigger the endgame phase (rulebook p43, "lock
 * down"). Stamps the local atom and pushes a wire message — the
 * server idempotently sets the canonical timestamp and broadcasts
 * setupChanged so hide-team devices surface the banner. Solo /
 * offline play just flips the local atom and relies on the
 * persistent store to keep the banner across reloads.
 */
export function seekerStartEndgame(
    zone?: EndgameZone | null,
    force?: boolean,
) {
    if (endgameStartedAt.get() !== null) return;
    const at = Date.now();
    if (!multiplayerEnabled.get()) {
        // Solo / offline: no server to validate the claim, so arm + confirm
        // locally (the seeker IS the whole team). Fire the success beat + cut
        // the map to the declared zone.
        endgameStartedAt.set(at);
        endgameConfirmedAt.set(at);
        endgameSuccessAt.set(at);
        if (zone) endgameZone.set(zone);
        return;
    }
    // v950: DON'T optimistically arm in multiplayer — the server validates the
    // claim against the hider's zone and either arms it (correct, via
    // `setupChanged`) or replies `endgameDenied` (wrong). Setting it locally
    // first would flash a false "in the zone" / "denied" state before the
    // authoritative verdict arrives. Stash the declared zone so a correct
    // verdict can promote it to the focus zone (v959).
    pendingEndgameZone.set(zone ?? null);
    getTransport().send({ t: "startEndgame", at, force });
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

/** Rename the local player. Writes the persistent display-name atom and,
 *  in a multiplayer room, tells the server so it re-broadcasts presence
 *  (the server de-dupes; the presence echo updates every roster). */
export function setOnlineName(name: string) {
    const trimmed = name.trim();
    displayName.set(trimmed);
    if (!multiplayerEnabled.get()) return;
    getTransport().send({ t: "setName", displayName: trimmed });
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
export function seekerRotateHider(
    toParticipantId: string,
    coHiderIds?: string[],
) {
    if (!multiplayerEnabled.get()) return;
    getTransport().send({
        t: "rotateHider",
        to: toParticipantId,
        // Additional hide-team members for the new round (v826). Omit the
        // key entirely when it's a single-hider round so older servers stay
        // happy (unknown key is ignored, but this keeps the wire minimal).
        ...(coHiderIds && coHiderIds.length > 0
            ? { coHiders: coHiderIds }
            : {}),
    });
}


/** Hider broadcasts a curse to all seekers in the room. */
export function hiderCastCurse(curse: CursePayload) {
    if (!multiplayerEnabled.get()) return;
    getTransport().send({ t: "castCurse", curse });
}

/**
 * A seeker cleared/dismissed a curse — tell the server so the hide team's
 * active-curse mirror + other seekers drop it too (v1022). No-op solo/offline
 * or for a curse with no server `castId` (a `?c=` link curse).
 */
export function sendCurseCleared(castId: number | undefined) {
    if (castId == null) return;
    if (!multiplayerEnabled.get()) return;
    getTransport().send({ t: "curseCleared", castId });
}

/**
 * v1079: a seeker sends the hider their VERIFICATION photo for a curse that
 * requires it (Curse of the Unguided Tourist). Relayed to the hide team, who
 * see it on their active-curse card.
 */
export function sendCurseProof(castId: number | undefined, photoUrl: string) {
    if (castId == null || !photoUrl) return;
    if (!multiplayerEnabled.get()) return;
    getTransport().send({ t: "curseProof", castId, photoUrl });
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
    if (dat.randomizedAway === true) {
        // Randomize (v1028/v1029): the hider DECLINED to answer and redirected
        // this question — mark the original randomized-away (it eliminates
        // nothing and is re-askable at its original cost). On the SEEKER, record
        // the OWED replacement (`pendingRandomize`): same category as the
        // original, which the seeker must ask (an un-asked subtype) before
        // anything else. We do NOT auto-open the configure dialog — the seeker
        // triggers it from the "Ask random new question" button on the answered
        // overlay, so cancelling never wastes the randomize.
        const wasAway =
            idx >= 0 &&
            (current[idx].data as { randomizedAway?: boolean })
                .randomizedAway === true;
        if (idx >= 0) {
            const next: Questions = [...current];
            next[idx] = {
                ...current[idx],
                data: {
                    ...(current[idx].data as Record<string, unknown>),
                    drag: false,
                    randomized: true,
                    randomizedAway: true,
                },
            } as Question;
            questions.set(next);
        } else {
            questions.set([...current, parsed]);
        }
        // Only the SEEKER owes a replacement, and only on the genuine live
        // transition — NOT a reconnect snapshot replay of an already-away
        // question. Gate on: we held the original live locally (idx >= 0) and
        // it wasn't already away.
        if (!wasAway && idx >= 0 && playerRole.get() === "seeker") {
            pendingRandomize.set({
                category: parsed.id as CategoryId,
                originalKey: parsed.key,
            });
        }
    } else if (dat.randomized === true && dat.randomizedAway !== true && idx >= 0) {
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
    // Reset on any transition into OR out of the hide team (v829: a single
    // `hider` role now), so a demoted hider doesn't keep a stale hiding zone
    // / inbox and a freshly-added one lands clean.
    const wasHideTeam = prev === "hider";
    const nowHideTeam = me.role === "hider";
    if (prev !== null && (wasHideTeam || nowHideTeam)) {
        resetHiderRoundState();
    }
    playerRole.set(me.role);
    // Navigate the affected device to the correct page. The seeker
    // app lives on `/`; the hider home on `/h`. Skip the navigation
    // on first role assignment (prev === null) — that path is the
    // initial RolePicker landing which already steers the user.
    // v1070: also skip pre-game — both routes render the same lobby, so a
    // team switch shouldn't swap shells (the "lobby reloads when I switch
    // teams" jank). GameRouteGate corrects the route once the clock arms.
    if (
        prev !== null &&
        Number.isFinite(hidingPeriodEndsAt.get()) &&
        typeof window !== "undefined"
    ) {
        const path = window.location.pathname;
        const onHider = path === "/h" || path.startsWith("/h/");
        const onSeeker =
            path === "/" || (!onHider && !path.startsWith("/h"));
        // Every hider lives on the hider surface (/h). v756: SOFT-navigate
        // via the appNavigate bridge (fall back to a hard nav only if the
        // router bridge isn't mounted). A `window.location` reload here tore
        // down the live WS + re-applied the server snapshot over local state
        // — the "lobby reloads when I pick hider" bug.
        if (me.role === "hider" && !onHider) {
            if (!appNavigate("/h", { replace: true }))
                window.location.assign("/h");
        } else if (me.role === "seeker" && !onSeeker) {
            if (!appNavigate("/", { replace: true }))
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
    // v970 (rulebook audit B): capture whether the PREVIOUS round actually
    // completed before the reset wipes it — a completed round grants the
    // new hider the 10-minute planning window (rulebook p81).
    const prevRoundCompleted = roundFoundAt.get() !== null;
    // v1023: record the just-finished round in THIS device's leaderboard
    // BEFORE the reset wipes the round state. Idempotent (keyed on the round's
    // foundAt) so the initiator — which also ran the append in startNewRound —
    // doesn't double-count. This is the fix for "only the device that started
    // the new round saw the previous round's result".
    appendRoundResult();
    // v670: reset ALL per-round state via the shared helper — the same
    // one `startNewRound`/`startNewGame` use — so a guest device can't
    // carry stale curses / Move-freeze / scoring credit-debit /
    // spotty-memory / celebration-dedupe across rounds (this path used to
    // reset only a subset, and none of those atoms ride `SetupState`, so
    // nothing else fixed them). Clears questions, hider hand/deck, map
    // overlays, the live hiding clock, and the endgame stamps too.
    resetSharedRoundState();
    if (prevRoundCompleted) {
        planningWindowEndsAt.set(Date.now() + 10 * 60_000);
    }
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
    // v1022: server-authoritative new-hider planning window.
    planningWindowEndsAt.set(state.setup.planningWindowEndsAt ?? null);
    // v946: a snapshot is a JOIN / reconnect resync, never the live moment the
    // clock arms — so it must NOT replay the GO-GO-GO (game start) or SEEK
    // (seeking start) celebration. Stamp the watchers' "already fired" dedupe
    // keys to the synced value: game-start always (an armed clock means the
    // game already began), seeking-start only if the hiding period ALREADY
    // ended (a joiner still IN the hiding period should get the SEEK beat when
    // it crosses zero, so leave that one for a future endsAt).
    if (Number.isFinite(state.setup.hidingPeriodEndsAt)) {
        const endsAt = state.setup.hidingPeriodEndsAt as number;
        gameStartFiredFor.set(endsAt);
        if (Date.now() >= endsAt) seekingStartFiredFor.set(endsAt);
    }
    endgameStartedAt.set(state.setup.endgameStartedAt);
    endgameConfirmedAt.set(state.setup.endgameConfirmedAt ?? null);
    // Move powerup freeze + revealed station (present only on newer setups).
    if ("seekersFrozenUntil" in state.setup) {
        seekersFrozenUntil.set(state.setup.seekersFrozenUntil ?? null);
    }
    if ("revealedStation" in state.setup) {
        revealedStation.set(state.setup.revealedStation ?? null);
    }
    if ("locationTrackingExternal" in state.setup) {
        locationTrackingExternal.set(!!state.setup.locationTrackingExternal);
    }
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
    // Round end. v946: if THIS device is only NOW learning the round ended
    // (its local roundFoundAt was null but the snapshot has it set — a seeker
    // whose phone slept through the mark-found and reconnected), open the
    // end-of-round dialog so it doesn't just show a frozen timer with no
    // explanation. `roundFoundAt` is persistent, so a dismiss survives a later
    // reconnect (old value already set → no re-open).
    const learnedRoundEnded =
        roundFoundAt.get() == null && state.roundFoundAt != null;
    roundFoundAt.set(state.roundFoundAt);
    if (learnedRoundEnded) endOfRoundDialogOpen.set(true);
    // Presence
    participants.set(state.participants);
    // Sync local role from server canonical roster — covers
    // rotation-initiated-elsewhere ("you are now the hider"),
    // initial welcome (server may know our prior role from a
    // resume), and snapshot replays.
    reconcileLocalRoleFromPresence(state.participants);
}

/**
 * Build a `ReceivedCurse` from a wire `CursePayload`. Shared by the fresh
 * `curseReceived` cast and the `curseBacklog` recovery (v943). Carries every
 * curse-specific enforcement/proof field through so the seeker's question UI
 * + CurseInbox behave identically whichever path delivered the curse.
 */
function curseToReceived(curse: CursePayload) {
    return {
        name: curse.name,
        description: curse.description,
        castingCost: curse.castingCost,
        disabledCategories: curse.disabledCategories,
        disabledQuestions: curse.disabledQuestions,
        photoUrl: curse.photoUrl,
        filmSeconds: curse.filmSeconds,
        rockCount: curse.rockCount,
        travelDestination: curse.travelDestination,
        travelDestLat: curse.travelDestLat,
        travelDestLng: curse.travelDestLng,
        castId: curse.castId,
        receivedAt: Date.now(),
        // v1022: the show-style REVEAL animation (CurseRevealOverlay) is now
        // the "curse received" moment, so skip the old big "CURSE RECEIVED"
        // notification card — mark it acknowledged on arrival and let it go
        // straight to the compact active-curse pill (dice / clear / countdown).
        acknowledged: true,
    };
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
                if (local === "seeker" || local === "hider") {
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
            if (msg.t === "qAdded" && (role === "hider")) {
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
                        body: `The hider randomized your ${label.toLowerCase()} question — pick the random replacement question you'll ask instead.`,
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
                // v879: snapshot the just-finished hider's name NOW, while the
                // roster still holds them — the "New round" button rotates
                // roles to the NEXT hider before startNewRound runs, so
                // resolving the name later attributed rounds to the wrong
                // person (the leaderboard name-shift bug). Same roster on
                // every device, so all devices snapshot the same name.
                {
                    const hider = participants
                        .get()
                        .find((p) => p.role === "hider");
                    const name = hider?.displayName?.trim();
                    if (name) roundEndHiderName.set(name);
                }
                // v851: the base hiding time (Move credit / late-answer
                // debit) AND the in-hand time bonus are BOTH hider-local, so
                // a seeker can't compute the true final time or the tally.
                // The hider therefore computes its authoritative result here
                // and PUBLISHES it over the wire (`roundSummary`); both sides
                // set the synced atoms the EndOfRoundDialog + leaderboard
                // read.
                if (playerRole.get() === "hider") {
                    const endsAt = hidingPeriodEndsAt.get();
                    const baseMs =
                        endsAt !== null
                            ? Math.max(
                                  0,
                                  Math.max(0, msg.foundAt - endsAt) +
                                      hiddenCreditMs.get() -
                                      effectiveHiddenDebitMs(msg.foundAt),
                              )
                            : 0;
                    const pieces = timeBonusPieces(
                        hiderHand.get(),
                        gameSize.get(),
                    );
                    roundEndBaseMs.set(baseMs);
                    roundEndBonusPieces.set(pieces);
                    getTransport()?.send({
                        t: "roundSummary",
                        baseMs,
                        bonusPieces: pieces,
                    });
                }
                // Fire the celebratory end-of-round dialog on this device
                // too (v631).
                endOfRoundDialogOpen.set(true);
                notify({
                    title: "Round over",
                    body:
                        playerRole.get() === "hider"
                            ? "The seeker marked you as found."
                            : "The hider was found.",
                    tag: "round-ended",
                });
            }
            return;
        case "roundSummary":
            // v851: the hider's authoritative round result (base hiding time
            // + individual in-hand time-bonus pieces, in minutes). Both the
            // EndOfRoundDialog tally and the leaderboard append read these.
            roundEndBaseMs.set(msg.baseMs);
            roundEndBonusPieces.set(msg.bonusPieces);
            return;
        case "foundFar": {
            // v853: the server range-checked our `found` claim and the
            // seeker's GPS is well away from the nearest hider. Soft warning
            // (rulebook p43 — be physically WITH the hider); on confirm we
            // re-send with force to end regardless. No distance is leaked (the
            // hider's position is secret) — just "GPS says you're pretty far".
            const foundAt = msg.foundAt;
            void (async () => {
                const ok = await appConfirm({
                    title: "Are you with the hider?",
                    description:
                        "Your GPS says you're pretty far from the hider. Only mark them found once you've physically reached them. Mark found anyway?",
                    confirmLabel: "Mark found",
                    destructive: true,
                });
                if (ok) seekerMarkFound(foundAt, true);
            })();
            return;
        }
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
            // Hide-team sync: a teammate's committed zone, or null on
            // clear / new round. v829: every hider mirrors it locally (any
            // hider can commit; the server fans to all OTHER hiders). Guard
            // the atom write so it doesn't re-trigger the push subscription
            // → server → back to us → loop; `applyingRemoteZone` tells the
            // subscription "this set came from the wire, don't re-send".
            applyingRemoteZone = true;
            try {
                hidingZone.set(msg.zone);
            } finally {
                applyingRemoteZone = false;
            }
            return;
        case "deck":
            // Shared hide-team card economy (v831 Track 2): a teammate
            // mutated the deck (or the server is delivering the current
            // shared deck on our join/role-claim). Adopt it into the seven
            // deck atoms under `applyingRemoteDeck` so the writes don't
            // re-trigger the outbound push → server → back → loop.
            applyingRemoteDeck = true;
            try {
                applySharedDeckState(msg.deck);
            } finally {
                applyingRemoteDeck = false;
            }
            return;
        case "roundProgress":
            // v942 (durability): a teammate pushed the hider's scored-time
            // ledger + pause state (or the server is delivering it on our
            // join/resume so we recover it after a device died). Adopt it
            // under the echo guard so the writes don't loop back out.
            if (msg.progress) {
                applyingRemoteRoundProgress = true;
                try {
                    applyRoundProgress(msg.progress);
                } finally {
                    applyingRemoteRoundProgress = false;
                }
            }
            return;
        case "scoutedSpots":
            // v942 Phase 2: a teammate updated the scouted-spots notebook
            // (or the server delivered it on our join so we recover it).
            if (Array.isArray(msg.spots)) {
                applyingRemoteScoutedSpots = true;
                try {
                    scoutedSpots.set(msg.spots as ScoutedSpot[]);
                } finally {
                    applyingRemoteScoutedSpots = false;
                }
            }
            return;
        case "setupChanged": {
            if (msg.setup.playArea) playArea.set(msg.setup.playArea);
            allowedTransit.set(msg.setup.allowedTransit);
            gameSize.set(msg.setup.gameSize);
            const prevHidingEndsAt = hidingPeriodEndsAt.get();
            hidingPeriodEndsAt.set(msg.setup.hidingPeriodEndsAt);
            // v1022: server-authoritative new-hider planning window — set on a
            // round rotate after a completed round, so all devices show the
            // 10-min lobby countdown (survives the client round-reset ordering).
            planningWindowEndsAt.set(msg.setup.planningWindowEndsAt ?? null);
            // v814: a guest receiving the host's START push (hiding clock
            // going null → set) plays the game-start flourish OVER the
            // lobby, same as the host. Set the flag SYNCHRONOUSLY with the
            // clock so the guest's pre-game branch never swaps to the map
            // for a frame (no flash / no map→lobby→map flicker). NOT set on a
            // reconnect (applySnapshot), so a mid-game rejoin never replays it.
            //
            // v820: also raise `gameStartCelebrationAt` HERE, synchronously,
            // rather than deferring it to the guest's GameStartWatcher effect.
            // The self-healing `gameStarted` gate (SeekerPage/HiderPage) holds
            // the pre-game branch only while the celebration is live, so if
            // `gameStartOverLobby` flipped true a frame before the celebration
            // existed, the guest would flash the map. Flipping both together
            // keeps the branch held from the first render. GameStartWatcher's
            // own set is guarded by `=== null`, so it won't double-fire.
            if (prevHidingEndsAt === null && msg.setup.hidingPeriodEndsAt !== null) {
                gameStartOverLobby.set(true);
                if (gameStartCelebrationAt.get() === null) {
                    gameStartCelebrationAt.set(Date.now());
                }
            }
            const prevEndgameAt = endgameStartedAt.get();
            endgameStartedAt.set(msg.setup.endgameStartedAt);
            const prevEndgameConfirmedAt = endgameConfirmedAt.get();
            endgameConfirmedAt.set(msg.setup.endgameConfirmedAt ?? null);
            // Move powerup: sync the seeker freeze + the revealed station.
            if ("seekersFrozenUntil" in msg.setup) {
                seekersFrozenUntil.set(msg.setup.seekersFrozenUntil ?? null);
            }
            if ("locationTrackingExternal" in msg.setup) {
                locationTrackingExternal.set(
                    !!msg.setup.locationTrackingExternal,
                );
            }
            if ("revealedStation" in msg.setup) {
                const prevReveal = revealedStation.get();
                const nextReveal = msg.setup.revealedStation ?? null;
                revealedStation.set(nextReveal);
                // The hider just played Move (no reveal → a reveal): tell the
                // seekers where the hider WAS and that they're frozen.
                if (prevReveal === null && nextReveal !== null) {
                    const role = playerRole.get();
                    if (role === "seeker") {
                        notify({
                            title: "Hider is on the move",
                            body: nextReveal.name
                                ? `They were at ${nextReveal.name}. Hold position — you're frozen while they relocate.`
                                : "They revealed their last station and are relocating. Hold position — you're frozen.",
                            tag: "move-powerup",
                        });
                    }
                }
            }
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
            // Endgame just got armed (null → number). v950: the server only
            // arms the endgame for a CORRECT claim (a wrong one fires the
            // transient `endgameDenied` instead, never touching this state), so
            // this always means "the seekers reached your zone." Tell the
            // hider to lock down (the seeker's "you're in the right zone" comes
            // from the confirmed-branch below).
            if (
                prevEndgameAt === null &&
                msg.setup.endgameStartedAt !== null
            ) {
                // v959: fire the big success celebration on BOTH roles, and —
                // for the declaring seeker — promote the pending zone so the
                // map cuts down to the correct final zone.
                endgameSuccessAt.set(Date.now());
                if (playerRole.get() === "seeker") {
                    const pending = pendingEndgameZone.get();
                    if (pending) endgameZone.set(pending);
                }
                pendingEndgameZone.set(null);
                if (playerRole.get() === "hider") {
                    notify({
                        title: "Seekers reached your zone!",
                        body: "The seekers are in your hiding zone — lock down your final spot.",
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
                if (role === "hider") {
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
            // v936: stamp `ts` with the HIDER's local receive time, NOT the
            // seeker's `msg.ts`. Everything that reads `ts` is asking "how
            // recently did we hear from this seeker" (the location-share
            // freshness rule, live-pin staleness, ETA freshness), and
            // comparing the seeker's clock to the hider's `now` broke under
            // cross-device clock skew: a seeker even ~1 min ahead of the
            // hider made every FRESH broadcast look older than the 60 s
            // window → the hider got a spurious "seekers need to share their
            // location" pause countdown while the seeker was actively
            // sharing (and shown online). Receive-time is skew-immune.
            const curr = seekerLocations.get();
            seekerLocations.set({
                ...curr,
                [msg.participantId]: {
                    lat: msg.lat,
                    lng: msg.lng,
                    accuracy: msg.accuracy,
                    ts: Date.now(),
                },
            });
            return;
        }
        case "error":
            console.warn("[multiplayer] server error", msg);
            multiplayerError.set({ code: msg.code, message: msg.message });
            if (msg.code === "session_invalid" || msg.code === "unknown_room") {
                // Drop back to local mode rather than spam reconnects. v1023:
                // unknown_room = the code names no active game (phantom join);
                // surface it and leave so the user can re-enter a valid code.
                if (msg.code === "unknown_room") {
                    toast.error(
                        msg.message ||
                            "No active game with that code.",
                        { autoClose: 5000 },
                    );
                }
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
            {
                // Dedup by server castId so a curse the server also replays
                // in a backlog (same-device reconnect) isn't doubled.
                const existing = receivedCurses.get();
                if (
                    msg.curse.castId != null &&
                    existing.some((c) => c.castId === msg.curse.castId)
                ) {
                    return;
                }
                const received = curseToReceived(msg.curse);
                receivedCurses.set([...existing, received]);
                notify({
                    title: msg.curse.name,
                    body: msg.curse.description,
                    tag: "curse",
                });
                // v1021: play the show-style curse REVEAL animation on the
                // seeker's screen (fresh live cast only — NOT the backlog
                // recovery path below, which is a silent resync).
                triggerCurseReveal(received);
            }
            return;
        case "curseBacklog": {
            // v943 (durability): the server re-delivers every curse cast this
            // round when a seeker (re)joins. Merge in only the ones we don't
            // already hold (dedup by castId) so a fresh device recovers the
            // full active-curse set while a surviving device keeps its
            // acknowledged/dismissed flags. No notify() — this is recovery,
            // not a fresh cast.
            const existing = receivedCurses.get();
            const have = new Set(
                existing
                    .map((c) => c.castId)
                    .filter((id): id is number => id != null),
            );
            const fresh = msg.curses.filter(
                (c) => c.castId == null || !have.has(c.castId),
            );
            if (fresh.length === 0) return;
            receivedCurses.set([...existing, ...fresh.map(curseToReceived)]);
            return;
        }
        case "curseCleared": {
            // v1022: a seeker cleared/dismissed a curse (or it auto-expired).
            // Mark the matching castId dismissed in BOTH the seeker's inbox
            // (other seekers) and the hider's cast-curse mirror, so every
            // device drops it from the active list.
            const markCleared = (
                store: typeof receivedCurses,
            ) =>
                store.set(
                    store
                        .get()
                        .map((c) =>
                            c.castId === msg.castId
                                ? { ...c, dismissed: true }
                                : c,
                        ),
                );
            markCleared(receivedCurses);
            markCleared(castCurses);
            return;
        }
        case "curseProof": {
            // v1079: a seeker sent the hider their verification photo (Curse of
            // the Unguided Tourist). Attach it to the matching cast-curse entry
            // so the hider sees it on the active-curse card.
            castCurses.set(
                castCurses
                    .get()
                    .map((c) =>
                        c.castId === msg.castId
                            ? { ...c, seekerProofUrl: msg.photoUrl }
                            : c,
                    ),
            );
            if (playerRole.get() === "hider") {
                notify({
                    title: "Verification photo received",
                    body: "The seekers sent proof for a curse — check the active curse card.",
                    tag: "curse-proof",
                });
            }
            return;
        }
        case "endgameDenied": {
            // v950: the server validated a seeker's endgame claim and denied
            // it. It armed nothing (the seekers can re-try) — this is the
            // transient signal. v970: `reason` distinguishes the wrong-place
            // denial from the ON-TRANSIT denial (right zone, but the endgame
            // only begins once the seekers are off transit — rulebook p75).
            const onTransit = msg.reason === "transit";
            const role = playerRole.get();
            if (role === "hider") {
                notify({
                    title: "Endgame attempted",
                    body: onTransit
                        ? "The seekers reached your zone but are still on transit — the endgame hasn't started yet."
                        : "The seekers tried to start the endgame, but they're not at your zone.",
                    tag: "endgame",
                });
            } else if (role === "seeker") {
                notify({
                    title: onTransit
                        ? "Get off transit first"
                        : "Not the right spot",
                    body: onTransit
                        ? "You're at the zone, but the endgame can only start once you're off transit. Disembark and declare again."
                        : "The hider isn't in this zone. Keep searching.",
                    tag: "endgame",
                });
            }
            // v1025: on an OFF-ZONE denial the declared zone was wrong — drop
            // it so a later correct claim starts clean. On a TRANSIT denial the
            // zone was RIGHT (they just need to get off transit), so KEEP it so
            // the "declare anyway" override re-declares the same zone.
            if (!onTransit) pendingEndgameZone.set(null);
            endgameDeniedReason.set(onTransit ? "transit" : "off-zone");
            endgameDeniedAt.set(Date.now());
            return;
        }
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
/** v829: true while an inbound `hideZone` is being written to the local
 *  atom, so the zone-push subscription doesn't echo a wire-driven set back
 *  to the server (which would loop across the now-multiple equal hiders). */
let applyingRemoteZone = false;
/** v831 Track 2: set while adopting an inbound shared deck, so the outbound
 *  deck subscription doesn't echo a wire-driven set back to the server. */
let applyingRemoteDeck = false;
/** v942: set while adopting an inbound round-progress blob, so the outbound
 *  ledger subscription doesn't echo a wire-driven set back to the server. */
let applyingRemoteRoundProgress = false;
/** v942 Phase 2: same, for the scouted-spots notebook sync. */
let applyingRemoteScoutedSpots = false;
export function installMultiplayerBridge() {
    if (_installed) return;
    _installed = true;
    const t = getTransport();
    t.on("message", handleServerMessage);
    t.on("status", (status) => transportStatus.set(status));
    t.on("reconnectAttempt", (n) => transportReconnectAttempt.set(n));

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
        if (role === "seeker" || role === "hider") {
            getTransport().send({ t: "role", role });
        }
    });

    // Forward a hider's committed hiding zone to the server so it can fan
    // out to the rest of the hide team. v829: EVERY hider can commit, so
    // any hider pushes — but an inbound `hideZone` also writes the atom, and
    // re-pushing that would loop (us → server → other hiders → back). The
    // `applyingRemoteZone` guard skips the send for a wire-driven set. Skip
    // the initial nanostores fire too (stale value from a prior session).
    let firstZoneFire = true;
    hidingZone.subscribe((zone) => {
        if (firstZoneFire) {
            firstZoneFire = false;
            return;
        }
        if (applyingRemoteZone) return;
        if (!multiplayerEnabled.get()) return;
        if (!currentGameCode.get()) return;
        if (transportStatus.get() !== "open") return;
        if (playerRole.get() !== "hider") return;
        getTransport().send({ t: "setHideZone", zone: zone ?? null });
    });

    // v831 Track 2: forward the shared card economy. Every hider draws /
    // keeps / discards / plays from ONE deck, so any local mutation of the
    // seven deck atoms is pushed to the server, which fans it to the other
    // hiders. One logical mutation touches several atoms (e.g. a draw sets
    // both deck and hand), so batch a microtask so it sends ONCE, and skip
    // wire-driven sets (`applyingRemoteDeck`) so an adopted teammate state
    // doesn't loop back out. Skip the initial nanostores fire per atom.
    let deckPushQueued = false;
    // nanostores fires a subscriber synchronously with the current value the
    // moment you subscribe; we swallow ALL seven of those initial fires
    // (stale localStorage values from a prior session) — the server delivers
    // the authoritative shared deck on our join/role-claim.
    let installingDeckSubs = true;
    const scheduleDeckPush = () => {
        if (installingDeckSubs) return;
        if (applyingRemoteDeck) return;
        if (deckPushQueued) return;
        deckPushQueued = true;
        queueMicrotask(() => {
            deckPushQueued = false;
            if (applyingRemoteDeck) return;
            if (!multiplayerEnabled.get()) return;
            if (!currentGameCode.get()) return;
            if (transportStatus.get() !== "open") return;
            if (playerRole.get() !== "hider") return;
            getTransport().send({
                t: "setDeck",
                deck: readSharedDeckState(),
            });
        });
    };
    hiderHand.subscribe(scheduleDeckPush);
    hiderDeck.subscribe(scheduleDeckPush);
    hiderDiscard.subscribe(scheduleDeckPush);
    hiderHandLimit.subscribe(scheduleDeckPush);
    chaliceDrawsRemaining.subscribe(scheduleDeckPush);
    pendingDraw.subscribe(scheduleDeckPush);
    pendingDrawQueue.subscribe(scheduleDeckPush);
    installingDeckSubs = false;

    // v942 (durability): mirror the HIDER's scored-time ledger + pause state
    // to the server on every change, so the running SCORE survives that
    // hider's device dying. Same microtask-batched, echo-guarded, hider-only
    // push as the deck. The six atoms are one logical value (a Move draw sets
    // credit; a late answer sets debit; a pause sets its timestamps), so
    // batch a microtask to send ONCE.
    let progressPushQueued = false;
    let installingProgressSubs = true;
    const scheduleProgressPush = () => {
        if (installingProgressSubs) return;
        if (applyingRemoteRoundProgress) return;
        if (progressPushQueued) return;
        progressPushQueued = true;
        queueMicrotask(() => {
            progressPushQueued = false;
            if (applyingRemoteRoundProgress) return;
            if (!multiplayerEnabled.get()) return;
            if (!currentGameCode.get()) return;
            if (transportStatus.get() !== "open") return;
            if (playerRole.get() !== "hider") return;
            getTransport().send({
                t: "setRoundProgress",
                progress: readRoundProgress(),
            });
        });
    };
    hiddenCreditMs.subscribe(scheduleProgressPush);
    hiddenDebitMs.subscribe(scheduleProgressPush);
    manualPausedAt.subscribe(scheduleProgressPush);
    manualPauseWasHiding.subscribe(scheduleProgressPush);
    gamePausedForLocationAt.subscribe(scheduleProgressPush);
    locationGraceStartedAt.subscribe(scheduleProgressPush);
    installingProgressSubs = false;

    // v943 (durability): mirror the HIDER's scouted-spots notebook to the
    // server, so the hide team's marked spots survive a device swap and any
    // co-hider sees them. Same microtask-batched, echo-guarded, hider-only
    // push as the deck/round-progress.
    let scoutedPushQueued = false;
    let installingScoutedSub = true;
    const scheduleScoutedPush = () => {
        if (installingScoutedSub) return;
        if (applyingRemoteScoutedSpots) return;
        if (scoutedPushQueued) return;
        scoutedPushQueued = true;
        queueMicrotask(() => {
            scoutedPushQueued = false;
            if (applyingRemoteScoutedSpots) return;
            if (!multiplayerEnabled.get()) return;
            if (!currentGameCode.get()) return;
            if (transportStatus.get() !== "open") return;
            if (playerRole.get() !== "hider") return;
            getTransport().send({
                t: "setScoutedSpots",
                spots: scoutedSpots.get(),
            });
        });
    };
    scoutedSpots.subscribe(scheduleScoutedPush);
    installingScoutedSub = false;
}
