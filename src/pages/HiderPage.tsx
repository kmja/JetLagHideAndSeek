import { useStore } from "@nanostores/react";
import { Suspense } from "react";

import { AppConfirmHost } from "@/components/AppConfirmHost";
import { NotificationPrompt } from "@/components/NotificationPrompt";
import { AppPromptHost } from "@/components/AppPromptHost";
import { ClosingInWatcher } from "@/components/ClosingInWatcher";
import { GamePausedOverlay } from "@/components/GamePausedOverlay";
import { GameStartWatcher } from "@/components/GameStartWatcher";
import { HandLimitEnforcer } from "@/components/HandLimitEnforcer";
import { HiderHandFan } from "@/components/HiderHandFan";
import { HiderReachOverlay } from "@/components/HiderReachOverlay";
import { HiderView } from "@/components/HiderView";
import { HidingZoneOptionsSync } from "@/components/HidingZoneOptionsSync";
import { LocationPauseBanner } from "@/components/LocationPauseBanner";
import { LocationPauseWatcher } from "@/components/LocationPauseWatcher";
import { MultiplayerBoot } from "@/components/multiplayer/MultiplayerBoot";
import { SeekerProximityWatcher } from "@/components/SeekerProximityWatcher";
import { StationTransitCard } from "@/components/StationTransitCard";
import { useHiderLocationBroadcast } from "@/hooks/useHiderLocationBroadcast";
import {
    gameStartCelebrationAt,
    gameStartOverLobby,
    hidingPeriodEndsAt,
} from "@/lib/gameSetup";
import { lazyWithRetry } from "@/lib/lazyWithRetry";
import { cn } from "@/lib/utils";

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
// v822: GoGoGoOverlay is mounted once at the App level now (survives the
// pre-game→in-game branch swap so it can fade out over the loaded map).
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
const EndOfRoundDialog = lazyWithRetry(() =>
    import("@/components/EndOfRoundDialog").then((m) => ({
        default: m.EndOfRoundDialog,
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
    const $overLobby = useStore(gameStartOverLobby);
    const $celebrationAt = useStore(gameStartCelebrationAt);
    // v889: the LOBBY stays mounted through the whole flourish so it doesn't
    // RELOAD mid-countdown (see SeekerPage for the full rationale — the branch
    // swap was remounting GameLobbyDialog + its preview map). The hider shell
    // mounts only when the flourish ENDS. v820 SELF-HEALING carries over:
    // `flourishActive` is tied to the celebration actually being live.
    const clockArmed = Number.isFinite($hidingEndsAt);
    const flourishActive =
        clockArmed && $overLobby && $celebrationAt !== null;

    // v853: push the hider's live GPS to the SERVER (never to seekers) so it
    // can range-check a `found` claim. Self-gates on role + multiplayer + a
    // live game; safe to call unconditionally (before the pre-game return).
    useHiderLocationBroadcast();

    // (Lobby→in-game swap body-lock leftover is cleared globally by
    // installBodyPointerEventsGuard — see main.tsx.)

    if (!clockArmed || flourishActive) {
        return (
            <div className="fixed inset-0 bg-jetlag overflow-hidden">
                <Suspense fallback={null}>
                    <GameLobbyDialog />
                    <GameSetupDialog />
                    <DebugPhaseControls />
                    <StaleSessionPrompt />
                    {/* v822: game-start flourish (GoGoGoOverlay) is mounted at
                        the App level now. */}
                </Suspense>
                <AppConfirmHost />
                <AppPromptHost />
                <GameStartWatcher />
                <MultiplayerBoot />
            </div>
        );
    }

    return (
        // v889: renders only once the flourish is over (the guard above keeps
        // the lobby mounted while `flourishActive`), fading in as the GoGoGo
        // overlay's cover fades out — a smooth reveal of the freshly-mounted
        // hider map (basemap HTTP cache warmed by the lobby preview).
        <div className="bg-background min-h-screen animate-in fade-in duration-500">
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
            {/* Seeker-proximity watcher — keeps the seekerEta atom fresh
                during seeking and fires an OS notification when the seekers
                cross into a closer colour band, even with the Zone drawer
                closed. Renders nothing. */}
            <SeekerProximityWatcher />
            <StationTransitCard />
            <LocationPauseWatcher />
            <HidingZoneOptionsSync />
            <LocationPauseBanner />
            <NotificationPrompt />
            <AppConfirmHost />
            <AppPromptHost />
            <Suspense fallback={null}>
                {/* In-game: HiderShell's HiderTopBar (visible on every
                    viewport) carries the debug launcher, so no floating
                    chip here. */}
                <DebugPhaseControls floating="never" />
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
                {/* v822: GoGoGoOverlay mounted at App level now. */}
                {/* Seeking-phase start moment (the hiding clock hit
                    zero). Mirror of the GO GO GO beat, fired for both
                    roles. */}
                <SeekingStartOverlay />
                <SeekingStartWatcher />
                <EndOfRoundDialog />
            </Suspense>
            {/* Hearthstone-style fanned hand pinned to the bottom of
                the viewport. Auto-hides when the hand is empty.
                Tapping the fan opens a full-screen carousel where the
                hider plays / casts / discards the focused card. */}
            <HiderHandFan />
            {/* Rulebook p44: force the hider to discard down to their hand
                limit the moment a draw takes them over it. */}
            <HandLimitEnforcer />
            {/* Manual game pause — full-screen curtain while paused. */}
            <GamePausedOverlay />
        </div>
    );
}

export default HiderPage;
