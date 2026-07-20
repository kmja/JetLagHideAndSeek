import { useStore } from "@nanostores/react";
import { Ban, Check, Hourglass, Skull, Train, X, Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useNow } from "@/hooks/useNow";
import { CATEGORIES, type CategoryId } from "@/lib/categories";
import { pendingOverlayActive, questions, topOverlayTall } from "@/lib/context";
import {
    CURSE_DRAINED_BRAIN,
    CURSE_SPOTTY_MEMORY,
    CURSE_URBAN_EXPLORER,
    seekerOnTransit,
    spottyCategoryForRoll,
    spottyMemoryCategory,
} from "@/lib/curseEnforcement";
import {
    curseDiceCount,
    curseDurationMs,
    curseRequiresDice,
    formatCurseCountdown,
} from "@/lib/curseMeta";
import { gameSize } from "@/lib/gameSetup";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { type ReceivedCurse, receivedCurses } from "@/lib/seekerInbound";
import { cn } from "@/lib/utils";
import type { WritableAtom } from "nanostores";
import { toast } from "react-toastify";

import { renderBodyText } from "./CardTile";
import { DiceRoller } from "./DiceRoller";
import { SectionPill } from "./JetLagLogo";

/**
 * App-enforced curses that last "for the rest of your run" — the seeker
 * can't manually clear them (that would just drop the enforcement); they
 * lift at round end when `receivedCurses` is wiped.
 */
const ENFORCED_REST_OF_RUN = new Set<string>([
    CURSE_DRAINED_BRAIN,
    CURSE_SPOTTY_MEMORY,
    CURSE_URBAN_EXPLORER,
]);

/** mm:ss (or h:mm:ss) from a whole-second film-duration target. */
function formatFilmTarget(totalSeconds: number): string {
    const s = Math.max(0, Math.floor(totalSeconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const pad = (n: number) => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/**
 * Two-part curse UI for the seeker:
 *
 * 1. Notification banners (unacknowledged) — full card with curse text.
 *    Tapping the card opens the dice dialog; "I understand" acknowledges.
 *
 * 2. Compact active-curse pill (acknowledged, not dismissed) — stays on
 *    the map so the seeker can roll dice at any time while under the curse.
 *    "Curse expired" removes it.
 *
 * The dice dialog is shared between both entry points.
 */
/**
 * @param source - which curse atom to render. Defaults to the seeker's
 *   `receivedCurses`; the HIDER passes `castCurses` (v946) to see the active
 *   curses they've cast rendered EXACTLY like the seeker's inbox — same pills,
 *   cards, dice, and countdowns (the "reuse the whole code" ask). Both atoms
 *   share the `ReceivedCurse[]` shape, so the whole component works unchanged.
 */
export function CurseInbox({
    source = receivedCurses,
}: {
    source?: WritableAtom<ReceivedCurse[]>;
} = {}) {
    const $curses = useStore(source);
    const $gameSize = useStore(gameSize);
    const $onTransit = useStore(seekerOnTransit);
    const $spottyCategory = useStore(spottyMemoryCategory);
    const $questions = useStore(questions);
    // When the top-center question overlay (pending / answered card, or the
    // thermometer tracker) is showing, push the top-right curse pills down
    // so the two don't overlap.
    const $pendingOverlay = useStore(pendingOverlayActive);
    const $tallOverlay = useStore(topOverlayTall);
    const [dialogCurse, setDialogCurse] = useState<ReceivedCurse | null>(null);

    const unack = $curses.filter((c) => !c.acknowledged);
    const active = $curses.filter((c) => c.acknowledged && !c.dismissed);

    // Spotty Memory re-rolls each question: the disabled category holds
    // until the seekers ask their next question, then they must roll
    // again. Detect a new question by watching the seeker question count
    // and clear the rolled category so the curse card forces a fresh roll.
    const spottyActive = $curses.some(
        (c) => !c.dismissed && c.name === CURSE_SPOTTY_MEMORY,
    );
    const prevQCountRef = useRef($questions.length);
    useEffect(() => {
        const grew = $questions.length > prevQCountRef.current;
        prevQCountRef.current = $questions.length;
        if (grew && spottyActive && spottyMemoryCategory.get() != null) {
            spottyMemoryCategory.set(null);
        }
    }, [$questions.length, spottyActive]);

    // When Spotty Memory clears entirely, drop any lingering rolled
    // category so it doesn't leak into a later curse.
    useEffect(() => {
        if (!spottyActive && spottyMemoryCategory.get() != null) {
            spottyMemoryCategory.set(null);
        }
    }, [spottyActive]);

    // Per-curse derived metadata (memo-free; cheap string ops).
    const meta = (c: ReceivedCurse) => {
        const durationMs = curseDurationMs(c, $gameSize);
        return {
            requiresDice: curseRequiresDice(c),
            durationMs,
            expiresAt: durationMs != null ? c.receivedAt + durationMs : null,
        };
    };

    // 1 Hz tick to drive the countdowns + auto-clear. Only ticks while
    // there's a live timed curse to watch (visibility-aware).
    const anyTimed = $curses.some(
        (c) => !c.dismissed && meta(c).expiresAt != null,
    );
    const now = useNow(anyTimed);

    // Auto-clear time-limited curses the moment their timer runs out — a
    // duration curse ("for the next N minutes") shouldn't linger needing a
    // manual dismiss. Marks them dismissed (same as the manual clear).
    useEffect(() => {
        const expired = $curses.filter((c) => {
            if (c.dismissed) return false;
            const e = meta(c).expiresAt;
            return e != null && now >= e;
        });
        if (expired.length === 0) return;
        const ids = new Set(expired.map((c) => c.receivedAt));
        source.set(
            source
                .get()
                .map((c) =>
                    ids.has(c.receivedAt)
                        ? { ...c, acknowledged: true, dismissed: true }
                        : c,
                ),
        );
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [now, $curses, $gameSize]);

    if (unack.length === 0 && active.length === 0) return null;

    const acknowledge = (receivedAt: number) => {
        source.set(
            source
                .get()
                .map((c) =>
                    c.receivedAt === receivedAt
                        ? { ...c, acknowledged: true }
                        : c,
                ),
        );
    };

    const dismiss = (receivedAt: number) => {
        source.set(
            source
                .get()
                .map((c) =>
                    c.receivedAt === receivedAt
                        ? { ...c, dismissed: true }
                        : c,
                ),
        );
        setDialogCurse(null);
    };

    // Keep dialog in sync with the live atom (e.g. acknowledged state may
    // change while the dialog is open).
    const resolvedDialog = dialogCurse
        ? ($curses.find((c) => c.receivedAt === dialogCurse.receivedAt) ?? null)
        : null;
    const dlgMeta = resolvedDialog ? meta(resolvedDialog) : null;

    return (
        <>
            {/* ── Active curses — top-right stack of purple pills, like
                the Jet Lag show. Each pill is its own curse (no longer
                collapsed into a count); tapping opens the dice dialog.
                Shown independently of any pending notification banner. */}
            {active.length > 0 && (
                <div
                    className={cn(
                        "fixed right-2 md:right-4 z-[1042]",
                        // v622: the top-right cluster (map-options chip +
                        // trip launcher) is gone, so the pills only need to
                        // clear the mobile top bar now — snug under it,
                        // near the top edge on desktop (no header there).
                        // v623: when the top-center question overlay is up,
                        // drop the pills below it so they don't overlap.
                        "transition-[top] duration-300 ease-out",
                        // v946: the thermometer tracker is much taller than the
                        // pending-answer card, so clear it with a bigger dodge.
                        $tallOverlay
                            ? "top-[calc(env(safe-area-inset-top)_+_310px)] md:top-[300px]"
                            : $pendingOverlay
                              ? "top-[calc(env(safe-area-inset-top)_+_150px)] md:top-[104px]"
                              : "top-[calc(env(safe-area-inset-top)_+_62px)] md:top-3",
                        "flex flex-col items-end gap-2",
                    )}
                    role="status"
                    aria-live="polite"
                >
                    {active.map((curse) => {
                        const m = meta(curse);
                        const remaining =
                            m.expiresAt != null
                                ? formatCurseCountdown(m.expiresAt - now)
                                : null;
                        return (
                            <button
                                key={curse.receivedAt}
                                type="button"
                                onClick={() => setDialogCurse(curse)}
                                aria-label={`Active curse: ${curse.name}. Tap for details.`}
                                title={`${curse.name} — tap for details`}
                                className={cn(
                                    "flex items-center gap-2.5 max-w-[220px]",
                                    "rounded-lg pl-3 pr-2.5 py-2 shadow-lg",
                                    "bg-[#5b4f96] hover:bg-[#6a5dab] transition-colors",
                                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70",
                                )}
                            >
                                <span className="min-w-0 flex flex-col text-left">
                                    <span className="min-w-0 font-inter-tight font-black uppercase tracking-tight text-xs leading-tight text-white truncate">
                                        {curse.name}
                                    </span>
                                    {remaining && (
                                        <span className="text-[10px] tabular-nums text-white/75 leading-none mt-0.5">
                                            {remaining} left
                                        </span>
                                    )}
                                </span>
                                <Skull
                                    className="w-5 h-5 text-white shrink-0"
                                    strokeWidth={2.25}
                                />
                            </button>
                        );
                    })}
                </div>
            )}

            <div
                className={cn(
                    "fixed inset-x-2 z-[1042]",
                    "bottom-[calc(80px+env(safe-area-inset-bottom))] md:bottom-4",
                    "max-w-md mx-auto",
                )}
                role="alert"
                aria-live="assertive"
            >
                {/* ── Unacknowledged notification banners ── */}
                {unack.map((curse, idx) => (
                    <button
                        key={curse.receivedAt}
                        type="button"
                        onClick={() => setDialogCurse(curse)}
                        className={cn(
                            "w-full text-left",
                            "rounded-md border-2 border-purple-500/60 bg-background/95 backdrop-blur-md shadow-xl",
                            "p-3 mb-2",
                            "hover:border-purple-400 transition-colors",
                            idx > 0 && "scale-[0.98] -mt-1",
                        )}
                    >
                        <div className="flex items-start gap-2.5">
                            <span
                                className="inline-flex items-center justify-center w-8 h-8 rounded-sm shrink-0"
                                style={{ background: "rgb(126 34 206)" }}
                                aria-hidden="true"
                            >
                                <Zap
                                    className="w-4 h-4 text-white"
                                    strokeWidth={2.5}
                                />
                            </span>
                            <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2 mb-1">
                                    <SectionPill className="bg-purple-500/15 text-purple-300">
                                        Curse received
                                    </SectionPill>
                                </div>
                                <div className="font-inter-tight font-black uppercase tracking-tight text-sm leading-tight">
                                    {curse.name}
                                </div>
                                <p className="text-xs text-foreground/80 mt-1 leading-snug">
                                    {renderBodyText(curse.description, $gameSize)}
                                </p>
                                {curse.photoUrl && (
                                    <img
                                        src={curse.photoUrl}
                                        alt={`${curse.name} proof photo`}
                                        className="mt-2 w-full max-h-40 rounded-md object-contain bg-black/20 border border-purple-500/30"
                                    />
                                )}
                                {curse.filmSeconds != null && (
                                    <p className="text-[11px] text-purple-300 mt-1 leading-snug font-semibold tabular-nums">
                                        Film a bird for at least{" "}
                                        {formatFilmTarget(curse.filmSeconds)}.
                                    </p>
                                )}
                                {curse.rockCount != null && (
                                    <p className="text-[11px] text-purple-300 mt-1 leading-snug font-semibold tabular-nums">
                                        Build a rock tower {curse.rockCount}{" "}
                                        rock{curse.rockCount === 1 ? "" : "s"}{" "}
                                        high.
                                    </p>
                                )}
                                {curse.travelDestination && (
                                    <p className="text-[11px] text-purple-300 mt-1 leading-snug font-semibold">
                                        Destination: {curse.travelDestination}
                                    </p>
                                )}
                                {/* Casting cost is the hider's concern, not
                                    the seeker's — omitted. Timed curses show
                                    a live "clears in" countdown instead. */}
                                {(() => {
                                    const e = meta(curse).expiresAt;
                                    if (e == null) return null;
                                    return (
                                        <p className="text-[11px] text-purple-300 mt-1 leading-snug inline-flex items-center gap-1 tabular-nums">
                                            <Hourglass className="w-3 h-3" />
                                            Clears in{" "}
                                            {formatCurseCountdown(e - now)}
                                        </p>
                                    );
                                })()}
                            </div>
                            <button
                                type="button"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    acknowledge(curse.receivedAt);
                                }}
                                aria-label="Dismiss notification"
                                className={cn(
                                    "shrink-0 w-6 h-6 flex items-center justify-center",
                                    "rounded-md text-muted-foreground",
                                    "hover:bg-accent hover:text-foreground transition-colors",
                                )}
                            >
                                <X className="w-3.5 h-3.5" />
                            </button>
                        </div>
                        <div className="flex items-center justify-between mt-2 gap-2">
                            <span className="text-[11px] text-purple-400/70 italic">
                                {meta(curse).requiresDice
                                    ? "Tap card to roll dice"
                                    : "Tap card for details"}
                            </span>
                            <Button
                                type="button"
                                size="sm"
                                variant="default"
                                className="gap-1.5 h-7 px-2.5 text-[11px]"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    acknowledge(curse.receivedAt);
                                }}
                            >
                                <Check className="w-3 h-3" />
                                I understand
                            </Button>
                        </div>
                    </button>
                ))}
            </div>

            {/* ── Dice dialog (shared between banners and compact pill) ── */}
            <Dialog
                open={resolvedDialog !== null}
                onOpenChange={(open) => {
                    if (!open) setDialogCurse(null);
                }}
            >
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <Zap className="w-4 h-4 text-purple-400 shrink-0" />
                            {resolvedDialog?.name}
                        </DialogTitle>
                    </DialogHeader>

                    {/* Curse description (no casting cost — that's the
                        hider's concern). Timed curses show a live "clears
                        in" countdown. */}
                    <div className="space-y-1.5">
                        <p className="text-sm text-foreground/80 leading-snug">
                            {resolvedDialog
                                ? renderBodyText(
                                      resolvedDialog.description,
                                      $gameSize,
                                  )
                                : null}
                        </p>
                        {resolvedDialog?.photoUrl && (
                            <img
                                src={resolvedDialog.photoUrl}
                                alt={`${resolvedDialog.name} proof photo`}
                                className="w-full max-h-60 rounded-md object-contain bg-black/20 border border-purple-500/30"
                            />
                        )}
                        {resolvedDialog?.filmSeconds != null && (
                            <p className="text-sm text-purple-300 font-semibold tabular-nums">
                                Film a bird for at least{" "}
                                {formatFilmTarget(resolvedDialog.filmSeconds)}{" "}
                                before asking your next question.
                            </p>
                        )}
                        {resolvedDialog?.rockCount != null && (
                            <p className="text-sm text-purple-300 font-semibold tabular-nums">
                                Build a rock tower {resolvedDialog.rockCount}{" "}
                                rock{resolvedDialog.rockCount === 1 ? "" : "s"}{" "}
                                high before asking your next question.
                            </p>
                        )}
                        {resolvedDialog?.travelDestination && (
                            <p className="text-sm text-purple-300 font-semibold">
                                Destination: {resolvedDialog.travelDestination}
                            </p>
                        )}
                        {dlgMeta?.expiresAt != null && (
                            <p className="text-xs text-purple-300 inline-flex items-center gap-1 tabular-nums">
                                <Hourglass className="w-3 h-3" />
                                Clears automatically in{" "}
                                {formatCurseCountdown(dlgMeta.expiresAt - now)}
                            </p>
                        )}
                    </div>

                    {/* If multiple active curses exist, show the others too */}
                    {active.length > 1 && (
                        <div className="space-y-1">
                            {active
                                .filter(
                                    (c) =>
                                        c.receivedAt !==
                                        resolvedDialog?.receivedAt,
                                )
                                .map((c) => (
                                    <button
                                        key={c.receivedAt}
                                        type="button"
                                        onClick={() => setDialogCurse(c)}
                                        className={cn(
                                            "w-full text-left px-2.5 py-1.5 rounded-md border border-purple-500/30",
                                            "text-xs text-purple-300 hover:bg-purple-500/10 transition-colors",
                                        )}
                                    >
                                        <span className="font-semibold">
                                            {c.name}
                                        </span>
                                        <span className="text-muted-foreground ml-1.5">
                                            — tap to switch
                                        </span>
                                    </button>
                                ))}
                        </div>
                    )}

                    {/* ── Enforced-curse controls ──
                        Spotty Memory rolls a d6 → disabled category;
                        Urban Explorer toggles the on-transit block;
                        Drained Brain shows its locked-out categories.
                        Other dice curses get the plain roller. */}
                    {resolvedDialog?.name === CURSE_SPOTTY_MEMORY ? (
                        <div className="space-y-2">
                            <DiceRoller
                                onSettle={(v) => {
                                    // v969 (rulebook audit A7): Small games
                                    // have five categories — a 6 is a reroll
                                    // (rulebook p397), never "tentacles".
                                    const cat = spottyCategoryForRoll(
                                        v,
                                        $gameSize,
                                    );
                                    if (cat === null) {
                                        toast.info(
                                            "Rolled a 6 — small games have five categories. Reroll!",
                                            { autoClose: 3500 },
                                        );
                                        return;
                                    }
                                    spottyMemoryCategory.set(cat);
                                }}
                            />
                            <div className="rounded-sm border border-purple-500/40 bg-purple-500/5 px-2.5 py-2 text-xs leading-snug">
                                {$spottyCategory ? (
                                    <span className="inline-flex items-center gap-1.5">
                                        <Ban className="w-3.5 h-3.5 text-purple-300 shrink-0" />
                                        <span>
                                            Disabled now:{" "}
                                            <span className="font-bold">
                                                {
                                                    CATEGORIES[$spottyCategory]
                                                        .label
                                                }
                                            </span>
                                            . You&apos;ll re-roll after your
                                            next question.
                                        </span>
                                    </span>
                                ) : (
                                    "Roll the die to see which category is disabled for your next question. You can't ask until you roll."
                                )}
                            </div>
                        </div>
                    ) : resolvedDialog?.name === CURSE_URBAN_EXPLORER ? (
                        <button
                            type="button"
                            onClick={() => seekerOnTransit.set(!$onTransit)}
                            aria-pressed={$onTransit}
                            className={cn(
                                "w-full rounded-sm border-2 px-3 py-2.5 flex items-center gap-2.5 text-left transition-colors",
                                $onTransit
                                    ? "border-purple-400 bg-purple-500/20"
                                    : "border-border bg-background/40 hover:border-purple-500/50",
                            )}
                        >
                            <Train
                                className={cn(
                                    "w-4 h-4 shrink-0",
                                    $onTransit
                                        ? "text-purple-200"
                                        : "text-muted-foreground",
                                )}
                            />
                            <span className="flex-1 min-w-0">
                                <span className="block text-xs font-semibold">
                                    {$onTransit
                                        ? "On transit — questions blocked"
                                        : "I'm on transit / in a station"}
                                </span>
                                <span className="block text-[11px] text-muted-foreground leading-snug">
                                    Turn this on while you&apos;re on transit
                                    or in a station — asking is blocked until
                                    you turn it off.
                                </span>
                            </span>
                            <span
                                className={cn(
                                    "shrink-0 w-9 h-5 rounded-full transition-colors relative",
                                    $onTransit
                                        ? "bg-purple-400"
                                        : "bg-muted-foreground/40",
                                )}
                            >
                                <span
                                    className={cn(
                                        "absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all",
                                        $onTransit ? "left-[18px]" : "left-0.5",
                                    )}
                                />
                            </span>
                        </button>
                    ) : resolvedDialog?.name === CURSE_DRAINED_BRAIN &&
                      resolvedDialog.disabledCategories &&
                      resolvedDialog.disabledCategories.length > 0 ? (
                        <div className="rounded-sm border border-purple-500/40 bg-purple-500/5 px-2.5 py-2">
                            <div className="text-[10px] uppercase tracking-[0.16em] font-poppins font-bold text-purple-300 mb-1.5">
                                Disabled for the rest of the run
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                                {resolvedDialog.disabledCategories.map((id) => {
                                    const meta =
                                        CATEGORIES[id as CategoryId];
                                    if (!meta) return null;
                                    const Icon = meta.icon;
                                    return (
                                        <span
                                            key={id}
                                            className="inline-flex items-center gap-1.5 rounded-full border border-purple-500/40 px-2.5 py-1 text-[11px] font-semibold"
                                        >
                                            <span
                                                className="inline-flex items-center justify-center w-4 h-4 rounded-sm shrink-0"
                                                style={{
                                                    backgroundColor:
                                                        meta.color,
                                                }}
                                                aria-hidden="true"
                                            >
                                                <Icon
                                                    size={10}
                                                    strokeWidth={2.5}
                                                    className="text-white"
                                                />
                                            </span>
                                            {meta.label}
                                        </span>
                                    );
                                })}
                            </div>
                        </div>
                    ) : dlgMeta?.requiresDice && resolvedDialog ? (
                        // v970: Jammed Door rolls TWO d6 per doorway
                        // (rulebook p396); other dice curses roll one.
                        <DiceRoller count={curseDiceCount(resolvedDialog)} />
                    ) : null}

                    <div className="flex gap-2">
                        {resolvedDialog && !resolvedDialog.acknowledged ? (
                            <Button
                                variant="outline"
                                className="flex-1 gap-1.5"
                                onClick={() => {
                                    acknowledge(resolvedDialog.receivedAt);
                                    setDialogCurse(null);
                                }}
                            >
                                <Check className="w-4 h-4" />
                                I understand
                            </Button>
                        ) : dlgMeta?.expiresAt != null ? (
                            // Timed curse: clears itself, no manual action
                            // needed — show the countdown instead of a
                            // clear button.
                            <div className="flex-1 flex items-center justify-center gap-1.5 text-sm text-purple-300 tabular-nums">
                                <Hourglass className="w-4 h-4" />
                                Clears in{" "}
                                {formatCurseCountdown(dlgMeta.expiresAt - now)}
                            </div>
                        ) : resolvedDialog &&
                          ENFORCED_REST_OF_RUN.has(resolvedDialog.name) ? (
                            // App-enforced "rest of your run" curses (Drained
                            // Brain / Spotty Memory / Urban Explorer): NOT
                            // manually clearable — clearing would just remove
                            // the enforcement. They lift automatically at
                            // round end (receivedCurses is wiped).
                            <div className="flex-1 flex items-center justify-center gap-1.5 text-xs text-muted-foreground leading-snug text-center">
                                Active for the rest of the run — lifts when the
                                round ends.
                            </div>
                        ) : (
                            // Open-ended curse: cleared by doing the task in
                            // the real world — trust the seekers' word.
                            <Button
                                variant="outline"
                                className="flex-1 gap-1.5"
                                onClick={() =>
                                    dismiss(resolvedDialog!.receivedAt)
                                }
                            >
                                <Check className="w-4 h-4" />
                                Clear curse
                            </Button>
                        )}
                        <Button
                            variant="ghost"
                            onClick={() => setDialogCurse(null)}
                        >
                            Close
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>
        </>
    );
}

export default CurseInbox;
