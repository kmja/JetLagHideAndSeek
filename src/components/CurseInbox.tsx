import { useStore } from "@nanostores/react";
import { Check, Hourglass, Skull, X, Zap } from "lucide-react";
import { useEffect, useState } from "react";

import { useNow } from "@/hooks/useNow";
import {
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
import { type ReceivedCurse,receivedCurses } from "@/lib/seekerInbound";
import { cn } from "@/lib/utils";

import { DiceRoller } from "./DiceRoller";
import { SectionPill } from "./JetLagLogo";

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
export function CurseInbox() {
    const $curses = useStore(receivedCurses);
    const $gameSize = useStore(gameSize);
    const [dialogCurse, setDialogCurse] = useState<ReceivedCurse | null>(null);

    const unack = $curses.filter((c) => !c.acknowledged);
    const active = $curses.filter((c) => c.acknowledged && !c.dismissed);

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
        receivedCurses.set(
            receivedCurses
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
        receivedCurses.set(
            receivedCurses
                .get()
                .map((c) =>
                    c.receivedAt === receivedAt
                        ? { ...c, acknowledged: true }
                        : c,
                ),
        );
    };

    const dismiss = (receivedAt: number) => {
        receivedCurses.set(
            receivedCurses
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
                        // Clear the top-right map-controls cluster
                        // (MapDisplayControls + trip launcher) below the
                        // mobile top bar / desktop top edge.
                        "top-[124px] md:top-[80px]",
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
                                    {curse.description}
                                </p>
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
                            {resolvedDialog?.description}
                        </p>
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

                    {/* Dice only for curses that actually make the seekers
                        roll. */}
                    {dlgMeta?.requiresDice && <DiceRoller />}

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
