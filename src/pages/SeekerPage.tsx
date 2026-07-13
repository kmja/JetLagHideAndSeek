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
import { useSeekerLocationBroadcast } from "@/hooks/useSeekerLocationBroadcast";
import {
    gameStartCelebrationAt,
    gameStartOverLobby,
    hidingPeriodEndsAt,
} from "@/lib/gameSetup";
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
    // v828: the in-game shell MOUNTS as soon as the hiding clock is armed —
    // INCLUDING during the game-start flourish — so the map (GL init +
    // basemap tiles + the slow play-area boundary/Overpass fetch) starts
    // loading the instant the 3-2-1 countdown begins, and is hopefully ready
    // by the time the user dismisses the GO-GO-GO card. It's just held
    // VISUALLY HIDDEN (opacity 0) behind the GoGoGo overlay while the
    // flourish plays, then revealed as the overlay fades. (Before v828 the
    // shell only mounted on dismiss — the "choppy unloaded map after closing
    // GO-GO-GO" the user reported.)
    //
    // `clockArmed` = there's a game. `flourishActive` = the GO-GO-GO flourish
    // is genuinely live (celebration set AND still over the lobby); it gates
    // ONLY the shell's opacity, not whether it mounts.
    //
    // v820 SELF-HEALING carries over: `flourishActive` is tied to the
    // celebration ACTUALLY being live, so a stuck `gameStartOverLobby` (with
    // the celebration already cleared) can't hide the map forever. The Move
    // powerup re-fires the celebration mid-game but leaves `gameStartOverLobby`
    // false, so `flourishActive` is false → its GO-GO-GO plays over the
    // visible map, never hides it.
    const clockArmed = Number.isFinite($hidingEndsAt);
    const flourishActive =
        clockArmed && $overLobby && $celebrationAt !== null;

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

    if (!clockArmed) {
        return (
            <div className="fixed inset-0 bg-jetlag overflow-hidden">
                {/* v819: the hidden full-screen warmup `<Map>` that used to
                    sit here (v338, to pre-warm the basemap HTTP cache during
                    lobby time) was REMOVED. It was a SECOND live MapLibre
                    WebGL context — on top of the lobby's own
                    `PlayAreaPreviewMap`, which already warms the SAME
                    basemap (PMTiles header + style + tiles) — so the pre-game
                    lobby ran TWO GL contexts + a full seeker Map's worth of
                    effects. On a constrained Chrome PWA, starting several
                    games in a session leaked/accumulated contexts until the
                    role picker FROZE (Chrome caps live WebGL contexts;
                    Firefox tolerated it as mere sluggishness). One map
                    pre-game (the preview) is enough for the warm; the in-game
                    map still initialises against the warmed HTTP cache. */}
                <Suspense fallback={null}>
                    <GameLobbyDialog />
                    <RolePicker />
                    <GameSetupDialog />
                    <DebugPhaseControls />
                    <StaleSessionPrompt />
                    {/* v822: the game-start flourish (GoGoGoOverlay) is mounted
                        at the App level now, so it survives this branch swap
                        and fades out over the loaded map. */}
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
        // v828: mounted as soon as the clock is armed so the map loads DURING
        // the countdown. While the flourish is live the shell is held at
        // opacity 0 (and pointer-events off) BEHIND the App-level GoGoGo
        // overlay — invisible, but fully mounted + loading. When the flourish
        // ends the opacity transitions 0→1 as the overlay's opaque cover fades
        // out, so the (now-loaded) map is revealed smoothly rather than
        // starting to load only after the card is closed. On a normal mid-game
        // reload flourishActive is false, so it renders at opacity 1 with no
        // transition (no spurious fade).
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
                        <MapOverlayLoadingToasts />
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
    );
}

export default SeekerPage;
