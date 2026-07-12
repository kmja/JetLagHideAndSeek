/**
 * Global self-healing guard for the recurring stuck
 * `body { pointer-events: none }` bug.
 *
 * ROOT CAUSE. `@radix-ui/react-dismissable-layer` (used by every Radix modal —
 * Dialog, AlertDialog, Select, modal Popover/DropdownMenu) disables background
 * interaction by setting `document.body.style.pointerEvents = "none"` when the
 * FIRST modal layer opens, and restoring it when the LAST one closes. The saved
 * "before" value lives in a MODULE-LEVEL `originalBodyPointerEvents`, captured
 * only on the 0→1 transition:
 *
 *     if (layers.size === 0) {
 *         originalBodyPointerEvents = body.style.pointerEvents;  // capture
 *         body.style.pointerEvents = "none";
 *     }
 *     layers.add(node);
 *     // cleanup:
 *     layers.delete(node);
 *     if (layers.size === 0) body.style.pointerEvents = originalBodyPointerEvents;
 *
 * That single shared slot desyncs in three ways this app hits constantly:
 *   1. A modal layer UNMOUNTS abruptly (a route change on role-pick, the
 *      lobby→in-game shell swap on a multiplayer push) so its cleanup — the
 *      only code that restores the body — never runs. The body stays "none".
 *   2. Overlapping layers (a Radix Dialog opened over a vaul Drawer, an
 *      AlertDialog over a Dialog) capture `originalBodyPointerEvents = "none"`
 *      on a nested 0→1 transition, so the eventual restore sets it BACK to
 *      "none".
 *   3. vaul also writes `body.style.pointerEvents` — but ONLY ever "auto"
 *      (to release a lock on a non-modal drawer); it never writes "none".
 *
 * Point 3 is what makes a reliable fix possible: **Radix is the ONLY source of
 * `body{pointer-events:none}`.** So a stray "none" is legitimate iff a Radix
 * modal layer is currently open in the DOM; if none is, the lock is orphaned
 * and safe to clear.
 *
 * This installs ONE observer for the whole app lifetime that clears an orphaned
 * lock — replacing the per-component band-aids (`useReleaseStuckBodyLock`, and
 * the ad-hoc clears in AddQuestionDialog / RolePicker / StationTransitCard).
 * Clearing is safe even in the rare false-negative (a modal source not matched
 * by the query below): every Radix modal ALSO renders a full-screen Overlay
 * that already blocks outside clicks, so the body lock is redundant
 * belt-and-braces, not the sole guard.
 */

// Selectors for an OPEN Radix modal layer — the states in which
// `body{pointer-events:none}` is legitimate. Non-modal layers don't disable
// outside pointer events, so they never set the lock and aren't listed.
const OPEN_MODAL_LAYER_SELECTOR = [
    '[role="dialog"][data-state="open"]',
    '[role="alertdialog"][data-state="open"]',
    '[role="menu"][data-state="open"]',
    '[role="listbox"][data-state="open"]',
    // Modal Popover / Select / DropdownMenu content lives inside a popper
    // wrapper; its presence means such a layer is open.
    "[data-radix-popper-content-wrapper]",
].join(",");

function aRadixModalLayerIsOpen(): boolean {
    return document.querySelector(OPEN_MODAL_LAYER_SELECTOR) !== null;
}

/**
 * Clear an ORPHANED `body{pointer-events:none}` right now, synchronously.
 * No-op when the body isn't locked, or when a Radix modal layer is genuinely
 * open (the lock is legitimate then). Exported for unit testing and for any
 * caller that wants an immediate heal without waiting for the observer.
 */
export function healBodyPointerEventsNow(): void {
    if (typeof document === "undefined") return;
    const body = document.body;
    if (!body || body.style.pointerEvents !== "none") return;
    if (aRadixModalLayerIsOpen()) return;
    body.style.pointerEvents = "";
}

/**
 * Install the guard. Returns a disposer (mainly for tests / HMR). In the app
 * it's installed once from `main.tsx` and never torn down.
 */
export function installBodyPointerEventsGuard(): () => void {
    if (
        typeof document === "undefined" ||
        typeof MutationObserver === "undefined"
    ) {
        return () => {};
    }
    const body = document.body;
    let raf1 = 0;
    let raf2 = 0;

    const heal = healBodyPointerEventsNow;

    // Debounce to the next two animation frames so we never fight Radix
    // mid-transition: a closing layer's cleanup restores the body in its own
    // tick, and a genuinely-open layer must be given a frame to appear in the
    // DOM before we conclude "nothing is open".
    const schedule = () => {
        cancelAnimationFrame(raf1);
        cancelAnimationFrame(raf2);
        raf1 = requestAnimationFrame(() => {
            raf2 = requestAnimationFrame(heal);
        });
    };

    // (a) The body's inline style changed — a lock may have just been set (or
    //     poisoned back to "none" by a nested restore).
    const styleObserver = new MutationObserver(() => {
        if (body.style.pointerEvents === "none") schedule();
    });
    styleObserver.observe(body, {
        attributes: true,
        attributeFilter: ["style"],
    });

    // (b) A portal mounted/unmounted (Radix + vaul portal to <body>). A modal
    //     layer unmounting is exactly the case that orphans the lock, so
    //     re-check whenever body's direct children change. childList only (no
    //     subtree) keeps this cheap.
    const treeObserver = new MutationObserver(() => {
        if (body.style.pointerEvents === "none") schedule();
    });
    treeObserver.observe(body, { childList: true });

    // Heal a lock that was already stuck before the guard installed.
    schedule();

    return () => {
        styleObserver.disconnect();
        treeObserver.disconnect();
        cancelAnimationFrame(raf1);
        cancelAnimationFrame(raf2);
    };
}

export default installBodyPointerEventsGuard;
