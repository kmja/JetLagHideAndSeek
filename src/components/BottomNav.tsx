import { useStore } from "@nanostores/react";
import { List, Map as MapIcon, Plus, Users } from "lucide-react";

import { useNow } from "@/hooks/useNow";
import {
    pendingRandomize,
    questions,
    questionsDrawerOpen,
} from "@/lib/context";
import {
    computeAskingRestrictions,
    seekerOnTransit,
    spottyMemoryCategory,
} from "@/lib/curseEnforcement";
import { hidingPeriodEndsAt, mapOptionsDrawerOpen } from "@/lib/gameSetup";
import { lobbyManualOpen, participants } from "@/lib/multiplayer/session";
import { receivedCurses } from "@/lib/seekerInbound";
import { cn } from "@/lib/utils";

import {
    NAV_BTN_CLASS,
    NAV_LABEL_CLASS,
    NavBadge,
} from "@/components/bottomNavPrimitives";

import { AddQuestionDialog } from "./AddQuestionDialog";
import { AppSettingsDrawer } from "./AppSettingsDrawer";
import {
    MapOptionsDrawer,
    useMapOptionsActiveCount,
} from "./MapDisplayControls";

/**
 * Bottom-anchored mobile navigation. Four slots (v629): Questions,
 * New question (primary CTA), Map, Lobby (rightmost). Settings lives in
 * the app header (SeekerTopBar); the hiding-period countdown lives on the
 * map's HiderTimer card.
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
    // v1029: while the seeker owes a Randomize replacement they must ask that
    // (via the answer card's "Ask new" button) before any other question.
    const $pendingRandomize = useStore(pendingRandomize);
    const randomizeOwed = $pendingRandomize !== null;
    const mapActiveCount = useMapOptionsActiveCount();

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

    const navBtnClass = NAV_BTN_CLASS;
    const navLabelClass = NAV_LABEL_CLASS;

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
                        <NavBadge
                            count={$questions.length}
                            className="bg-secondary text-foreground border border-border"
                            aria-label={`${$questions.length} questions added`}
                        />
                    )}
                </button>

                <AddQuestionDialog respondToSignal>
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
                                curseBlock.blockedAll ||
                                randomizeOwed) &&
                                "opacity-50",
                        )}
                        disabled={
                            hiding ||
                            hasPendingAnswer ||
                            curseBlock.blockedAll ||
                            randomizeOwed
                        }
                        aria-label="Add question"
                        title={
                            hiding
                                ? "Hiding period — wait for the timer or end it manually to start asking"
                                : hasPendingAnswer
                                  ? "Waiting for the hider to answer your previous question"
                                  : randomizeOwed
                                    ? "The hider randomized your question — ask the replacement from the answer card first"
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

                {/* Map slot (v629). Opens the roomy map-options drawer
                    (basemap / overlays / transit). */}
                <button
                    type="button"
                    onClick={() => mapOptionsDrawerOpen.set(true)}
                    className={navBtnClass}
                    aria-label="Map options"
                    title="Basemap, overlays, transit lines"
                >
                    <MapIcon className="w-5 h-5" strokeWidth={2} />
                    <span className={navLabelClass}>Map</span>
                    {mapActiveCount > 0 && (
                        <NavBadge
                            count={mapActiveCount}
                            className="bg-primary text-primary-foreground border border-background"
                            aria-label={`${mapActiveCount} map option(s) active`}
                        />
                    )}
                </button>

                {/* Lobby slot (v629) — rightmost. Opens the GameLobbyDialog;
                    badge = live online-participant count. */}
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
                        <NavBadge
                            count={$participants.filter((p) => p.online).length}
                            className="bg-secondary text-foreground border border-border"
                            aria-label={`${$participants.filter((p) => p.online).length} players online`}
                        />
                    )}
                </button>

                <AppSettingsDrawer />
                <MapOptionsDrawer />
            </div>
        </div>
    );
};
