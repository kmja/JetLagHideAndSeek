import { useRef } from "react";

import { debugPanelOpen } from "@/lib/debugState";

/** Taps needed in quick succession to reveal the debug panel. */
const TAPS_NEEDED = 5;
/** Max gap (ms) between taps before the counter resets. */
const TAP_WINDOW_MS = 700;

/**
 * Secret gesture to open the developer debug panel (v882): the header
 * wordmark (dead-centre, top of the screen) must be tapped 5 times in quick
 * succession. A single tap does nothing, so the panel is no longer trivially
 * discoverable during a demo — but it stays reachable for development without
 * a visible launcher. Returns an onClick handler; the wordmark otherwise reads
 * as plain branding.
 */
export function useDebugSecretTap(): () => void {
    const count = useRef(0);
    const last = useRef(0);
    return () => {
        const now = Date.now();
        // Reset the streak if it's been too long since the previous tap.
        if (now - last.current > TAP_WINDOW_MS) count.current = 0;
        last.current = now;
        count.current += 1;
        if (count.current >= TAPS_NEEDED) {
            count.current = 0;
            debugPanelOpen.set(true);
        }
    };
}
