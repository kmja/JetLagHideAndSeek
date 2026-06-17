import { useStore } from "@nanostores/react";
import { ChevronRight, Timer } from "lucide-react";
import { useMemo, useState } from "react";

import { useVisibleInterval } from "@/hooks/useVisibleInterval";
import { CATEGORIES, type CategoryId } from "@/lib/categories";
import {
    ANSWER_WINDOW_MS,
    answeringQuestion,
    hiderInbox,
    type InboxEntry,
} from "@/lib/hiderRole";
import { cn } from "@/lib/utils";
import type { Question } from "@/maps/schema";

/**
 * Pinned "you have a question to answer" reminder for the hider
 * shell. Persists for the whole time there's an un-replied entry
 * in the inbox — same pattern as ThermometerOverlay /
 * PendingAnswerOverlay on the seeker side: a toaster-style pill
 * floating over the map.
 *
 * Tapping the pill jumps to the answer view (`/h?q=…`) for the most
 * recent unanswered question, exactly like tapping a row in the
 * inbox sheet.
 *
 * Mounted by HiderShell. Hides itself entirely when there's nothing
 * waiting so it never sits on the map for no reason.
 */
export function HiderUnansweredOverlay() {
    const $inbox = useStore(hiderInbox);
    const waiting = useMemo(
        () =>
            $inbox
                .filter((e) => !e.repliedAt)
                .sort((a, b) => b.arrivedAt - a.arrivedAt),
        [$inbox],
    );

    // 1 Hz tick while a question is waiting, so the countdown next
    // to the prompt actually counts. Visibility-aware: paused while
    // the tab is hidden, so a backgrounded phone doesn't keep
    // burning a setInterval.
    const [now, setNow] = useState(() => Date.now());
    useVisibleInterval(
        () => setNow(Date.now()),
        1000,
        waiting.length > 0,
    );

    if (waiting.length === 0) return null;

    const latest = waiting[0];
    const meta = CATEGORIES[latest.id as CategoryId];
    const Icon = meta?.icon;
    const prompt = waitingPrompt(latest);
    const extraCount = waiting.length - 1;

    // Rulebook gives the hider 5 minutes per question. Past that
    // the seeker can pressure / re-ask; we clamp at 0:00 + flag the
    // entry as overdue so the countdown switches tone.
    const deadlineMs = latest.arrivedAt + ANSWER_WINDOW_MS;
    const remainingMs = Math.max(0, deadlineMs - now);
    const overdue = remainingMs === 0;
    const mins = Math.floor(remainingMs / 60_000);
    const secs = Math.floor((remainingMs % 60_000) / 1000);
    const countdownLabel = `${mins}:${String(secs).padStart(2, "0")}`;

    const handleClick = () => {
        // v301: open the answer flow as a dialog over the hider
        // shell instead of navigating to /h?q=… and unmounting the
        // whole shell. The dialog reads `answeringQuestion`.
        answeringQuestion.set({
            id: latest.id,
            key: latest.key,
            data: latest.data,
        } as Question);
    };

    return (
        <div
            className={cn(
                "pointer-events-none fixed left-1/2 -translate-x-1/2 z-[1035]",
                // Sits below the time header (top bar 48 + safe-area
                // + time header ~72 ≈ 120) with a small gap. v292
                // shaved 0.5rem off the top-bar height.
                "top-[calc(8rem+env(safe-area-inset-top))]",
                "max-w-[92vw] w-[min(92vw,420px)]",
            )}
            data-testid="hider-unanswered-overlay"
        >
            <button
                type="button"
                onClick={handleClick}
                className={cn(
                    "pointer-events-auto w-full text-left",
                    "flex items-center gap-3 px-3 py-2.5 rounded-md",
                    "bg-background/95 backdrop-blur-md shadow-xl",
                    "border-2 border-yellow-500/70",
                    "hover:border-yellow-400 hover:bg-background transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                )}
                aria-label={`Answer ${meta?.label ?? latest.id} question`}
            >
                {Icon && (
                    <span
                        className="inline-flex items-center justify-center w-9 h-9 rounded shrink-0"
                        style={{ backgroundColor: meta?.color ?? "#999" }}
                        aria-hidden
                    >
                        <Icon size={18} strokeWidth={2.5} className="text-white" />
                    </span>
                )}
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-[10px] uppercase tracking-[0.16em] font-poppins font-bold text-yellow-500">
                            Question waiting
                        </span>
                        {/* v302: 5-min rulebook countdown. Goes red
                            on overdue. tabular-nums so digits don't
                            jiggle as the seconds tick. */}
                        <span
                            className={cn(
                                "inline-flex items-center gap-1 shrink-0",
                                "text-[10px] font-mono font-bold tabular-nums leading-none",
                                "px-1.5 py-0.5 rounded-full border",
                                overdue
                                    ? "bg-destructive/15 border-destructive/50 text-destructive"
                                    : "bg-yellow-500/15 border-yellow-500/50 text-yellow-500",
                            )}
                            aria-label={
                                overdue
                                    ? "Answer window expired"
                                    : `${countdownLabel} left to answer`
                            }
                        >
                            <Timer className="w-3 h-3" strokeWidth={2.5} />
                            {overdue ? "0:00" : countdownLabel}
                        </span>
                    </div>
                    <p className="text-sm font-poppins font-semibold leading-snug truncate">
                        {prompt}
                    </p>
                </div>
                {extraCount > 0 && (
                    <span
                        className={cn(
                            "shrink-0 text-[10px] font-mono font-bold tabular-nums",
                            "bg-yellow-500 text-background",
                            "px-1.5 py-0.5 rounded-full",
                        )}
                        aria-label={`${extraCount} more question${extraCount === 1 ? "" : "s"} waiting`}
                    >
                        +{extraCount}
                    </span>
                )}
                <ChevronRight
                    className="w-4 h-4 text-muted-foreground shrink-0"
                    aria-hidden
                />
            </button>
        </div>
    );
}

/**
 * One-line summary of what the seeker is asking. Same shape as the
 * inbox-sheet WaitingRow's prompt so the overlay and the sheet stay
 * in sync; duplicated locally to avoid a circular import with the
 * sheet component.
 */
function waitingPrompt(entry: InboxEntry): string {
    const d = entry.data as Record<string, unknown>;
    const nice = (raw: unknown): string =>
        String(raw ?? "")
            .replace(/-/g, " ")
            .replace(/\b\w/g, (c) => c.toUpperCase());
    switch (entry.id) {
        case "radius": {
            const radius = d.radius;
            const unit =
                d.unit === "miles" ? "mi" : d.unit === "meters" ? "m" : "km";
            return `Within ${radius} ${unit} of the seeker?`;
        }
        case "thermometer":
            return "Did the seeker get warmer or colder?";
        case "matching":
            return d.type
                ? `Same ${nice(d.type)}?`
                : "Do we match on this attribute?";
        case "measuring":
            return d.type
                ? `Closer or further from the nearest ${nice(d.type)}?`
                : "Closer or further than the seeker?";
        case "tentacles":
            return `Closest ${nice(d.locationType) || "location"} to you?`;
        default:
            return "Tap to reveal & send your answer.";
    }
}

export default HiderUnansweredOverlay;
