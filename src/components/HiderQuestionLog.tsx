import { useStore } from "@nanostores/react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";

import {
    answeringQuestion,
    hiderInbox,
    type InboxEntry,
} from "@/lib/hiderRole";
import { cn } from "@/lib/utils";
import type { Question } from "@/maps/schema";

import { answeredDetail } from "./cards/base";
import {
    QuestionOverlayCard,
    summarizeQuestion,
} from "./questionOverlayCard";

const QuestionOutcomeMap = lazy(() =>
    import("./QuestionOutcomeMap").then((m) => ({
        default: m.QuestionOutcomeMap,
    })),
);

/**
 * Hider's view of the inbox, mirroring the seeker's question log.
 * Splits inbox entries into two buckets:
 *
 *   • **Awaiting your answer** — a `QuestionOverlayCard` (same chrome as
 *     every other question card) you tap to open the answer view.
 *
 *   • **Answered** — a collapsed `QuestionOverlayCard` that expands to the
 *     seeker-style `QuestionOutcomeMap` (fed the reconstructed question
 *     DIRECTLY, since the hider's entries aren't in the seeker `questions`
 *     store the base card looks them up from — which is why answered cards
 *     used to expand to nothing).
 */
export function HiderQuestionLog() {
    const $inbox = useStore(hiderInbox);

    const sorted = useMemo(
        () => [...$inbox].sort((a, b) => b.arrivedAt - a.arrivedAt),
        [$inbox],
    );
    const answered = sorted.filter((e) => e.repliedAt);
    const waiting = sorted.filter((e) => !e.repliedAt);

    if (sorted.length === 0) {
        // Empty state — mirrors the seeker's question-drawer empty box.
        return (
            <section className="mt-5">
                <div
                    className={cn(
                        "rounded-md border-2 border-dashed border-border",
                        "px-4 py-8 flex flex-col items-center text-center gap-2",
                    )}
                >
                    <div className="text-[10px] uppercase tracking-[0.08em] font-display font-extrabold text-muted-foreground">
                        No questions yet
                    </div>
                    <p className="text-xs text-muted-foreground leading-snug max-w-[26ch]">
                        Questions the seekers send land here. Tap one to reveal
                        it and send your answer.
                    </p>
                </div>
            </section>
        );
    }

    return (
        <section className="mt-5 space-y-5">
            {waiting.length > 0 && (
                <div>
                    <div className="flex items-center gap-2 mb-2">
                        <h3 className="text-sm font-semibold tracking-tight">
                            Awaiting answer
                        </h3>
                        <span className="text-[10px] text-muted-foreground tabular-nums ml-0.5">
                            {waiting.length}
                        </span>
                    </div>
                    <ul className="space-y-3">
                        {waiting.map((entry) => (
                            <WaitingRow key={entry.key} entry={entry} />
                        ))}
                    </ul>
                </div>
            )}

            {answered.length > 0 && (
                <div>
                    <div className="flex items-center gap-2 mb-2">
                        <h3 className="text-sm font-semibold tracking-tight">
                            Answered
                        </h3>
                        <span className="text-[10px] text-muted-foreground tabular-nums ml-0.5">
                            {answered.length}
                        </span>
                    </div>
                    <div className="space-y-3">
                        {answered.map((entry) => (
                            <AnsweredCard key={entry.key} entry={entry} />
                        ))}
                    </div>
                </div>
            )}
        </section>
    );
}

/**
 * Awaiting (un-replied) entry — the same `QuestionOverlayCard` chrome as
 * every other card. Tapping it routes to the answer view (`answeringQuestion`
 * atom → the answer dialog over the drawer).
 */
function WaitingRow({ entry }: { entry: InboxEntry }) {
    const openAnswerView = () => {
        answeringQuestion.set({
            id: entry.id,
            key: entry.key,
            data: entry.data,
        } as Question);
    };

    return (
        <li>
            <QuestionOverlayCard
                categoryId={entry.id}
                flat
                summary={summarizeQuestion({ id: entry.id, data: entry.data })}
                eyebrow={
                    <span className="text-yellow-600 dark:text-yellow-400">
                        Needs your answer
                    </span>
                }
                right={
                    <ChevronRight
                        className="w-5 h-5 text-muted-foreground"
                        aria-hidden="true"
                    />
                }
                onClick={openAnswerView}
                ariaLabel={`Answer ${entry.id} question`}
            />
        </li>
    );
}

/**
 * Answered entry — a collapsed overlay card that expands to a static outcome
 * map (or the received photo). Reconstructs the question object from the
 * inbox entry (data + the hider's reply, drag:false) and feeds it straight
 * to `QuestionOutcomeMap` — NOT via the seeker `questions` store, which the
 * hider's entries never enter.
 */
function AnsweredCard({ entry }: { entry: InboxEntry }) {
    const [expanded, setExpanded] = useState(false);
    // v1042: smooth expand/collapse via the grid-rows 0fr→1fr trick (matching
    // the seeker's `cards/base` card). The body stays mounted through the close
    // transition then unmounts, so a collapsed card holds no live outcome map.
    const [bodyMounted, setBodyMounted] = useState(false);
    useEffect(() => {
        if (expanded) {
            setBodyMounted(true);
            return;
        }
        const t = window.setTimeout(() => setBodyMounted(false), 320);
        return () => window.clearTimeout(t);
    }, [expanded]);

    const question = useMemo(
        () =>
            ({
                id: entry.id,
                key: entry.key,
                data: {
                    ...(entry.data as Record<string, unknown>),
                    ...(entry.reply ?? {}),
                    drag: false,
                },
            }) as Question,
        [entry],
    );

    const summary = summarizeQuestion({ id: question.id, data: question.data });
    const isPhoto = entry.id === "photo";
    const d = question.data as Record<string, unknown>;
    const photoSrc = (d.photoUrl as string) || (d.photoUri as string) || null;
    // v1018: `answeredDetail` is role-agnostic and says "Photo received" (correct
    // for the seeker who receives it). On the HIDER's own log that reads wrong —
    // the hider SENT the photo — so show "Photo sent" here.
    const detail =
        isPhoto && photoSrc
            ? "Photo sent"
            : (answeredDetail(question) ?? summary.detail);
    // v883: a vetoed / randomized-away question eliminates nothing, so its
    // outcome map (the whole play area) is meaningless — show a note instead.
    const noOutcome = Boolean(d.vetoed) || Boolean(d.randomizedAway);

    return (
        <div>
            <QuestionOverlayCard
                categoryId={entry.id}
                flat
                summary={{ ...summary, detail: detail ?? undefined }}
                answered
                eyebrow={
                    entry.repliedAt ? (
                        <span className="text-muted-foreground">
                            {relTime(entry.repliedAt)}
                        </span>
                    ) : undefined
                }
                right={
                    <ChevronDown
                        className={cn(
                            "w-5 h-5 text-muted-foreground transition-transform",
                            expanded && "rotate-180",
                        )}
                        aria-hidden="true"
                    />
                }
                onClick={() => setExpanded((v) => !v)}
                ariaLabel={`${expanded ? "Collapse" : "Expand"} answered ${entry.id} question`}
            />
            {/* grid-rows 0fr→1fr smoothly reveals the body; the inner wrapper
                clips it during the transition. */}
            <div
                className={cn(
                    "grid transition-[grid-template-rows] duration-300 ease-out",
                    expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
                )}
            >
                <div className="overflow-hidden min-h-0">
                    {bodyMounted && (
                        <div className="pt-2">
                            {noOutcome ? (
                                <p className="px-1 text-xs italic text-muted-foreground">
                                    {d.vetoed
                                        ? "You vetoed this question — no answer was given and nothing was eliminated."
                                        : "This question was randomized away — nothing was eliminated."}
                                </p>
                            ) : isPhoto ? (
                                photoSrc ? (
                                    <img
                                        src={photoSrc}
                                        alt="Answer photo"
                                        className="w-full rounded-md border border-border"
                                    />
                                ) : (
                                    <p className="px-1 text-xs italic text-muted-foreground">
                                        Photo unavailable.
                                    </p>
                                )
                            ) : (
                                <Suspense
                                    fallback={
                                        <div className="h-[180px] w-full animate-pulse rounded-md border border-dashed border-border" />
                                    }
                                >
                                    <QuestionOutcomeMap question={question} />
                                </Suspense>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

/** Compact relative time for the answered-card eyebrow ("10m ago"). */
function relTime(ts: number): string {
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return "just now";
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.round(h / 24)}d ago`;
}

export default HiderQuestionLog;
