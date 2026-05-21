import { Dice5, Share2, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "react-toastify";

import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogTitle,
} from "@/components/ui/dialog";
import { discardCard } from "@/lib/hiderRole";
import type { CurseCard } from "@/lib/hiderDeck";
import { encodeCurseLink, shareOrCopy } from "@/lib/shareLinks";
import { cn } from "@/lib/utils";

/**
 * Confirm-and-cast dialog for curses. Surfaces:
 *
 *   • Casting cost — the printed condition the hider must satisfy
 *     (carry an egg, photograph an animal, etc.). Reading it once
 *     here means the hider can't miss it.
 *
 *   • Inline dice roller when the casting cost involves rolling a
 *     die that can fizzle the curse outright (Endless Tumble fizzles
 *     on 5/6; Gambler's Feet fizzles on even). The roller has the
 *     primary "Cast" button gated until the roll has happened, and
 *     swaps the success message when the curse auto-fizzles.
 *
 *   • The "Cast on seekers" action — shares the curse via
 *     `encodeCurseLink` so the seekers can tap to receive it, then
 *     moves the card to discard regardless of share outcome (since
 *     casting cost has already been paid by the hider).
 *
 * Falls through silently for curses with no special pre-cast roll —
 * the dialog still surfaces the cost but skips the dice widget.
 */

/**
 * Per-card fizzle rules. Each entry maps the curse name to:
 *   - a brief explainer of the dice mechanic
 *   - the set of die-roll values that *fizzle* (no effect, card still
 *     spent — the curse is wasted)
 */
const DICE_FIZZLE: Record<
    string,
    { fizzleOn: number[]; explainer: string } | undefined
> = {
    "Curse of the Endless Tumble": {
        fizzleOn: [5, 6],
        explainer: "Roll a die. On 5 or 6 the curse has no effect.",
    },
    "Curse of the Gambler's Feet": {
        fizzleOn: [2, 4, 6],
        explainer: "Roll a die. On an even number the curse has no effect.",
    },
};

export function CastCurseDialog({
    open,
    onOpenChange,
    card,
}: {
    open: boolean;
    onOpenChange: (o: boolean) => void;
    card: CurseCard | null;
}) {
    const fizzleRule = card ? DICE_FIZZLE[card.name] : undefined;
    const [rolled, setRolled] = useState<number | null>(null);
    const [rolling, setRolling] = useState(false);
    const [sharing, setSharing] = useState(false);

    useEffect(() => {
        if (open) {
            setRolled(null);
            setRolling(false);
            setSharing(false);
        }
    }, [open, card?.id]);

    if (!card) return null;

    const fizzles =
        fizzleRule !== undefined &&
        rolled !== null &&
        fizzleRule.fizzleOn.includes(rolled);

    const canCast =
        !sharing &&
        // Cards with a fizzle rule must be rolled first; cards without
        // can cast right away.
        (fizzleRule === undefined || rolled !== null);

    const roll = () => {
        if (rolling) return;
        setRolling(true);
        const start = Date.now();
        const tick = () => {
            const elapsed = Date.now() - start;
            setRolled(1 + Math.floor(Math.random() * 6));
            if (elapsed < 450) {
                window.setTimeout(tick, 60);
            } else {
                setRolling(false);
            }
        };
        tick();
    };

    const cast = async () => {
        if (!canCast) return;

        // Fizzled curse: spend the card without sharing.
        if (fizzles) {
            discardCard(card.id);
            toast.info(
                `${card.name} fizzled on a ${rolled}. Card moved to discard.`,
                { autoClose: 3000 },
            );
            onOpenChange(false);
            return;
        }

        setSharing(true);
        try {
            const url = encodeCurseLink({
                name: card.name,
                description: card.description,
                castingCost: card.castingCost ?? null,
            });
            const result = await shareOrCopy({
                title: `${card.name} cast on you`,
                text: `${card.name}: ${card.description}`,
                url,
            });
            if (result.method === "share" || result.method === "copy") {
                discardCard(card.id);
                toast.success(
                    `${card.name} sent. Curse moved to discard.`,
                    { autoClose: 2500 },
                );
                onOpenChange(false);
            } else if (result.method === "failed") {
                toast.error("Could not share the curse — try again.");
            }
            // "cancelled" → leave the dialog open so the hider can
            // retry. Their casting cost is still paid in real life.
        } finally {
            setSharing(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                className={cn(
                    "!bg-[hsl(var(--sidebar-background))] !text-white",
                    "flex flex-col p-0 gap-0",
                    "max-h-[85vh]",
                )}
            >
                <div className="px-6 pt-5 pb-3 shrink-0 border-b border-border flex items-start gap-3">
                    <span className="inline-flex items-center justify-center w-9 h-9 rounded shrink-0 bg-purple-500/20 mt-0.5">
                        <Zap className="w-4 h-4 text-purple-400" />
                    </span>
                    <div className="min-w-0 flex-1">
                        <div className="text-[10px] uppercase tracking-[0.16em] font-poppins font-bold text-muted-foreground">
                            Cast curse
                        </div>
                        <DialogTitle className="font-inter-tight font-black uppercase text-lg tracking-tight leading-tight mt-1">
                            {card.name}
                        </DialogTitle>
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto px-6 py-4 min-h-0 space-y-3 text-sm">
                    <DialogDescription className="text-sm leading-snug text-foreground/90">
                        {card.description}
                    </DialogDescription>

                    {card.castingCost && (
                        <div className="rounded-sm border-2 border-yellow-500/40 bg-yellow-500/5 px-3 py-2.5">
                            <div className="text-[10px] uppercase tracking-[0.16em] font-poppins font-bold text-yellow-500">
                                Casting cost
                            </div>
                            <p className="text-xs text-foreground/90 leading-snug mt-1">
                                {card.castingCost}
                            </p>
                        </div>
                    )}

                    {fizzleRule && (
                        <div className="rounded-sm border border-border bg-secondary/40 p-3 space-y-2">
                            <div className="text-[10px] uppercase tracking-[0.16em] font-poppins font-bold text-muted-foreground">
                                Pre-cast roll
                            </div>
                            <p className="text-xs text-muted-foreground leading-snug">
                                {fizzleRule.explainer}
                            </p>
                            <div className="flex items-center gap-3">
                                <button
                                    type="button"
                                    onClick={roll}
                                    disabled={rolling}
                                    aria-label="Roll d6"
                                    className={cn(
                                        "shrink-0 w-12 h-12 rounded-md",
                                        "bg-background border-2 border-primary",
                                        "flex items-center justify-center",
                                        "font-inter-tight italic font-black text-2xl tabular-nums text-primary",
                                        "transition-transform",
                                        rolling &&
                                            "animate-[jlDiceTumble_400ms_ease-out]",
                                        !rolling &&
                                            "hover:scale-[1.05] active:scale-95",
                                        "disabled:cursor-not-allowed",
                                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                    )}
                                >
                                    {rolled ?? <Dice5 className="w-5 h-5" />}
                                </button>
                                <div className="text-xs flex-1">
                                    {rolled === null ? (
                                        <span className="text-muted-foreground">
                                            Tap to roll.
                                        </span>
                                    ) : fizzles ? (
                                        <span className="text-destructive font-semibold">
                                            Curse fizzles. Card will move to
                                            discard without affecting the
                                            seekers.
                                        </span>
                                    ) : (
                                        <span className="text-emerald-400 font-semibold">
                                            Rolled {rolled}. Curse stands —
                                            cast away.
                                        </span>
                                    )}
                                </div>
                            </div>
                        </div>
                    )}
                </div>

                <DialogFooter className="px-6 py-4 shrink-0 border-t border-border gap-2 sm:gap-2 sm:justify-end">
                    <Button
                        variant="outline"
                        onClick={() => onOpenChange(false)}
                    >
                        Not now
                    </Button>
                    <Button
                        onClick={cast}
                        disabled={!canCast}
                        className={cn(
                            "gap-1.5",
                            fizzles && "bg-destructive hover:bg-destructive/90",
                        )}
                    >
                        {fizzles ? (
                            <>
                                <Zap className="w-4 h-4" />
                                Discard fizzled curse
                            </>
                        ) : (
                            <>
                                <Share2 className="w-4 h-4" />
                                Cast on seekers
                            </>
                        )}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

export default CastCurseDialog;
