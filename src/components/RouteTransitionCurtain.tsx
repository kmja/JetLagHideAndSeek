import { useStore } from "@nanostores/react";
import { useEffect, useRef, useState } from "react";

import { HideSeekWordmark } from "@/components/JetLagLogo";
import { playerRole } from "@/lib/hiderRole";
import { cn } from "@/lib/utils";

const isHiderSide = (r: string | null) => r === "hider" || r === "coHider";

/**
 * Branded transition curtain for the seeker↔hider SHELL swap (v805).
 *
 * Picking a role navigates between two SEPARATE full-screen apps — the seeker
 * (`/`) and hider (`/h`) routes each mount their own MapLibre map — so the
 * route change tears one whole tree down and builds the other. That reads as
 * a jarring "reload" even though it's a soft SPA navigation (see App.tsx's
 * `GameRouteGate` / `appNavigate`, NOT a `window.location` reload).
 *
 * This covers that swap with a `bg-background` + wordmark curtain that snaps
 * in the instant the role crosses the seeker/hider boundary (masking the
 * closing RolePicker dialog + the tree swap) and fades out once the new shell
 * has had a beat to mount — so the whole thing reads as one smooth branded
 * wipe. Driven purely off the `playerRole` atom (the same signal that drives
 * the route redirect), so it's mounted OUTSIDE the router in `App` and
 * survives the navigation.
 */
export function RouteTransitionCurtain() {
    const role = useStore(playerRole);
    const prevRole = useRef(role);
    const [active, setActive] = useState(false);
    // Drives the opacity: starts opaque (instant cover), flips transparent to
    // fade out.
    const [shown, setShown] = useState(false);

    useEffect(() => {
        const prev = prevRole.current;
        prevRole.current = role;
        // Curtain whenever the role crosses the seeker↔hider boundary — which
        // is exactly when the route swaps shells. This INCLUDES the host's
        // null→hider pick (null renders on the seeker `/` side, so
        // isHiderSide flips false→true and the route redirects to `/h`), the
        // case the jank was reported for. A coHider↔hider shuffle or a
        // seeker↔null change stays on the same shell → isHiderSide is
        // unchanged → no curtain.
        if (isHiderSide(prev) !== isHiderSide(role)) {
            setActive(true);
            setShown(true);
            const HOLD_MS = 320; // covers the tree swap + first map init frame
            const FADE_MS = 340;
            const t1 = window.setTimeout(() => setShown(false), HOLD_MS);
            const t2 = window.setTimeout(
                () => setActive(false),
                HOLD_MS + FADE_MS,
            );
            return () => {
                window.clearTimeout(t1);
                window.clearTimeout(t2);
            };
        }
    }, [role]);

    if (!active) return null;
    return (
        <div
            aria-hidden="true"
            className={cn(
                "fixed inset-0 z-[2000] flex items-center justify-center bg-background",
                "transition-opacity duration-300 ease-out",
                shown ? "opacity-100" : "opacity-0",
            )}
        >
            <HideSeekWordmark size="lg" className="text-foreground" />
        </div>
    );
}

export default RouteTransitionCurtain;
