import { useStore } from "@nanostores/react";
import { Suspense, useEffect, useState } from "react";

import { AppConfirmHost } from "@/components/AppConfirmHost";
import { NotificationPrompt } from "@/components/NotificationPrompt";
import { AppPromptHost } from "@/components/AppPromptHost";
import { AppShell } from "@/components/AppShell";
import { BottomNav } from "@/components/BottomNav";
import { GamePausedOverlay } from "@/components/GamePausedOverlay";
import { GameStartWatcher } from "@/components/GameStartWatcher";
import { HiderTimer } from "@/components/HiderTimer";
import { HidingZoneOptionsSync } from "@/components/HidingZoneOptionsSync";
import { LocationPauseBanner } from "@/components/LocationPauseBanner";
import { LocationPauseWatcher } from "@/components/LocationPauseWatcher";
// Eager-import the map itself. It's a ~880 KB chunk on its own
// (maplibre-gl) and was historically wrapped in React.lazy +
// MapErrorBoundary + lazyWithRetry to handle the deploy-race
// case where the chunk hash on disk no longer matched the one
// in the stale-SW-served index.html. That layered lazy stack
// turned a chunk-load failure (rare, transient) into a
// 'map literally never appears' failure (common, persistent).
// Shipping the map in the eager bundle eliminates the entire
// failure mode at the cost of one larger initial download.
// The map IS the app — there is no version of this page that
// works without it, so deferring it never made product sense.
import { Map } from "@/components/Map";
import { MapDisplayControls } from "@/components/MapDisplayControls";
import { MapErrorBoundary } from "@/components/MapErrorBoundary";
import { MapLoadingOverlay } from "@/components/MapLoadingOverlay";
import { MultiplayerBoot } from "@/components/multiplayer/MultiplayerBoot";
import { OptionDrawers } from "@/components/OptionDrawers";
import { MapOverlayLoadingToasts } from "@/components/MapOverlayLoadingToasts";
import { EndgameDeniedBanner } from "@/components/EndgameDeniedBanner";
import { PendingAnswerOverlay } from "@/components/PendingAnswerOverlay";
import { QuestionSidebar } from "@/components/QuestionSidebar";
import { SeekerFrozenBanner } from "@/components/SeekerFrozenBanner";
import { SeekerTopBar } from "@/components/SeekerTopBar";
import { SeekerTripPlannerSheet } from "@/components/SeekerTripPlannerSheet";
import { StationTransitCard } from "@/components/StationTransitCard";
import { ThermometerOverlay } from "@/components/ThermometerOverlay";
import {
    SidebarProvider as SidebarProviderL,
    SidebarTrigger as SidebarTriggerL,
} from "@/components/ui/sidebar-l";
import { SidebarProvider as SidebarProviderR } from "@/components/ui/sidebar-r";
import { ZoneSidebar } from "@/components/ZoneSidebar";
import { useSeekerLocationBroadcast } from "@/hooks/useSeekerLocationBroadcast";
import {
    gameStartCelebrationAt,
    gameStartOverLobby,
    hidingPeriodEndsAt,
} from "@/lib/gameSetup";
import { playerRole } from "@/lib/hiderRole";
import { lazyWithRetry } from "@/lib/lazyWithRetry";
import { multiplayerEnabled } from "@/lib/multiplayer/session";
import { cn } from "@/lib/utils";

// Dialogs / overlays / wizards that only render once the user
// actually triggers them — lazy so a freshly-landed seeker doesn't
// pay for the QR-code lib (GameLobbyDialog), the welcome wizard,
// the curse-inbox UI, etc. on first paint. Null Suspense fallback
// because the chunks are tiny and the components stay gated by
// state anyway — Suspense is only entered on the trigger event,
// at which point a sub-second blank dialog is invisible.
const AnswerLinkReader = lazyWithRetry(() =>
    import("@/components/AnswerLinkReader").then((m) => ({
        default: m.AnswerLinkReader,
    })),
);
const CurseInbox = lazyWithRetry(() =>
    import("@/components/CurseInbox").then((m) => ({ default: m.CurseInbox })),
);
const DebugPhaseControls = lazyWithRetry(() =>
    import("@/components/DebugPhaseControls").then((m) => ({
        default: m.DebugPhaseControls,
    })),
);
const GameLobbyDialog = lazyWithRetry(() =>
    import("@/components/GameLobbyDialog").then((m) => ({
        default: m.GameLobbyDialog,
    })),
);
const RolePicker = lazyWithRetry(() =>
    import("@/components/RolePicker").then((m) => ({ default: m.RolePicker })),
);
const GameSetupDialog = lazyWithRetry(() =>
    import("@/components/GameSetupDialog").then((m) => ({
        default: m.GameSetupDialog,
    })),
);
// v822: GoGoGoOverlay is now mounted once at the App level (survives the
// pre-game→in-game branch swap so it can fade out over the loaded map).
const SeekingStartOverlay = lazyWithRetry(() =>
    import("@/components/SeekingStartOverlay").then((m) => ({
        default: m.SeekingStartOverlay,
    })),
);
const EndOfRoundDialog = lazyWithRetry(() =>
    import("@/components/EndOfRoundDialog").then((m) => ({
        default: m.EndOfRoundDialog,
    })),
);
const SeekingStartWatcher = lazyWithRetry(() =>
    import("@/components/SeekingStartOverlay").then((m) => ({
        default: m.SeekingStartWatcher,
    })),
);
const StaleSessionPrompt = lazyWithRetry(() =>
    import("@/components/StaleSessionPrompt").then((m) => ({
        default: m.StaleSessionPrompt,
    })),
);
/**
 * Seeker route. Direct port of the old `src/pages/index.astro` —
 * same component tree, same z-index layering. The only difference
 * is that nothing here is `client:only` anymore: we're a real SPA
 * so every child renders normally. That eliminates the leaflet-
 * imports-break-SSR class of bugs documented in CLAUDE.md and
 * lets components import leaflet at the top of their files
 * without ceremony.
 */
export function SeekerPage() {
    // Stream the local seeker's GPS to the hide team (rulebook p5).
    // The hook gates on role + multiplayer + sharing toggle + live
    // game state, so it's a no-op outside an active seeker session.
    useSeekerLocationBroadcast();

    // v297: the main map + chrome only mount once the game has
    // actually started (i.e. hidingPeriodEndsAt is set). Pre-game,
    // the lobby IS the page — no map, no sidebars, no top/bottom
    // nav. Preloading (basemap tiles, references, transit) fires
    // from inside GameLobbyDialog the moment the lobby opens, so
    // the boundary load doesn't start cold when the seeker shell
    // finally takes over.
    const $hidingEndsAt = useStore(hidingPeriodEndsAt);
    const $overLobby = useStore(gameStartOverLobby);
    const $celebrationAt = useStore(gameStartCelebrationAt);
    // v889: the LOBBY stays mounted through the entire game-start flourish,
    // so it doesn't RELOAD mid-countdown. The bug: the moment the clock armed,
    // `clockArmed` flipped and this page swapped the pre-game branch for the
    // in-game shell — which REMOUNTS `GameLobbyDialog` (mounted in BOTH
    // branches), reloading its `PlayAreaPreviewMap` right as the 3-2-1 played
    // (the "lobby sort of reloads in the middle of the countdown"). Now the
    // pre-game branch (the SAME lobby instance) is kept mounted while
    // `flourishActive`, and the GoGoGo backdrop progressively dims + blurs it
    // as the countdown runs, then the GO-GO-GO card bursts. The in-game shell
    // mounts only when the flourish ENDS (on dismiss) — the lobby preview map
    // already warmed the basemap HTTP cache, so the map paints fast under the
    // overlay's reveal fade. (This intentionally supersedes v828's
    // "mount the shell hidden during the countdown", which required the branch
    // swap that caused the reload + a second live GL context mid-flourish.)
    //
    // v820 SELF-HEALING carries over: `flourishActive` is tied to the
    // celebration ACTUALLY being live, so a stuck `gameStartOverLobby` (with
    // the celebration already cleared) can't strand the lobby forever. The Move
    // powerup re-fires the celebration mid-game but leaves `gameStartOverLobby`
    // false, so `flourishActive` is false → its GO-GO-GO plays over the
    // visible map, never re-shows the lobby.
    const clockArmed = Number.isFinite($hidingEndsAt);
    const flourishActive =
        clockArmed && $overLobby && $celebrationAt !== null;
    // v946: a multiplayer guest who JOINS an already-started game arrives with
    // the clock armed (it rides the welcome snapshot) but NO role yet — they
    // must land in the LOBBY + RolePicker, not get dumped into the seeking
    // shell (the "joined mid-game → stuck on SEEK!" bug). Solo games have a
    // null role too, so gate on multiplayer. Once they pick a role this flips
    // false and the in-game shell mounts.
    const $mpEnabled = useStore(multiplayerEnabled);
    const $role = useStore(playerRole);
    const needsRolePick = $mpEnabled && $role === null;

    // v616: during the hiding period the HiderTimer sits bottom-LEFT, so
    // the bottom-left Map-options chip is pushed up above it. A one-shot
    // timeout flips this at the deadline (no per-second tick).
    const [inHidingPeriod, setInHidingPeriod] = useState(
        () => $hidingEndsAt != null && Date.now() < $hidingEndsAt,
    );
    useEffect(() => {
        if ($hidingEndsAt == null) {
            setInHidingPeriod(false);
            return;
        }
        const ms = $hidingEndsAt - Date.now();
        if (ms <= 0) {
            setInHidingPeriod(false);
            return;
        }
        setInHidingPeriod(true);
        const t = window.setTimeout(() => setInHidingPeriod(false), ms);
        return () => window.clearTimeout(t);
    }, [$hidingEndsAt]);

    // (The lobby→in-game swap could leave a stuck `body{pointer-events:none}`
    // when the lobby drawer/dialog unmounted without closing — now cleared
    // globally by installBodyPointerEventsGuard.)

    // Pre-game backdrop (lobby is hoisted below so it never remounts). The
    // hidden warmup <Map> that used to sit here was removed in v819 (a second
    // GL context froze constrained Chrome PWAs); the lobby's own
    // PlayAreaPreviewMap warms the basemap HTTP cache.
    const preGame = (
        <div className="fixed inset-0 bg-jetlag overflow-hidden">
            <Suspense fallback={null}>
                <RolePicker />
                <GameSetupDialog />
                <DebugPhaseControls />
                <StaleSessionPrompt />
            </Suspense>
            <AppConfirmHost />
            <AppPromptHost />
            <GameStartWatcher />
            <MultiplayerBoot />
        </div>
    );

    const showMap = true;

    return (
        // v893: `GameLobbyDialog` is hoisted here — rendered ONCE, ABOVE the
        // pre-game↔in-game branch — so arming the clock at Start can swap to
        // the in-game shell (which mounts + LOADS the map during the 3-2-1
        // countdown, v828) WITHOUT remounting the lobby / reloading its
        // PlayAreaPreviewMap (the v889 mid-countdown "reload"). The lobby is a
        // body-portaled drawer whose own `open` state (kept open through the
        // flourish via `gameStartOverLobby`) drives visibility, so one stable
        // instance is correct. While the flourish plays the shell is held
        // opacity-0 behind the App-level GoGoGo overlay, then fades in (0→1) as
        // the overlay's cover fades out — the map is already loaded by dismiss.
        <>
            <Suspense fallback={null}>
                <GameLobbyDialog />
            </Suspense>
            {!clockArmed || needsRolePick ? (
                preGame
            ) : (
        <div
            className={cn(
                "bg-jetlag transition-opacity duration-500 ease-out",
                flourishActive && "pointer-events-none",
            )}
            style={{ opacity: flourishActive ? 0 : 1 }}
        >
            <SidebarProviderL>
                <SidebarProviderR defaultOpen={false}>
                    <QuestionSidebar />
                    {/* v466: the seeker shell is now the shared AppShell
                        (header → map area → footer flex column). The map
                        area is a definite-height `relative flex-1` box so
                        the on-map controls anchor to it with plain top-2 /
                        bottom-2 and the Map fills it via `absolute inset-0`
                        (see AppShell for the height rationale). On desktop
                        the header/nav are `md:hidden`, so it's just the
                        full-height map area between the sidebars. */}
                    <AppShell
                        as="main"
                        className="flex-grow h-dvh"
                        mapAreaId="map-modal-dialog-container-leaflet"
                        header={<SeekerTopBar />}
                        footer={<BottomNav />}
                    >
                        <div
                            className="absolute top-2 left-2 z-[1030] group-[.fullscreen]:hidden hidden md:block"
                            data-tutorial-id="left-sidebar-trigger"
                        >
                            <SidebarTriggerL />
                        </div>
                        {/* Persistent hider timer. v457: the card
                            positions itself — bottom-LEFT during the
                            hiding period (yellow "hiding time remaining"
                            box) and bottom-RIGHT once seeking starts
                            (white clock + gold "time to beat" strip),
                            matching the Jet Lag show. */}
                        <HiderTimer />
                        {/* Top-right: trip-planner launcher. Slides down
                            when the pending-answer overlay is pinned to the
                            top so they don't overlap on narrow screens. */}
                        {/* Map-options chip — DESKTOP ONLY (v622). On mobile
                            these controls live in the bottom-nav "Map" slot
                            (MapOptionsDrawer), so the floating chip is hidden
                            there. On desktop (no bottom nav) it stays bottom-
                            left, pushed up above the HiderTimer during the
                            hiding period. */}
                        <div
                            className={cn(
                                "hidden md:block absolute left-4 z-[1030] group-[.fullscreen]:hidden",
                                "transition-[bottom] duration-300 ease-out",
                                inHidingPeriod ? "bottom-28" : "bottom-3",
                            )}
                        >
                            <MapDisplayControls />
                        </div>
                        <div className="bottom-5 right-2 mx-auto mb-2 w-fit absolute z-[1030] group-[.fullscreen]:hidden hidden md:block">
                            <OptionDrawers />
                        </div>
                        <ThermometerOverlay />
                        <PendingAnswerOverlay />
                        <EndgameDeniedBanner />
                        <MapOverlayLoadingToasts />
                        {/* Error boundary catches any render-time error the
                            map might raise (style parse, WebGL init, etc.)
                            and surfaces a recover-and-reload card. The
                            `absolute inset-0` wrapper gives the Map a
                            definite-height containing block — see AppShell. */}
                        {showMap ? (
                            <div className="absolute inset-0">
                                <MapErrorBoundary>
                                    <Map className="w-full h-full group-[.fullscreen]:w-full group-[.fullscreen]:h-full" />
                                </MapErrorBoundary>
                            </div>
                        ) : (
                            // Placeholder backdrop while the wizard runs.
                            // Matches the map's dark base so the dialog
                            // doesn't sit on a flash of bare body.
                            <div className="absolute inset-0 bg-[#0f172a]" />
                        )}
                        {showMap && <MapLoadingOverlay />}
                    </AppShell>
                    <ZoneSidebar />
                    <Suspense fallback={null}>
                        <GameSetupDialog />
                        <RolePicker />
                        <AnswerLinkReader />
                        <CurseInbox />
                        {/* In-game: the debug launcher lives in the
                            mobile header (SeekerTopBar). The floating chip
                            stays only on desktop, which has no header. */}
                        <DebugPhaseControls floating="desktop" />
                        <StaleSessionPrompt />
                        <SeekingStartOverlay />
                        <SeekingStartWatcher />
                        <EndOfRoundDialog />
                    </Suspense>
                    {/* Trip planner sheet — opened from the launcher
                        in the top-right cluster. Self-renders null
                        when its open atom is false. */}
                    <SeekerTripPlannerSheet />
                    <SeekerFrozenBanner />
                    <LocationPauseWatcher />
                    <HidingZoneOptionsSync />
                    <LocationPauseBanner />
                    <StationTransitCard allowEndgame />
                    <NotificationPrompt />
                    <AppConfirmHost />
                    <AppPromptHost />
                    <GameStartWatcher />
                    <MultiplayerBoot />
                    {/* Manual game pause — full-screen curtain while paused. */}
                    <GamePausedOverlay />
                </SidebarProviderR>
            </SidebarProviderL>
        </div>
            )}
        </>
    );
}

export default SeekerPage;
