import { useStore } from "@nanostores/react";
import type { LucideIcon } from "lucide-react";
import {
    Beef,
    BookOpen,
    Building2,
    Camera,
    Check,
    FerrisWheel,
    Film,
    Fish,
    Flag,
    Hospital,
    Hourglass,
    Landmark,
    Mountain,
    PawPrint,
    Plane,
    Ruler,
    Share2,
    ShoppingBag,
    Train,
    TrainFront,
    TrainTrack,
    TreePine,
    Trees,
    Waves,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "react-toastify";

import { useNow } from "@/hooks/useNow";
import { CATEGORIES, type CategoryId } from "@/lib/categories";
import { questionModified, questions, triggerLocalRefresh } from "@/lib/context";
import { answerWindowMs, gameSize } from "@/lib/gameSetup";
import { participants } from "@/lib/multiplayer/session";
import { isHiderConnected } from "@/lib/multiplayer/store";
import { encodeQuestionForHider, shareOrCopy } from "@/lib/shareLinks";
import { cn } from "@/lib/utils";
import type { Question, ThermometerQuestion } from "@/maps/schema";

import {
    prettyTypeNoun,
    useNearestReference,
} from "./NearestReferencePreview";

/**
 * Icon for the question's subtype (museum → Landmark, airport → Plane,
 * etc.). Used as the badge avatar so the seeker reads the *thing the
 * question is about*, not just the rulebook category color. Falls back
 * to the category's own icon when the subtype isn't iconified here.
 */
const SUBTYPE_ICONS: Record<string, LucideIcon> = {
    airport: Plane,
    city: Building2,
    "major-city": Building2,
    aquarium: Fish,
    hospital: Hospital,
    peak: Mountain,
    museum: Landmark,
    theme_park: FerrisWheel,
    zoo: PawPrint,
    cinema: Film,
    library: BookOpen,
    golf_course: Flag,
    consulate: Landmark,
    park: Trees,
    coastline: Waves,
    mcdonalds: Beef,
    seven11: ShoppingBag,
    "rail-measure": Train,
    "same-train-line": TrainTrack,
    "same-length-station": Ruler,
    "highspeed-measure-shinkansen": TrainFront,
    tree: TreePine,
    selfie: Camera,
};

function getSubtypeIcon(type: string | undefined): LucideIcon | null {
    if (!type) return null;
    const stripped = type.endsWith("-full")
        ? type.slice(0, -"-full".length)
        : type;
    return SUBTYPE_ICONS[stripped] ?? null;
}

/** Human-readable subtype label for the header (e.g. "Museum",
 *  "McDonald's", "Train station"). CSS uppercases it. */
function subtypeLabel(type: string | undefined): string | null {
    if (!type) return null;
    const stripped = type.endsWith("-full")
        ? type.slice(0, -"-full".length)
        : type;
    switch (stripped) {
        case "mcdonalds":
            return "McDonald's";
        case "seven11":
            return "7-Eleven";
        case "rail-measure":
            return "Train station";
        case "major-city":
            return "Major city";
        case "highspeed-measure-shinkansen":
            return "Shinkansen";
        case "same-train-line":
            return "Train line";
        case "same-length-station":
            return "Station length";
        default:
            return stripped.replace(/[-_]/g, " ");
    }
}

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
/** Override the questions list to preview a specific pending state in
 *  the /debug/overlays gallery without touching global state. */
export interface PendingAnswerPreview {
    questions: ReturnType<typeof questions.get>;
}

export function PendingAnswerOverlay({
    preview,
}: { preview?: PendingAnswerPreview } = {}) {
    useStore(triggerLocalRefresh);
    let $questions = useStore(questions);
    if (preview) $questions = preview.questions;
    const $gameSize = useStore(gameSize);
    // Reactive subscription — the share button re-labels itself when
    // a hider joins/leaves the online room mid-question. `isHiderConnected`
    // reads the same store imperatively for the click handler.
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
            // New question (or same one re-armed) → reset to active.
            setDisplayed(pending);
            setPhase("active");
            return;
        }
        if (prevKey !== null) {
            // The previously-pending question is no longer pending. That
            // happens for TWO very different reasons, and we must not
            // treat them the same:
            //   - ANSWERED: its `drag` flipped to false — the question
            //     still EXISTS in the list. Celebrate, then slide out.
            //   - DISCARDED: the seeker opened the new-question dialog
            //     (which adds a drag:true draft, so it counts as pending)
            //     and then CANCELLED — the draft was removed from the
            //     list entirely. No answer happened, so show nothing.
            // The bug this guards: a cancelled draft flashed a green
            // "ANSWERED!" card on the map. Distinguish by existence.
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
            // Discarded draft → clear immediately, no celebration.
            setDisplayed(null);
            setPhase("active");
            return;
        }
        setDisplayed(null);
        setPhase("active");
    }, [pending?.key]);

    // 1 Hz tick to keep the countdown fresh. Visibility-aware so
    // a hidden tab isn't waking the CPU every second just to drift
    // a countdown that nobody is looking at.
    // v377: shared clock (was a dedicated 1 Hz setInterval).
    const now = useNow(Boolean(displayed) && phase === "active");

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
    // Rulebook p5/p32: 5 min for everything except photo (10 min S/M,
    // 20 min L). `answerWindowMs` reads the live game size.
    const windowMs = answerWindowMs(displayed.id, $gameSize);
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
        // If the hider is connected to the online room they already
        // received the question over the WebSocket bridge — skip the
        // share-link entirely and just stamp `createdAt` so the 5-min
        // answer clock starts ticking.
        if (isHiderConnected()) {
            const d = displayed.data as { createdAt?: number };
            if (!d.createdAt) {
                d.createdAt = Date.now();
                questionModified();
            }
            toast.success("Sent to hider", { autoClose: 1500 });
            return;
        }

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
                {(() => {
                    // Avatar icon — subtype-specific where we have one
                    // (Museum, Plane, Fish…), category fallback otherwise.
                    // Swaps to a green checkmark once the question is
                    // answered.
                    const AvatarIcon = summary.icon ?? Icon;
                    return (
                        <span
                            className={cn(
                                "inline-flex items-center justify-center w-9 h-9 rounded shrink-0 transition-colors duration-300",
                                phase === "answered" ? "bg-emerald-500" : "",
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
                                <AvatarIcon
                                    size={16}
                                    strokeWidth={2.5}
                                    className="text-white"
                                />
                            )}
                        </span>
                    );
                })()}

                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 leading-none">
                        <span className="text-[10px] uppercase tracking-[0.14em] font-poppins font-semibold text-muted-foreground min-w-0 truncate">
                            {summary.headerCategoryLabel}
                            {summary.headerSubtypeLabel && (
                                <>
                                    {" · "}
                                    <span className="text-foreground/80">
                                        {summary.headerSubtypeLabel}
                                    </span>
                                </>
                            )}
                        </span>
                        <span className="ml-auto shrink-0 flex items-center gap-1.5">
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
                            {phase === "active" && overdue && (
                                <span
                                    className="text-[10px] font-poppins font-bold uppercase tracking-[0.1em] text-destructive"
                                    title="Past the answer window — the hider's clock is paused until they answer, and they earn no card (rulebook p61)"
                                >
                                    Clock paused
                                </span>
                            )}
                        </span>
                    </div>
                    <div className="mt-1 text-sm font-inter-tight font-bold text-foreground leading-tight truncate">
                        {summary.title}
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
                            isHiderConnected()
                                ? notYetSent
                                    ? "Mark sent to hider"
                                    : "Re-send to hider"
                                : notYetSent
                                  ? "Share question with hider"
                                  : "Re-share question with hider"
                        }
                        title={
                            isHiderConnected()
                                ? "Hider is connected — they already see this question. Tap to start the 5-min answer window."
                                : notYetSent
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
interface QuestionSummary {
    /** Top-left uppercase chip — the rulebook category (e.g. "Matching"). */
    headerCategoryLabel: string;
    /** Optional second uppercase chip after a separator (e.g. "Museum",
     *  "Airport", "Coastline"). Omit when the subtype is meaningless. */
    headerSubtypeLabel?: string;
    /** Avatar icon for the badge. Overrides the category-level icon —
     *  matching for a museum uses the museum icon rather than the
     *  generic "equals" matching glyph. */
    icon?: LucideIcon;
    /** Bold one-line title below the chips. For matching/measuring
     *  this is the resolved place name; for other categories the
     *  question recap (e.g. "Within 5 km?"). Truncated by the caller. */
    title: string;
    /** Optional secondary line below the title. */
    detail?: string;
}

function summarizeQuestion(
    q: Question,
    nearestState?: ReturnType<typeof useNearestReference>,
): QuestionSummary {
    const d = q.data as Record<string, unknown>;
    const cat = CATEGORIES[q.id as CategoryId];
    const categoryLabel = cat?.label ?? q.id;
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
                headerCategoryLabel: categoryLabel,
                title:
                    radius !== undefined ? `Within ${radius} ${u}?` : "Radar",
                detail: "Inside or outside this radius from the seeker's point",
            };
        }
        case "thermometer": {
            const dist = d.distance as string | undefined;
            return {
                headerCategoryLabel: categoryLabel,
                headerSubtypeLabel: dist ?? undefined,
                title: dist
                    ? `Warmer or colder over ${dist}?`
                    : "Warmer or colder after the move?",
                detail: "Hider tells you which direction is closer to them",
            };
        }
        case "matching": {
            const subType = d.type ? String(d.type) : undefined;
            const subLabel = subtypeLabel(subType) ?? undefined;
            const subIcon = getSubtypeIcon(subType) ?? undefined;
            const noun = subType ? prettyTypeNoun(subType) : "place";
            const name = nearestStateName(nearestState);

            let title: string;
            if (name) {
                title = name;
            } else if (nearestState?.status === "loading") {
                title = "Looking up nearest…";
            } else if (subType) {
                // Subtype isn't lookup-able (zone admin, custom,
                // train-line, etc.) — keep a templated title.
                title = `Same nearest ${niceType(subType)}?`;
            } else {
                title = "Matching question";
            }

            return {
                headerCategoryLabel: categoryLabel,
                headerSubtypeLabel: subLabel,
                icon: subIcon,
                title,
                detail: name
                    ? "Hider says yes if their nearest is the same place"
                    : `Hider says yes if their nearest ${noun} matches yours`,
            };
        }
        case "measuring": {
            const subType = d.type ? String(d.type) : undefined;
            const subLabel = subtypeLabel(subType) ?? undefined;
            const subIcon = getSubtypeIcon(subType) ?? undefined;
            const noun = subType ? prettyTypeNoun(subType) : "place";
            const name = nearestStateName(nearestState);
            const distanceM =
                nearestState?.status === "ok"
                    ? nearestState.ref.distanceMeters
                    : undefined;

            let title: string;
            let detail: string;
            if (name) {
                title = name;
                detail =
                    distanceM !== undefined
                        ? `${formatDistance(distanceM)} away · hider says if they're closer or further`
                        : "Hider tells you which of you is closer to it";
            } else if (nearestState?.status === "loading") {
                title = "Looking up nearest…";
                detail = "Hider tells you which of you is closer to it";
            } else if (subType) {
                title = `Closer or further from the nearest ${niceType(subType)}?`;
                detail = "Hider tells you which of you is closer";
            } else {
                title = "Measuring question";
                detail = `Hider tells you who's closer to the nearest ${noun}`;
            }

            return {
                headerCategoryLabel: categoryLabel,
                headerSubtypeLabel: subLabel,
                icon: subIcon,
                title,
                detail,
            };
        }
        case "tentacles": {
            const subType = d.locationType
                ? String(d.locationType)
                : undefined;
            const subLabel = subtypeLabel(subType) ?? undefined;
            const subIcon = getSubtypeIcon(subType) ?? undefined;
            return {
                headerCategoryLabel: categoryLabel,
                headerSubtypeLabel: subLabel,
                icon: subIcon,
                title: subType
                    ? `Closest ${niceType(subType)} to you?`
                    : "Tentacles question",
                detail: "Hider names the specific place",
            };
        }
        case "photo": {
            const subType = d.type ? String(d.type) : undefined;
            const subLabel = subtypeLabel(subType) ?? undefined;
            const subIcon = getSubtypeIcon(subType) ?? undefined;
            return {
                headerCategoryLabel: categoryLabel,
                headerSubtypeLabel: subLabel,
                icon: subIcon,
                title: `Photo of ${niceType(d.type ?? "your spot")}`,
                detail: "Hider sends a photo back",
            };
        }
        default:
            return {
                headerCategoryLabel: categoryLabel,
                title: (q as Question).id as string,
            };
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
