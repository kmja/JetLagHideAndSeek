import { useStore } from "@nanostores/react";
import { Check, Hourglass, Share2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "react-toastify";

import { CATEGORIES, type CategoryId } from "@/lib/categories";
import { questionModified, questions, triggerLocalRefresh } from "@/lib/context";
import { encodeQuestionForHider, shareOrCopy } from "@/lib/shareLinks";
import { cn } from "@/lib/utils";
import type { Question, ThermometerQuestion } from "@/maps/schema";

import {
    prettyTypeNoun,
    useNearestReference,
} from "./NearestReferencePreview";

/**
 * Floating "waiting for answer" card pinned at the bottom of the map.
 * Three jobs:
 *
 *  1. Persistent reminder that you can't ask a new question yet
 *     (rulebook p13, one-at-a-time).
 *  2. Quick recap of *what* the question was — category + the specific
 *     parameters — so the seeker can answer "what did I ask again?"
 *     without opening the questions panel.
 *  3. Status + answer-window countdown: NOT SENT (yellow) → WAITING FOR
 *     ANSWER (primary, MM:SS ticking) → OVERDUE (red) → ANSWERED!
 *     (green, brief celebration) → slide-out close animation.
 *
 * When the displayed question's `drag` flips to false (the seeker
 * committed the hider's answer), we hold the card in the "answered"
 * state for ~1.1 s and then slide-and-fade it out. The radar-scan
 * overlay on the map fades on the same beat (see RadarScanOverlay) so
 * the seeker reads it as "scan complete; here's the new play area".
 */
export function PendingAnswerOverlay() {
    useStore(triggerLocalRefresh);
    const $questions = useStore(questions);

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
            // New question (or same one re-armed) → reset to active.
            setDisplayed(pending);
            setPhase("active");
            return;
        }
        if (prevKey !== null) {
            // Question just got answered. Celebrate, then slide out.
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
    }, [pending?.key]);

    // 1 Hz tick to keep the countdown fresh. No-op while we have nothing
    // to show (or we're already in the answered/closing phase).
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!displayed || phase !== "active") return;
        setNow(Date.now());
        const id = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(id);
    }, [displayed?.key, phase]);

    // Nearest-reference lookup for matching/measuring headlines. Always
    // called so the hook order stays stable across renders.
    const showRefLookup =
        displayed?.id === "matching" || displayed?.id === "measuring";
    const nearestState = useNearestReference(
        showRefLookup ? (displayed!.data as { lat: number }).lat ?? 0 : 0,
        showRefLookup ? (displayed!.data as { lng: number }).lng ?? 0 : 0,
        showRefLookup ? (displayed!.data as { type: string }).type ?? "" : "",
    );

    if (!displayed) return null;

    const meta = CATEGORIES[displayed.id as CategoryId];
    const Icon = meta?.icon ?? Hourglass;
    const createdAt = (displayed.data as { createdAt?: number }).createdAt;
    const isPhoto = displayed.id === "photo";
    // Rulebook p5/p32: 5 min for everything except photo (10 min S/M, up
    // to 20 min L). The card lives without knowing game size; we use 10
    // min for photo as the safer middle ground.
    const windowMs = isPhoto ? 10 * 60_000 : 5 * 60_000;
    const remainingMs = createdAt
        ? Math.max(0, createdAt + windowMs - now)
        : null;
    const remainingSec =
        remainingMs !== null ? Math.ceil(remainingMs / 1000) : null;
    const mm = remainingSec !== null ? Math.floor(remainingSec / 60) : 0;
    const ss = remainingSec !== null ? remainingSec % 60 : 0;
    const overdue =
        phase === "active" && remainingSec !== null && remainingSec <= 0;
    const notYetSent = createdAt === undefined;

    const summary = summarizeQuestion(displayed, nearestState);
    const status = pickStatus({ phase, notYetSent, overdue });

    const handleShare = async () => {
        const url = encodeQuestionForHider(displayed);
        const result = await shareOrCopy({
            title: `${meta?.label ?? "Question"} for the hider`,
            text: `${meta?.label ?? "Question"}: tap to answer`,
            url,
        });
        if (result.method === "share" || result.method === "copy") {
            const d = displayed.data as { createdAt?: number };
            if (!d.createdAt) {
                d.createdAt = Date.now();
                questionModified();
            }
            if (result.method === "copy") {
                toast.success("Question link copied", { autoClose: 1500 });
            }
        } else if (result.method === "failed") {
            toast.error("Could not share question link");
        }
    };

    return (
        <div
            className={cn(
                "pointer-events-none absolute left-1/2 -translate-x-1/2 z-[1031]",
                // Bottom of the map view — just above the mobile bottom
                // nav (~72 px tall) on mobile, hugging the bottom edge on
                // desktop. The thermometer overlay and this one are
                // mutually exclusive per rulebook, so they share the slot.
                "bottom-[calc(80px+env(safe-area-inset-bottom))] md:bottom-4",
                "max-w-[92vw] w-[min(92vw,460px)]",
                // Slide-out close: keeps the card mounted so the
                // transition can run, then the parent timer flips
                // `displayed` to null.
                "transition-all duration-500 ease-out",
                phase === "closing" &&
                    "translate-y-16 opacity-0 -translate-x-1/2",
                phase === "answered" && "scale-[1.02] -translate-x-1/2",
            )}
            data-testid="pending-answer-overlay"
            data-phase={phase}
        >
            <div
                className={cn(
                    "pointer-events-auto",
                    "flex items-center gap-3 px-3 py-2.5 rounded-md",
                    "bg-background/95 backdrop-blur-md shadow-xl",
                    "border-2 transition-colors duration-300",
                    status.border,
                )}
            >
                <span
                    className={cn(
                        "inline-flex items-center justify-center w-9 h-9 rounded shrink-0 transition-colors duration-300",
                        phase === "answered"
                            ? "bg-emerald-500"
                            : "",
                    )}
                    style={
                        phase === "answered"
                            ? undefined
                            : { backgroundColor: meta?.color ?? "#999" }
                    }
                    aria-hidden="true"
                >
                    {phase === "answered" ? (
                        <Check
                            size={18}
                            strokeWidth={3}
                            className="text-white animate-[jlAnsweredPop_400ms_ease-out]"
                        />
                    ) : (
                        <Icon size={16} strokeWidth={2.5} className="text-white" />
                    )}
                </span>

                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 leading-none">
                        <span className="text-[10px] uppercase tracking-[0.14em] font-poppins font-semibold text-muted-foreground">
                            {meta?.label ?? displayed.id}
                        </span>
                        <span className={cn("ml-auto shrink-0 flex items-center gap-1.5")}>
                            <span
                                className={cn(
                                    "text-[10px] uppercase tracking-[0.14em] font-poppins font-bold",
                                    status.textTone,
                                )}
                            >
                                {status.label}
                            </span>
                            {phase === "active" && !notYetSent && !overdue && (
                                <span
                                    className="text-[11px] font-poppins font-bold tabular-nums text-primary"
                                    title="Time left in the hider's answer window"
                                >
                                    {mm}:{String(ss).padStart(2, "0")}
                                </span>
                            )}
                        </span>
                    </div>
                    <div className="mt-1 text-sm font-inter-tight font-bold text-foreground leading-tight truncate">
                        {summary.headline}
                    </div>
                    {summary.detail && (
                        <div className="text-[11px] text-muted-foreground leading-snug truncate mt-0.5">
                            {summary.detail}
                        </div>
                    )}
                </div>

                {phase === "active" && (
                    <button
                        type="button"
                        onClick={handleShare}
                        aria-label={
                            notYetSent
                                ? "Share question with hider"
                                : "Re-share question with hider"
                        }
                        title={
                            notYetSent
                                ? "Share with hider — starts the answer window"
                                : "Re-share with hider"
                        }
                        className={cn(
                            "flex items-center justify-center w-9 h-9 rounded-md shrink-0",
                            "bg-primary text-primary-foreground hover:bg-primary/90",
                            "transition-colors",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        )}
                    >
                        <Share2 className="w-4 h-4" />
                    </button>
                )}
            </div>
        </div>
    );
}

/** Compute the visible status pill (label + border + text color). */
function pickStatus(opts: {
    phase: "active" | "answered" | "closing";
    notYetSent: boolean;
    overdue: boolean;
}): { label: string; border: string; textTone: string } {
    if (opts.phase === "answered" || opts.phase === "closing") {
        return {
            label: "Answered!",
            border: "border-emerald-500/80",
            textTone: "text-emerald-500",
        };
    }
    if (opts.overdue) {
        return {
            label: "Overdue",
            border: "border-destructive/60",
            textTone: "text-destructive",
        };
    }
    if (opts.notYetSent) {
        return {
            label: "Not sent",
            border: "border-yellow-500/60",
            textTone: "text-yellow-500",
        };
    }
    return {
        label: "Waiting for answer",
        border: "border-primary/40",
        textTone: "text-primary",
    };
}

/**
 * Find the question that's still awaiting an answer and has the most
 * pressing deadline. Thermometer in its "started" state is intentionally
 * excluded — it's not waiting for an answer yet, the seeker is moving.
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

/**
 * Render a short human-readable recap of the question's parameters. The
 * `headline` is the dominant detail (radius value, the resolved nearest
 * place, subtype, etc.); the optional `detail` carries any secondary
 * clarification. For matching/measuring we splice in the resolved nearest
 * place name when it's available so the seeker sees the actual reference
 * ("Nearest aquarium: SeaWorld?") instead of a generic template.
 *
 * Truncated by the caller so it stays one line.
 */
function summarizeQuestion(
    q: Question,
    nearestState?: ReturnType<typeof useNearestReference>,
): {
    headline: string;
    detail?: string;
} {
    const d = q.data as Record<string, unknown>;
    const niceType = (raw: unknown): string =>
        String(raw ?? "")
            .replace(/-/g, " ")
            .replace(/\b\w/g, (c) => c.toUpperCase());

    switch (q.id) {
        case "radius": {
            const radius = d.radius as number | undefined;
            const unit = d.unit as string | undefined;
            const u = unit === "miles" ? "mi" : unit === "meters" ? "m" : "km";
            return {
                headline: radius !== undefined ? `Within ${radius} ${u}?` : "Radar",
                detail: "Inside or outside this radius from the seeker's point",
            };
        }
        case "thermometer": {
            const dist = d.distance as string | undefined;
            return {
                headline: dist
                    ? `Warmer or colder over ${dist}?`
                    : "Warmer or colder after the move?",
                detail: "Hider tells you which direction is closer to them",
            };
        }
        case "matching": {
            const noun = d.type ? prettyTypeNoun(String(d.type)) : "place";
            const name = nearestStateName(nearestState);
            if (name) {
                return {
                    headline: `Nearest ${noun}: ${name}?`,
                    detail: "Hider says yes if their nearest is the same place",
                };
            }
            if (nearestState?.status === "loading") {
                return {
                    headline: `Nearest ${noun}: looking up…`,
                    detail: "Hider says yes if their nearest matches yours",
                };
            }
            return {
                headline: d.type
                    ? `Same nearest ${niceType(d.type)}?`
                    : "Matching question",
                detail: "Same vs different nearest place of the chosen type",
            };
        }
        case "measuring": {
            const noun = d.type ? prettyTypeNoun(String(d.type)) : "place";
            const name = nearestStateName(nearestState);
            const distanceM =
                nearestState?.status === "ok"
                    ? nearestState.ref.distanceMeters
                    : undefined;
            if (name) {
                const dist =
                    distanceM !== undefined
                        ? ` (${formatDistance(distanceM)})`
                        : "";
                return {
                    headline: `Nearest ${noun}: ${name}${dist} — closer or further?`,
                    detail: "Hider tells you which of you is closer to it",
                };
            }
            if (nearestState?.status === "loading") {
                return {
                    headline: `Nearest ${noun}: looking up…`,
                    detail: "Hider tells you which of you is closer to it",
                };
            }
            return {
                headline: d.type
                    ? `Closer or further from the nearest ${niceType(d.type)}?`
                    : "Measuring question",
                detail: "Hider tells you which of you is closer",
            };
        }
        case "tentacles":
            return {
                headline: d.locationType
                    ? `Closest ${niceType(d.locationType)} to you?`
                    : "Tentacles question",
                detail: "Hider names the specific place",
            };
        case "photo":
            return {
                headline: `Photo of ${niceType(d.type ?? "your spot")}`,
                detail: "Hider sends a photo back",
            };
        default:
            return { headline: (q as Question).id as string };
    }
}

function nearestStateName(
    state: ReturnType<typeof useNearestReference> | undefined,
): string | null {
    if (!state || state.status !== "ok") return null;
    return state.ref.name;
}

function formatDistance(m: number): string {
    if (m < 1000) return `${Math.round(m)} m`;
    if (m < 10_000) return `${(m / 1000).toFixed(1)} km`;
    return `${Math.round(m / 1000)} km`;
}

export default PendingAnswerOverlay;
