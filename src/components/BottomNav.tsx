import { useStore } from "@nanostores/react";
import type { LucideIcon } from "lucide-react";
import {
    Bus,
    BookOpen,
    Copy,
    Flag,
    Footprints,
    List,
    Plus,
    Radio,
    RadioReceiver,
    Settings,
    Share2,
    Ship,
    Sparkles,
    Timer,
    Train,
    TrainTrack,
    TramFront,
    Trophy,
    Users,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Drawer as VaulDrawer } from "vaul";

import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
} from "@/components/ui/sheet";
import { useVisibleInterval } from "@/hooks/useVisibleInterval";
import { questions, questionsDrawerOpen } from "@/lib/context";
import {
    allowedTransit,
    endgameStartedAt,
    formatTimeRemaining,
    gameSize,
    hidingPeriodEndsAt,
    moreSheetOpen,
    playArea,
    setupCompleted,
    setupDialogOpen,
    TRANSIT_LABELS,
    type TransitMode,
} from "@/lib/gameSetup";
import { startNewGame, startNewRound } from "@/lib/roundActions";
import { cn } from "@/lib/utils";

import { SizeBadge } from "./JetLagLogo";

// Transit-mode icon glyphs matching the game-setup wizard's icons.
const TRANSIT_ICONS: Record<TransitMode, LucideIcon> = {
    bus: Bus,
    tram: TramFront,
    train: Train,
    subway: TrainTrack,
    ferry: Ship,
};

import { toast } from "react-toastify";

import {
    playerRole,
    roundFoundAt,
} from "@/lib/hiderRole";
import {
    currentGameCode,
    lobbyManualOpen,
    multiplayerEnabled,
    participants,
    seekerLocationSharing,
} from "@/lib/multiplayer/session";
import { appConfirm } from "@/lib/confirm";
import { copyFoundLink, shareFoundLink } from "@/lib/foundShare";
import { seekerRotateHider } from "@/lib/multiplayer/store";

import { AddQuestionDialog } from "./AddQuestionDialog";
import { HowToPlaySheet } from "./HowToPlaySheet";
import { PresenceChip } from "./multiplayer/PresenceIndicators";
import { RotateHiderDialog } from "./multiplayer/RotateHiderDialog";
import { OfflineTilePreloader } from "./OfflineTilePreloader";
import { OptionDrawers } from "./OptionDrawers";
import { PreloadChoicesPanel } from "./PreloadChoicesPanel";
import { PWAInstallButton } from "./PWAInstallButton";
import { RulebookSheet } from "./RulebookSheet";
import { Button } from "./ui/button";

/**
 * Bottom-anchored navigation bar shown only on mobile. The "Game" slot
 * doubles as the hiding-period countdown — during an active hiding
 * period the button shows MM:SS instead of "Game", and tapping opens
 * a sheet with the option to end hiding early.
 */
export const BottomNav = () => {
    const $questions = useStore(questions);
    const $setupCompleted = useStore(setupCompleted);
    const $playArea = useStore(playArea);
    const $allowedTransit = useStore(allowedTransit);
    const $gameSize = useStore(gameSize);
    const $hidingEndsAt = useStore(hidingPeriodEndsAt);
    const $endgameStartedAt = useStore(endgameStartedAt);
    const $foundAt = useStore(roundFoundAt);
    const $moreOpen = useStore(moreSheetOpen);
    const $currentGameCode = useStore(currentGameCode);
    const $multiplayerEnabled = useStore(multiplayerEnabled);
    const $sharing = useStore(seekerLocationSharing);
    const $participants = useStore(participants);
    const [gameSheetOpen, setGameSheetOpen] = useState(false);
    // "Start new round" → rotation dialog gate. Only meaningful in
    // online games with ≥2 participants (solo / offline takes the
    // confirm()-only fast path below).
    const [rotateDialogOpen, setRotateDialogOpen] = useState(false);

    // Does the new-round flow need to show the hider-picker?
    // Yes when we're in an online room with at least two
    // participants — otherwise there's no one to rotate to.
    const canRotateHider =
        $multiplayerEnabled &&
        $currentGameCode !== null &&
        $participants.length >= 2;

    const handleNewRound = async () => {
        if (canRotateHider) {
            // Open the picker; the dialog's onConfirm will run the
            // wire send + local reset.
            setRotateDialogOpen(true);
            return;
        }
        // Offline / solo: confirm via the app-styled dialog (was a
        // raw window.confirm() that came with the OS chrome).
        const ok = await appConfirm({
            title: "Start a new round?",
            description:
                "Question log, hider hand, hiding zone and spot will all reset. Play area + transit + size stay the same.",
            confirmLabel: "New round",
        });
        if (!ok) return;
        setGameSheetOpen(false);
        startNewRound();
        toast.success("New round — hiding period starting now.", {
            autoClose: 2500,
        });
    };

    const handleConfirmRotation = (newHiderId: string) => {
        // Tell the server who the new hider is; the server
        // broadcasts presence + a fresh snapshot so every client
        // reconciles their role and wipes round-scoped state.
        seekerRotateHider(newHiderId);
        // Local cleanup for THIS device. Other devices apply the
        // snapshot they get via the bridge; per-device hider state
        // (zone / hand / deck) cleans up in
        // reconcileLocalRoleFromPresence when their role transitions.
        startNewRound();
        setRotateDialogOpen(false);
        setGameSheetOpen(false);
        toast.success("New round — hiding period starting now.", {
            autoClose: 2500,
        });
    };

    // Tick state at 1 Hz while a hiding period is active so the
    // displayed countdown stays current. `useVisibleInterval`
    // pauses while the tab is hidden — saves battery on locked
    // phones since players run the app for hours. On resume it
    // re-syncs immediately so the countdown jumps to truth.
    const [now, setNow] = useState(Date.now());
    const hidingRunning =
        $hidingEndsAt !== null && $hidingEndsAt > now;
    useVisibleInterval(() => setNow(Date.now()), 1000, hidingRunning);
    // Refresh `now` immediately whenever the end-timestamp changes
    // — otherwise after "End hiding period · Start seeking" snaps
    // hidingPeriodEndsAt to Date.now(), the next render could
    // briefly see a stale `now > endsAt` and keep `hiding === true`.
    useEffect(() => {
        if ($hidingEndsAt) setNow(Date.now());
    }, [$hidingEndsAt]);

    // Derive `hiding` from the live timestamp where possible — falling
    // back to `now` only between interval ticks. This guarantees the
    // post-end transition is immediate even if a re-render fires before
    // the next setNow.
    const remainingMs = $hidingEndsAt
        ? Math.max(0, $hidingEndsAt - Math.max(now, Date.now()))
        : 0;
    const hiding = Boolean($hidingEndsAt && remainingMs > 0);
    // Rulebook p13: "you cannot ask multiple questions at once; if you are
    // waiting on an answer from a previous question, you cannot ask your
    // next question until the first has been answered." We treat any
    // question still in draft (drag:true) as awaiting an answer.
    const hasPendingAnswer = $questions.some((q) => q.data.drag === true);

    const navBtnClass = cn(
        "relative flex-1 flex flex-col items-center justify-center gap-0.5",
        "py-2 px-1 rounded-md min-h-[48px]",
        "text-muted-foreground hover:text-foreground hover:bg-secondary",
        "active:bg-secondary/80 transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    );
    const navLabelClass = "text-[10px] font-poppins font-semibold";

    return (
        <div
            className={cn(
                "md:hidden fixed bottom-0 left-0 right-0 z-[1040]",
                "bg-background/95 backdrop-blur-md border-t border-border",
                "pb-[env(safe-area-inset-bottom)]",
            )}
            data-tutorial-id="bottom-nav"
        >
            {/* Tiny multiplayer status chip — only renders when in an
                online game. Hovers just above the nav rail. */}
            {$currentGameCode && (
                <div className="absolute -top-7 left-1/2 -translate-x-1/2 pointer-events-none">
                    <PresenceChip />
                </div>
            )}
            <div className="flex items-stretch px-2 py-2 gap-1">
                <button
                    type="button"
                    onClick={() => questionsDrawerOpen.set(true)}
                    className={navBtnClass}
                    aria-label="Open questions sidebar"
                >
                    <List className="w-5 h-5" strokeWidth={2} />
                    <span className={navLabelClass}>Questions</span>
                    {$questions.length > 0 && (
                        <span
                            className={cn(
                                "absolute top-1 right-2",
                                "text-[9px] font-mono font-semibold",
                                "bg-secondary text-foreground",
                                "px-1.5 min-w-[18px] h-[18px]",
                                "rounded-full flex items-center justify-center",
                                "border border-border",
                            )}
                            aria-label={`${$questions.length} questions added`}
                        >
                            {$questions.length}
                        </span>
                    )}
                </button>

                <AddQuestionDialog>
                    <button
                        type="button"
                        className={cn(
                            "flex-[1.4] flex flex-col items-center justify-center gap-0.5",
                            "py-2 px-1 rounded-md min-h-[48px]",
                            "bg-primary text-primary-foreground",
                            "hover:bg-primary/90 active:bg-primary/80",
                            "transition-colors font-poppins",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            (hiding || hasPendingAnswer) && "opacity-50",
                        )}
                        disabled={hiding || hasPendingAnswer}
                        aria-label="Add question"
                        title={
                            hiding
                                ? "Hiding period — wait for the timer or end it manually to start asking"
                                : hasPendingAnswer
                                  ? "Waiting for the hider to answer your previous question"
                                  : "Add a question"
                        }
                    >
                        <Plus className="w-5 h-5" strokeWidth={2.5} />
                        <span className="text-[10px] font-bold uppercase tracking-wider">
                            New question
                        </span>
                    </button>
                </AddQuestionDialog>

                {/* Lobby slot (v242). Opens the GameLobbyDialog so
                    players can see the roster and join code without
                    digging into "More". Shows the live online-
                    participant count as a badge so the seeker knows
                    at a glance who's connected. */}
                <button
                    type="button"
                    onClick={() => lobbyManualOpen.set(true)}
                    className={navBtnClass}
                    aria-label="Open game lobby"
                    title="Players, room code, role rotation"
                >
                    <Users className="w-5 h-5" strokeWidth={2} />
                    <span className={navLabelClass}>Lobby</span>
                    {$participants.filter((p) => p.online).length > 0 && (
                        <span
                            className={cn(
                                "absolute top-1 right-2",
                                "text-[9px] font-mono font-semibold",
                                "bg-secondary text-foreground",
                                "px-1.5 min-w-[18px] h-[18px]",
                                "rounded-full flex items-center justify-center",
                                "border border-border",
                            )}
                            aria-label={`${$participants.filter((p) => p.online).length} players online`}
                        >
                            {$participants.filter((p) => p.online).length}
                        </span>
                    )}
                </button>

                {/* Game slot. During hiding period it doubles as a count-
                    down display. Tap to open the drawer with an "End hiding"
                    button + the usual setup summary. */}
                <VaulDrawer.Root
                    open={gameSheetOpen}
                    onOpenChange={setGameSheetOpen}
                    shouldScaleBackground={false}
                >
                    <VaulDrawer.Trigger asChild>
                        <button
                            type="button"
                            className={cn(
                                navBtnClass,
                                hiding && "text-foreground bg-secondary/60",
                            )}
                            aria-label={
                                hiding
                                    ? `Hiding period: ${formatTimeRemaining(remainingMs)} remaining`
                                    : $setupCompleted
                                      ? "Game settings"
                                      : "Set up game"
                            }
                        >
                            {hiding ? (
                                <Timer
                                    className="w-5 h-5"
                                    style={{
                                        color: "hsl(var(--accent-yellow))",
                                    }}
                                    strokeWidth={2}
                                />
                            ) : (
                                <Settings
                                    className="w-5 h-5"
                                    strokeWidth={2}
                                />
                            )}
                            <span
                                className={cn(
                                    navLabelClass,
                                    hiding && "tabular-nums",
                                )}
                                style={
                                    hiding
                                        ? {
                                              color: "hsl(var(--accent-yellow))",
                                          }
                                        : undefined
                                }
                            >
                                {hiding
                                    ? formatTimeRemaining(remainingMs)
                                    : $setupCompleted
                                      ? "Settings"
                                      : "Setup"}
                            </span>
                            {!$setupCompleted && !hiding && (
                                <span
                                    className="absolute top-1 right-2 w-2 h-2 rounded-full bg-primary"
                                    aria-label="Setup needed"
                                />
                            )}
                        </button>
                    </VaulDrawer.Trigger>
                    <VaulDrawer.Portal>
                        <VaulDrawer.Overlay className="fixed inset-0 z-[1040] bg-black/60" />
                        <VaulDrawer.Content className="fixed inset-x-0 bottom-0 z-[1045] mt-24 flex h-auto max-h-[85vh] flex-col rounded-t-[10px] border bg-background text-foreground pb-[env(safe-area-inset-bottom)]">
                            <div className="mx-auto mt-3 mb-1 h-1.5 w-12 shrink-0 rounded-full bg-muted" />
                            <div className="overflow-y-auto px-6 pt-4 pb-6">
                                <div className="space-y-1.5">
                                    <VaulDrawer.Title className="text-lg font-semibold leading-none tracking-tight">
                                        {hiding
                                            ? "Hiding period"
                                            : "Game settings"}
                                    </VaulDrawer.Title>
                                    <VaulDrawer.Description className="text-sm text-muted-foreground">
                                        {hiding
                                            ? "The hider has time to get to their hiding spot. The seeker can't ask questions yet."
                                            : $setupCompleted
                                              ? "Your current setup. Edit anything, or start fresh."
                                              : "Set up your game to get started."}
                                    </VaulDrawer.Description>
                                </div>

                                {hiding && (
                                    <div className="mt-4">
                                        <div className="text-center py-6 rounded-sm bg-secondary/30 border border-border">
                                            <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground font-inter-tight font-bold mb-2">
                                                Time remaining
                                            </div>
                                            <div
                                                className="text-5xl font-inter-tight italic font-black tabular-nums leading-none"
                                                style={{
                                                    color: "hsl(var(--accent-yellow))",
                                                }}
                                            >
                                                {formatTimeRemaining(
                                                    remainingMs,
                                                )}
                                            </div>
                                        </div>
                                        {/* No "End hiding period" button here:
                                            only the hider can end the hiding
                                            phase early (from their HiderHome).
                                            The debug panel keeps a copy for
                                            testing. */}
                                        {/* Game settings remain editable
                                            during the hiding period — the
                                            host can still tweak transit /
                                            size or add adjacent areas
                                            while the hider is en route. */}
                                        <Button
                                            variant="outline"
                                            onClick={() => {
                                                setGameSheetOpen(false);
                                                setupDialogOpen.set(true);
                                            }}
                                            className="w-full mt-2"
                                        >
                                            Edit settings
                                        </Button>
                                    </div>
                                )}

                                {/* Endgame trigger and Mark-hider-found
                                    moved out of this sheet into the
                                    HiderTimer surface (top-left, below
                                    the round timer) so they're visible
                                    on the main map without opening the
                                    settings sheet. */}

                                {/* Location sharing — per rulebook p5 every
                                    seeker shares their GPS with the hider for
                                    the round. Default on; toggle off only
                                    for privacy/debugging. Visible state with
                                    a Wifi-style chip so the seeker knows
                                    they're broadcasting. */}
                                {!hiding &&
                                    $setupCompleted &&
                                    $hidingEndsAt !== null &&
                                    !$foundAt &&
                                    $multiplayerEnabled && (
                                        <div className="mt-4">
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    seekerLocationSharing.set(
                                                        !$sharing,
                                                    )
                                                }
                                                className={cn(
                                                    "w-full flex items-center gap-2.5",
                                                    "rounded-md border-2 px-3 py-2.5",
                                                    "transition-colors text-left",
                                                    $sharing
                                                        ? "border-emerald-400/60 bg-emerald-400/10 text-emerald-300"
                                                        : "border-border bg-secondary/40 text-muted-foreground",
                                                )}
                                            >
                                                {$sharing ? (
                                                    <Radio className="w-4 h-4 shrink-0 text-emerald-400" />
                                                ) : (
                                                    <RadioReceiver className="w-4 h-4 shrink-0" />
                                                )}
                                                <div className="min-w-0 flex-1">
                                                    <div className="text-[9px] uppercase tracking-[0.18em] font-poppins font-bold">
                                                        {$sharing
                                                            ? "Sharing GPS with hider"
                                                            : "GPS sharing off"}
                                                    </div>
                                                    <div className="text-[11px] leading-snug text-muted-foreground">
                                                        {$sharing
                                                            ? "The hider sees your live position (rulebook p5). Tap to pause."
                                                            : "The hider can't see your position. Tap to resume."}
                                                    </div>
                                                </div>
                                            </button>
                                        </div>
                                    )}

                                {/* Round-end controls. Only meaningful once
                                    the hiding period has ended (we're in the
                                    seeking phase). The pre-found
                                    "Mark hider found" CTA moved into
                                    the HiderTimer (top-left of the
                                    map). The post-found FoundSummary
                                    stays here because it's a recap
                                    card (final score, new-round / new-
                                    game actions) — best read inside
                                    Settings rather than crammed under
                                    the timer. */}
                                {!hiding &&
                                    $setupCompleted &&
                                    $hidingEndsAt !== null &&
                                    $foundAt && (
                                        <div className="mt-4">
                                                <FoundSummary
                                                    foundAt={$foundAt}
                                                    hidingEndsAt={$hidingEndsAt}
                                                    onShareAgain={() => {
                                                        void shareFoundLink(
                                                            $foundAt,
                                                        );
                                                    }}
                                                    onCopyLink={() => {
                                                        void copyFoundLink(
                                                            $foundAt,
                                                        );
                                                    }}
                                                    onNewRound={handleNewRound}
                                                    onNewGame={async () => {
                                                        const ok = await appConfirm(
                                                            {
                                                                title: "Start a new game?",
                                                                description:
                                                                    "This drops the play area, transit modes, and size — the setup wizard will re-open.",
                                                                confirmLabel: "New game",
                                                                destructive: true,
                                                            },
                                                        );
                                                        if (!ok) return;
                                                        setGameSheetOpen(false);
                                                        startNewGame();
                                                    }}
                                                />
                                        </div>
                                    )}

                                {!hiding && (
                                    <div className="mt-4 space-y-3">
                                        {$setupCompleted && (
                                            <div className="space-y-2 text-sm">
                                                <div className="flex justify-between gap-2">
                                                    <span className="text-muted-foreground">
                                                        Play area
                                                    </span>
                                                    <span className="font-medium truncate min-w-0 text-right">
                                                        {(() => {
                                                            const dn =
                                                                $playArea?.displayName;
                                                            if (!dn) return "—";
                                                            // displayName is "City, State, Country"
                                                            // (from determineName). Show first +
                                                            // last chunks so the country comes
                                                            // through but we drop state for brevity.
                                                            const parts = dn
                                                                .split(",")
                                                                .map((s) =>
                                                                    s.trim(),
                                                                )
                                                                .filter(Boolean);
                                                            if (parts.length === 0) return dn;
                                                            if (parts.length === 1) return parts[0];
                                                            return `${parts[0]}, ${parts[parts.length - 1]}`;
                                                        })()}
                                                    </span>
                                                </div>
                                                <div className="flex justify-between items-start gap-2">
                                                    <span className="text-muted-foreground shrink-0 pt-1">
                                                        Transit
                                                    </span>
                                                    <span className="flex flex-wrap gap-1.5 justify-end items-center min-w-0">
                                                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-secondary border border-border text-xs">
                                                            <Footprints className="w-3.5 h-3.5 text-muted-foreground" />
                                                            <span className="text-muted-foreground italic">
                                                                walking
                                                            </span>
                                                        </span>
                                                        {$allowedTransit.length ===
                                                            0 && (
                                                            <span className="text-xs text-muted-foreground italic">
                                                                only
                                                            </span>
                                                        )}
                                                        {$allowedTransit.map(
                                                            (m) => {
                                                                const Icon =
                                                                    TRANSIT_ICONS[
                                                                        m
                                                                    ];
                                                                return (
                                                                    <span
                                                                        key={m}
                                                                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-secondary border border-border text-xs"
                                                                    >
                                                                        <Icon className="w-3.5 h-3.5" />
                                                                        <span>
                                                                            {
                                                                                TRANSIT_LABELS[
                                                                                    m
                                                                                ]
                                                                            }
                                                                        </span>
                                                                    </span>
                                                                );
                                                            },
                                                        )}
                                                    </span>
                                                </div>
                                                <div className="flex justify-between items-center gap-2">
                                                    <span className="text-muted-foreground">
                                                        Size
                                                    </span>
                                                    <SizeBadge
                                                        size={$gameSize}
                                                    />
                                                </div>
                                            </div>
                                        )}
                                        {/* "Leave game" lived here as a
                                            second action button; it
                                            moved into the lobby dialog
                                            (header → Leave) so the
                                            in-game settings stay
                                            focused on the wizard-shaped
                                            three concepts. Edit
                                            settings stretches full
                                            width now that it's solo. */}
                                        <div className="pt-2">
                                            <Button
                                                variant="outline"
                                                className="w-full"
                                                onClick={() => {
                                                    setGameSheetOpen(false);
                                                    setupDialogOpen.set(true);
                                                }}
                                            >
                                                {$setupCompleted
                                                    ? "Edit settings"
                                                    : "Set up game"}
                                            </Button>
                                        </div>
                                        {/* v236: preload preferences. Same
                                            three-bucket panel the wizard uses;
                                            flipping a bucket from off → on
                                            here triggers `runPreloadForBucket`
                                            immediately so deferred data
                                            arrives without waiting for the
                                            next hiding period. */}
                                        {$setupCompleted && (
                                            <div className="pt-2 border-t border-border">
                                                <div className="text-[10px] uppercase tracking-[0.16em] font-poppins font-bold text-muted-foreground mb-2 mt-3">
                                                    Preload during hiding
                                                </div>
                                                <PreloadChoicesPanel
                                                    runImmediatelyOnEnable
                                                />
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        </VaulDrawer.Content>
                    </VaulDrawer.Portal>
                </VaulDrawer.Root>

                {/* "More" sheet content. v242: the trigger moved off
                    the bottom nav into SeekerTopBar's settings icon
                    (left of the wordmark). The Sheet body stays here
                    because its content is intertwined with the
                    bottom-nav's state (Rulebook/Howto/Lobby buttons
                    that close-then-open via setMoreOpen). Drive open
                    state from the shared moreSheetOpen atom. */}
                <Sheet
                    open={$moreOpen}
                    onOpenChange={(v) => moreSheetOpen.set(v)}
                >
                    <SheetContent
                        side="bottom"
                        className="rounded-t-2xl"
                    >
                        <SheetHeader>
                            <SheetTitle>More</SheetTitle>
                            <SheetDescription>
                                Share your map, see the tutorial, or open
                                advanced options.
                            </SheetDescription>
                        </SheetHeader>
                        <div className="mt-4 space-y-2">
                            <HowToPlaySheet
                                onBeforeOpen={() => moreSheetOpen.set(false)}
                            />
                            <RulebookSheet
                                onBeforeOpen={() => moreSheetOpen.set(false)}
                            >
                                <button
                                    type="button"
                                    className={cn(
                                        "w-full flex items-center justify-center gap-2",
                                        "px-3 py-2 rounded-md",
                                        "bg-secondary hover:bg-accent border border-border",
                                        "text-sm font-semibold text-foreground transition-colors",
                                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                    )}
                                    title="Open the official Hide + Seek rulebook (searchable)"
                                >
                                    <BookOpen className="w-4 h-4" />
                                    Rulebook
                                </button>
                            </RulebookSheet>
                            {/* PWA controls — install affordance for
                                supported platforms, and tile pre-cache
                                so the seeker can preload offline maps
                                for the chosen play area. */}
                            <PWAInstallButton />
                            <div
                                className={cn(
                                    "w-full px-3 py-3 rounded-md",
                                    "bg-secondary/40 border border-border",
                                )}
                            >
                                <OfflineTilePreloader />
                            </div>
                            <div className="pb-2 flex justify-center">
                                <OptionDrawers compact />
                            </div>
                        </div>
                        {/* 'Star on GitHub' button removed in v101. */}
                        {/* Bottom padding for safe-area + visual breathing
                            room. */}
                        <div
                            aria-hidden
                            className="h-6 pb-[env(safe-area-inset-bottom)]"
                        />
                    </SheetContent>
                </Sheet>
            </div>

            {/* Hider-rotation dialog. Opened by `handleNewRound` when
                an online game has multiple participants. Renders at
                the BottomNav root so its z-index isn't trapped by
                any sheet/drawer that's also open. */}
            <RotateHiderDialog
                open={rotateDialogOpen}
                onOpenChange={setRotateDialogOpen}
                onConfirm={handleConfirmRotation}
            />
        </div>
    );
};

/* ────────────────── Round-end helpers ────────────────── */

/**
 * Share the "round ended" link so the hider can lock their device too. The
 * link contains the seeker-decided `foundAt` timestamp, so both sides agree
 * on the elapsed-time numerator used for scoring.
 */
// Round-end share helpers extracted to src/lib/foundShare.ts so
// HiderTimer can share them — both surfaces fire the same flow.

// MarkFoundCta moved into HiderTimer as a compact inline button.

function FoundSummary({
    foundAt,
    hidingEndsAt,
    onShareAgain,
    onCopyLink,
    onNewRound,
    onNewGame,
}: {
    foundAt: number;
    hidingEndsAt: number;
    onShareAgain: () => void;
    onCopyLink: () => void;
    onNewRound: () => void;
    onNewGame: () => void;
}) {
    const elapsedMs = Math.max(0, foundAt - hidingEndsAt);
    const totalSec = Math.floor(elapsedMs / 1000);
    const hh = Math.floor(totalSec / 3600);
    const mm = Math.floor((totalSec % 3600) / 60);
    const ss = totalSec % 60;
    const elapsed =
        hh > 0
            ? `${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`
            : `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;

    return (
        <div className="rounded-sm border-2 border-primary bg-primary/5 px-4 py-3">
            <div className="flex items-start gap-3">
                <Trophy className="w-5 h-5 text-primary mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1">
                    <div className="text-xs font-inter-tight font-bold uppercase tracking-[0.16em]">
                        Round ended
                    </div>
                    <div className="font-inter-tight italic font-black tabular-nums text-3xl text-primary leading-none mt-1">
                        {elapsed}
                    </div>
                    <p className="text-[11px] text-muted-foreground leading-snug mt-1">
                        Seek time from end of hiding period. The hider's hand
                        time-bonus minutes get subtracted from this to get the
                        final score.
                    </p>
                </div>
            </div>
            {/* Share-again row. Always-visible recovery for when
                the auto-fired share sheet was dismissed without
                sending — Share retries via the OS sheet, Copy
                writes the link straight to the clipboard. Either
                gets the hider the link they need to lock their
                device, so neither one is the "wrong" choice. */}
            <div className="grid grid-cols-2 gap-2 mt-3">
                <Button
                    variant="outline"
                    onClick={onShareAgain}
                    className="gap-1.5"
                >
                    <Share2 className="w-4 h-4" />
                    Share again
                </Button>
                <Button
                    variant="outline"
                    onClick={onCopyLink}
                    className="gap-1.5"
                >
                    <Copy className="w-4 h-4" />
                    Copy link
                </Button>
            </div>
            {/* New-round / new-game actions live here so the
                seeker has a clear next step from the same panel
                that confirmed the round ended. New round keeps
                the play area + size + transit + multiplayer room
                — only the per-round state (questions, hider
                hand, zone, spot, found-at) resets. New game
                drops back to the wizard. */}
            <div className="grid grid-cols-2 gap-2 mt-2">
                <Button
                    onClick={onNewRound}
                    className="gap-1.5"
                >
                    <Sparkles className="w-4 h-4" />
                    New round
                </Button>
                <Button
                    variant="outline"
                    onClick={onNewGame}
                >
                    New game
                </Button>
            </div>
        </div>
    );
}
