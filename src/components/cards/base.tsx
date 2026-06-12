import { useStore } from "@nanostores/react";
import { Copy, Share2, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { VscChevronDown } from "react-icons/vsc";
import { toast } from "react-toastify";

import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Separator } from "@/components/ui/separator";
import {
    SidebarGroup,
    SidebarGroupContent,
    SidebarGroupLabel,
    SidebarMenu,
} from "@/components/ui/sidebar-l";
import { useVisibleInterval } from "@/hooks/useVisibleInterval";
import { CATEGORIES, type CategoryId } from "@/lib/categories";
import { isLoading, questionModified, questions } from "@/lib/context";
import {
    encodeQuestionForHider,
    shareOrCopy,
} from "@/lib/shareLinks";
import { cn } from "@/lib/utils";
import type { Question } from "@/maps/schema";

/**
 * Compact relative time formatter for question timestamps.
 * Returns "just now", "5m ago", "2h ago", "3d ago".
 */
function formatRelativeTime(timestamp: number, now: number): string {
    const diffMs = now - timestamp;
    const diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 30) return "just now";
    if (diffSec < 60) return `${diffSec}s ago`;
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    return `${diffDay}d ago`;
}

export const QuestionCard = ({
    children,
    questionKey,
    className,
    label,
    sub,
    category,
    summary,
    createdAt,
    collapsed,
    forceExpanded,
    locked,
    setLocked,
    setCollapsed,
}: {
    children: React.ReactNode;
    questionKey: number;
    className?: string;
    label?: string;
    sub?: string;
    category?: CategoryId;
    summary?: React.ReactNode;
    createdAt?: number;
    collapsed?: boolean;
    forceExpanded?: boolean;
    locked?: boolean;
    setLocked?: (locked: boolean) => void;
    setCollapsed?: (collapsed: boolean) => void;
}) => {
    const [isCollapsed, setIsCollapsed] = useState(
        forceExpanded ? false : (collapsed ?? true),
    );
    const $questions = useStore(questions);
    const $isLoading = useStore(isLoading);

    const categoryMeta = category ? CATEGORIES[category] : undefined;
    const CategoryIcon = categoryMeta?.icon;

    // Resolve the live Question from the store so we can build a fresh
    // share URL (config may have changed since add-time). Thermometer in
    // its "started" phase has nothing to share yet — its share row is
    // contributed by the card itself once finished.
    const thisQuestion = $questions.find((q) => q.key === questionKey);
    const thermStatus =
        thisQuestion?.id === "thermometer"
            ? (thisQuestion.data as { status?: string }).status ?? "finished"
            : null;
    const shareable =
        thisQuestion &&
        thisQuestion.data.drag === true &&
        thermStatus !== "started" &&
        // The configure dialog already has its own "Confirm & share" CTA;
        // a second share row up top would be redundant and would let the
        // seeker ship the question before they've committed to its config.
        !forceExpanded;

    // Tick every minute to keep relative timestamps fresh.
    // Visibility-aware so a hidden tab doesn't burn CPU.
    const [nowTick, setNowTick] = useState(Date.now());
    useVisibleInterval(
        () => setNowTick(Date.now()),
        60000,
        createdAt !== undefined,
    );
    const relativeTime = createdAt
        ? formatRelativeTime(createdAt, nowTick)
        : null;

    // Rulebook p5 / p32: the hider must answer most questions within 5 min;
    // photo questions get 10 min (S/M) or 20 min (L). We display a short
    // countdown on the unanswered card so the seeker has clear feedback
    // about whether their answer window is still open.
    //
    // The 5/10/20 min split per game size isn't surfaced into the card
    // (the card doesn't know the game size); we use 10 min for photo as
    // a reasonable middle value. Refine when we model the hider role.
    const answerDeadlineMs =
        category === "photo" ? 10 * 60_000 : 5 * 60_000;
    const isPending = locked === false;
    const [countdownTick, setCountdownTick] = useState(Date.now());
    useVisibleInterval(
        () => setCountdownTick(Date.now()),
        1000,
        isPending && createdAt !== undefined,
    );
    const remainingSec =
        isPending && createdAt
            ? Math.max(
                  0,
                  Math.ceil(
                      (createdAt + answerDeadlineMs - countdownTick) / 1000,
                  ),
              )
            : null;
    const answerDeadlineLabel =
        remainingSec === null
            ? null
            : remainingSec > 0
              ? `${Math.floor(remainingSec / 60)}:${String(
                    remainingSec % 60,
                ).padStart(2, "0")} to answer`
              : "answer overdue";

    const toggleCollapse = () => {
        if (setCollapsed) {
            setCollapsed(!isCollapsed);
        }
        setIsCollapsed((prevState) => !prevState);
    };

    return (
        <>
            <SidebarGroup
                className={cn(
                    category && "border-l-[3px] border-l-[var(--cat-color)]",
                    className,
                )}
                style={
                    categoryMeta
                        ? ({
                              "--cat-color": categoryMeta.color,
                          } as React.CSSProperties)
                        : undefined
                }
            >
                {/* Header row + summary. When collapsed we wrap the whole
                    visible band in a click-target div so any tap (not just
                    the chevron / label / summary) expands the card.
                    Action buttons (trash) stop propagation on their own. */}
                <div
                    className={cn(
                        "relative",
                        isCollapsed && "cursor-pointer",
                    )}
                    onClick={isCollapsed ? toggleCollapse : undefined}
                    role={isCollapsed ? "button" : undefined}
                    aria-expanded={!isCollapsed}
                >
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            toggleCollapse();
                        }}
                        className={cn(
                            "absolute top-2 left-2 text-white border rounded-md transition-transform duration-200 hover:bg-white/10",
                            isCollapsed && "-rotate-90",
                        )}
                        aria-label={isCollapsed ? "Expand" : "Collapse"}
                    >
                        <VscChevronDown />
                    </button>
                    {/* Trash button — top-right of the header. Stops
                        propagation so tapping it doesn't also toggle the
                        collapsed state. Opens the existing confirm
                        AlertDialog before actually removing the question. */}
                    <AlertDialog>
                        <AlertDialogTrigger asChild>
                            <button
                                type="button"
                                onClick={(e) => e.stopPropagation()}
                                disabled={$isLoading}
                                aria-label="Delete question"
                                title="Delete question"
                                className={cn(
                                    "absolute top-2 right-2 w-6 h-6",
                                    "flex items-center justify-center rounded-md",
                                    "text-muted-foreground hover:text-destructive hover:bg-destructive/10",
                                    "transition-colors",
                                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                    "disabled:opacity-40 disabled:cursor-not-allowed",
                                )}
                            >
                                <Trash2 className="w-3.5 h-3.5" />
                            </button>
                        </AlertDialogTrigger>
                        <AlertDialogContent
                            onClick={(e) => e.stopPropagation()}
                        >
                            <AlertDialogHeader>
                                <AlertDialogTitle>
                                    Are you absolutely sure?
                                </AlertDialogTitle>
                                <AlertDialogDescription>
                                    This action cannot be undone. This will
                                    permanently delete the question.
                                </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                <AlertDialogAction
                                    onClick={() => {
                                        questions.set(
                                            $questions.filter(
                                                (q) =>
                                                    q.key !== questionKey,
                                            ),
                                        );
                                    }}
                                    className="mb-2 sm:mb-0"
                                >
                                    Delete Question
                                </AlertDialogAction>
                            </AlertDialogFooter>
                        </AlertDialogContent>
                    </AlertDialog>
                    <SidebarGroupLabel
                        className="ml-8 mr-10 flex items-center gap-2 rounded-sm transition-colors"
                    >
                        {CategoryIcon && (
                            <span
                                className="inline-flex items-center justify-center w-5 h-5 rounded shrink-0"
                                style={{
                                    backgroundColor: categoryMeta!.color,
                                }}
                                aria-hidden="true"
                            >
                                <CategoryIcon
                                    size={13}
                                    strokeWidth={2.5}
                                    className="text-white"
                                />
                            </span>
                        )}
                        <span>
                            {label} {sub && `(${sub})`}
                        </span>
                        {answerDeadlineLabel && (
                            <span
                                className={cn(
                                    "ml-auto text-[10px] font-mono tabular-nums shrink-0",
                                    remainingSec === 0
                                        ? "text-destructive"
                                        : "text-primary",
                                )}
                                title="Hider's answer window (rulebook p5/p32)"
                            >
                                {answerDeadlineLabel}
                            </span>
                        )}
                        {!answerDeadlineLabel && relativeTime && (
                            <span
                                className="ml-auto text-[10px] text-muted-foreground font-mono shrink-0"
                                title={new Date(createdAt!).toLocaleString()}
                            >
                                {relativeTime}
                            </span>
                        )}
                    </SidebarGroupLabel>
                    {summary && isCollapsed && (
                        <div className="ml-[3.25rem] mr-10 -mt-1 pb-2 text-xs text-muted-foreground truncate">
                            {summary}
                        </div>
                    )}
                    <SidebarGroupContent
                        className={cn(
                            "overflow-hidden transition-all duration-200 max-h-[100rem]", // 100rem is arbitrary
                            isCollapsed && "max-h-0",
                        )}
                    >
                        <SidebarMenu>
                            {shareable && thisQuestion && (
                                <ShareQuestionRow question={thisQuestion} />
                            )}
                            {children}
                        </SidebarMenu>
                    </SidebarGroupContent>
                </div>
            </SidebarGroup>
            <Separator className="h-1" />
        </>
    );
};

/**
 * Inline "send this question to the hider" row, rendered at the top of every
 * pending (drag:true) question card. Backup path for when the OS share sheet
 * dismissed (or otherwise didn't fire) after the initial Confirm.
 *
 * On a successful share or copy, also stamps `data.createdAt = Date.now()`
 * if it wasn't already set — the 5-minute answer countdown starts here
 * rather than at confirm-time, which matches the hider's actual receipt
 * of the link.
 */
function ShareQuestionRow({ question }: { question: Question }) {
    const $isLoading = useStore(isLoading);
    const meta = CATEGORIES[question.id as CategoryId];

    const stampSent = () => {
        const d = question.data as { createdAt?: number };
        if (d.createdAt) return; // already sent — don't reset the countdown
        d.createdAt = Date.now();
        questionModified();
    };

    const handleShare = async () => {
        const url = encodeQuestionForHider(question);
        const result = await shareOrCopy({
            title: `${meta?.label ?? "Question"} for the hider`,
            text: `${meta?.label ?? "Question"}: tap to answer`,
            url,
        });
        if (result.method === "share" || result.method === "copy") {
            stampSent();
        }
        if (result.method === "copy") {
            toast.success("Question link copied", { autoClose: 1500 });
        } else if (result.method === "failed") {
            toast.error("Could not share question link");
        }
    };

    const handleCopy = async () => {
        const url = encodeQuestionForHider(question);
        try {
            await navigator.clipboard.writeText(url);
            stampSent();
            toast.success("Question link copied", { autoClose: 1500 });
        } catch {
            toast.error("Could not copy");
        }
    };

    const alreadySent = Boolean(
        (question.data as { createdAt?: number }).createdAt,
    );

    return (
        <div className="px-2 pt-2 pb-1">
            <div className="text-[10px] uppercase tracking-[0.16em] font-poppins font-semibold text-muted-foreground mb-1.5">
                {alreadySent ? "Re-share with hider" : "Send to hider"}
            </div>
            <div className="flex gap-2">
                <button
                    type="button"
                    onClick={handleShare}
                    disabled={$isLoading}
                    className={cn(
                        "flex-1 flex items-center justify-center gap-1.5",
                        "px-2 py-2 rounded-md text-xs font-poppins font-semibold",
                        "bg-primary text-primary-foreground hover:bg-primary/90",
                        "transition-colors",
                        "disabled:opacity-50 disabled:cursor-not-allowed",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    )}
                >
                    <Share2 className="w-3.5 h-3.5" />
                    Share
                </button>
                <button
                    type="button"
                    onClick={handleCopy}
                    disabled={$isLoading}
                    className={cn(
                        "flex-1 flex items-center justify-center gap-1.5",
                        "px-2 py-2 rounded-md text-xs font-poppins font-semibold",
                        "bg-secondary text-foreground hover:bg-accent border border-border",
                        "transition-colors",
                        "disabled:opacity-50 disabled:cursor-not-allowed",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    )}
                >
                    <Copy className="w-3.5 h-3.5" />
                    Copy link
                </button>
            </div>
        </div>
    );
}

/**
 * Suppressed manual-answer disclosure. The app now trusts that a real
 * hider will reply via share-link or multiplayer — so the seeker
 * never needs to override the answer locally. Renders nothing for
 * every question type. The component is kept (rather than ripped
 * out at every callsite) so the wiring stays simple if we ever want
 * to bring a debug-only manual mode back.
 */
export const ManualAnswerDisclosure = (
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _props: { compact?: boolean; children: React.ReactNode },
) => null;

