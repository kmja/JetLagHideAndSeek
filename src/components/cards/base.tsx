import { useStore } from "@nanostores/react";
import { LockIcon, UnlockIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { VscChevronDown, VscShare, VscTrash } from "react-icons/vsc";

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
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@/components/ui/dialog";
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
    const copyButtonRef = useRef<HTMLButtonElement>(null);

    const categoryMeta = category ? CATEGORIES[category] : undefined;
    const CategoryIcon = categoryMeta?.icon;

    // Tick every minute to keep relative timestamps fresh. Skip if no timestamp.
    const [nowTick, setNowTick] = useState(Date.now());
    useEffect(() => {
        if (!createdAt) return;
        const id = setInterval(() => setNowTick(Date.now()), 60000);
        return () => clearInterval(id);
    }, [createdAt]);
    const relativeTime = createdAt
        ? formatRelativeTime(createdAt, nowTick)
        : null;

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
                <div className="relative">
                    <button
                        onClick={toggleCollapse}
                        className={cn(
                            "absolute top-2 left-2 text-white border rounded-md transition-all duration-500 hover:bg-white/10",
                            isCollapsed && "-rotate-90",
                        )}
                        aria-label={isCollapsed ? "Expand" : "Collapse"}
                    >
                        <VscChevronDown />
                    </button>
                    <SidebarGroupLabel
                        className="ml-8 mr-8 cursor-pointer flex items-center gap-2 hover:bg-white/[0.03] rounded-sm transition-colors"
                        onClick={toggleCollapse}
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
                        {relativeTime && (
                            <span
                                className="ml-auto text-[10px] text-muted-foreground font-mono shrink-0"
                                title={new Date(createdAt!).toLocaleString()}
                            >
                                {relativeTime}
                            </span>
                        )}
                    </SidebarGroupLabel>
                    {summary && isCollapsed && (
                        <div
                            onClick={toggleCollapse}
                            className="ml-[3.25rem] mr-8 -mt-1 pb-2 text-xs text-muted-foreground cursor-pointer truncate"
                        >
                            {summary}
                        </div>
                    )}
                    <SidebarGroupContent
                        className={cn(
                            "overflow-hidden transition-all duration-1000 max-h-[100rem]", // 100rem is arbitrary
                            isCollapsed && "max-h-0",
                        )}
                    >
                        <SidebarMenu>{children}</SidebarMenu>
                        <div className="flex gap-2 pt-2 px-2 justify-center">
                            <Dialog>
                                <DialogTrigger asChild>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        title="Share question as JSON"
                                        aria-label="Share question as JSON"
                                    >
                                        <VscShare />
                                    </Button>
                                </DialogTrigger>
                                <DialogContent>
                                    <DialogHeader>
                                        <DialogTitle className="text-2xl">
                                            Share this Question!
                                        </DialogTitle>
                                        <DialogDescription>
                                            Below you can access the JSON
                                            representing the question. Send this
                                            to another player for them to copy.
                                            They can then click &ldquo;Paste
                                            Question&rdquo; at the bottom of the
                                            &ldquo;Questions&rdquo; sidebar.
                                        </DialogDescription>
                                    </DialogHeader>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="mb-2 sm:mb-0 transition-colors"
                                        ref={copyButtonRef}
                                        onClick={() => {
                                            navigator.clipboard
                                                .writeText(
                                                    JSON.stringify(
                                                        $questions.find(
                                                            (q) =>
                                                                q.key ===
                                                                questionKey,
                                                        ),
                                                        null,
                                                        4,
                                                    ),
                                                )
                                                .then(() => {
                                                    if (copyButtonRef.current) {
                                                        copyButtonRef.current.textContent =
                                                            "Copied!";
                                                        copyButtonRef.current.classList.add(
                                                            "bg-green-500",
                                                        );
                                                        setTimeout(() => {
                                                            if (
                                                                copyButtonRef.current
                                                            ) {
                                                                copyButtonRef.current.textContent =
                                                                    "Copy to Clipboard";
                                                                copyButtonRef.current.classList.remove(
                                                                    "bg-green-500",
                                                                );
                                                            }
                                                        }, 2000);
                                                    }
                                                })
                                                .catch(() => {
                                                    if (copyButtonRef.current) {
                                                        copyButtonRef.current.textContent =
                                                            "Failed to Copy";
                                                        copyButtonRef.current.classList.add(
                                                            "bg-red-500",
                                                        );
                                                        setTimeout(() => {
                                                            if (
                                                                copyButtonRef.current
                                                            ) {
                                                                copyButtonRef.current.textContent =
                                                                    "Copy to Clipboard";
                                                                copyButtonRef.current.classList.remove(
                                                                    "bg-red-500",
                                                                );
                                                            }
                                                        }, 2000);
                                                    }
                                                });
                                        }}
                                    >
                                        Copy to Clipboard
                                    </Button>
                                    <textarea
                                        className="w-full h-[300px] bg-slate-900 text-white rounded-md p-2"
                                        readOnly
                                        value={JSON.stringify(
                                            $questions.find(
                                                (q) => q.key === questionKey,
                                            ),
                                            null,
                                            4,
                                        )}
                                    ></textarea>
                                </DialogContent>
                            </Dialog>
                            <AlertDialog>
                                <AlertDialogTrigger asChild>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={$isLoading}
                                        title="Delete question"
                                        aria-label="Delete question"
                                        className="hover:bg-destructive/10 hover:text-destructive hover:border-destructive transition-colors"
                                    >
                                        <VscTrash />
                                    </Button>
                                </AlertDialogTrigger>
                                <AlertDialogContent>
                                    <AlertDialogHeader>
                                        <AlertDialogTitle>
                                            Are you absolutely sure?
                                        </AlertDialogTitle>
                                        <AlertDialogDescription>
                                            This action cannot be undone. This
                                            will permanently delete the
                                            question.
                                        </AlertDialogDescription>
                                    </AlertDialogHeader>
                                    <AlertDialogFooter>
                                        <AlertDialogCancel>
                                            Cancel
                                        </AlertDialogCancel>
                                        <AlertDialogAction
                                            onClick={() => {
                                                questions.set(
                                                    $questions.filter(
                                                        (q) =>
                                                            q.key !==
                                                            questionKey,
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
                            {locked !== undefined && (
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => setLocked!(!locked)}
                                    disabled={$isLoading}
                                    title={
                                        locked
                                            ? "Unlock marker position"
                                            : "Lock marker position"
                                    }
                                    aria-label={
                                        locked
                                            ? "Unlock marker position"
                                            : "Lock marker position"
                                    }
                                >
                                    {locked ? <LockIcon /> : <UnlockIcon />}
                                </Button>
                            )}
                        </div>
                    </SidebarGroupContent>
                </div>
            </SidebarGroup>
            <Separator className="h-1" />
        </>
    );
};
