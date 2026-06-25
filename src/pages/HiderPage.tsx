import { useStore } from "@nanostores/react";
import { Suspense } from "react";

import { AppConfirmHost } from "@/components/AppConfirmHost";
import { AppPromptHost } from "@/components/AppPromptHost";
import { ClosingInWatcher } from "@/components/ClosingInWatcher";
import { GameStartWatcher } from "@/components/GameStartWatcher";
import { HiderHandFan } from "@/components/HiderHandFan";
import { HiderReachOverlay } from "@/components/HiderReachOverlay";
import { HiderView } from "@/components/HiderView";
import { HidingZoneOptionsSync } from "@/components/HidingZoneOptionsSync";
import { LocationPauseBanner } from "@/components/LocationPauseBanner";
import { LocationPauseWatcher } from "@/components/LocationPauseWatcher";
import { MultiplayerBoot } from "@/components/multiplayer/MultiplayerBoot";
import { StationTransitCard } from "@/components/StationTransitCard";
import { useReleaseStuckBodyLock } from "@/hooks/useReleaseStuckBodyLock";
import { hidingPeriodEndsAt } from "@/lib/gameSetup";
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
    // v297: HiderView + hand fan only mount once the game has
    // actually started (hidingPeriodEndsAt is set). Pre-game, the
    // lobby IS the page — no hider shell, no map, no hand strip.
    // Preloading fires from inside GameLobbyDialog the moment the
    // lobby opens so the hider's reference cache warms before
    // their shell takes over.
    const $hidingEndsAt = useStore(hidingPeriodEndsAt);
    const gameStarted = $hidingEndsAt !== null;

    // See SeekerPage: the lobby→in-game branch swap can unmount an open
    // lobby drawer without closing it, leaving body pointer-events stuck
    // and freezing this shell. Clear any such leftover on transition.
    useReleaseStuckBodyLock(gameStarted);

    if (!gameStarted) {
        return (
            <div className="fixed inset-0 bg-jetlag overflow-hidden">
                <Suspense fallback={null}>
                    <GameLobbyDialog />
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

    return (
        <div className="bg-background min-h-screen">
            <HiderView />
            <MultiplayerBoot />
            <GameStartWatcher />
            <ClosingInWatcher />
            {/* Reach overlay watcher — populates hiderReachFC from
                live GPS during the hiding/grace phases so
                HiderBackgroundMap can paint every reachable
                candidate zone with an arrival time. Self-gates by
                phase + GPS + zone-committed; renders nothing
                directly. */}
            <HiderReachOverlay />
            <StationTransitCard />
            <LocationPauseWatcher />
            <HidingZoneOptionsSync />
            <LocationPauseBanner />
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
                {/* Mid-game lobby reopen — drawer variant of the
                    same component. Triggered by the Lobby slot in
                    the bottom nav. */}
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
