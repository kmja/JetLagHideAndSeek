import { useStore } from "@nanostores/react";
import { Loader2, WifiOff } from "lucide-react";
import { useEffect, useState } from "react";

import { reconnectActive } from "@/lib/multiplayer/connectionGate";
import { transportReconnectAttempt } from "@/lib/multiplayer/session";
import { reconnectNow } from "@/lib/multiplayer/store";

/**
 * On-map "Reconnecting…" PILL (v1187, replacing the v935 full-screen curtain).
 * While `reconnectActive` (a real online game whose socket has been down past
 * the grace), show a small, clearly-visible status pill near the top of the
 * map — WITHOUT blocking the rest of the app. The player can still pan the map,
 * open the questions list, check the timer, etc.; only MUTATING game actions are
 * paused, and those are gated centrally in the store via `guardOnlineAction`
 * (see `connectionGate.ts`), not by a screen-covering overlay.
 *
 * The pill's wrapper is `pointer-events-none` so it never intercepts taps meant
 * for the map behind it — only the pill itself (and its Retry button) is
 * interactive.
 */

/**
 * If the auto-reconnect attempt counter is somehow stuck (e.g. a socket wedged
 * in CONNECTING before the transport's own connect-timeout trips), still give
 * the user a manual "Retry" once the pill has been up this long. Retry calls
 * `reconnectNow` → `forceReconnect`, dropping whatever socket exists and opening
 * a fresh one, so it can recover a state the auto-reconnect can't.
 */
const RETRY_FALLBACK_MS = 3_500;

export function ReconnectingBanner() {
    const active = useStore(reconnectActive);
    const $attempt = useStore(transportReconnectAttempt);
    const [fallbackRetry, setFallbackRetry] = useState(false);
    // Hold "Retry" back until the FIRST automatic reconnect has actually failed
    // (attempt ≥ 2), or the pill has simply been up a while — offering it during
    // a healthy in-progress reconnect just invites interrupting it.
    const showRetry = $attempt >= 2 || fallbackRetry;

    useEffect(() => {
        if (!active) {
            setFallbackRetry(false);
            return;
        }
        const t = window.setTimeout(
            () => setFallbackRetry(true),
            RETRY_FALLBACK_MS,
        );
        return () => window.clearTimeout(t);
    }, [active]);

    if (!active) return null;

    return (
        <div
            className="fixed inset-x-0 top-[calc(env(safe-area-inset-top)+3.5rem)] z-[1900] flex justify-center px-3 pointer-events-none"
            aria-live="polite"
        >
            <div
                className="pointer-events-auto flex items-center gap-2 rounded-full border border-border bg-card/95 text-card-foreground shadow-lg backdrop-blur px-3 py-1.5 max-w-[calc(100vw-1.5rem)] animate-in fade-in slide-in-from-top-2 duration-200"
                role="status"
                aria-label="Reconnecting to the game"
            >
                <span className="relative flex items-center shrink-0">
                    <WifiOff className="w-4 h-4 text-muted-foreground" />
                    <Loader2 className="w-3 h-3 animate-spin text-primary absolute -bottom-1 -right-1" />
                </span>
                <span className="text-xs font-semibold whitespace-nowrap">
                    Reconnecting…
                </span>
                {showRetry && (
                    <button
                        type="button"
                        onClick={() => reconnectNow()}
                        className="text-xs font-bold text-primary hover:underline whitespace-nowrap ml-0.5 focus-visible:outline-none focus-visible:underline"
                    >
                        Retry
                    </button>
                )}
            </div>
        </div>
    );
}

export default ReconnectingBanner;
