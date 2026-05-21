import { useStore } from "@nanostores/react";
import {
    Bus,
    Footprints,
    List,
    MoreHorizontal,
    Plus,
    Settings,
    Ship,
    Timer,
    Train,
    TrainTrack,
    TramFront,
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
import { questions, questionsDrawerOpen } from "@/lib/context";
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

import { AddQuestionDialog } from "./AddQuestionDialog";
import { HowToPlaySheet } from "./HowToPlaySheet";
import { OptionDrawers } from "./OptionDrawers";
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
    const [moreOpen, setMoreOpen] = useState(false);
    const [gameSheetOpen, setGameSheetOpen] = useState(false);

    // Tick state at 1 Hz when hiding period is active so the displayed
    // countdown stays current without spamming re-renders the rest of the
    // time. Effect is a no-op (and cheap) when no hiding period is set.
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        if (!$hidingEndsAt) return;
        // Don't clear the timestamp when the hiding period expires — the
        // HiderTimer uses it as the *anchor* for the "Hidden for" elapsed
        // counter once we transition into the seeking phase. We just stop
        // the per-second tick once the countdown reaches zero.
        if ($hidingEndsAt <= Date.now()) return;
        setNow(Date.now());
        const id = window.setInterval(() => {
            const t = Date.now();
            setNow(t);
            if ($hidingEndsAt <= t) {
                window.clearInterval(id);
            }
        }, 1000);
        return () => window.clearInterval(id);
    }, [$hidingEndsAt]);

    const remainingMs = $hidingEndsAt ? Math.max(0, $hidingEndsAt - now) : 0;
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
                                                // (instead of clearing) so the
                                                // HiderTimer flips to the
                                                // "Hidden for" elapsed counter
                                                // immediately.
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
