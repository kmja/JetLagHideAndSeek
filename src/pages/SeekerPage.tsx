import { AnswerLinkReader } from "@/components/AnswerLinkReader";
import { BottomNav } from "@/components/BottomNav";
import { CurseInbox } from "@/components/CurseInbox";
import { DebugPhaseControls } from "@/components/DebugPhaseControls";
import { GameLobbyDialog } from "@/components/GameLobbyDialog";
import { GameSetupDialog } from "@/components/GameSetupDialog";
import { GameStartWatcher } from "@/components/GameStartWatcher";
import { GoGoGoOverlay } from "@/components/GoGoGoOverlay";
import { HiderTimer } from "@/components/HiderTimer";
import { MapDisplayControls } from "@/components/MapDisplayControls";
import { MapSwitcher } from "@/components/MapSwitcher";
import { MapLoadingOverlay } from "@/components/MapLoadingOverlay";
import { OptionDrawers } from "@/components/OptionDrawers";
import { PendingAnswerOverlay } from "@/components/PendingAnswerOverlay";
import { QuestionSidebar } from "@/components/QuestionSidebar";
import { RadarScanOverlay } from "@/components/RadarScanOverlay";
import { RolePicker } from "@/components/RolePicker";
import { StaleSessionPrompt } from "@/components/StaleSessionPrompt";
import { ThermometerOverlay } from "@/components/ThermometerOverlay";
import { TransitRoutesOverlay } from "@/components/TransitRoutesOverlay";
import { Welcome } from "@/components/Welcome";
import { ZoneSidebar } from "@/components/ZoneSidebar";
import { MultiplayerBoot } from "@/components/multiplayer/MultiplayerBoot";
import {
    SidebarProvider as SidebarProviderL,
    SidebarTrigger as SidebarTriggerL,
} from "@/components/ui/sidebar-l";
import { SidebarProvider as SidebarProviderR } from "@/components/ui/sidebar-r";

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
                    <Welcome />
                    <GameSetupDialog />
                    <GameLobbyDialog />
                    <AnswerLinkReader />
                    <RolePicker />
                    <CurseInbox />
                    <DebugPhaseControls />
                    <StaleSessionPrompt />
                    <GameStartWatcher />
                    <GoGoGoOverlay />
                    <MultiplayerBoot />
                </SidebarProviderR>
            </SidebarProviderL>
        </div>
    );
}

export default SeekerPage;
