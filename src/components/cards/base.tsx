import { useStore } from "@nanostores/react";
import { ChevronDown, Copy, Share2 } from "lucide-react";
import { useState } from "react";
import { toast } from "react-toastify";

import { QuestionOutcomeMap } from "@/components/QuestionOutcomeMap";
import {
    QuestionOverlayCard,
    type QuestionSummary,
    summarizeQuestion,
} from "@/components/questionOverlayCard";
import { SidebarMenu } from "@/components/ui/sidebar-l";
import { useNow } from "@/hooks/useNow";
import { useVisibleInterval } from "@/hooks/useVisibleInterval";
import { CATEGORIES, type CategoryId } from "@/lib/categories";
import { isLoading, questionModified, questions } from "@/lib/context";
import { answerWindowMs, gameSize } from "@/lib/gameSetup";
import { multiplayerEnabled } from "@/lib/multiplayer/session";
import {
    isHiderConnected,
    seekerResendQuestion,
} from "@/lib/multiplayer/store";
import {
    encodeQuestionForHider,
    shareOrCopy,
} from "@/lib/shareLinks";
import { cn } from "@/lib/utils";
import type { Question } from "@/maps/schema";

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

/**
 * The hider's resolved answer, as a short human line for an ANSWERED
 * card's detail row (e.g. "Inside the radius", "Hider is closer"). Returns
 * null for types/states with no concise answer to show — the caller falls
 * back to the generic question prompt then.
 */
function answeredDetail(q: Question): string | null {
    const d = q.data as Record<string, unknown>;
    switch (q.id) {
        case "radius":
            return d.within ? "Inside the radius" : "Outside the radius";
        case "measuring":
            return d.hiderCloser ? "Hider is closer" : "Hider is further";
        case "thermometer":
            return d.warmer ? "Warmer after the move" : "Colder after the move";
        case "matching":
            if (typeof d.lengthComparison === "string") {
                const c = d.lengthComparison;
                return c === "same"
                    ? "Same name length"
                    : `Hider's name is ${c}`;
            }
            return d.same ? "Same as you" : "Different from you";
        case "tentacles": {
            const loc = d.location as
                | { properties?: { name?: unknown } }
                | false
                | null
                | undefined;
            if (!loc) return "None within range";
            const name = loc.properties?.name;
            return typeof name === "string" && name.trim()
                ? `Nearest: ${name}`
                : "Found one nearby";
        }
        case "photo":
            return d.declined
                ? "Hider couldn't answer"
                : d.photoUrl || d.photoUri
                  ? "Photo received"
                  : "Answered";
        default:
            return null;
    }
}

export const QuestionCard = ({
    children,
    questionKey,
    className,
    category,
    createdAt,
    collapsed,
    forceExpanded,
    locked,
    setCollapsed,
}: {
    children: React.ReactNode;
    questionKey: number;
    className?: string;
    /** Legacy props — kept for call-site compatibility. The collapsed
     *  header now derives its label/sub from `summarizeQuestion`. */
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
    const $gameSize = useStore(gameSize);

    // Resolve the live Question from the store so we can build a fresh
    // share URL (config may have changed since add-time). Thermometer in
    // its "started" phase has nothing to share yet — its share row is
    // contributed by the card itself once finished.
    const thisQuestion = $questions.find((q) => q.key === questionKey);
    const thermStatus =
        thisQuestion?.id === "thermometer"
            ? (thisQuestion.data as { status?: string }).status ?? "finished"
            : null;
    const shareable =
        thisQuestion &&
        thisQuestion.data.drag === true &&
        thermStatus !== "started" &&
        // The configure dialog already has its own "Confirm & share" CTA;
        // a second share row up top would be redundant and would let the
        // seeker ship the question before they've committed to its config.
        !forceExpanded;

    // Tick every minute to keep relative timestamps fresh.
    // Visibility-aware so a hidden tab doesn't burn CPU.
    const [nowTick, setNowTick] = useState(Date.now());
    useVisibleInterval(
        () => setNowTick(Date.now()),
        60000,
        createdAt !== undefined,
    );
    const relativeTime = createdAt
        ? formatRelativeTime(createdAt, nowTick)
        : null;

    // Rulebook p5 / p32: the hider must answer most questions within 5 min;
    // photo questions get 10 min (S/M) or 20 min (L). The split is sourced
    // from the live game size via answerWindowMs so the countdown on the
    // unanswered card matches the rule the hider is actually playing under.
    const answerDeadlineMs = answerWindowMs(category ?? "", $gameSize);
    const isPending = locked === false;
    // v377: shared clock instead of a per-card setInterval. With N
    // questions this was N independent 1 Hz timers each firing its own
    // render pass; now they all read one batched clock.
    const countdownTick = useNow(isPending && createdAt !== undefined);
    const remainingSec =
        isPending && createdAt
            ? Math.max(
                  0,
                  Math.ceil(
                      (createdAt + answerDeadlineMs - countdownTick) / 1000,
                  ),
              )
            : null;
    const answerDeadlineLabel =
        remainingSec === null
            ? null
            : remainingSec > 0
              ? `${Math.floor(remainingSec / 60)}:${String(
                    remainingSec % 60,
                ).padStart(2, "0")} to answer`
              : "answer overdue";

    // v344: explicit lifecycle status so the seeker never has to infer
    // "is this answered?" from the presence of a countdown. Four states:
    //   - in-progress : thermometer mid-run (status "started")
    //   - not-sent    : created but never shared (drag true, no createdAt)
    //   - awaiting     : shared, waiting on the hider (drag true + createdAt)
    //   - answered     : hider replied (drag false / locked)
    // `forceExpanded` = the configure dialog, where the question hasn't
    // been committed yet; we suppress the pill there to avoid implying
    // it's already in a lifecycle state.
    type Lifecycle =
        | "in-progress"
        | "not-sent"
        | "awaiting"
        | "answered"
        | "vetoed"
        | "randomized";
    const respData = thisQuestion?.data as
        | { vetoed?: boolean; randomized?: boolean }
        | undefined;
    const lifecycle: Lifecycle | null = forceExpanded
        ? null
        : respData?.vetoed
          ? "vetoed"
          : respData?.randomized
            ? "randomized"
            : thermStatus === "started"
              ? "in-progress"
              : locked === true
                ? "answered"
                : createdAt
                  ? "awaiting"
                  : "not-sent";
    const lifecycleMeta: Record<
        Lifecycle,
        { label: string; cls: string }
    > = {
        vetoed: {
            label: "Vetoed",
            cls: "bg-destructive/15 text-destructive border-destructive/30",
        },
        randomized: {
            label: "Randomized",
            cls: "bg-[hsl(265,60%,60%)]/15 text-[hsl(265,60%,72%)] border-[hsl(265,60%,60%)]/30",
        },
        "in-progress": {
            label: "In progress",
            cls: "bg-primary/15 text-primary border-primary/30",
        },
        "not-sent": {
            label: "Not sent",
            cls: "bg-muted text-muted-foreground border-border",
        },
        awaiting: {
            label: "Awaiting answer",
            cls: "bg-[hsl(var(--accent-yellow))]/15 text-[hsl(var(--accent-yellow))] border-[hsl(var(--accent-yellow))]/30",
        },
        answered: {
            label: "Answered",
            cls: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
        },
    };

    const toggleCollapse = () => {
        if (setCollapsed) setCollapsed(!isCollapsed);
        setIsCollapsed((prev) => !prev);
    };

    // Show-style summary (same engine as the pending-answer overlay) so the
    // collapsed card reads identically to the on-map overlay. While a
    // question is still awaiting / draft we keep the overlay's generic
    // prompt ("Inside or outside the radius?"); once it's ANSWERED we swap
    // in the resolved answer ("Inside the radius", "Hider is closer", …) so
    // the log says what the hider actually replied at a glance.
    const baseSummary: QuestionSummary = summarizeQuestion(
        thisQuestion ?? { id: category ?? "", data: {} },
    );
    const resolved =
        lifecycle === "answered" && thisQuestion
            ? answeredDetail(thisQuestion)
            : null;
    const cardSummary: QuestionSummary = {
        ...baseSummary,
        detail: resolved ?? baseSummary.detail,
    };

    // Right slot: the lifecycle status (Answered / Awaiting / …) over the
    // relative time or answer countdown, plus a BIG chevron. Mirrors the
    // overlay's "live status on the right" with the expand affordance.
    const timeNode = answerDeadlineLabel ? (
        <span
            className={cn(
                "text-[10px] font-mono tabular-nums whitespace-nowrap",
                remainingSec === 0 ? "text-destructive" : "text-primary",
            )}
            title="Hider's answer window (rulebook p5/p32)"
        >
            {answerDeadlineLabel}
        </span>
    ) : relativeTime ? (
        <span
            className="text-[10px] font-mono text-[color:var(--overlay-card-desc)] whitespace-nowrap"
            title={createdAt ? new Date(createdAt).toLocaleString() : undefined}
        >
            {relativeTime}
        </span>
    ) : null;

    const rightSlot = (
        <div className="flex items-center gap-2">
            {(lifecycle || timeNode) && (
                <div className="flex flex-col items-end gap-0.5 leading-none">
                    {lifecycle && (
                        <span
                            className={cn(
                                "text-[9px] uppercase tracking-wider font-poppins font-semibold",
                                "px-1.5 py-0.5 rounded border whitespace-nowrap",
                                lifecycleMeta[lifecycle].cls,
                            )}
                        >
                            {lifecycleMeta[lifecycle].label}
                        </span>
                    )}
                    {timeNode}
                </div>
            )}
            <ChevronDown
                className={cn(
                    "h-6 w-6 shrink-0 text-[color:var(--overlay-card-desc)] transition-transform duration-200",
                    !isCollapsed && "rotate-180",
                )}
                strokeWidth={2.5}
            />
        </div>
    );

    // Once a question is RESOLVED (locked / answered) its config children
    // are a read-only duplicate of what the outcome map already shows — the
    // subtype select, the location-picker mini-map, etc. Hide them so the
    // expanded card is just the outcome map. Still shown while the question
    // is in-flight (the thermometer end-point share, drafts), in the
    // configure dialog (`forceExpanded`), and for photo (whose children ARE
    // the received image, not a duplicate map).
    const showChildren =
        forceExpanded || category === "photo" || locked !== true;
    const shareRow = shareable && thisQuestion;

    return (
        <div
            className={cn(
                // Match the on-map QuestionOverlayCard treatment: sharp
                // corners, a subtle NEUTRAL outline (not category-tinted), a
                // real shadow for lift, and a surface only a hair above the
                // drawer background — so the shadow does the separating, not
                // a contrasting block. Margins/inset are owned by the list
                // container (QuestionSidebar) so the card sits flush in the
                // configure dialog too.
                "relative overflow-hidden border shadow-lg",
                "border-sidebar-border bg-sidebar-accent",
                className,
            )}
        >
            {/* Collapsed header = the same Jet-Lag-show overlay chrome the
                pending-answer card uses (solid category-colour icon block,
                big coloured label, status on the right). Borderless +
                square-cornered here; the wrapper supplies the rounded,
                category-tinted border so the whole thing reads as one card.
                The configure dialog (`forceExpanded`) keeps it static — no
                chevron, no collapse. */}
            <QuestionOverlayCard
                categoryId={category ?? ""}
                summary={cardSummary}
                error={lifecycle === "not-sent"}
                right={forceExpanded ? undefined : rightSlot}
                onClick={forceExpanded ? undefined : toggleCollapse}
                ariaLabel={
                    forceExpanded
                        ? undefined
                        : isCollapsed
                          ? "Expand question details"
                          : "Collapse question details"
                }
                className="rounded-none border-0 shadow-none bg-transparent"
            />
            <div
                className={cn(
                    "overflow-hidden transition-all duration-200 max-h-[200rem] pb-2",
                    isCollapsed && !forceExpanded && "max-h-0",
                )}
            >
                {/* Expanded: a static map highlighting this question's
                    resulting area (the part of the play region still
                    consistent with the answer). Suppressed in the configure
                    dialog, which already embeds the interactive picker.
                    Mounted only while expanded so each collapsed card isn't
                    running its own MapLibre instance. Skipped for PHOTO —
                    it eliminates nothing (the engine would just highlight
                    the whole play area), and the photo card's own image
                    below IS the outcome. */}
                {!forceExpanded &&
                    thisQuestion &&
                    !isCollapsed &&
                    category !== "photo" && (
                        <div className="px-2 pt-2">
                            <QuestionOutcomeMap question={thisQuestion} />
                        </div>
                    )}
                {(showChildren || shareRow) && (
                    <SidebarMenu>
                        {shareRow && (
                            <ShareQuestionRow question={thisQuestion!} />
                        )}
                        {showChildren && children}
                    </SidebarMenu>
                )}
            </div>
        </div>
    );
};

/**
 * Inline "send this question to the hider" row, rendered at the top of every
 * pending (drag:true) question card. Backup path for when the OS share sheet
 * dismissed (or otherwise didn't fire) after the initial Confirm.
 *
 * On a successful share or copy, also stamps `data.createdAt = Date.now()`
 * if it wasn't already set — the 5-minute answer countdown starts here
 * rather than at confirm-time, which matches the hider's actual receipt
 * of the link.
 */
function ShareQuestionRow({ question }: { question: Question }) {
    const $isLoading = useStore(isLoading);
    const $mpEnabled = useStore(multiplayerEnabled);
    const meta = CATEGORIES[question.id as CategoryId];

    const stampSent = () => {
        const d = question.data as { createdAt?: number };
        if (d.createdAt) return; // already sent — don't reset the countdown
        d.createdAt = Date.now();
        questionModified();
    };

    const handleShare = async () => {
        const url = encodeQuestionForHider(question);
        const result = await shareOrCopy({
            title: `${meta?.label ?? "Question"} for the hider`,
            text: `${meta?.label ?? "Question"}: tap to answer`,
            url,
        });
        if (result.method === "share" || result.method === "copy") {
            stampSent();
        }
        if (result.method === "copy") {
            toast.success("Question link copied", { autoClose: 1500 });
        } else if (result.method === "failed") {
            toast.error("Could not share question link");
        }
    };

    const handleCopy = async () => {
        const url = encodeQuestionForHider(question);
        try {
            await navigator.clipboard.writeText(url);
            stampSent();
            toast.success("Question link copied", { autoClose: 1500 });
        } catch {
            toast.error("Could not copy");
        }
    };

    // v347: in multiplayer mode the in-app pipeline already pushed
    // this question to the server (seekerAddQuestion at create time);
    // the OS share sheet is redundant. The primary button becomes
    // "Resend via app" — re-pushes via the wire (idempotent by key)
    // for the recovery case where the first push didn't land. The
    // "Copy link" backup stays as an out-of-band escape hatch.
    const handleResend = () => {
        const ok = seekerResendQuestion(question.key);
        if (!ok) {
            toast.error("Couldn't resend over the app");
            return;
        }
        stampSent();
        if (isHiderConnected()) {
            toast.success("Resent to hider", { autoClose: 1500 });
        } else {
            toast.info("Resent — hider's offline, they'll get it on reconnect.", {
                autoClose: 2500,
            });
        }
    };

    const alreadySent = Boolean(
        (question.data as { createdAt?: number }).createdAt,
    );

    const primaryLabel = $mpEnabled
        ? alreadySent
            ? "Resend via app"
            : "Send via app"
        : alreadySent
          ? "Re-share with hider"
          : "Send to hider";

    return (
        <div className="px-2 pt-2 pb-1">
            <div className="text-[10px] uppercase tracking-[0.16em] font-poppins font-semibold text-muted-foreground mb-1.5">
                {primaryLabel}
            </div>
            <div className="flex gap-2">
                <button
                    type="button"
                    onClick={$mpEnabled ? handleResend : handleShare}
                    disabled={$isLoading}
                    className={cn(
                        "flex-1 flex items-center justify-center gap-1.5",
                        "px-2 py-2 rounded-md text-xs font-poppins font-semibold",
                        "bg-primary text-primary-foreground hover:bg-primary/90",
                        "transition-colors",
                        "disabled:opacity-50 disabled:cursor-not-allowed",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    )}
                >
                    <Share2 className="w-3.5 h-3.5" />
                    {$mpEnabled ? "Resend" : "Share"}
                </button>
                <button
                    type="button"
                    onClick={handleCopy}
                    disabled={$isLoading}
                    title={
                        $mpEnabled
                            ? "Manual backup — copies a share link in case the in-app channel isn't working"
                            : undefined
                    }
                    className={cn(
                        "flex-1 flex items-center justify-center gap-1.5",
                        "px-2 py-2 rounded-md text-xs font-poppins font-semibold",
                        "bg-secondary text-foreground hover:bg-accent border border-border",
                        "transition-colors",
                        "disabled:opacity-50 disabled:cursor-not-allowed",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    )}
                >
                    <Copy className="w-3.5 h-3.5" />
                    Copy link
                </button>
            </div>
        </div>
    );
}

/**
 * Suppressed manual-answer disclosure. The app now trusts that a real
 * hider will reply via share-link or multiplayer — so the seeker
 * never needs to override the answer locally. Renders nothing for
 * every question type. The component is kept (rather than ripped
 * out at every callsite) so the wiring stays simple if we ever want
 * to bring a debug-only manual mode back.
 */
export const ManualAnswerDisclosure = (
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _props: { compact?: boolean; children: React.ReactNode },
) => null;

