import { useStore } from "@nanostores/react";
import { Suspense } from "react";

import { AppConfirmHost } from "@/components/AppConfirmHost";
import { AppPromptHost } from "@/components/AppPromptHost";
import { BottomNav } from "@/components/BottomNav";
import { GameStartWatcher } from "@/components/GameStartWatcher";
import { HiderTimer } from "@/components/HiderTimer";
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
import { SeekerTopBar } from "@/components/SeekerTopBar";
import { SeekerTripPlannerLauncher } from "@/components/SeekerTripPlannerLauncher";
import { SeekerTripPlannerSheet } from "@/components/SeekerTripPlannerSheet";
import { ThermometerOverlay } from "@/components/ThermometerOverlay";
import { TravelTimesOverlay } from "@/components/TravelTimesOverlay";
import {
    SidebarProvider as SidebarProviderL,
    SidebarTrigger as SidebarTriggerL,
} from "@/components/ui/sidebar-l";
import { SidebarProvider as SidebarProviderR } from "@/components/ui/sidebar-r";
import { ZoneSidebar } from "@/components/ZoneSidebar";
import { useSeekerLocationBroadcast } from "@/hooks/useSeekerLocationBroadcast";
import { hidingPeriodEndsAt } from "@/lib/gameSetup";
import { lazyWithRetry } from "@/lib/lazyWithRetry";

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
const SeekingStartWatcher = lazyWithRetry(() =>
    import("@/components/SeekingStartOverlay").then((m) => ({
        default: m.SeekingStartWatcher,
    })),
);
const RolePicker = lazyWithRetry(() =>
    import("@/components/RolePicker").then((m) => ({ default: m.RolePicker })),
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
                    <GameSetupDialog />
                    <RolePicker />
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
                    <main className="flex flex-col flex-grow group">
                        <div
                            className="flex justify-center"
                            id="map-modal-dialog-container-leaflet"
                        >
                            <div className="w-full h-full relative">
                                <div
                                    className="absolute top-[72px] md:top-2 left-2 z-[1030] group-[.fullscreen]:hidden hidden md:block"
                                    data-tutorial-id="left-sidebar-trigger"
                                >
                                    <SidebarTriggerL />
                                </div>
                                {/* Persistent hider timer — bottom-right
                                    (v270, moved from top-left). Wrapper
                                    pins the BOTTOM of the timer card just
                                    above the bottom nav (mobile) /
                                    OptionDrawers cluster (desktop). The
                                    endgame action buttons stack ABOVE the
                                    timer inside HiderTimer (v272 swap),
                                    so this offset doesn't need to absorb
                                    the action stack's variable height. */}
                                <div className="absolute bottom-[80px] md:bottom-[64px] right-2 md:right-4 z-[1030] group-[.fullscreen]:hidden">
                                    <HiderTimer />
                                </div>
                                {/* Top-right cluster: zones trigger +
                                    satellite + transit-lines toggles.
                                    Visible on both desktop and mobile —
                                    the bottom-nav slot that previously
                                    held the zones trigger has been
                                    reassigned to "Game". On mobile we
                                    shift it below the SeekerTopBar. */}
                                <div className="absolute top-[64px] md:top-2 right-2 z-[1030] group-[.fullscreen]:hidden flex flex-col items-end gap-2">
                                    <MapDisplayControls />
                                    {/* Trip planner launcher — small
                                        pill sitting under the map-
                                        options chip. Opens the bottom-
                                        drawer SeekerTripPlannerSheet
                                        which fetches a journey from
                                        live GPS to the typed place. */}
                                    <SeekerTripPlannerLauncher />
                                </div>
                                <div className="bottom-5 right-2 mx-auto mb-2 w-fit absolute z-[1030] group-[.fullscreen]:hidden hidden md:block">
                                    <OptionDrawers />
                                </div>
                                <ThermometerOverlay />
                                <PendingAnswerOverlay />
                                <TravelTimesOverlay />
                                {/* Transit overlays + radar sweep are
                                    now built into Map directly as
                                    Source/Layer pairs; the old
                                    sibling components have been
                                    deleted along with the Leaflet
                                    renderer.
                                    Error boundary catches any render-
                                    time error the map might raise
                                    (style parse, WebGL init, etc.)
                                    and surfaces a recover-and-reload
                                    card. Without it those errors
                                    bubble up to the root and the
                                    whole app blanks. */}
                                {showMap ? (
                                    <MapErrorBoundary>
                                        <Map className="w-full group-[.fullscreen]:w-full group-[.fullscreen]:h-full" />
                                    </MapErrorBoundary>
                                ) : (
                                    // Placeholder backdrop while the
                                    // wizard runs. Matches the map's
                                    // dark base so the dialog doesn't
                                    // sit on a flash of bare body.
                                    <div className="w-full h-screen bg-[#0f172a]" />
                                )}
                                {showMap && <MapLoadingOverlay />}
                            </div>
                        </div>
                    </main>
                    <ZoneSidebar />
                    <SeekerTopBar />
                    <BottomNav />
                    <Suspense fallback={null}>
                        <GameSetupDialog />
                        <GameLobbyDialog />
                        <AnswerLinkReader />
                        <RolePicker />
                        <CurseInbox />
                        <DebugPhaseControls />
                        <StaleSessionPrompt />
                        <GoGoGoOverlay />
                        <SeekingStartOverlay />
                        <SeekingStartWatcher />
                    </Suspense>
                    {/* Trip planner sheet — opened from the launcher
                        in the top-right cluster. Self-renders null
                        when its open atom is false. */}
                    <SeekerTripPlannerSheet />
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
