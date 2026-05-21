import { useStore } from "@nanostores/react";
import { Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { VscChevronDown } from "react-icons/vsc";

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
import { CATEGORIES, type CategoryId } from "@/lib/categories";
import { isLoading, questions } from "@/lib/context";
import { cn } from "@/lib/utils";

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

    // Tick every minute to keep relative timestamps fresh.
    const [nowTick, setNowTick] = useState(Date.now());
    useEffect(() => {
        if (!createdAt) return;
        const id = setInterval(() => setNowTick(Date.now()), 60000);
        return () => clearInterval(id);
    }, [createdAt]);
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
    useEffect(() => {
        if (!isPending || !createdAt) return;
        const id = setInterval(() => setCountdownTick(Date.now()), 1000);
        return () => clearInterval(id);
    }, [isPending, createdAt]);
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
                        <SidebarMenu>{children}</SidebarMenu>
                    </SidebarGroupContent>
                </div>
            </SidebarGroup>
            <Separator className="h-1" />
        </>
    );
};

/**
 * Collapsible wrapper for the "manual answer" toggle in question cards.
 * When `compact` is true, the children are hidden behind a small "Set
 * answer manually" button that reveals them on click. Used in the
 * just-added-question dialog where we expect the hider to provide the
 * answer via share-link instead.
 */
export const ManualAnswerDisclosure = ({
    children,
}: {
    /** Accepted for backwards-compat but no longer drives behavior —
     *  the disclosure is now collapsed by default for every question
     *  type, matching the "the answer arrives from the hider, you
     *  rarely need to set it manually" workflow. */
    compact?: boolean;
    children: React.ReactNode;
}) => {
    const [open, setOpen] = useState(false);
    if (open) return <>{children}</>;
    return (
        <button
            type="button"
            onClick={() => setOpen(true)}
            className={cn(
                "w-full px-2 py-2 mt-1 text-left text-xs",
                "text-muted-foreground hover:text-foreground",
                "transition-colors",
            )}
        >
            ▾ Set answer manually
        </button>
    );
};

