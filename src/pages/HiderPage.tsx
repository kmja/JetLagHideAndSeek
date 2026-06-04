import { DebugPhaseControls } from "@/components/DebugPhaseControls";
import { GameLobbyDialog } from "@/components/GameLobbyDialog";
import { GameSetupDialog } from "@/components/GameSetupDialog";
import { GameStartWatcher } from "@/components/GameStartWatcher";
import { GoGoGoOverlay } from "@/components/GoGoGoOverlay";
import { HiderView } from "@/components/HiderView";
import { MultiplayerBoot } from "@/components/multiplayer/MultiplayerBoot";
import { RolePicker } from "@/components/RolePicker";
import { StaleSessionPrompt } from "@/components/StaleSessionPrompt";

/**
 * Hider route. Direct port of the old `src/pages/h.astro` —
 * same component tree, the SPA router just swaps pages without
 * a full reload now. RolePicker auto-redirects between / and /h
 * when the local role changes (see RolePicker's pickSeeker /
 * pickHider handlers), which still works via
 * `window.location.assign()`.
 */
export function HiderPage() {
    return (
        <div className="bg-background min-h-screen">
            <HiderView />
            <DebugPhaseControls />
            <StaleSessionPrompt />
            <MultiplayerBoot />
            {/* Game settings + new-game wizard. Mounted on the
                hider page so the hider has the same access the
                seeker does via the BottomNav settings sheet.
                Triggered from HiderHome's header. */}
            <GameSetupDialog />
            {/* Role picker — mounted here so the "Switch role"
                button in the lobby has a dialog to consume
                rolePickerOpen on /h too. */}
            <RolePicker />
            {/* Pre-game lobby. Same component as on the seeker
                page; it auto-detects the hider role and renders
                the waiting state (no map readiness check, no
                Start button — the hider can't start, only the
                host on / can). */}
            <GameLobbyDialog />
            {/* Hiding-period gate + GO GO GO moment. Same
                watchers as SeekerPage so the hider sees the
                celebration too once the host kicks off. */}
            <GameStartWatcher />
            <GoGoGoOverlay />
        </div>
    );
}

export default HiderPage;
