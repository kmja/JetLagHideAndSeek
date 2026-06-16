import { Suspense } from "react";

import { AppConfirmHost } from "@/components/AppConfirmHost";
import { AppPromptHost } from "@/components/AppPromptHost";
import { ClosingInWatcher } from "@/components/ClosingInWatcher";
import { GameStartWatcher } from "@/components/GameStartWatcher";
import { HiderHandFan } from "@/components/HiderHandFan";
import { HiderView } from "@/components/HiderView";
import { MultiplayerBoot } from "@/components/multiplayer/MultiplayerBoot";
import { lazyWithRetry } from "@/lib/lazyWithRetry";

// Same lazy-dialog pattern SeekerPage uses — these are all
// state-gated and only render once the hider triggers them
// (settings sheet, role swap, lobby host action, post-hiding
// celebration). Suspense entry is rare in practice.
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
 * Hider route. Direct port of the old `src/pages/h.astro` —
 * same component tree, the SPA router just swaps pages without
 * a full reload now. RolePicker auto-redirects between / and /h
 * when the local role changes (see RolePicker's pickSeeker /
 * pickHider handlers), which still works via
 * `window.location.assign()`.
 */
export function HiderPage() {
    // v267: GameRouteGate in App.tsx handles the welcome/setup
    // redirects at the route level, so HiderPage now only mounts
    // when both atoms are committed.

    return (
        <div className="bg-background min-h-screen">
            <HiderView />
            <MultiplayerBoot />
            <GameStartWatcher />
            <ClosingInWatcher />
            <AppConfirmHost />
            <AppPromptHost />
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
                {/* Seeking-phase start moment (the hiding clock hit
                    zero). Mirror of the GO GO GO beat, fired for both
                    roles. */}
                <SeekingStartOverlay />
                <SeekingStartWatcher />
            </Suspense>
            {/* Hearthstone-style fanned hand pinned to the bottom of
                the viewport. Auto-hides when the hand is empty.
                Tapping the fan opens a full-screen carousel where the
                hider plays / casts / discards the focused card. */}
            <HiderHandFan />
        </div>
    );
}

export default HiderPage;
