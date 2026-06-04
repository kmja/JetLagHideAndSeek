import { lazy, Suspense } from "react";

import { GameStartWatcher } from "@/components/GameStartWatcher";
import { HiderView } from "@/components/HiderView";
import { MultiplayerBoot } from "@/components/multiplayer/MultiplayerBoot";

// Same lazy-dialog pattern SeekerPage uses — these are all
// state-gated and only render once the hider triggers them
// (settings sheet, role swap, lobby host action, post-hiding
// celebration). Suspense entry is rare in practice.
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
            <MultiplayerBoot />
            <GameStartWatcher />
            <Suspense fallback={null}>
                <DebugPhaseControls />
                <StaleSessionPrompt />
                {/* Game settings + new-game wizard. Mounted on
                    the hider page so the hider has the same access
                    the seeker does via the BottomNav settings
                    sheet. Triggered from HiderHome's header. */}
                <GameSetupDialog />
                {/* Role picker — mounted here so the "Switch role"
                    button in the lobby has a dialog to consume
                    rolePickerOpen on /h too. */}
                <RolePicker />
                {/* Pre-game lobby. Same component as on the seeker
                    page; it auto-detects the hider role and renders
                    the waiting state. */}
                <GameLobbyDialog />
                {/* Hiding-period gate + GO GO GO moment. */}
                <GoGoGoOverlay />
            </Suspense>
        </div>
    );
}

export default HiderPage;
