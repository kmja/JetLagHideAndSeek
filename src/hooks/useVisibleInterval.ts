import { useEffect } from "react";

/**
 * `setInterval` that pauses while the document is hidden.
 *
 * On mobile, the app often spends hours running countdowns and
 * elapsed-time displays. Each `setInterval(_, 1000)` keeps the
 * CPU woken once per second — a meaningful battery hit when the
 * user has the screen off or has switched apps. This hook gates
 * those ticks on `document.visibilityState === "visible"` and
 * re-syncs once on every `visibilitychange` so the visible state
 * never lags by more than one tick.
 *
 * Usage:
 *
 *   useVisibleInterval(() => setNow(Date.now()), 1000);
 *
 * The callback is invoked immediately on visibility-resume so the
 * displayed value matches reality before the next tick. Pass
 * `enabled = false` to suspend (returns a no-op cleanup).
 */
export function useVisibleInterval(
    callback: () => void,
    intervalMs: number,
    enabled: boolean = true,
): void {
    useEffect(() => {
        if (!enabled) return;
        if (typeof document === "undefined") return;

        let id: number | null = null;

        const start = () => {
            if (id !== null) return;
            // Fire once immediately so a long hidden-period catch-up
            // doesn't leave displayed values stale for up to
            // `intervalMs` after the tab returns.
            callback();
            id = window.setInterval(callback, intervalMs);
        };
        const stop = () => {
            if (id === null) return;
            window.clearInterval(id);
            id = null;
        };

        const onVisibility = () => {
            if (document.visibilityState === "visible") start();
            else stop();
        };

        // Kick off according to current state.
        onVisibility();
        document.addEventListener("visibilitychange", onVisibility);
        return () => {
            document.removeEventListener("visibilitychange", onVisibility);
            stop();
        };
    }, [intervalMs, enabled]);
}
