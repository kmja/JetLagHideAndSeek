import { atom } from "nanostores";
import { toast } from "react-toastify";

import {
    currentGameCode,
    demoMode,
    multiplayerEnabled,
    transportStatus,
} from "./session";

/**
 * Reconnection gate (v1187). Replaces the old full-screen "Reconnecting…"
 * curtain (v935) with a two-part model:
 *
 *  - `reconnectActive` — true while we're in a REAL online game whose socket
 *    has been non-open long enough to warrant surfacing. Both the on-map
 *    `ReconnectingBanner` PILL and the write-gate below read this single atom,
 *    so they stay in lockstep: if the pill is up, mutating actions are paused;
 *    a sub-grace network blip pauses neither. The rest of the app stays fully
 *    interactive — the player can pan the map, read the questions list, check
 *    the timer (the countdown runs off an absolute timestamp, so it's correct
 *    offline), etc.
 *
 *  - `guardOnlineAction()` — the CENTRAL write-gate. User-initiated mutating
 *    game actions call it and abort when it returns false. This is what still
 *    honours the v935 guarantee: `transport.send` QUEUES to an outbox while the
 *    socket is closed and flushes on reconnect, but the reconnect `welcome`
 *    snapshot is authoritative and OVERWRITES local state — so a mutation
 *    composed against stale local state would either be clobbered or delivered
 *    stale. Blocking the action (with a friendly toast) instead of freezing the
 *    whole app is the safe middle ground.
 */
export const reconnectActive = atom<boolean>(false);

/**
 * Grace before the pill appears / writes pause, so a normal fast (re)connect
 * doesn't flash anything and a <1.5 s blip (which `transport` would queue and
 * deliver almost immediately, with negligible staleness) doesn't block a tap.
 */
const SHOW_DELAY_MS = 1500;

function isDisconnected(): boolean {
    return (
        multiplayerEnabled.get() &&
        !demoMode.get() &&
        currentGameCode.get() !== null &&
        transportStatus.get() !== "open"
    );
}

let graceTimer: ReturnType<typeof setTimeout> | null = null;

function reevaluate() {
    if (isDisconnected()) {
        // Already active, or already counting down the grace — nothing to do.
        if (reconnectActive.get() || graceTimer !== null) return;
        graceTimer = setTimeout(() => {
            graceTimer = null;
            // Re-check: the socket may have reopened during the grace.
            if (isDisconnected()) reconnectActive.set(true);
        }, SHOW_DELAY_MS);
    } else {
        if (graceTimer !== null) {
            clearTimeout(graceTimer);
            graceTimer = null;
        }
        if (reconnectActive.get()) reconnectActive.set(false);
    }
}

/**
 * Install once from `main.tsx`, OUTSIDE React so it survives route changes.
 * Watches the connection signals and drives `reconnectActive`.
 */
export function installConnectionGate() {
    transportStatus.subscribe(reevaluate);
    currentGameCode.subscribe(reevaluate);
    multiplayerEnabled.subscribe(reevaluate);
    demoMode.subscribe(reevaluate);
}

/**
 * Central write-gate for a user-initiated mutating game action. Returns
 * `false` (and shows a deduped toast) while the reconnecting pill is up, so the
 * caller should abort BEFORE any local mutation or wire send. Returns `true`
 * (allow) in a healthy online game, in solo/offline play, and during the
 * sub-grace blip window.
 */
export function guardOnlineAction(
    message = "Reconnecting to the game — hang on a moment, then try again.",
): boolean {
    if (reconnectActive.get()) {
        toast.info(message, { toastId: "reconnect-write-blocked" });
        return false;
    }
    return true;
}
