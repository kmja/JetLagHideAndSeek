import { debugPanelOpen } from "@/lib/debugState";

/** Taps needed in quick succession to reveal the debug panel. */
const TAPS_NEEDED = 5;
/** Max gap (ms) between taps before the counter resets. */
const TAP_WINDOW_MS = 700;
/** Top-centre hit region (px): within this half-width of the horizontal
 *  centre AND within this distance of the very top of the viewport. */
const REGION_HALF_WIDTH_PX = 130;
const REGION_HEIGHT_PX = 96;

let count = 0;
let last = 0;
let installed = false;

function onPointerDown(e: PointerEvent) {
    const cx = window.innerWidth / 2;
    if (Math.abs(e.clientX - cx) > REGION_HALF_WIDTH_PX) return;
    if (e.clientY > REGION_HEIGHT_PX) return;
    const now = Date.now();
    // Reset the streak if it's been too long since the previous tap.
    if (now - last > TAP_WINDOW_MS) count = 0;
    last = now;
    count += 1;
    if (count >= TAPS_NEEDED) {
        count = 0;
        debugPanelOpen.set(true);
    }
}

/**
 * Install the hidden debug gesture (v883): tapping the TOP-CENTRE of the
 * screen 5 times in quick succession opens the developer debug panel. It's a
 * passive, capture-phase document listener that only OBSERVES taps landing in
 * a small top-centre region — it never blocks or consumes the event, so it
 * doesn't interfere with any UI (a modal title, a header, the wordmark). This
 * works ACROSS THE APP, on every screen, not just where the wordmark shows,
 * and there's no visible launcher to tap accidentally. Idempotent; called once
 * from `main.tsx`.
 */
export function installDebugSecretTap(): void {
    if (installed || typeof window === "undefined") return;
    installed = true;
    window.addEventListener("pointerdown", onPointerDown, {
        capture: true,
        passive: true,
    });
}
