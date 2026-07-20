import { useStore } from "@nanostores/react";
import { Dices, RefreshCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "react-toastify";

import { useNow } from "@/hooks/useNow";
import type { CategoryId } from "@/lib/categories";
import {
    addQuestionSignal,
    configuringQuestionKey,
    pendingOverlayActive,
    pendingRandomize,
    questionModified,
    questions,
    randomizeReplacement,
    triggerLocalRefresh,
} from "@/lib/context";
import { answerWindowMs, type GameSize, gameSize } from "@/lib/gameSetup";
import { getSubtypes } from "@/lib/subtypes";
import { multiplayerEnabled, participants } from "@/lib/multiplayer/session";
import {
    isHiderConnected,
    seekerResendQuestion,
} from "@/lib/multiplayer/store";
import { encodeQuestionForHider } from "@/lib/shareLinks";
import { cn } from "@/lib/utils";
import type { Question, ThermometerQuestion } from "@/maps/schema";

import { answeredDetail } from "./cards/base";
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
    // v1029: the owed Randomize replacement (if any).
    const $pendingRandomize = useStore(pendingRandomize);

    // Exclude the question currently open in the configure dialog — it's a
    // still-unsent draft (drag:true, no createdAt) and would otherwise show as
    // a "Couldn't send — tap retry" card floating behind the dialog (v823).
    // In preview (gallery) mode there's no live dialog, so don't filter.
    const $configuringKey = useStore(configuringQuestionKey);
    const pending = findOldestPending(
        $questions,
        preview ? null : $configuringKey,
    );

    // Lifecycle phases for the card itself.
    type Phase = "active" | "answered" | "closing";
    const [displayed, setDisplayed] = useState<Question | null>(pending);
    const [phase, setPhase] = useState<Phase>("active");
    // v1019: full-screen photo viewer for an answered photo question.
    const [photoLightbox, setPhotoLightbox] = useState<string | null>(null);
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
            //   - ANSWERED: drag flipped false, still EXISTS → switch to
            //     the answered state and KEEP it on screen. It no longer
            //     auto-dismisses — the seeker decides when it goes away by
            //     tapping "Details" or "Dismiss" (see `rightSlot`). This
            //     gives them a beat to register the answer instead of the
            //     card vanishing on its own.
            //   - DISCARDED: a cancelled draft was removed → show nothing.
            const prevQ = questions.get().find((q) => q.key === prevKey);
            // v899: only a question that was actually SENT (createdAt stamped)
            // can become "answered". A draft that leaves the pending set with
            // no createdAt was never sent — it's a discarded/cancelled draft,
            // NOT an answer. Without this a one-render transient (the draft
            // briefly counts as pending before `configuringQuestionKey`
            // excludes it) latched a STICKY "answered" card hidden behind the
            // configure dialog and revealed it on Cancel (the reported bug).
            const wasSent =
                prevQ !== undefined &&
                (prevQ.data as { createdAt?: number }).createdAt !== undefined;
            if (wasSent) {
                setPhase("answered");
                return;
            }
            setDisplayed(null);
            setPhase("active");
            return;
        }
        setDisplayed(null);
        setPhase("active");
    }, [pending?.key]);

    // Dismiss the persistent answered card: play the slide-up/fade close
    // transition, then unmount. Used by the "Dismiss" action and by
    // "Details" (which also opens the questions panel).
    const closeTimerRef = useRef<number | null>(null);
    const dismissAnswered = () => {
        if (preview) return;
        setPhase("closing");
        if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
        closeTimerRef.current = window.setTimeout(() => {
            setDisplayed(null);
            setPhase("active");
        }, 500);
    };
    useEffect(
        () => () => {
            if (closeTimerRef.current)
                window.clearTimeout(closeTimerRef.current);
        },
        [],
    );

    // Gallery override: force a phase + question so the static gallery
    // can show the otherwise-transient "answered" celebration.
    const dShown = preview?.forcePhase
        ? (preview.questions[0] ?? null)
        : displayed;
    const phShown: Phase = preview?.forcePhase ?? phase;

    // 1 Hz tick to keep the countdown fresh (visibility-aware).
    const now = useNow(Boolean(dShown) && phShown === "active");

    // Broadcast whether the overlay is occupying the top of the map, so
    // the top-right controls can slide down out of its way. Skip in the
    // gallery so previews don't move live chrome. Clear on unmount.
    useEffect(() => {
        if (preview) return;
        pendingOverlayActive.set(Boolean(dShown));
        return () => pendingOverlayActive.set(false);
    }, [Boolean(dShown), preview]);

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

    // The live (now-answered) copy of the displayed question, so the
    // answered card can show the hider's RESOLVED answer rather than the
    // generic prompt. Falls back to the displayed snapshot.
    const liveShown =
        $questions.find((q) => q.key === dShown.key) ?? dShown;
    const resolvedAnswer = answered ? answeredDetail(liveShown) : null;
    // v1019: a PHOTO answer eliminates nothing on the map, so give the seeker a
    // clear signal — the answered overlay opens the received photo on tap.
    const photoAnswerSrc =
        answered && dShown.id === "photo"
            ? ((liveShown.data as { photoUrl?: string; photoUri?: string })
                  .photoUrl ??
              (liveShown.data as { photoUrl?: string; photoUri?: string })
                  .photoUri ??
              null)
            : null;

    // v1029: this question was randomized away and the seeker OWES a
    // same-category replacement — the answered overlay shows an "Ask random new
    // question" button instead of a result, and asking anything else is blocked
    // until it's sent.
    const randomizeOwed =
        answered &&
        !preview &&
        $pendingRandomize !== null &&
        $pendingRandomize.originalKey === liveShown.key &&
        (liveShown.data as { randomizedAway?: boolean }).randomizedAway === true;

    // Trigger the replacement: roll an un-asked subtype in the SAME category
    // and jump the (always-mounted) AddQuestionDialog straight to its configure
    // step. `pendingRandomize` stays set until the seeker actually SENDS it, so
    // cancelling never wastes the randomize.
    const askRandomReplacement = () => {
        if (preview || !$pendingRandomize) return;
        const cat = $pendingRandomize.category;
        const subtype = rollReplacementSubtype(cat, $gameSize, questions.get());
        randomizeReplacement.set({ category: cat, subtype });
        addQuestionSignal.set(addQuestionSignal.get() + 1);
    };

    const summary = summarizeQuestion(dShown);
    // Failed send → full-card error state with an explanatory detail line.
    // Answered → swap the generic prompt for the hider's resolved answer.
    const cardSummary = notYetSent
        ? { ...summary, detail: "Couldn't send to the hider — tap retry" }
        : randomizeOwed
          ? {
                // A randomized question isn't a pending/answered state — make
                // it read as a mystery to re-roll: dice icon + "???" title.
                ...summary,
                icon: Dices,
                bigLabel: "???",
                detail: "Randomized — ask a new question of this category",
            }
          : answered && resolvedAnswer
            ? { ...summary, detail: resolvedAnswer }
            : summary;

    // Open the questions panel for full detail (the answered card's
    // "Details" action and the active-card tap target both use this).
    const openDetails = () => {
        if (preview) return;
        const sb = SidebarContext.get();
        if (sb.isMobile) sb.setOpenMobile(true);
        else sb.setOpen(true);
    };
    // "Details" on the answered card: open the panel AND retire the
    // overlay (the panel now shows the full answered card).
    const openDetailsAndDismiss = () => {
        openDetails();
        dismissAnswered();
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
    ) : randomizeOwed ? (
        // v1029: the hider randomized this away — the seeker MUST ask a
        // same-category replacement before anything else. This button (not a
        // dismiss X) is the only way forward; cancelling the configure dialog
        // leaves the owe intact so it can be retried.
        <button
            type="button"
            onClick={(e) => {
                e.stopPropagation();
                askRandomReplacement();
            }}
            aria-label="Ask a random new question of this category"
            title="Ask a random new question of this category"
            className={cn(
                "flex flex-col items-center justify-center gap-0.5 px-3 py-1.5 rounded-md",
                "bg-primary text-primary-foreground hover:bg-primary/90 transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            )}
        >
            <Dices className="w-4 h-4" strokeWidth={2.5} />
            <span className="text-[9px] uppercase tracking-[0.1em] font-poppins font-bold">
                Ask new
            </span>
        </button>
    ) : answered ? (
        // Persistent answered state — the card no longer vanishes on its
        // own. Tapping the card opens the full detail; this is just a big
        // X to dismiss.
        <button
            type="button"
            onClick={(e) => {
                e.stopPropagation();
                dismissAnswered();
            }}
            aria-label="Dismiss"
            title="Dismiss"
            className={cn(
                "flex items-center justify-center rounded-md p-1.5",
                "text-[color:var(--overlay-card-desc)] hover:bg-foreground/10 hover:text-[color:var(--overlay-card-fg)] transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            )}
        >
            <X className="w-6 h-6" strokeWidth={2.5} />
        </button>
    ) : null;

    return (
        <div
            className={cn(
                "pointer-events-none absolute left-1/2 -translate-x-1/2 z-[1031]",
                // Top of the map view (the controls dodge downward when a
                // question is showing). Hugs the top edge of the map area,
                // below the seeker top bar.
                "top-2 md:top-4",
                "max-w-[92vw] w-[min(92vw,460px)]",
                "transition-all duration-500 ease-out",
                phShown === "closing" &&
                    "-translate-y-16 opacity-0 -translate-x-1/2",
                phShown === "answered" && "scale-[1.02] -translate-x-1/2",
            )}
            data-testid="pending-answer-overlay"
            data-phase={phShown}
        >
            <QuestionOverlayCard
                categoryId={dShown.id}
                summary={cardSummary}
                categoryEyebrow
                eyebrow={
                    randomizeOwed ? (
                        <span className="text-[color:var(--cat-label)]">
                            Randomized
                        </span>
                    ) : answered ? (
                        <span className="text-success">Answered</span>
                    ) : undefined
                }
                answered={answered && !randomizeOwed}
                error={notYetSent}
                onClick={
                    randomizeOwed
                        ? askRandomReplacement
                        : photoAnswerSrc
                          ? () => setPhotoLightbox(photoAnswerSrc)
                          : answered
                            ? openDetailsAndDismiss
                            : openDetails
                }
                ariaLabel={
                    randomizeOwed
                        ? "Ask a random new question of this category"
                        : photoAnswerSrc
                          ? "View the hider's photo"
                          : answered
                            ? "Open answered question details"
                            : "Open question details"
                }
                right={rightSlot}
            />
            {photoLightbox &&
                createPortal(
                    <div
                        className="fixed inset-0 z-[1200] bg-black/90 flex items-center justify-center p-4"
                        onClick={() => setPhotoLightbox(null)}
                        role="dialog"
                        aria-label="Hider's photo"
                    >
                        <img
                            src={photoLightbox}
                            alt="Hider's photo answer"
                            className="max-w-full max-h-full object-contain rounded-lg shadow-2xl"
                        />
                        <button
                            type="button"
                            onClick={(e) => {
                                e.stopPropagation();
                                setPhotoLightbox(null);
                            }}
                            aria-label="Close photo"
                            className="absolute top-4 right-4 flex items-center justify-center rounded-full bg-white/15 hover:bg-white/25 text-white p-2"
                        >
                            <X className="w-6 h-6" strokeWidth={2.5} />
                        </button>
                    </div>,
                    document.body,
                )}
        </div>
    );
}

/**
 * v1029: roll the subtype for a Randomize replacement — the SAME category as
 * the randomized question, an UN-ASKED subtype (rulebook p376: "a random
 * different question of the same category"). Radar / thermometer have no
 * subtype (their configure carousel already skips used sizes), so they return
 * undefined. If every subtype has been used, fall back to any (so the seeker is
 * never stuck with nothing to ask).
 */
function rollReplacementSubtype(
    category: CategoryId,
    size: GameSize,
    qs: Question[],
): string | undefined {
    if (
        category !== "matching" &&
        category !== "measuring" &&
        category !== "tentacles" &&
        category !== "photo"
    ) {
        return undefined;
    }
    const subs = getSubtypes(category, size) ?? [];
    if (subs.length === 0) return undefined;
    const used = new Set<string>();
    for (const q of qs) {
        if (q.id !== category) continue;
        const d = q.data as {
            type?: string;
            locationType?: string;
            randomizedAway?: boolean;
        };
        // A randomized-away question wasn't really asked (rulebook p376).
        if (d.randomizedAway === true) continue;
        const s = category === "tentacles" ? d.locationType : d.type;
        if (s) used.add(s);
    }
    const unused = subs.filter((s) => !used.has(s.value));
    const pool = unused.length > 0 ? unused : subs;
    return pool[Math.floor(Math.random() * pool.length)].value;
}

/**
 * Find the question still awaiting an answer with the most pressing
 * deadline. A "started" thermometer is excluded — the seeker is moving,
 * it's not waiting for an answer yet.
 */
function findOldestPending(
    qs: Question[],
    configuringKey: number | null,
): Question | null {
    const candidates = qs.filter((q) => {
        if (q.data.drag !== true) return false;
        // Skip the draft still open in the configure dialog (not sent yet).
        if (configuringKey !== null && q.key === configuringKey) return false;
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
