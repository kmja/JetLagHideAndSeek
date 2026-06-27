import { useStore } from "@nanostores/react";
import { useMemo, useState } from "react";

import { useVisibleInterval } from "@/hooks/useVisibleInterval";
import {
    ANSWER_WINDOW_MS,
    answeringQuestion,
    hiderInbox,
    type InboxEntry,
} from "@/lib/hiderRole";
import { cn } from "@/lib/utils";
import type { Question } from "@/maps/schema";

import {
    QuestionOverlayCard,
    summarizeQuestion,
} from "./questionOverlayCard";

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
/** Override the inbox to preview the pill in the /debug/overlays gallery
 *  without touching global state. */
export interface HiderUnansweredPreview {
    inbox: InboxEntry[];
}

export function HiderUnansweredOverlay({
    preview,
}: { preview?: HiderUnansweredPreview } = {}) {
    let $inbox = useStore(hiderInbox);
    if (preview) $inbox = preview.inbox;
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
    const summary = summarizeQuestion(latest);
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

    // Compact white status under the icon inside the solid colour square:
    // the answer-window countdown, plus a "+N" when more are queued.
    const rightSlot = (
        <div className="flex flex-col items-center gap-0.5 leading-none">
            <span className="text-sm font-poppins font-black tabular-nums leading-none">
                {overdue ? "0:00" : countdownLabel}
            </span>
            {extraCount > 0 && (
                <span
                    className="text-[8px] font-poppins font-bold leading-none"
                    aria-label={`${extraCount} more question${extraCount === 1 ? "" : "s"} waiting`}
                >
                    +{extraCount}
                </span>
            )}
        </div>
    );

    return (
        <div
            className={cn(
                // v462: floats over the TOP of the map area (the shell
                // renders it inside that relative box), so it anchors
                // with a plain top-2 instead of a magic header offset.
                "pointer-events-none absolute left-1/2 -translate-x-1/2 z-[1035]",
                "top-2",
                "max-w-[92vw] w-[min(92vw,420px)]",
            )}
            data-testid="hider-unanswered-overlay"
        >
            <QuestionOverlayCard
                categoryId={latest.id}
                summary={summary}
                onClick={handleClick}
                ariaLabel={`Answer ${summary.bigLabel} question`}
                right={rightSlot}
            />
        </div>
    );
}

export default HiderUnansweredOverlay;
