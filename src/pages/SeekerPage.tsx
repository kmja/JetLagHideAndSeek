import { useStore } from "@nanostores/react";
import { Suspense, useEffect, useState } from "react";

import { AppConfirmHost } from "@/components/AppConfirmHost";
import { AppPromptHost } from "@/components/AppPromptHost";
import { AppShell } from "@/components/AppShell";
import { BottomNav } from "@/components/BottomNav";
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
import { PendingAnswerOverlay } from "@/components/PendingAnswerOverlay";
import { QuestionSidebar } from "@/components/QuestionSidebar";
import { SeekerFrozenBanner } from "@/components/SeekerFrozenBanner";
import { SeekerTopBar } from "@/components/SeekerTopBar";
import { SeekerTripPlannerSheet } from "@/components/SeekerTripPlannerSheet";
import { StationTransitCard } from "@/components/StationTransitCard";
import { ThermometerOverlay } from "@/components/ThermometerOverlay";
import { TravelTimesOverlay } from "@/components/TravelTimesOverlay";
import {
    SidebarProvider as SidebarProviderL,
    SidebarTrigger as SidebarTriggerL,
} from "@/components/ui/sidebar-l";
import { SidebarProvider as SidebarProviderR } from "@/components/ui/sidebar-r";
import { ZoneSidebar } from "@/components/ZoneSidebar";
import { useReleaseStuckBodyLock } from "@/hooks/useReleaseStuckBodyLock";
import { useSeekerLocationBroadcast } from "@/hooks/useSeekerLocationBroadcast";
import { hidingPeriodEndsAt } from "@/lib/gameSetup";
import { lazyWithRetry } from "@/lib/lazyWithRetry";
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
const GoGoGoOverlay = lazyWithRetry(() =>
    import("@/components/GoGoGoOverlay").then((m) => ({
        default: m.GoGoGoOverlay,
    })),
);
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
    const gameStarted = $hidingEndsAt !== null;

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

    // Safety net for the lobby→in-game branch swap below: if the lobby
    // drawer was still open when the game started (e.g. a guest getting
    // the host's setupChanged push), it unmounts without closing and can
    // leave `body { pointer-events: none }` stuck — freezing this shell
    // while the hiding clock keeps ticking. Clear any such leftover.
    useReleaseStuckBodyLock(gameStarted);

    if (!gameStarted) {
        return (
            <div className="fixed inset-0 bg-jetlag overflow-hidden">
                {/* v338: pre-mount the Map underneath the lobby so its
                    PMTiles header read, style fetch, and (if the
                    play area is set in the wizard) basemap tile
                    fetches all finish during the time the player
                    spends in the lobby. The lobby dialog uses a vaul
                    drawer with its own full-screen overlay
                    (z-[1050]+) and an opaque content panel, so the
                    Map is hidden visually — only the network warmup
                    runs.

                    Caveat: the Map's MapLibre instance is re-created
                    when this branch unmounts and the main branch
                    mounts (component identity differs). The HTTP
                    cache for tile range requests survives that
                    transition though, which is where the bulk of
                    perceived latency lives — so the second instance
                    initialises against an already-warm cache and
                    renders near-instantly. */}
                <div className="absolute inset-0 pointer-events-none opacity-0">
                    <MapErrorBoundary>
                        <Map className="w-full h-full" />
                    </MapErrorBoundary>
                </div>
                <Suspense fallback={null}>
                    <GameLobbyDialog />
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
    }

    const showMap = true;

    return (
        <div className="bg-jetlag">
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
                        className="flex-grow h-svh"
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
                        <TravelTimesOverlay />
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
                        <GameLobbyDialog />
                        <RolePicker />
                        <AnswerLinkReader />
                        <CurseInbox />
                        {/* In-game: the debug launcher lives in the
                            mobile header (SeekerTopBar). The floating chip
                            stays only on desktop, which has no header. */}
                        <DebugPhaseControls floating="desktop" />
                        <StaleSessionPrompt />
                        <GoGoGoOverlay />
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
                    <AppConfirmHost />
                    <AppPromptHost />
                    <GameStartWatcher />
                    <MultiplayerBoot />
                </SidebarProviderR>
            </SidebarProviderL>
        </div>
    );
}

export default SeekerPage;
