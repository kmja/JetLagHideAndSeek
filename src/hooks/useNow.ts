import { atom } from "nanostores";
import { useEffect, useState } from "react";

/**
 * Shared 1 Hz clock (v377).
 *
 * The app had ~10 independent `useVisibleInterval(() => setNow(Date.now()),
 * 1000)` timers — one per countdown component, and crucially one PER
 * QUESTION CARD (cards/base.tsx). With 8 questions in the sidebar that's
 * 8+ separate setInterval callbacks firing at slightly different sub-second
 * offsets, each triggering its own React render pass. That's continuous
 * re-render pressure and a battery drain.
 *
 * `useNow` replaces all of them with ONE process-wide interval, ref-counted
 * so it only runs while at least one consumer is mounted+enabled, and
 * visibility-gated (paused while the tab is hidden) exactly like the old
 * hook. Because every consumer reads the same atom, a tick fans out to all
 * of them in a SINGLE batched React render instead of N staggered ones.
 *
 * Usage — drop-in for the old pattern:
 *
 *   const now = useNow(enabled);   // was: useState + useVisibleInterval
 *
 * When `enabled` is false the consumer doesn't subscribe (no re-renders),
 * matching the old `enabled` gate. The returned value is then a stable
 * snapshot — fine because a disabled countdown isn't being displayed.
 */
const nowAtom = atom<number>(Date.now());

let refCount = 0;
let intervalId: ReturnType<typeof setInterval> | null = null;
let visibilityHandler: (() => void) | null = null;

function tick() {
    nowAtom.set(Date.now());
}

function runInterval() {
    if (intervalId !== null) return;
    tick(); // immediate, so a resumed tab isn't stale for up to a second
    intervalId = setInterval(tick, 1000);
}

function pauseInterval() {
    if (intervalId === null) return;
    clearInterval(intervalId);
    intervalId = null;
}

function acquire() {
    refCount++;
    if (refCount > 1) return;
    // First consumer — start the clock + wire visibility gating.
    if (typeof document === "undefined") {
        runInterval();
        return;
    }
    visibilityHandler = () => {
        if (document.visibilityState === "visible") runInterval();
        else pauseInterval();
    };
    document.addEventListener("visibilitychange", visibilityHandler);
    if (document.visibilityState === "visible") runInterval();
}

function release() {
    refCount--;
    if (refCount > 0) return;
    pauseInterval();
    if (visibilityHandler) {
        document.removeEventListener("visibilitychange", visibilityHandler);
        visibilityHandler = null;
    }
}

export function useNow(enabled: boolean = true): number {
    const [now, setNow] = useState<number>(() => Date.now());
    useEffect(() => {
        if (!enabled) return;
        acquire();
        // nanostores fires subscribe synchronously with the current value,
        // so this also syncs `now` to the shared clock immediately.
        const unsub = nowAtom.subscribe((v) => setNow(v));
        return () => {
            unsub();
            release();
        };
    }, [enabled]);
    return now;
}
