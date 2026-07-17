import { useEffect } from "react";

/**
 * Hold a Screen Wake Lock while `enabled` is true (v938).
 *
 * The web platform has NO background-geolocation API: the seeker's live
 * location broadcast is `watchPosition` + a timer, which the browser
 * suspends the moment the page stops executing (screen off, app
 * backgrounded). A Screen Wake Lock keeps the screen on — and therefore the
 * page alive — WHILE the app is open and foregrounded, so a seeker who keeps
 * the app in-hand doesn't have their location die the instant the display
 * would otherwise time out. It CANNOT help once the app is switched away or
 * the screen is manually turned off (the lock auto-releases when the page is
 * hidden) — that genuinely needs a native app.
 *
 * The lock is re-acquired on `visibilitychange → visible` because the
 * platform releases it whenever the page is hidden. All failures are
 * swallowed: the API is unsupported on some browsers, and a request throws
 * if made while the page is hidden — neither should ever surface an error.
 */
export function useWakeLock(enabled: boolean): void {
    useEffect(() => {
        if (!enabled) return;
        if (typeof navigator === "undefined") return;
        const wl = (
            navigator as Navigator & {
                wakeLock?: {
                    request: (type: "screen") => Promise<WakeLockSentinelLike>;
                };
            }
        ).wakeLock;
        if (!wl) return;

        let sentinel: WakeLockSentinelLike | null = null;
        let cancelled = false;

        const acquire = async () => {
            if (cancelled || sentinel) return;
            try {
                sentinel = await wl.request("screen");
                // The lock drops on its own when the page hides; clear our
                // handle so the visibility handler re-acquires on return.
                sentinel.addEventListener?.("release", () => {
                    sentinel = null;
                });
            } catch {
                /* unsupported / not allowed while hidden — ignore */
            }
        };

        const onVisibility = () => {
            if (document.visibilityState === "visible") void acquire();
        };

        void acquire();
        document.addEventListener("visibilitychange", onVisibility);

        return () => {
            cancelled = true;
            document.removeEventListener("visibilitychange", onVisibility);
            if (sentinel) {
                try {
                    void sentinel.release?.();
                } catch {
                    /* ignore */
                }
                sentinel = null;
            }
        };
    }, [enabled]);
}

/** Minimal shape of a WakeLockSentinel (types vary across TS DOM libs). */
interface WakeLockSentinelLike {
    release?: () => Promise<void>;
    addEventListener?: (type: "release", listener: () => void) => void;
}
