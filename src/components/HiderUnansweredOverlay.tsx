import { useStore } from "@nanostores/react";
import { ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";

import { useNow } from "@/hooks/useNow";
import { answerWindowMs, gameSize } from "@/lib/gameSetup";
import {
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
                // v1018: a thermometer the seeker has only STARTED (not yet
                // finished + sent) must NOT show as an incoming question to
                // answer — it's still being walked. It only becomes answerable
                // when the seeker finishes it (status:"finished", which stamps
                // createdAt). Mirrors the seeker's PendingAnswerOverlay, which
                // already excludes started thermometers.
                .filter(
                    (e) =>
                        !(
                            e.id === "thermometer" &&
                            (e.data as { status?: string })?.status ===
                                "started"
                        ),
                )
                .sort((a, b) => b.arrivedAt - a.arrivedAt),
        [$inbox],
    );

    // 1 Hz tick while a question is waiting, so the countdown next
    // to the prompt actually counts. Visibility-aware: paused while
    // the tab is hidden, so a backgrounded phone doesn't keep
    // burning a setInterval.
    // v905: shared clock — freezes while the game is paused.
    const now = useNow(waiting.length > 0);
    const $gameSize = useStore(gameSize);

    if (waiting.length === 0) return null;

    const latest = waiting[0];
    const summary = summarizeQuestion(latest);
    const extraCount = waiting.length - 1;

    // v936: the answer deadline is `createdAt + answerWindowMs(category)` —
    // an ABSOLUTE, seeker-stamped timestamp that BOTH devices agree on and
    // that survives a hider reconnect. The old `arrivedAt + ANSWER_WINDOW_MS`
    // was wrong twice over: (1) `ANSWER_WINDOW_MS` is a flat 5 min, so a
    // PHOTO question (10 min small/medium, 20 large) showed the hider 5 min
    // while the seeker correctly counted 10; (2) `arrivedAt` is the hider's
    // LOCAL receive time, so reconnecting (which re-delivers the question)
    // RESTARTED the countdown from scratch on its own timer. `createdAt` is
    // stamped by the seeker at send and rides the synced question payload.
    const createdAt = (latest.data as { createdAt?: number })?.createdAt;
    const windowMs = answerWindowMs(latest.id, $gameSize);
    const deadlineMs = (createdAt ?? latest.arrivedAt) + windowMs;
    const remainingMs = Math.max(0, deadlineMs - now);
    const overdue = remainingMs === 0;
    const mins = Math.floor(remainingMs / 60_000);
    const secs = Math.floor((remainingMs % 60_000) / 1000);
    const countdownLabel = `${mins}:${String(secs).padStart(2, "0")}`;
    // v946: jitter the timer in the final minute so the closing window is
    // unmissable (the whole card already pulses).
    const lastMinute = !overdue && remainingMs < 60_000;

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

    // Status on the right: the answer-window countdown (category colour,
    // red when overdue) with a chevron — the whole card is the tap target
    // to open the answer flow, the chevron is the visible affordance.
    const rightSlot = (
        <div className="flex items-center gap-1.5">
            <div className="flex flex-col items-center leading-none">
                <span
                    className={cn(
                        "text-[8px] uppercase tracking-[0.14em] font-poppins font-bold mb-0.5 whitespace-nowrap",
                        overdue
                            ? "text-destructive"
                            : "text-[color:var(--overlay-card-desc)]",
                    )}
                >
                    {overdue ? "Game paused" : "Answer in"}
                </span>
                <span
                    className={cn(
                        "inline-block text-2xl font-poppins font-black tabular-nums leading-none",
                        overdue || lastMinute
                            ? "text-destructive"
                            : "text-[color:var(--cat-label)]",
                        lastMinute &&
                            "motion-safe:animate-[jlTimerJitter_0.28s_ease-in-out_infinite]",
                    )}
                >
                    {overdue ? "0:00" : countdownLabel}
                </span>
                {extraCount > 0 && (
                    <span
                        className="text-[9px] font-poppins font-bold mt-0.5 text-[color:var(--overlay-card-desc)]"
                        aria-label={`${extraCount} more question${extraCount === 1 ? "" : "s"} waiting`}
                    >
                        +{extraCount} more
                    </span>
                )}
            </div>
            <ChevronRight
                className="w-5 h-5 shrink-0 text-[color:var(--overlay-card-desc)]"
                strokeWidth={2.5}
                aria-hidden
            />
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
                // v946: steady attention pulse the whole time a question waits.
                "motion-safe:animate-[jlPendingPulse_1.6s_ease-in-out_infinite]",
            )}
            data-testid="hider-unanswered-overlay"
        >
            <QuestionOverlayCard
                categoryId={latest.id}
                summary={summary}
                categoryEyebrow
                onClick={handleClick}
                ariaLabel={`Answer ${summary.bigLabel} question`}
                right={rightSlot}
            />
        </div>
    );
}

export default HiderUnansweredOverlay;
