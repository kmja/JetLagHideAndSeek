import { Suspense } from "react";

import { Welcome } from "@/components/Welcome";
import { lazyWithRetry } from "@/lib/lazyWithRetry";

// Lazy so the debug bundle never loads on a normal launch — it only
// pulls in when the floating "debug" chip is actually opened. Same
// pattern as the seeker/hider shells.
const DebugPhaseControls = lazyWithRetry(() =>
    import("@/components/DebugPhaseControls").then((m) => ({
        default: m.DebugPhaseControls,
    })),
);

/**
 * /welcome route. Thin wrapper around the Welcome panel so the
 * seeker / hider shells (sidebars, map, top + bottom nav, lazy
 * drawers) never load on app launch for a fresh user. The route
 * guards in App.tsx redirect unseen users here from `/` and `/h`;
 * Welcome itself reverse-redirects to / or /h once a path is
 * picked.
 *
 * The debug panel is mounted here too (its floating chip + panel) so
 * testers can reach the developer tools — phase controls, card / overlay
 * galleries, GPS spoof, data reset — straight from the landing page,
 * without first entering a game.
 */
export function WelcomePage() {
    return (
        <>
            <Welcome />
            <Suspense fallback={null}>
                <DebugPhaseControls />
            </Suspense>
        </>
    );
}

export default WelcomePage;
