import { useEffect } from "react";

import {
    installMultiplayerBridge,
    tryResumeFromPersistent,
} from "@/lib/multiplayer/store";

/**
 * Tiny mount-only component that wires the multiplayer transport
 * into the store bridge on first render, then attempts to resume a
 * previously-active game (using persisted `sessionToken` +
 * `currentGameCode`).
 *
 * Render once per page (both `index.astro` and `h.astro` mount it).
 * It returns nothing visible.
 */
export function MultiplayerBoot() {
    useEffect(() => {
        installMultiplayerBridge();
        tryResumeFromPersistent();
    }, []);
    return null;
}

export default MultiplayerBoot;
