import { useStore } from "@nanostores/react";
import { Suspense, useEffect } from "react";
import {
    createBrowserRouter,
    Navigate,
    RouterProvider,
    useNavigate,
} from "react-router-dom";
import { ToastContainer } from "react-toastify";

import { registerAppNavigate } from "@/lib/appNavigate";

import { BetaGate } from "@/components/BetaGate";
import { GoGoGoOverlay } from "@/components/GoGoGoOverlay";
import { MapErrorBoundary } from "@/components/MapErrorBoundary";
import { PWAUpdatePrompt } from "@/components/PWAUpdatePrompt";
import { CurseRevealOverlay } from "@/components/CurseRevealOverlay";
import { ReconnectingBanner } from "@/components/ReconnectingBanner";
import { RouteTransitionCurtain } from "@/components/RouteTransitionCurtain";
import { RulebookSheet } from "@/components/RulebookSheet";
import { SpoofIndicator } from "@/components/SpoofIndicator";
import { WakeLockController } from "@/components/WakeLockController";
import { installGpsSpoof } from "@/lib/debugGpsSpoof";
import { setupCompleted, welcomeSeen } from "@/lib/gameSetup";
import { playerRole } from "@/lib/hiderRole";
import { lazyWithRetry } from "@/lib/lazyWithRetry";

// v353: install the debug GPS-spoof monkey-patch at module load —
// BEFORE any component mounts — so a watchPosition started on mount
// (the main map's blue dot, the seeker-location broadcast) is already
// spoof-aware. A no-op until the debug panel actually sets a spoof.
installGpsSpoof();

// Each route is lazy-loaded so a user landing on `/` never has to
// download the hider bundle (and vice versa for `/h`). Wrapped in
// lazyWithRetry so a stale-SW chunk 404 self-heals on the second
// attempt instead of bombing straight to a blank page.
const SeekerPage = lazyWithRetry(() =>
    import("@/pages/SeekerPage").then((m) => ({ default: m.SeekerPage })),
);
const HiderPage = lazyWithRetry(() =>
    import("@/pages/HiderPage").then((m) => ({ default: m.HiderPage })),
);
// Developer-only card gallery. Lazy so it never weighs on the real
// routes; reachable from the debug panel's "Card gallery" link.
const DebugCardsPage = lazyWithRetry(() =>
    import("@/pages/DebugCardsPage").then((m) => ({
        default: m.DebugCardsPage,
    })),
);
const DebugOverlaysPage = lazyWithRetry(() =>
    import("@/pages/DebugOverlaysPage").then((m) => ({
        default: m.DebugOverlaysPage,
    })),
);
const DebugAdjacencyPage = lazyWithRetry(() =>
    import("@/pages/DebugAdjacencyPage").then((m) => ({
        default: m.DebugAdjacencyPage,
    })),
);
// First-time / new-game wizard route (v252). Was a dialog overlay
// on the seeker view; now its own page. Reached via the Welcome
// screen's "Start new game" or the route-level redirect when
// `setupCompleted` flips false.
const SetupPage = lazyWithRetry(() =>
    import("@/pages/SetupPage").then((m) => ({ default: m.SetupPage })),
);
// Fresh-launch welcome route (v267). Was a dialog overlaid on the
// seeker view; now its own page so the seeker shell never loads on
// app launch for a first-time user. The seeker/hider route guards
// redirect unseen users here.
const WelcomePage = lazyWithRetry(() =>
    import("@/pages/WelcomePage").then((m) => ({ default: m.WelcomePage })),
);

/**
 * Game-route gate. Wraps the seeker / hider pages so neither shell
 * (sidebars, map, top + bottom nav, drawers) loads while the user
 * is still on the welcome / setup screens. Routes through the same
 * two atoms the inner pages used to read in `useEffect`s — but at
 * the route level so the redirect happens BEFORE the page mounts,
 * not after a frame of seeker chrome flashes.
 *
 * v292: also enforces role/route consistency. RolePicker handles
 * the role→route nav on click, but a reload or deep link to the
 * wrong shell used to leave the user on the seeker page with the
 * hider role (visible bug: seeker bottom-nav under the hider role).
 * The gate now bounces hider/co-hider visits to `/` over to `/h`
 * (and vice versa for a seeker landing on `/h`).
 */
function GameRouteGate({
    children,
    expectedRole,
}: {
    children: React.ReactNode;
    expectedRole: "seeker" | "hider";
}) {
    const $welcomeSeen = useStore(welcomeSeen);
    const $setupCompleted = useStore(setupCompleted);
    const $role = useStore(playerRole);
    if (!$welcomeSeen) {
        // Preserve a shared `?join=CODE` deep link when bouncing a fresh
        // device to /welcome, so the join flow can prefill the room code
        // (the param would otherwise be dropped by the redirect). v925.
        const join = new URLSearchParams(window.location.search).get("join");
        return (
            <Navigate
                to={join ? `/welcome?join=${encodeURIComponent(join)}` : "/welcome"}
                replace
            />
        );
    }
    if (!$setupCompleted) return <Navigate to="/setup" replace />;
    if ($role !== null) {
        const onHiderSide = $role === "hider";
        if (expectedRole === "seeker" && onHiderSide) {
            return <Navigate to="/h" replace />;
        }
        if (expectedRole === "hider" && !onHiderSide) {
            return <Navigate to="/" replace />;
        }
    }
    return <>{children}</>;
}

// Both routes mount under the same Suspense boundary so the
// fallback (or lack thereof) is consistent. The route chunks
// load in well under a second on any reasonable connection so
// the fallback is just a faint spinner — short enough not to
// feel laggy, present enough that a slow connection doesn't
// look like the app is broken. The error boundary catches
// chunk 404s after a redeploy and offers a recover-and-reload
// path; without it, a stale SW that 404s the page chunk leaves
// the user staring at a blank screen with no escape.
/** Registers React Router's `navigate` with the appNavigate bridge so plain
 *  modules (multiplayer/store.ts) can SOFT-navigate on a role change instead
 *  of a full `window.location` reload. Mounted in every route via
 *  RouteWrapper, so a navigate is always registered while the app is up. */
function NavigationBridge() {
    const navigate = useNavigate();
    useEffect(() => {
        registerAppNavigate((to, opts) => navigate(to, opts));
        return () => registerAppNavigate(null);
    }, [navigate]);
    return null;
}

const RouteWrapper = ({ element }: { element: React.ReactNode }) => (
    <MapErrorBoundary>
        <NavigationBridge />
        <Suspense
            fallback={
                <div className="fixed inset-0 flex items-center justify-center bg-background">
                    <div className="h-8 w-8 rounded-full border-2 border-muted-foreground/30 border-t-primary animate-spin" />
                </div>
            }
        >
            {element}
        </Suspense>
    </MapErrorBoundary>
);

// Single React-Router root. The Astro era had two .astro pages
// each compiled to its own HTML shell; the SPA serves a single
// shell and the router picks SeekerPage / HiderPage by pathname.
// SPA fallback to index.html is configured in wrangler.jsonc so
// deep links keep working.
const router = createBrowserRouter([
    {
        path: "/",
        element: (
            <RouteWrapper
                element={
                    <GameRouteGate expectedRole="seeker">
                        <SeekerPage />
                    </GameRouteGate>
                }
            />
        ),
    },
    {
        path: "/h",
        element: (
            <RouteWrapper
                element={
                    <GameRouteGate expectedRole="hider">
                        <HiderPage />
                    </GameRouteGate>
                }
            />
        ),
    },
    {
        path: "/h/",
        element: (
            <RouteWrapper
                element={
                    <GameRouteGate expectedRole="hider">
                        <HiderPage />
                    </GameRouteGate>
                }
            />
        ),
    },
    { path: "/welcome", element: <RouteWrapper element={<WelcomePage />} /> },
    { path: "/setup", element: <RouteWrapper element={<SetupPage />} /> },
    {
        path: "/debug/cards",
        element: <RouteWrapper element={<DebugCardsPage />} />,
    },
    {
        path: "/debug/overlays",
        element: <RouteWrapper element={<DebugOverlaysPage />} />,
    },
    {
        path: "/debug/adjacency",
        element: <RouteWrapper element={<DebugAdjacencyPage />} />,
    },
    // Catch-all — anything else lands on the seeker shell (which the
    // gate then redirects from if welcome / setup haven't been done,
    // or if the current playerRole belongs on /h).
    {
        path: "*",
        element: (
            <RouteWrapper
                element={
                    <GameRouteGate expectedRole="seeker">
                        <SeekerPage />
                    </GameRouteGate>
                }
            />
        ),
    },
]);

export function App() {
    return (
        // v817: a ROOT error boundary. Per-route boundaries (RouteWrapper)
        // already catch page crashes, but a throw in BetaGate, the router
        // itself, or the transition curtain used to bubble past them and
        // blank the whole page to white with no recovery. MapErrorBoundary
        // is a general boundary whose Reload wipes the SW + Cache Storage —
        // which is also the fix for the "stale service-worker serves an
        // index pointing at chunks the latest deploy replaced" white screen
        // that a rapid deploy cadence can cause.
        <MapErrorBoundary>
            <BetaGate>
                <RouterProvider router={router} />
            </BetaGate>
            {/* Branded curtain over the seeker↔hider shell swap — mounted
                OUTSIDE the router so it survives the route change. */}
            <RouteTransitionCurtain />
            {/* v822: the game-start flourish is mounted ONCE here, above the
                router, so it survives the pre-game→in-game branch swap inside
                SeekerPage/HiderPage. That's what lets the overlay stay up
                (fading its opaque cover out) WHILE the game shell mounts and
                loads beneath it — a smooth reveal instead of a hard cut. It
                portals to <body> and is inert (renders null) unless a
                celebration is active, so mounting it globally is safe on every
                route. */}
            <GoGoGoOverlay />
            {/* v935: full-screen "Reconnecting…" curtain while an online game
                is mid-reconnect — dims + blocks the app so the player can't
                act against stale, un-synced state, and it's obvious the game
                is resyncing rather than silently frozen. Inert unless in a
                game with a non-open socket. */}
            <ReconnectingBanner />
            {/* v937: always-visible chip when a (now-persistent) debug GPS
                spoof is active, so it can't be silently forgotten. */}
            <SpoofIndicator />
            {/* v938: hold a Screen Wake Lock during an active round so the
                app stays alive while foregrounded (live GPS + map + timers).
                The web platform can't track in the background — this is the
                available mitigation. */}
            <WakeLockController />
            {/* v1021: Jet-Lag-show curse REVEAL animation — plays full-screen
                when a curse is cast on the seekers. App-level so it shows on
                any seeker screen; renders nothing unless its atom is set
                (only ever on the seeker). */}
            <CurseRevealOverlay />
            {/* v1044: the rulebook drawer is a SINGLETON here, driven by the
                shared `rulebookTarget` atom, so any surface (settings, or a
                "learn more" link on a question / curse / power-up card) can open
                it deep-linked via `openRulebookAt(anchor)`. Inert until opened. */}
            <RulebookSheet />
            {/* Toast portal — single instance shared across both
                routes. v304: progress bar visible (it's the
                visual countdown), draggable enabled (swipe to
                dismiss). Styling lives in globals.css
                "React-Toastify card restyle". */}
            <ToastContainer
                position="top-center"
                autoClose={4000}
                hideProgressBar={false}
                newestOnTop
                closeOnClick
                pauseOnFocusLoss
                draggable
                draggablePercent={40}
                pauseOnHover
                theme="dark"
            />
            <PWAUpdatePrompt />
        </MapErrorBoundary>
    );
}

export default App;
