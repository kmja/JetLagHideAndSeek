import { useStore } from "@nanostores/react";
import { Check, Dice5, X, Zap } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { receivedCurses, type ReceivedCurse } from "@/lib/seekerInbound";
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
    const [dialogCurse, setDialogCurse] = useState<ReceivedCurse | null>(null);

    const unack = $curses.filter((c) => !c.acknowledged);
    const active = $curses.filter((c) => c.acknowledged && !c.dismissed);

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

    return (
        <>
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
                                {curse.castingCost && (
                                    <p className="text-[11px] text-muted-foreground mt-1 leading-snug italic">
                                        Casting cost: {curse.castingCost}
                                    </p>
                                )}
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
                                Tap card to roll dice
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

                {/* ── Compact active-curse pill (acknowledged, not dismissed) ── */}
                {unack.length === 0 && active.length > 0 && (
                    <button
                        type="button"
                        onClick={() => setDialogCurse(active[0])}
                        className={cn(
                            "w-full flex items-center gap-2.5",
                            "rounded-md border border-purple-500/40 bg-background/90 backdrop-blur-md shadow-lg",
                            "px-3 py-2",
                            "hover:border-purple-400 transition-colors",
                        )}
                        aria-label={
                            active.length === 1
                                ? `Active curse: ${active[0].name}. Tap to roll dice.`
                                : `${active.length} active curses. Tap to roll dice.`
                        }
                    >
                        <span
                            className="inline-flex items-center justify-center w-6 h-6 rounded-sm shrink-0"
                            style={{ background: "rgb(126 34 206)" }}
                            aria-hidden="true"
                        >
                            <Zap
                                className="w-3 h-3 text-white"
                                strokeWidth={2.5}
                            />
                        </span>
                        <div className="min-w-0 flex-1 text-left">
                            <div className="text-[11px] font-poppins font-semibold text-purple-300 truncate">
                                {active.length === 1
                                    ? active[0].name
                                    : `${active.length} active curses`}
                            </div>
                            <div className="text-[10px] text-muted-foreground">
                                Tap to roll dice
                            </div>
                        </div>
                        <Dice5 className="w-4 h-4 text-purple-400 shrink-0" />
                    </button>
                )}
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

                    {/* Curse description */}
                    <div className="space-y-1.5">
                        <p className="text-sm text-foreground/80 leading-snug">
                            {resolvedDialog?.description}
                        </p>
                        {resolvedDialog?.castingCost && (
                            <p className="text-xs text-muted-foreground italic">
                                Casting cost: {resolvedDialog.castingCost}
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

                    <DiceRoller />

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
                        ) : (
                            <Button
                                variant="outline"
                                className="flex-1 text-muted-foreground"
                                onClick={() =>
                                    dismiss(resolvedDialog!.receivedAt)
                                }
                            >
                                Curse expired
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
