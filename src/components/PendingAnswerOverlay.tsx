import { useStore } from "@nanostores/react";
import { RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "react-toastify";

import { useNow } from "@/hooks/useNow";
import { questionModified, questions, triggerLocalRefresh } from "@/lib/context";
import { answerWindowMs, gameSize } from "@/lib/gameSetup";
import { multiplayerEnabled, participants } from "@/lib/multiplayer/session";
import {
    isHiderConnected,
    seekerResendQuestion,
} from "@/lib/multiplayer/store";
import { encodeQuestionForHider } from "@/lib/shareLinks";
import { cn } from "@/lib/utils";
import type { Question, ThermometerQuestion } from "@/maps/schema";

import {
    QuestionOverlayCard,
    summarizeQuestion,
} from "./questionOverlayCard";
import { SidebarContext } from "./ui/sidebar-l";

/**
 * Floating "waiting for answer" card pinned at the bottom of the map.
 * Reminds the seeker they can't ask again yet, recaps the question, and
 * shows the answer-window status: NOT SENT (retry) → WAITING (prominent
 * countdown) → OVERDUE (clock paused) → ANSWERED!. Shares the show-style
 * `QuestionOverlayCard` chrome with the hider's unanswered overlay.
 */

/** Override the questions list to preview a specific pending state in
 *  the /debug/overlays gallery without touching global state. */
export interface PendingAnswerPreview {
    questions: ReturnType<typeof questions.get>;
    /** Force a lifecycle phase so the gallery can show the otherwise
     *  transient "answered" celebration statically. The first question
     *  is rendered in this phase. */
    forcePhase?: "active" | "answered";
}

export function PendingAnswerOverlay({
    preview,
}: { preview?: PendingAnswerPreview } = {}) {
    useStore(triggerLocalRefresh);
    let $questions = useStore(questions);
    if (preview) $questions = preview.questions;
    const $gameSize = useStore(gameSize);
    // Reactive subscription — re-render when a hider joins/leaves so the
    // "sent vs share" handler stays accurate.
    useStore(participants);

    const pending = findOldestPending($questions);

    // Lifecycle phases for the card itself.
    type Phase = "active" | "answered" | "closing";
    const [displayed, setDisplayed] = useState<Question | null>(pending);
    const [phase, setPhase] = useState<Phase>("active");
    const prevKeyRef = useRef<number | null>(pending?.key ?? null);

    useEffect(() => {
        const currentKey = pending?.key ?? null;
        const prevKey = prevKeyRef.current;
        prevKeyRef.current = currentKey;

        if (pending) {
            setDisplayed(pending);
            setPhase("active");
            return;
        }
        if (prevKey !== null) {
            // The previously-pending question is gone. Two reasons:
            //   - ANSWERED: drag flipped false, still EXISTS → celebrate.
            //   - DISCARDED: a cancelled draft was removed → show nothing.
            const stillExists = questions
                .get()
                .some((q) => q.key === prevKey);
            if (stillExists) {
                setPhase("answered");
                const answeredTimer = window.setTimeout(
                    () => setPhase("closing"),
                    1100,
                );
                const closeTimer = window.setTimeout(() => {
                    setDisplayed(null);
                    setPhase("active");
                }, 1700);
                return () => {
                    window.clearTimeout(answeredTimer);
                    window.clearTimeout(closeTimer);
                };
            }
            setDisplayed(null);
            setPhase("active");
            return;
        }
        setDisplayed(null);
        setPhase("active");
    }, [pending?.key]);

    // Gallery override: force a phase + question so the static gallery
    // can show the otherwise-transient "answered" celebration.
    const dShown = preview?.forcePhase
        ? (preview.questions[0] ?? null)
        : displayed;
    const phShown: Phase = preview?.forcePhase ?? phase;

    // 1 Hz tick to keep the countdown fresh (visibility-aware).
    const now = useNow(Boolean(dShown) && phShown === "active");

    if (!dShown) return null;

    const createdAt = (dShown.data as { createdAt?: number }).createdAt;
    // Rulebook p5/p32: 5 min for everything except photo (10 min S/M,
    // 20 min L). `answerWindowMs` reads the live game size.
    const windowMs = answerWindowMs(dShown.id, $gameSize);
    const remainingMs = createdAt
        ? Math.max(0, createdAt + windowMs - now)
        : null;
    const remainingSec =
        remainingMs !== null ? Math.ceil(remainingMs / 1000) : null;
    const mm = remainingSec !== null ? Math.floor(remainingSec / 60) : 0;
    const ss = remainingSec !== null ? remainingSec % 60 : 0;
    const overdue =
        phShown === "active" && remainingSec !== null && remainingSec <= 0;
    const notYetSent = phShown === "active" && createdAt === undefined;
    const waiting = phShown === "active" && !notYetSent && !overdue;
    const answered = phShown === "answered" || phShown === "closing";

    const summary = summarizeQuestion(dShown);
    // Failed send → full-card error state with an explanatory detail line.
    const cardSummary = notYetSent
        ? { ...summary, detail: "Couldn't send to the hider — tap retry" }
        : summary;

    // Tap anywhere on the card → open the questions panel for full detail.
    const openDetails = () => {
        const sb = SidebarContext.get();
        if (sb.isMobile) sb.setOpenMobile(true);
        else sb.setOpen(true);
    };

    const stampSent = () => {
        const d = dShown.data as { createdAt?: number };
        if (!d.createdAt) {
            d.createdAt = Date.now();
            questionModified();
        }
    };

    // Retry sending. The primary path is the APP channel: re-push the
    // question over the multiplayer WebSocket (idempotent by key; the
    // server queues it if the hider is momentarily offline). It never
    // opens an OS share sheet. Only solo/offline play — which has no app
    // channel at all — falls back to copying a share link to the
    // clipboard (still no share dialog).
    const handleRetry = async () => {
        if (preview) {
            toast.info("Preview only — no live question to send.", {
                autoClose: 1500,
            });
            return;
        }
        if (multiplayerEnabled.get()) {
            const ok = seekerResendQuestion(dShown.key);
            if (!ok) {
                toast.error("Couldn't resend over the app");
                return;
            }
            stampSent();
            toast.success(
                isHiderConnected()
                    ? "Resent to hider"
                    : "Resent — hider's offline, they'll get it on reconnect.",
                { autoClose: 2500 },
            );
            return;
        }
        // Solo / offline — no in-app channel; copy a share link instead.
        try {
            await navigator.clipboard.writeText(encodeQuestionForHider(dShown));
            stampSent();
            toast.success("Question link copied — send it to the hider.", {
                autoClose: 2500,
            });
        } catch {
            toast.error("Couldn't copy the question link.");
        }
    };

    // Status on the right of the card. Prominent countdown while waiting
    // (in the category colour — deep on a light card, bright on dark),
    // a paused "0:00" when overdue, a Retry button when the send failed,
    // and "Answered!" on resolve.
    const rightSlot = waiting ? (
        <div className="flex flex-col items-center leading-none">
            <span className="text-[8px] uppercase tracking-[0.14em] font-poppins font-bold text-[color:var(--overlay-card-desc)] mb-0.5">
                Answer in
            </span>
            <span className="text-2xl font-poppins font-black tabular-nums leading-none text-[color:var(--cat-label)]">
                {mm}:{String(ss).padStart(2, "0")}
            </span>
        </div>
    ) : overdue ? (
        <div className="flex flex-col items-center leading-none text-destructive">
            <span className="text-2xl font-poppins font-black tabular-nums leading-none">
                0:00
            </span>
            <span
                className="text-[8px] uppercase tracking-[0.12em] font-poppins font-bold mt-0.5 whitespace-nowrap"
                title="Past the answer window — the hider's clock is paused (rulebook p61)"
            >
                Game paused
            </span>
        </div>
    ) : notYetSent ? (
        // Full card is in the error state (see `error` prop below); the
        // right slot is just the Retry action.
        <button
            type="button"
            onClick={(e) => {
                e.stopPropagation();
                void handleRetry();
            }}
            aria-label="Retry sending the question to the hider"
            title="Sending failed — retry. Starts the answer window."
            className={cn(
                "flex flex-col items-center justify-center gap-0.5 px-3 py-1.5 rounded-md",
                "bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            )}
        >
            <RefreshCw className="w-4 h-4" strokeWidth={2.5} />
            <span className="text-[9px] uppercase tracking-[0.1em] font-poppins font-bold">
                Retry
            </span>
        </button>
    ) : answered ? (
        <span className="text-xs uppercase tracking-[0.12em] font-poppins font-black text-emerald-500">
            Answered!
        </span>
    ) : null;

    return (
        <div
            className={cn(
                "pointer-events-none absolute left-1/2 -translate-x-1/2 z-[1031]",
                // Bottom of the map view — just above the mobile bottom nav
                // on mobile, hugging the bottom edge on desktop. Shares the
                // slot with the thermometer overlay (mutually exclusive).
                "bottom-[calc(80px+env(safe-area-inset-bottom))] md:bottom-4",
                "max-w-[92vw] w-[min(92vw,460px)]",
                "transition-all duration-500 ease-out",
                phShown === "closing" &&
                    "translate-y-16 opacity-0 -translate-x-1/2",
                phShown === "answered" && "scale-[1.02] -translate-x-1/2",
            )}
            data-testid="pending-answer-overlay"
            data-phase={phShown}
        >
            <QuestionOverlayCard
                categoryId={dShown.id}
                summary={cardSummary}
                answered={answered}
                error={notYetSent}
                onClick={openDetails}
                ariaLabel="Open question details"
                right={rightSlot}
            />
        </div>
    );
}

/**
 * Find the question still awaiting an answer with the most pressing
 * deadline. A "started" thermometer is excluded — the seeker is moving,
 * it's not waiting for an answer yet.
 */
function findOldestPending(qs: Question[]): Question | null {
    const candidates = qs.filter((q) => {
        if (q.data.drag !== true) return false;
        if (q.id === "thermometer") {
            const status = (q.data as ThermometerQuestion).status ?? "finished";
            if (status === "started") return false;
        }
        return true;
    });
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => {
        const ta = (a.data as { createdAt?: number }).createdAt ?? Infinity;
        const tb = (b.data as { createdAt?: number }).createdAt ?? Infinity;
        return ta - tb;
    });
    return candidates[0];
}

export default PendingAnswerOverlay;
