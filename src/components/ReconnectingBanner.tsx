import { useStore } from "@nanostores/react";
import { Loader2, WifiOff } from "lucide-react";
import { useEffect, useState } from "react";

import {
    currentGameCode,
    demoMode,
    multiplayerEnabled,
    transportReconnectAttempt,
    transportStatus,
} from "@/lib/multiplayer/session";
import { reconnectNow } from "@/lib/multiplayer/store";
import { Button } from "@/components/ui/button";

/**
 * Full-screen "Reconnecting…" curtain (v935). While we're in a multiplayer
 * game (a room code is set) but the transport isn't OPEN, dim + block the
 * app so the player can't act against a stale, un-synced state — and so it's
 * obvious the game is mid-reconnect rather than silently broken. A short
 * grace delay keeps a normal fast (re)connect from flashing the curtain.
 *
 * This pairs with the transport's resume liveness probe: a backgrounded
 * socket that comes back a zombie now force-reconnects, flipping the status
 * to "reconnecting" — which this surfaces instead of leaving the user
 * staring at a frozen board that isn't receiving updates.
 */
const SHOW_DELAY_MS = 1500;

export function ReconnectingBanner() {
    const $status = useStore(transportStatus);
    const $code = useStore(currentGameCode);
    const $mp = useStore(multiplayerEnabled);
    const $demo = useStore(demoMode);
    const $attempt = useStore(transportReconnectAttempt);
    const [visible, setVisible] = useState(false);
    // Hold the manual "Retry now" back until the FIRST automatic reconnect
    // attempt has actually failed (attempt ≥ 2 = first retry already came back
    // unsuccessful). Offering it during a healthy in-progress reconnect just
    // invites the user to interrupt it. The auto-reconnect resolves the vast
    // majority of drops on its own within a second or two.
    const showRetry = $attempt >= 2;

    // In a real online game but the socket isn't open → we're disconnected.
    // Demo mode presents as "open" and never hits this, but guard anyway.
    const disconnected =
        $mp && !$demo && $code !== null && $status !== "open";

    useEffect(() => {
        if (!disconnected) {
            setVisible(false);
            return;
        }
        const t = window.setTimeout(() => setVisible(true), SHOW_DELAY_MS);
        return () => window.clearTimeout(t);
    }, [disconnected]);

    if (!visible) return null;

    return (
        <div
            className="fixed inset-0 z-[1900] flex items-center justify-center bg-black/65 backdrop-blur-sm px-6 animate-in fade-in duration-200"
            role="alertdialog"
            aria-live="assertive"
            aria-label="Reconnecting to the game"
        >
            <div className="w-full max-w-xs rounded-2xl border border-border bg-card text-card-foreground shadow-2xl p-6 flex flex-col items-center text-center gap-3">
                <div className="relative">
                    <WifiOff className="w-8 h-8 text-muted-foreground" />
                    <Loader2 className="w-4 h-4 animate-spin text-primary absolute -bottom-1 -right-1" />
                </div>
                <div className="space-y-1">
                    <p className="font-display font-bold text-lg">
                        Reconnecting…
                    </p>
                    <p className="text-sm text-muted-foreground leading-snug">
                        Lost the connection to your game. Hold tight — your
                        progress is safe and we'll resync automatically.
                    </p>
                </div>
                {showRetry && (
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => reconnectNow()}
                        className="mt-1"
                    >
                        Retry now
                    </Button>
                )}
            </div>
        </div>
    );
}

export default ReconnectingBanner;
