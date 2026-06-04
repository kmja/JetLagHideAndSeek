import { lazy, Suspense } from "react";

import { BottomNav } from "@/components/BottomNav";
import { GameStartWatcher } from "@/components/GameStartWatcher";
import { HiderTimer } from "@/components/HiderTimer";
import { MapDisplayControls } from "@/components/MapDisplayControls";
import { MapLoadingOverlay } from "@/components/MapLoadingOverlay";
import { MapSwitcher } from "@/components/MapSwitcher";
import { MultiplayerBoot } from "@/components/multiplayer/MultiplayerBoot";
import { OptionDrawers } from "@/components/OptionDrawers";
import { PendingAnswerOverlay } from "@/components/PendingAnswerOverlay";
import { QuestionSidebar } from "@/components/QuestionSidebar";
import { RadarScanOverlay } from "@/components/RadarScanOverlay";
import { ThermometerOverlay } from "@/components/ThermometerOverlay";
import { TransitRoutesOverlay } from "@/components/TransitRoutesOverlay";
import {
    SidebarProvider as SidebarProviderL,
    SidebarTrigger as SidebarTriggerL,
} from "@/components/ui/sidebar-l";
import { SidebarProvider as SidebarProviderR } from "@/components/ui/sidebar-r";
import { ZoneSidebar } from "@/components/ZoneSidebar";

// Dialogs / overlays / wizards that only render once the user
// actually triggers them — lazy so a freshly-landed seeker doesn't
// pay for the QR-code lib (GameLobbyDialog), the welcome wizard,
// the curse-inbox UI, etc. on first paint. Null Suspense fallback
// because the chunks are tiny and the components stay gated by
// state anyway — Suspense is only entered on the trigger event,
// at which point a sub-second blank dialog is invisible.
const AnswerLinkReader = lazy(() =>
    import("@/components/AnswerLinkReader").then((m) => ({
        default: m.AnswerLinkReader,
    })),
);
const CurseInbox = lazy(() =>
    import("@/components/CurseInbox").then((m) => ({ default: m.CurseInbox })),
);
const DebugPhaseControls = lazy(() =>
    import("@/components/DebugPhaseControls").then((m) => ({
        default: m.DebugPhaseControls,
    })),
);
const GameLobbyDialog = lazy(() =>
    import("@/components/GameLobbyDialog").then((m) => ({
        default: m.GameLobbyDialog,
    })),
);
const GameSetupDialog = lazy(() =>
    import("@/components/GameSetupDialog").then((m) => ({
        default: m.GameSetupDialog,
    })),
);
const GoGoGoOverlay = lazy(() =>
    import("@/components/GoGoGoOverlay").then((m) => ({
        default: m.GoGoGoOverlay,
    })),
);
const RolePicker = lazy(() =>
    import("@/components/RolePicker").then((m) => ({ default: m.RolePicker })),
);
const StaleSessionPrompt = lazy(() =>
    import("@/components/StaleSessionPrompt").then((m) => ({
        default: m.StaleSessionPrompt,
    })),
);
const Welcome = lazy(() =>
    import("@/components/Welcome").then((m) => ({ default: m.Welcome })),
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
                                {/* Persistent hider timer — top-left on
                                    mobile, slightly inset on desktop next
                                    to the sidebar trigger. Shows hiding-
                                    period countdown then hidden-time
                                    elapsed once the period ends. */}
                                <div className="absolute top-2 left-2 md:left-12 z-[1030] group-[.fullscreen]:hidden">
                                    <HiderTimer />
                                </div>
                                {/* Top-right cluster: zones trigger +
                                    satellite + transit-lines toggles.
                                    Visible on both desktop and mobile —
                                    the bottom-nav slot that previously
                                    held the zones trigger has been
                                    reassigned to "Game". */}
                                <div className="absolute top-2 right-2 z-[1030] group-[.fullscreen]:hidden">
                                    <MapDisplayControls />
                                </div>
                                <div className="bottom-5 right-2 mx-auto mb-2 w-fit absolute z-[1030] group-[.fullscreen]:hidden hidden md:block">
                                    <OptionDrawers />
                                </div>
                                <ThermometerOverlay />
                                <PendingAnswerOverlay />
                                <TransitRoutesOverlay />
                                <RadarScanOverlay />
                                <MapSwitcher className="w-full group-[.fullscreen]:w-full group-[.fullscreen]:h-full" />
                                <MapLoadingOverlay />
                            </div>
                        </div>
                    </main>
                    <ZoneSidebar />
                    <BottomNav />
                    <Suspense fallback={null}>
                        <Welcome />
                        <GameSetupDialog />
                        <GameLobbyDialog />
                        <AnswerLinkReader />
                        <RolePicker />
                        <CurseInbox />
                        <DebugPhaseControls />
                        <StaleSessionPrompt />
                        <GoGoGoOverlay />
                    </Suspense>
                    <GameStartWatcher />
                    <MultiplayerBoot />
                </SidebarProviderR>
            </SidebarProviderL>
        </div>
    );
}

export default SeekerPage;
