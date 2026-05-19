import { useStore } from "@nanostores/react";
import {
    Footprints,
    Gamepad2,
    List,
    MoreHorizontal,
    Plus,
    Timer,
} from "lucide-react";
import { useEffect, useState } from "react";

import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
    SheetTrigger,
} from "@/components/ui/sheet";
import { SidebarContext as SidebarContextL } from "@/components/ui/sidebar-l";
import { questions } from "@/lib/context";
import {
    allowedTransit,
    formatTimeRemaining,
    gameSize,
    hidingPeriodEndsAt,
    playArea,
    setupCompleted,
    setupDialogOpen,
    TRANSIT_LABELS,
} from "@/lib/gameSetup";
import { cn } from "@/lib/utils";

import { AddQuestionDialog } from "./AddQuestionDialog";
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
        if ($hidingEndsAt <= Date.now()) {
            // Already expired — auto-clear so the button reverts to Game.
            hidingPeriodEndsAt.set(null);
            return;
        }
        setNow(Date.now());
        const id = window.setInterval(() => {
            const t = Date.now();
            setNow(t);
            if ($hidingEndsAt <= t) {
                hidingPeriodEndsAt.set(null);
                window.clearInterval(id);
            }
        }, 1000);
        return () => window.clearInterval(id);
    }, [$hidingEndsAt]);

    const remainingMs = $hidingEndsAt ? Math.max(0, $hidingEndsAt - now) : 0;
    const hiding = Boolean($hidingEndsAt && remainingMs > 0);

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
                    onClick={() =>
                        SidebarContextL.get().setOpenMobile(true)
                    }
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
                            hiding && "opacity-50",
                        )}
                        disabled={hiding}
                        aria-label="Add question"
                        title={
                            hiding
                                ? "Hiding period — wait for the timer or end it manually to start asking"
                                : "Add a question"
                        }
                    >
                        <Plus className="w-5 h-5" strokeWidth={2.5} />
                        <span className="text-[10px] font-bold uppercase tracking-wider">
                            Ask
                        </span>
                    </button>
                </AddQuestionDialog>

                {/* Game slot. During hiding period it doubles as a count-
                    down display. Tap to open the sheet with an "End hiding"
                    button + the usual setup summary. */}
                <Sheet open={gameSheetOpen} onOpenChange={setGameSheetOpen}>
                    <SheetTrigger asChild>
                        <button
                            type="button"
                            className={cn(
                                navBtnClass,
                                hiding &&
                                    "text-foreground bg-secondary/60",
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
                                <Gamepad2
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
                                      ? "Game"
                                      : "Setup"}
                            </span>
                            {!$setupCompleted && !hiding && (
                                <span
                                    className="absolute top-1 right-2 w-2 h-2 rounded-full bg-primary"
                                    aria-label="Setup needed"
                                />
                            )}
                        </button>
                    </SheetTrigger>
                    <SheetContent
                        side="bottom"
                        className="rounded-t-2xl pb-[env(safe-area-inset-bottom)]"
                    >
                        <SheetHeader>
                            <SheetTitle>
                                {hiding ? "Hiding period" : "Game"}
                            </SheetTitle>
                            <SheetDescription>
                                {hiding
                                    ? "The hider has time to get to their hiding spot. The seeker can't ask questions yet."
                                    : $setupCompleted
                                      ? "Your current setup. Edit anything, or start fresh."
                                      : "Set up your game to get started."}
                            </SheetDescription>
                        </SheetHeader>

                        {hiding && (
                            <div className="mt-4">
                                <div className="text-center py-6 rounded-md bg-secondary/30 border border-border">
                                    <div className="text-xs uppercase tracking-wider text-muted-foreground font-poppins font-semibold mb-2">
                                        Time remaining
                                    </div>
                                    <div className="text-4xl font-poppins font-bold tabular-nums text-primary">
                                        {formatTimeRemaining(remainingMs)}
                                    </div>
                                </div>
                                <Button
                                    onClick={() => {
                                        hidingPeriodEndsAt.set(null);
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
                                                {$playArea?.displayName.split(",")[0] ??
                                                    "—"}
                                            </span>
                                        </div>
                                        <div className="flex justify-between gap-2">
                                            <span className="text-muted-foreground">
                                                Transit
                                            </span>
                                            <span className="font-medium truncate min-w-0 text-right">
                                                <Footprints className="inline w-3 h-3 mr-1 -mt-0.5" />
                                                {$allowedTransit
                                                    .map(
                                                        (m) =>
                                                            TRANSIT_LABELS[m],
                                                    )
                                                    .join(", ") ||
                                                    "Walking only"}
                                            </span>
                                        </div>
                                        <div className="flex justify-between gap-2">
                                            <span className="text-muted-foreground">
                                                Size
                                            </span>
                                            <span className="font-medium capitalize">
                                                {$gameSize}
                                            </span>
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
                                            ? "Edit setup"
                                            : "Set up game"}
                                    </Button>
                                    {$setupCompleted && (
                                        <Button
                                            variant="destructive"
                                            className="flex-1"
                                            onClick={() => {
                                                setGameSheetOpen(false);
                                                setupCompleted.set(false);
                                                hidingPeriodEndsAt.set(null);
                                                setupDialogOpen.set(true);
                                            }}
                                        >
                                            New game
                                        </Button>
                                    )}
                                </div>
                            </div>
                        )}
                    </SheetContent>
                </Sheet>

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
                        className="rounded-t-2xl pb-[env(safe-area-inset-bottom)]"
                    >
                        <SheetHeader>
                            <SheetTitle>More</SheetTitle>
                            <SheetDescription>
                                Share your map, see the tutorial, or open
                                advanced options.
                            </SheetDescription>
                        </SheetHeader>
                        <div className="mt-4 pb-2 flex justify-center">
                            <OptionDrawers />
                        </div>
                    </SheetContent>
                </Sheet>
            </div>
        </div>
    );
};
