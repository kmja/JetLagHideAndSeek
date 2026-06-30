import { useStore } from "@nanostores/react";
import { List, Plus, Settings, Users } from "lucide-react";

import { useNow } from "@/hooks/useNow";
import { questions, questionsDrawerOpen } from "@/lib/context";
import {
    computeAskingRestrictions,
    seekerOnTransit,
    spottyMemoryCategory,
} from "@/lib/curseEnforcement";
import {
    hidingPeriodEndsAt,
    moreSheetOpen,
} from "@/lib/gameSetup";
import { lobbyManualOpen, participants } from "@/lib/multiplayer/session";
import { receivedCurses } from "@/lib/seekerInbound";
import { cn } from "@/lib/utils";

import { AddQuestionDialog } from "./AddQuestionDialog";
import { AppSettingsDrawer } from "./AppSettingsDrawer";

/**
 * Bottom-anchored mobile navigation. Four slots: Questions, New
 * question (primary CTA), Lobby, Settings. v270 retired the
 * standalone "Game" drawer that used to live in the Settings slot —
 * its content split between the lobby (mid-game info, round-end
 * recap via RoundEndSection) and the Settings drawer (preload, app
 * preferences). The hiding-period countdown lives on the map's
 * HiderTimer card; surfacing it again here was visual noise.
 */
export const BottomNav = () => {
    const $questions = useStore(questions);
    const $hidingEndsAt = useStore(hidingPeriodEndsAt);
    const $participants = useStore(participants);
    // Curse enforcement (v621): some active curses block ALL asking
    // (Urban Explorer on transit, or Spotty Memory before the seekers
    // roll). Partial category blocks are handled inside AddQuestionDialog;
    // only a full block disables the New-question button here.
    const $curses = useStore(receivedCurses);
    const $onTransit = useStore(seekerOnTransit);
    const $spottyCategory = useStore(spottyMemoryCategory);
    const curseBlock = computeAskingRestrictions($curses, {
        onTransit: $onTransit,
        spottyCategory: $spottyCategory,
    });

    // Tick state at 1 Hz while a hiding period is active so the
    // New-question button stays accurately disabled across the
    // hiding → seeking boundary. `useVisibleInterval` pauses while
    // the tab is hidden — saves battery on locked phones since players
    // run the app for hours. On resume it re-syncs immediately so the
    // disabled state jumps to truth.
    // v377: shared clock. Gate on "is there an end timestamp at all"
    // rather than "is it still in the future" — the latter depended on
    // `now`, creating a now⇄hidingRunning cycle the old code patched with
    // a manual refresh effect. Gating on presence breaks the cycle, and
    // useNow fires immediately on subscribe so the snap-to-now case stays
    // correct without the extra effect.
    const now = useNow($hidingEndsAt !== null);

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
                // v462: a real flow row at the bottom of the seeker column
                // (was `fixed bottom-0`). Sits BELOW the map instead of
                // overlaying it, so the map's bottom controls anchor to
                // the map area with a plain bottom offset.
                "md:hidden shrink-0 z-[1040]",
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
                            (hiding ||
                                hasPendingAnswer ||
                                curseBlock.blockedAll) &&
                                "opacity-50",
                        )}
                        disabled={
                            hiding || hasPendingAnswer || curseBlock.blockedAll
                        }
                        aria-label="Add question"
                        title={
                            hiding
                                ? "Hiding period — wait for the timer or end it manually to start asking"
                                : hasPendingAnswer
                                  ? "Waiting for the hider to answer your previous question"
                                  : curseBlock.blockedAll
                                    ? (curseBlock.reason ??
                                      "Asking is blocked by an active curse")
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

                {/* v270: the standalone "Game" drawer (countdown +
                    in-line setup summary + preload + FoundSummary)
                    was retired. The countdown lives on the map's
                    HiderTimer; the setup summary + preload moved to
                    the Settings drawer triggered by the rightmost
                    bottom-nav slot; the post-found recap moved into
                    the lobby's mid-game branch via RoundEndSection. */}

                {/* Settings slot — opens the moreSheetOpen drawer
                    that the SeekerTopBar gear used to launch. The
                    trigger lives here now so every bottom-nav surface
                    is reachable from the same row. */}
                <button
                    type="button"
                    onClick={() => moreSheetOpen.set(true)}
                    className={navBtnClass}
                    aria-label="Settings"
                    title="Settings — tutorial, rulebook, units, theme, preload"
                >
                    <Settings className="w-5 h-5" strokeWidth={2} />
                    <span className={navLabelClass}>Settings</span>
                </button>

                <AppSettingsDrawer />
            </div>
        </div>
    );
};
