import { useStore } from "@nanostores/react";
import {
    Bus,
    Flag,
    Footprints,
    List,
    MoreHorizontal,
    Plus,
    Settings,
    Share2,
    Ship,
    Target,
    Timer,
    Train,
    TrainTrack,
    TramFront,
    Trophy,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { LucideIcon } from "lucide-react";

import { Drawer as VaulDrawer } from "vaul";

import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
    SheetTrigger,
} from "@/components/ui/sheet";
import { questions, questionsDrawerOpen, zoneSidebarOpen } from "@/lib/context";
import {
    allowedTransit,
    formatTimeRemaining,
    gameSize,
    hidingPeriodEndsAt,
    playArea,
    setupCompleted,
    setupDialogOpen,
    TRANSIT_LABELS,
    type TransitMode,
} from "@/lib/gameSetup";
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

import {
    playerRole,
    resetHiderRoundState,
    roundFoundAt,
} from "@/lib/hiderRole";
import { encodeFoundLink, shareOrCopy } from "@/lib/shareLinks";
import { toast } from "react-toastify";

import { AddQuestionDialog } from "./AddQuestionDialog";
import { HowToPlaySheet } from "./HowToPlaySheet";
import { OfflineTilePreloader } from "./OfflineTilePreloader";
import { OptionDrawers } from "./OptionDrawers";
import { PWAInstallButton } from "./PWAInstallButton";
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
    const $foundAt = useStore(roundFoundAt);
    const [moreOpen, setMoreOpen] = useState(false);
    const [gameSheetOpen, setGameSheetOpen] = useState(false);

    // Tick state at 1 Hz when hiding period is active so the displayed
    // countdown stays current without spamming re-renders the rest of the
    // time. Effect is a no-op (and cheap) when no hiding period is set.
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        if (!$hidingEndsAt) return;
        // Always refresh `now` whenever the end-timestamp changes —
        // otherwise after "End hiding period · Start seeking" snaps
        // hidingPeriodEndsAt to Date.now(), the early-exit path below
        // would leave `now` stuck at its last interval value, which
        // could be up to a second stale. That left `remainingMs > 0`
        // for that interval and kept `hiding === true`, blocking the
        // NEW QUESTION button and re-showing the End-hiding UI.
        setNow(Date.now());
        // Don't clear the timestamp when the hiding period expires —
        // HiderTimer uses it as the *anchor* for the "Hidden for"
        // elapsed counter once we transition into the seeking phase.
        // We just stop the per-second tick once the countdown reaches
        // zero, since after that `now` doesn't need to keep changing
        // for the hiding-period UI (the elapsed timer in HiderTimer
        // has its own interval).
        if ($hidingEndsAt <= Date.now()) return;
        const id = window.setInterval(() => {
            const t = Date.now();
            setNow(t);
            if ($hidingEndsAt <= t) {
                window.clearInterval(id);
            }
        }, 1000);
        return () => window.clearInterval(id);
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
                                    className="w-5 h-5 text-primary"
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
                                    hiding && "tabular-nums text-primary",
                                )}
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
                                            <div className="text-5xl font-inter-tight italic font-black tabular-nums text-primary leading-none">
                                                {formatTimeRemaining(
                                                    remainingMs,
                                                )}
                                            </div>
                                        </div>
                                        <Button
                                            onClick={() => {
                                                // Snap the countdown to now
                                                // (instead of clearing) so
                                                // HiderTimer flips into the
                                                // "Hidden for" elapsed mode
                                                // immediately. Guarded: if
                                                // somehow this fires when
                                                // we're already past the
                                                // hiding period, do nothing
                                                // (preserves the existing
                                                // elapsed anchor instead of
                                                // resetting it to zero).
                                                const existing =
                                                    hidingPeriodEndsAt.get();
                                                if (
                                                    existing !== null &&
                                                    existing <= Date.now()
                                                ) {
                                                    setGameSheetOpen(false);
                                                    return;
                                                }
                                                hidingPeriodEndsAt.set(
                                                    Date.now(),
                                                );
                                                setGameSheetOpen(false);
                                            }}
                                            className="w-full mt-3"
                                        >
                                            End hiding period · Start seeking
                                        </Button>
                                    </div>
                                )}

                                {/* Round-end controls. Only meaningful once
                                    the hiding period has ended (we're in the
                                    seeking phase). The "Mark hider found"
                                    primary action sets `roundFoundAt` and
                                    offers a share-link the seeker hands the
                                    hider so both sides agree the round is
                                    over and the final score is frozen. */}
                                {!hiding &&
                                    $setupCompleted &&
                                    $hidingEndsAt !== null && (
                                        <div className="mt-4">
                                            {$foundAt ? (
                                                <FoundSummary
                                                    foundAt={$foundAt}
                                                    hidingEndsAt={$hidingEndsAt}
                                                    onShareAgain={() => {
                                                        void shareFoundLink(
                                                            $foundAt,
                                                        );
                                                    }}
                                                />
                                            ) : (
                                                <MarkFoundCta
                                                    onTap={() => {
                                                        const ts = Date.now();
                                                        roundFoundAt.set(ts);
                                                        void shareFoundLink(
                                                            ts,
                                                        );
                                                    }}
                                                />
                                            )}
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
                                        <div className="flex gap-2 pt-2">
                                            <Button
                                                variant="outline"
                                                className="flex-1"
                                                onClick={() => {
                                                    setGameSheetOpen(false);
                                                    setupDialogOpen.set(true);
                                                }}
                                            >
                                                {$setupCompleted
                                                    ? "Edit settings"
                                                    : "Set up game"}
                                            </Button>
                                            {$setupCompleted && (
                                                <Button
                                                    variant="destructive"
                                                    className="flex-1"
                                                    onClick={() => {
                                                        setGameSheetOpen(
                                                            false,
                                                        );
                                                        setupCompleted.set(
                                                            false,
                                                        );
                                                        hidingPeriodEndsAt.set(
                                                            null,
                                                        );
                                                        // Don't leave a stale
                                                        // "round ended" badge
                                                        // hanging on the seeker
                                                        // side when starting a
                                                        // fresh game.
                                                        roundFoundAt.set(null);
                                                        // Clear hider-side
                                                        // state on this device
                                                        // too — same device
                                                        // testing means the
                                                        // hider inbox, hand,
                                                        // and zone would
                                                        // otherwise survive
                                                        // into the next game.
                                                        resetHiderRoundState();
                                                        setupDialogOpen.set(
                                                            true,
                                                        );
                                                    }}
                                                >
                                                    New game
                                                </Button>
                                            )}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </VaulDrawer.Content>
                    </VaulDrawer.Portal>
                </VaulDrawer.Root>

                <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
                    <SheetTrigger asChild>
                        <button
                            type="button"
                            className={cn(navBtnClass, "max-w-[56px]")}
                            aria-label="More options"
                        >
                            <MoreHorizontal
                                className="w-5 h-5"
                                strokeWidth={2}
                            />
                            <span className={navLabelClass}>More</span>
                        </button>
                    </SheetTrigger>
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
                            <HowToPlaySheet />
                            <button
                                type="button"
                                onClick={() => {
                                    setMoreOpen(false);
                                    zoneSidebarOpen.set(true);
                                }}
                                className={cn(
                                    "w-full flex items-center justify-center gap-2",
                                    "px-3 py-2 rounded-md",
                                    "bg-secondary hover:bg-accent border border-border",
                                    "text-sm font-semibold text-foreground transition-colors",
                                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                )}
                            >
                                <Target className="w-4 h-4" />
                                Hiding zone settings
                            </button>

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
                            {(() => {
                                // Roles lock once a game is underway —
                                // switching mid-game doesn't make sense
                                // (the seeker would lose their question
                                // state on this device, the hider has a
                                // committed zone, etc.). Reset via "New
                                // game" in the Settings drawer to make
                                // the toggle available again.
                                const gameStarted = $questions.length > 0;
                                return (
                                    <button
                                        type="button"
                                        disabled={gameStarted}
                                        title={
                                            gameStarted
                                                ? "Roles lock once the first question has been asked. Start a new game to switch."
                                                : "Switch this device to the hider side"
                                        }
                                        onClick={() => {
                                            if (
                                                !confirm(
                                                    "Switch this device to the hider side? You'll go to the hider home — seeker state stays saved.",
                                                )
                                            ) {
                                                return;
                                            }
                                            playerRole.set("hider");
                                            window.location.assign("/h");
                                        }}
                                        className={cn(
                                            "w-full flex items-center justify-center gap-2",
                                            "px-3 py-2 rounded-md",
                                            "bg-secondary hover:bg-accent border border-border",
                                            "text-sm font-semibold text-foreground transition-colors",
                                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                            "disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-secondary",
                                        )}
                                    >
                                        Switch to hider
                                    </button>
                                );
                            })()}
                            <div className="pb-2 flex justify-center">
                                <OptionDrawers />
                            </div>
                        </div>
                        <a
                            href="https://github.com/taibeled/JetLagHideAndSeek"
                            target="_blank"
                            rel="noopener noreferrer"
                            className={cn(
                                "mt-3 w-full flex items-center justify-center gap-2",
                                "py-2 px-3 rounded-md",
                                "bg-emerald-600 hover:bg-emerald-500 transition-colors",
                                "text-sm font-semibold text-white",
                            )}
                        >
                            Star this on GitHub! It&apos;s free :)
                        </a>
                        {/* Bottom padding for safe-area + visual breathing
                            room. Lives below the GitHub link so the link
                            doesn't kiss the screen edge on mobile. */}
                        <div
                            aria-hidden
                            className="h-6 pb-[env(safe-area-inset-bottom)]"
                        />
                    </SheetContent>
                </Sheet>
            </div>
        </div>
    );
};

/* ────────────────── Round-end helpers ────────────────── */

/**
 * Share the "round ended" link so the hider can lock their device too. The
 * link contains the seeker-decided `foundAt` timestamp, so both sides agree
 * on the elapsed-time numerator used for scoring.
 */
async function shareFoundLink(foundAt: number) {
    const url = encodeFoundLink(foundAt);
    const result = await shareOrCopy({
        title: "Round ended",
        text: `I found the hider! Tap to end your timer: ${url}`,
        url,
    });
    if (result.method === "copy") {
        toast.success("Round-ended link copied", { autoClose: 1500 });
    } else if (result.method === "failed") {
        toast.error("Could not share the round-end link");
    }
}

function MarkFoundCta({ onTap }: { onTap: () => void }) {
    return (
        <div
            className={cn(
                "rounded-sm border border-dashed border-border",
                "bg-secondary/30 px-4 py-3",
            )}
        >
            <div className="flex items-start gap-3">
                <Flag className="w-5 h-5 text-primary mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1">
                    <div className="text-xs font-inter-tight font-bold uppercase tracking-[0.16em] mb-1">
                        Round end
                    </div>
                    <p className="text-xs text-muted-foreground leading-snug">
                        Tap once you've physically spotted the hider. This
                        freezes the time-bonus tally for scoring and shares a
                        link so the hider can lock their device too.
                    </p>
                </div>
            </div>
            <Button onClick={onTap} className="w-full mt-3 gap-2">
                <Flag className="w-4 h-4" />
                Mark hider found · Share link
            </Button>
        </div>
    );
}

function FoundSummary({
    foundAt,
    hidingEndsAt,
    onShareAgain,
}: {
    foundAt: number;
    hidingEndsAt: number;
    onShareAgain: () => void;
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
            <Button
                variant="outline"
                onClick={onShareAgain}
                className="w-full mt-3 gap-2"
            >
                <Share2 className="w-4 h-4" />
                Share round-end link again
            </Button>
        </div>
    );
}
