import { useStore } from "@nanostores/react";
import { ChevronRight } from "lucide-react";
import { useMemo } from "react";

import { CATEGORIES, type CategoryId } from "@/lib/categories";
import { hiderInbox, type InboxEntry } from "@/lib/hiderRole";
import { encodeQuestionForHider } from "@/lib/shareLinks";
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

    if (waiting.length === 0) return null;

    const latest = waiting[0];
    const meta = CATEGORIES[latest.id as CategoryId];
    const Icon = meta?.icon;
    const prompt = waitingPrompt(latest);
    const extraCount = waiting.length - 1;

    const handleClick = () => {
        const question = {
            id: latest.id,
            key: latest.key,
            data: latest.data,
        } as Question;
        try {
            const url = encodeQuestionForHider(question);
            const parsed = new URL(url);
            window.location.assign(
                parsed.pathname + parsed.search + parsed.hash,
            );
        } catch {
            const payload = JSON.stringify(question);
            window.location.assign(`/h?q=${encodeURIComponent(payload)}`);
        }
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
                    <div className="text-[10px] uppercase tracking-[0.16em] font-poppins font-bold text-yellow-500">
                        Question waiting
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
