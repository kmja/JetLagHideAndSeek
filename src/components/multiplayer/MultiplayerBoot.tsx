import { useEffect } from "react";
import { toast } from "react-toastify";

import {
    currentGameCode,
    displayName as displayNameAtom,
    multiplayerEnabled,
} from "@/lib/multiplayer/session";
import {
    installMultiplayerBridge,
    joinAsGuest,
    tryResumeFromPersistent,
} from "@/lib/multiplayer/store";

/**
 * Tiny mount-only component that wires the multiplayer transport
 * into the store bridge on first render, attempts to resume any
 * previously-active game, and then handles a `?join=CODE` URL
 * parameter for invite-link entry.
 *
 * Render once per page (both `index.astro` and `h.astro` mount it).
 * It returns nothing visible.
 */
export function MultiplayerBoot() {
    useEffect(() => {
        installMultiplayerBridge();
        // v363: defer the WS connect until after window.onload so
        // browsers don't surface "WebSocket interrupted while the page
        // was loading" — Firefox/Edge log that whenever a WS is opened
        // during the initial load and the browser races the handshake
        // against the load completion. Transport already auto-reconnects
        // on that race, so it was just console noise; deferring kills
        // the noise at the source. If we're already past `load`, fire
        // synchronously to keep the resume snappy.
        const fire = () => {
            // v779: demo games no longer persist across a reload (demoMode is
            // volatile again — see session.ts), so there is nothing to resume;
            // a reloaded demo simply drops to offline. Real games reconnect via
            // the persisted session below.
            tryResumeFromPersistent();
            maybeAutoJoinFromUrl();
        };
        if (document.readyState === "complete") {
            fire();
        } else {
            window.addEventListener("load", fire, { once: true });
        }
    }, []);
    return null;
}

/**
 * Read `?join=CODE` from the URL and connect as a guest if we aren't
 * already in a room. If no display name has been chosen yet we still
 * connect with a placeholder so the user can edit it later from Game
 * Settings → Online play; this beats throwing them into a name prompt
 * before they've even seen the app.
 */
function maybeAutoJoinFromUrl() {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const code = params.get("join");
    if (!code) return;
    const trimmed = code.trim().toUpperCase();
    if (!/^[A-Z0-9]{4,8}$/.test(trimmed)) return;

    // If we're already in a game (e.g. resumed from persistent state),
    // don't trample it. The user can leave manually if they want to
    // switch rooms.
    if (multiplayerEnabled.get() && currentGameCode.get()) {
        toast.info(
            "Already in an online game — leave it first to join a new one.",
            { autoClose: 3500 },
        );
        return;
    }

    // Send the typed name, or empty to let the server assign a unique
    // Jet Lag cast name (avoids two players defaulting to the same one).
    const name = (displayNameAtom.get() || "").trim();
    joinAsGuest(trimmed, name);
    toast.info(`Joining game ${trimmed}…`, { autoClose: 2500 });

    // Tidy the URL so the user doesn't accidentally re-trigger the
    // join (or share a polluted address bar). `replaceState` keeps
    // history clean without forcing a reload.
    params.delete("join");
    const cleaned = `${window.location.pathname}${
        params.toString() ? `?${params.toString()}` : ""
    }${window.location.hash}`;
    window.history.replaceState(null, "", cleaned);
}

export default MultiplayerBoot;
