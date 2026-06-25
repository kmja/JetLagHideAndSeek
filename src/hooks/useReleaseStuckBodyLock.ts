import { useEffect } from "react";

/**
 * Release a leftover body interaction-lock after the lobby→in-game
 * branch swap.
 *
 * `SeekerPage`/`HiderPage` hard-swap their entire component tree the
 * instant `hidingPeriodEndsAt` flips non-null (game start). On a guest
 * device that flip arrives as a multiplayer `setupChanged` push *while
 * the lobby drawer is still open*, so the vaul `Drawer` / Radix
 * `Dialog` unmounts without its close handler ever running. Both
 * libraries set `document.body.style.pointerEvents = "none"` while a
 * modal is open and only restore it on a clean close — an
 * unmount-mid-open can leave the body permanently
 * `pointer-events: none`, freezing the freshly-mounted in-game shell
 * to ALL input while background timers (the hiding clock) keep
 * ticking. That's the "seeker view completely unresponsive but the
 * hiding timer keeps ticking up" bug. (Known vaul behaviour:
 * https://github.com/emilkowalski/vaul/issues — the restore is
 * deferred and can be skipped when the drawer is removed rather than
 * closed.)
 *
 * When the in-game shell mounts we clear any such leftover. At game
 * start no modal legitimately needs the body lock, so this is safe;
 * we guard on the value actually being `"none"` and fire once on the
 * transition plus once more shortly after, in case vaul re-asserts
 * during its own unmount path.
 *
 * @param active true once the in-game shell is mounted (game started).
 */
export function useReleaseStuckBodyLock(active: boolean) {
    useEffect(() => {
        if (!active) return;
        const release = () => {
            if (document.body.style.pointerEvents === "none") {
                document.body.style.pointerEvents = "";
            }
        };
        // Once after paint, once more after vaul's animation-length
        // restore window would have elapsed — idempotent, so the second
        // pass is a no-op unless the first raced a stale re-assert.
        const raf = requestAnimationFrame(release);
        const timer = window.setTimeout(release, 400);
        return () => {
            cancelAnimationFrame(raf);
            window.clearTimeout(timer);
        };
    }, [active]);
}
