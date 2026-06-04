import { useStore } from "@nanostores/react";
import { Bug, X } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import {
    addQuestion,
    leafletMapContext,
    questionModified,
    questions,
} from "@/lib/context";
import { type Card,shuffledDeck } from "@/lib/hiderDeck";
import {
    hiderHand,
    hiderInbox,
    playerRole,
    presentDraw,
    QUESTION_DRAW_BUDGET,
} from "@/lib/hiderRole";
import { encodeQuestionForHider } from "@/lib/shareLinks";
import { cn } from "@/lib/utils";
import { APP_VERSION } from "@/lib/version";
import type { Question } from "@/maps/schema";

import { DICE_FIZZLE } from "./CastCurseDialog";

/**
 * Temporary developer panel for jumping the latest question between any
 * of its lifecycle phases. Float-mounted on both `/` (seeker) and `/h`
 * (hider).
 *
 * The phase buttons are **stateless setters**, not transitions — each
 * one moves the latest question to that exact phase, regardless of
 * which phase it's currently in. So you can bounce back and forth
 * freely (e.g. Answered → Waiting → Not sent → Overdue → Answered)
 * without having to reset between attempts.
 *
 * Phase definitions:
 *
 *   • Not sent           — `drag:true`, `createdAt` undefined
 *   • Waiting for answer — `drag:true`, `createdAt` = now
 *   • Overdue            — `drag:true`, `createdAt` = 6 min ago
 *   • Answered · Yes     — `drag:false`, positive answer field
 *   • Answered · No      — `drag:false`, negative answer field
 *
 * Remove this component (and its mount sites in `index.astro` and
 * `h.astro`) before shipping a release.
 */

type Phase = "not-sent" | "waiting" | "overdue" | "answered-yes" | "answered-no";

export function DebugPhaseControls() {
    const [open, setOpen] = useState(false);
    const $questions = useStore(questions);
    const $inbox = useStore(hiderInbox);
    const $map = useStore(leafletMapContext);
    const $role = useStore(playerRole);

    /* ─────── seeker actions ─────── */

    /** Map center if available, else a Stockholm-ish fallback. */
    const pickCenter = (): { lat: number; lng: number } => {
        if ($map) {
            const c = $map.getCenter();
            return { lat: c.lat, lng: c.lng };
        }
        return { lat: 59.3293, lng: 18.0686 };
    };

    /** The most-recently-added question — what the phase buttons act on. */
    const latestQuestion = (): Question | null => {
        const list = questions.get();
        return list[list.length - 1] ?? null;
    };

    const addRadarQuestion = () => {
        const { lat, lng } = pickCenter();
        addQuestion({
            id: "radius",
            data: {
                lat,
                lng,
                radius: 5,
                unit: "kilometers",
            },
        });
    };

    /**
     * Move the latest question to a specific phase. Stateless — works
     * regardless of where the question currently is, so the user can
     * jump backward (e.g. "answered" → "not sent") freely.
     */
    const setPhase = (target: Phase) => {
        const q = latestQuestion();
        if (!q) return;
        const d = q.data as Record<string, unknown>;

        // drag flag: false only for answered phases.
        d.drag = !target.startsWith("answered");

        // createdAt management
        if (target === "not-sent") {
            delete d.createdAt;
        } else if (target === "overdue") {
            // Past the 5-min answer window for non-photo questions.
            d.createdAt = Date.now() - 6 * 60_000;
        } else {
            // waiting + answered both want a createdAt so the
            // "answered" pill replaces the "waiting" pill cleanly.
            d.createdAt = Date.now();
        }

        // Answer-field management. Each question type uses a different
        // field for its answer; we apply the boolean (or stub string)
        // when the target phase is one of the answered phases.
        if (target === "answered-yes" || target === "answered-no") {
            const positive = target === "answered-yes";
            switch (q.id) {
                case "radius":
                    d.within = positive;
                    break;
                case "matching":
                    d.same = positive;
                    break;
                case "measuring":
                    d.hiderCloser = positive;
                    break;
                case "thermometer":
                    d.warmer = positive;
                    break;
                case "tentacles":
                    d.hiderPlace = positive ? "Test Place" : "";
                    break;
                case "photo":
                    // Photo has no boolean answer — drag:false is enough.
                    break;
            }
        }

        questionModified();
    };

    /** Derive the latest question's current phase, for highlighting
     *  the active button in the panel. */
    const currentPhase = (): Phase | null => {
        const q = latestQuestion();
        if (!q) return null;
        const d = q.data as { drag?: boolean; createdAt?: number };
        if (d.drag === false) {
            // We can't easily tell "yes" vs "no" without reading the
            // per-category answer field; pick the "yes" highlight for
            // simplicity since both share the same visual phase
            // (answered + slide-out animation).
            return "answered-yes";
        }
        if (d.createdAt === undefined) return "not-sent";
        const ageMs = Date.now() - d.createdAt;
        const windowMs = q.id === "photo" ? 10 * 60_000 : 5 * 60_000;
        return ageMs >= windowMs ? "overdue" : "waiting";
    };

    /** Labels for the answered-yes / answered-no buttons based on the
     *  latest question's type. */
    const answerLabels = (() => {
        const q = latestQuestion();
        switch (q?.id) {
            case "radius":
                return { positive: "Inside", negative: "Outside" };
            case "matching":
                return { positive: "Match", negative: "Different" };
            case "measuring":
                return { positive: "Closer", negative: "Further" };
            case "thermometer":
                return { positive: "Warmer", negative: "Colder" };
            case "tentacles":
                return { positive: "Has answer", negative: "Empty answer" };
            case "photo":
                return { positive: "Sent", negative: "Sent (no)" };
            default:
                return { positive: "Yes", negative: "No" };
        }
    })();

    const resetQuestions = () => {
        questions.set([]);
    };

    /**
     * Testing-only: flip the device to hider role and open the latest
     * pending question's `?q=` URL directly. Production "Switch to
     * hider" deliberately doesn't do this (roles lock once a game has
     * started), but for round-tripping the answer flow on a single
     * device this is the path the seeker would otherwise text to the
     * hider.
     */
    const openLatestAsHider = () => {
        const all = questions.get();
        const latest = [...all].reverse().find((q) => {
            if (q.data.drag !== true) return false;
            if (q.id === "thermometer") {
                const status =
                    (q.data as { status?: string }).status ?? "finished";
                if (status === "started") return false;
            }
            return true;
        });
        if (!latest) return;
        playerRole.set("hider");
        const url = encodeQuestionForHider(latest);
        try {
            const parsed = new URL(url);
            window.location.assign(
                parsed.pathname + parsed.search + parsed.hash,
            );
        } catch {
            window.location.assign("/h");
        }
    };

    /* ─────── role switching (bypasses production lock) ─────── */

    /**
     * Force-switch the device's role and route to the matching page,
     * regardless of whether the production "Switch to seeker / hider"
     * affordances are currently locked (they hide once the game has
     * a question history to prevent mid-game role flips).
     *
     * When flipping to the hider side, also ferry every pending
     * seeker-side question (`drag === true`, except for started-but-
     * not-finished thermometer questions) into the hider's inbox.
     * Otherwise the hider lands on `/h` with an empty question log
     * and the round-trip can't be tested on a single device.
     * Deduped by question key so repeat presses don't pile up.
     *
     * Debug-only — production code paths should keep using their
     * gated switchers, and in a real game the question would arrive
     * via share link.
     */
    const forceRole = (target: "seeker" | "hider") => {
        if (target === "hider") {
            const pending = questions.get().filter((q) => {
                if (q.data.drag !== true) return false;
                if (q.id === "thermometer") {
                    const status =
                        (q.data as { status?: string }).status ?? "finished";
                    if (status === "started") return false;
                }
                return true;
            });
            if (pending.length > 0) {
                const inbox = hiderInbox.get();
                const existingKeys = new Set(inbox.map((e) => e.key));
                const additions = pending
                    .filter((q) => !existingKeys.has(q.key))
                    .map((q) => ({
                        key: q.key,
                        id: q.id,
                        data: q.data as Record<string, unknown>,
                        arrivedAt: Date.now(),
                    }));
                if (additions.length > 0) {
                    hiderInbox.set([...inbox, ...additions]);
                }
            }
        }
        playerRole.set(target);
        const path = target === "hider" ? "/h" : "/";
        if (window.location.pathname === path) {
            // Refresh so the page re-mounts under the new role.
            window.location.reload();
        } else {
            window.location.assign(path);
        }
    };

    /* ─────── hider actions ─────── */

    /**
     * Pick a uniformly-random index using `crypto.getRandomValues`
     * instead of `Math.random`. Lets the debug tool stay
     * deterministically random even if a test eval has pinned
     * `Math.random` to a fixed value (the GPS spoof + dice-roll
     * mocks earlier in the session do this) — using `Math.random`
     * directly would make the debug tool deal the same card
     * every click. Falls back to `Math.random` if `crypto` isn't
     * available (older / locked-down browsers).
     */
    const randIdx = (len: number): number => {
        if (len <= 0) return 0;
        try {
            const buf = new Uint32Array(1);
            crypto.getRandomValues(buf);
            return buf[0] % len;
        } catch {
            return Math.floor(Math.random() * len);
        }
    };

    /**
     * Drop a fresh card into the hider's hand. Picks from the full
     * deck of 100 cards — proportional kind distribution matches
     * the real deck (55 time-bonus / 21 powerup / 24 curse).
     * Ignores the hand cap so the user can stack however many they
     * want for UI testing.
     *
     * `kind` lets you bias the pick to one of the three card kinds.
     */
    const drawRandomCard = (kind?: Card["kind"]) => {
        const deck = shuffledDeck();
        const pool = kind ? deck.filter((c) => c.kind === kind) : deck;
        if (pool.length === 0) return;
        const card = pool[randIdx(pool.length)];
        hiderHand.set([...hiderHand.get(), card]);
    };

    /**
     * Same draw flow as `drawRandomCard`, but filters to the
     * subset of curses that have a pre-cast die roll (the
     * Endless Tumble / Gambler's Feet family). Quick way to
     * smoke-test the dice tumble, confetti, and fizzle effects
     * without spamming the random-curse button until you land on
     * a rollable one.
     */
    const drawRandomRollableCurse = () => {
        const rollableNames = new Set(
            Object.keys(DICE_FIZZLE).filter(
                (name) => DICE_FIZZLE[name] !== undefined,
            ),
        );
        const deck = shuffledDeck();
        const pool = deck.filter(
            (c) => c.kind === "curse" && rollableNames.has(c.name),
        );
        if (pool.length === 0) return;
        const card = pool[randIdx(pool.length)];
        hiderHand.set([...hiderHand.get(), card]);
    };

    const injectInboxQuestion = () => {
        const list = hiderInbox.get();
        hiderInbox.set([
            ...list,
            {
                key: Math.floor(Math.random() * 1_000_000),
                id: "radius",
                data: {
                    lat: 59.3293,
                    lng: 18.0686,
                    radius: 5,
                    unit: "kilometers",
                    drag: true,
                } as Record<string, unknown>,
                arrivedAt: Date.now(),
            },
        ]);
    };

    const markLatestInboxReplied = () => {
        const list = hiderInbox.get();
        if (list.length === 0) return;
        const sorted = [...list].sort((a, b) => b.arrivedAt - a.arrivedAt);
        const target = sorted.find((e) => !e.repliedAt);
        if (!target) return;
        // Stamp the inbox entry as replied so it moves from
        // "Awaiting answer" into "Answered" in the hider's log.
        hiderInbox.set(
            list.map((e) =>
                e.key === target.key
                    ? { ...e, repliedAt: Date.now(), reply: { within: true } }
                    : e,
            ),
        );
        // Mirror the card-draw side effect the real share-back flow
        // produces (see ShareBackRow.markRepliedInInbox in
        // HiderView). Without this, replying via the debug button
        // never queues a draw and the hand/deck flows can't be
        // tested end-to-end.
        const budget = QUESTION_DRAW_BUDGET[target.id];
        if (budget) {
            const autoResolved = presentDraw(
                budget.draw,
                budget.keep,
                target.id,
                target.key,
            );
            void autoResolved;
        }
    };

    const unreplyLatestInbox = () => {
        const list = hiderInbox.get();
        if (list.length === 0) return;
        const sorted = [...list].sort((a, b) => b.arrivedAt - a.arrivedAt);
        const target = sorted.find((e) => e.repliedAt);
        if (!target) return;
        hiderInbox.set(
            list.map((e) =>
                e.key === target.key
                    ? { ...e, repliedAt: undefined, reply: undefined }
                    : e,
            ),
        );
    };

    const clearInbox = () => {
        hiderInbox.set([]);
    };

    const pendingCount = $questions.filter((q) => q.data.drag === true).length;
    const inboxUnreplied = $inbox.filter((e) => !e.repliedAt).length;
    const hasLatest = latestQuestion() !== null;
    const phase = currentPhase();

    // Render into a fresh body-level portal so the bug button + open
    // panel are never trapped inside another component's stacking
    // context or Radix's modal-Dialog sibling tree (which can mark
    // siblings as inert and swallow clicks even when z-index is
    // higher). Combined with z-[9999] and explicit pointer-events,
    // this guarantees the debug control is clickable in every app
    // state — over the welcome screen, lobby, role picker, GO GO GO
    // celebration, anything.
    const [mounted, setMounted] = useState(false);
    useEffect(() => {
        setMounted(true);
    }, []);
    if (!mounted || typeof document === "undefined") return null;

    const content = !open ? (
        <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label="Open debug phase controls"
            className={cn(
                "fixed left-3 top-3 z-[9999] pointer-events-auto",
                "w-9 h-9 flex items-center justify-center rounded-full",
                "bg-amber-500 text-white shadow-lg",
                "hover:bg-amber-400 transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300",
            )}
            title={`Debug phase controls · ${APP_VERSION}`}
        >
            <Bug className="w-4 h-4" />
        </button>
    ) : (
        <div
            className={cn(
                "fixed left-3 top-3 z-[9999] pointer-events-auto",
                "w-[300px] max-h-[85vh] overflow-y-auto",
                "bg-background text-foreground border-2 border-amber-500 rounded-md shadow-2xl",
                "text-xs",
            )}
            role="dialog"
            aria-label="Debug phase controls"
        >
            <div className="flex items-center justify-between bg-amber-500 text-white px-2.5 py-1.5">
                <span className="font-poppins font-bold uppercase tracking-wider flex items-center gap-1.5">
                    <Bug className="w-3.5 h-3.5" />
                    Phase tester
                    <span className="font-mono font-semibold normal-case tracking-normal text-[10px] bg-white/20 rounded px-1.5 py-0.5">
                        {APP_VERSION}
                    </span>
                </span>
                <button
                    type="button"
                    onClick={() => setOpen(false)}
                    aria-label="Close debug panel"
                    className="hover:bg-white/20 w-6 h-6 flex items-center justify-center rounded"
                >
                    <X className="w-3.5 h-3.5" />
                </button>
            </div>

            <div className="p-2.5 space-y-3">
                {/* Live counters + current phase indicator. */}
                <div className="text-[10px] text-muted-foreground tabular-nums leading-tight space-y-0.5">
                    <div>
                        Pending: {pendingCount} · All: {$questions.length} ·
                        Inbox unreplied: {inboxUnreplied}
                    </div>
                    <div>
                        Latest question:{" "}
                        <span className="font-semibold text-foreground">
                            {latestQuestion()?.id ?? "—"}
                        </span>
                        {phase && (
                            <>
                                {" · phase: "}
                                <span className="font-semibold text-foreground">
                                    {phaseLabel(phase)}
                                </span>
                            </>
                        )}
                    </div>
                </div>

                <Section title={`Role · current: ${$role}`}>
                    <div className="grid grid-cols-2 gap-1.5">
                        <DebugButton
                            onClick={() => forceRole("seeker")}
                            variant={
                                $role === "seeker" ? "primary" : "default"
                            }
                        >
                            → Seeker
                        </DebugButton>
                        <DebugButton
                            onClick={() => forceRole("hider")}
                            variant={
                                $role === "hider" ? "primary" : "default"
                            }
                        >
                            → Hider
                        </DebugButton>
                    </div>
                    <p className="text-[10px] text-muted-foreground italic px-1">
                        Bypasses the production role lock. Resets the
                        route to `/` or `/h` to match.
                    </p>
                </Section>

                <Section title="Add">
                    <DebugButton onClick={addRadarQuestion}>
                        Add radar question
                    </DebugButton>
                    <p className="text-[10px] text-muted-foreground italic px-1">
                        For matching / measuring etc., add via the
                        normal UI. The phase buttons below operate on
                        whichever question was most recently added.
                    </p>
                </Section>

                <Section title="Set phase (latest question)">
                    <PhaseButton
                        label="Not sent"
                        active={phase === "not-sent"}
                        disabled={!hasLatest}
                        onClick={() => setPhase("not-sent")}
                    />
                    <PhaseButton
                        label="Waiting for answer"
                        active={phase === "waiting"}
                        disabled={!hasLatest}
                        onClick={() => setPhase("waiting")}
                    />
                    <PhaseButton
                        label="Overdue"
                        active={phase === "overdue"}
                        disabled={!hasLatest}
                        onClick={() => setPhase("overdue")}
                    />
                    <PhaseButton
                        label={`Answered · ${answerLabels.positive}`}
                        active={phase === "answered-yes"}
                        disabled={!hasLatest}
                        onClick={() => setPhase("answered-yes")}
                        accent="primary"
                    />
                    <PhaseButton
                        label={`Answered · ${answerLabels.negative}`}
                        active={phase === "answered-yes"} // visually grouped — see currentPhase()
                        disabled={!hasLatest}
                        onClick={() => setPhase("answered-no")}
                        accent="primary"
                    />
                </Section>

                <Section title="Hider side">
                    <DebugButton
                        onClick={openLatestAsHider}
                        disabled={!hasLatest}
                        variant="primary"
                    >
                        Open latest question as hider →
                    </DebugButton>
                    <DebugButton onClick={injectInboxQuestion}>
                        Inject test question to inbox
                    </DebugButton>
                    <DebugButton onClick={markLatestInboxReplied}>
                        Mark latest inbox replied
                    </DebugButton>
                    <DebugButton onClick={unreplyLatestInbox}>
                        Un-reply latest inbox
                    </DebugButton>
                    <DebugButton onClick={clearInbox} variant="danger">
                        Clear inbox
                    </DebugButton>

                    {/* Hand-card injection — pulls from a freshly
                        shuffled full deck so the kind distribution
                        matches the real deck. Useful for stacking
                        the hand to test the grid layout, the cast
                        flow, the casting-cost UIs, etc. */}
                    <DebugButton onClick={() => drawRandomCard()}>
                        Add random card to hand
                    </DebugButton>
                    <div className="grid grid-cols-3 gap-1.5">
                        <DebugButton
                            onClick={() => drawRandomCard("time-bonus")}
                        >
                            + Time bonus
                        </DebugButton>
                        <DebugButton
                            onClick={() => drawRandomCard("powerup")}
                        >
                            + Powerup
                        </DebugButton>
                        <DebugButton
                            onClick={() => drawRandomCard("curse")}
                        >
                            + Curse
                        </DebugButton>
                    </div>
                    {/* Specifically pick a curse that requires a
                        die-roll pre-cast — quick way to smoke-test
                        the dice tumble, confetti, and fizzle
                        effects without rolling the random "+ Curse"
                        button until one happens to land. */}
                    <DebugButton
                        onClick={drawRandomRollableCurse}
                        variant="primary"
                    >
                        + Curse with die-roll cost
                    </DebugButton>
                </Section>

                <DebugButton onClick={resetQuestions} variant="danger">
                    Reset · clear all questions
                </DebugButton>

                <p className="text-[10px] text-muted-foreground leading-snug italic pt-1 border-t border-border">
                    Temporary widget for testing the question lifecycle.
                    Remove via `DebugPhaseControls` before release.
                </p>
            </div>
        </div>
    );

    return createPortal(content, document.body);
}

function phaseLabel(p: Phase): string {
    switch (p) {
        case "not-sent":
            return "Not sent";
        case "waiting":
            return "Waiting";
        case "overdue":
            return "Overdue";
        case "answered-yes":
        case "answered-no":
            return "Answered";
    }
}

function Section({
    title,
    children,
}: {
    title: string;
    children: React.ReactNode;
}) {
    return (
        <div>
            <div className="text-[10px] uppercase tracking-[0.16em] font-poppins font-bold text-muted-foreground mb-1.5">
                {title}
            </div>
            <div className="flex flex-col gap-1.5">{children}</div>
        </div>
    );
}

function DebugButton({
    onClick,
    children,
    variant = "default",
    disabled,
}: {
    onClick: () => void;
    children: React.ReactNode;
    variant?: "default" | "primary" | "danger";
    disabled?: boolean;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className={cn(
                "w-full text-left px-2.5 py-1.5 rounded-sm border border-border",
                "text-xs font-poppins font-medium",
                "transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300",
                "disabled:opacity-40 disabled:cursor-not-allowed",
                variant === "default" && "bg-secondary hover:bg-accent",
                variant === "primary" &&
                    "bg-primary/15 hover:bg-primary/25 text-primary border-primary/40",
                variant === "danger" &&
                    "bg-destructive/15 hover:bg-destructive/25 text-destructive border-destructive/40",
            )}
        >
            {children}
        </button>
    );
}

/**
 * Phase setter button. Highlights when the latest question is currently
 * in this phase so the user can see "you are here" at a glance and can
 * still click to no-op-confirm or apply elsewhere.
 */
function PhaseButton({
    label,
    onClick,
    active,
    disabled,
    accent = "default",
}: {
    label: string;
    onClick: () => void;
    active?: boolean;
    disabled?: boolean;
    accent?: "default" | "primary";
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            aria-pressed={active}
            className={cn(
                "w-full text-left px-2.5 py-1.5 rounded-sm border",
                "text-xs font-poppins font-medium",
                "transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300",
                "disabled:opacity-40 disabled:cursor-not-allowed",
                active
                    ? "bg-amber-500/20 border-amber-500 text-amber-200 font-semibold"
                    : accent === "primary"
                      ? "bg-primary/10 hover:bg-primary/20 text-primary border-primary/30"
                      : "bg-secondary hover:bg-accent border-border",
            )}
        >
            <span className="flex items-center gap-2">
                {active && (
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400" />
                )}
                {label}
            </span>
        </button>
    );
}

export default DebugPhaseControls;
