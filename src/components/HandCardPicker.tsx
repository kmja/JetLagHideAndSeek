import { useStore } from "@nanostores/react";
import { Check, Plus, Sparkles, Zap } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogTitle,
} from "@/components/ui/dialog";
import { hiderHand } from "@/lib/hiderRole";
import type { Card } from "@/lib/hiderDeck";
import { cn } from "@/lib/utils";

/**
 * Reusable "pick N cards from your hand" modal. Used by powerup
 * resolution flows (Discard 1 Draw 2, Discard 2 Draw 3, Duplicate
 * Another Card) so the hider gets to actually choose rather than
 * being told what the engine picked for them.
 *
 * Selection is capped at `pickCount`; tapping a card past the cap
 * replaces the oldest pick (same pattern as DrawPickerDialog).
 * Confirm enables only when exactly `pickCount` cards are chosen.
 */
export function HandCardPicker({
    open,
    onOpenChange,
    title,
    description,
    pickCount,
    excludeIds,
    confirmLabel,
    onConfirm,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    description: string;
    pickCount: number;
    /** Card IDs to leave out of the picker (e.g. the powerup card
     *  itself shouldn't appear in its own discard-2 picker). */
    excludeIds: string[];
    confirmLabel: string;
    onConfirm: (ids: string[]) => void;
}) {
    const $hand = useStore(hiderHand);
    const [selected, setSelected] = useState<string[]>([]);

    // Reset selection whenever the dialog opens fresh or the picker's
    // target count changes.
    useEffect(() => {
        if (open) setSelected([]);
    }, [open, pickCount]);

    const candidates = $hand.filter((c) => !excludeIds.includes(c.id));

    const toggle = (id: string) => {
        setSelected((curr) => {
            if (curr.includes(id)) return curr.filter((x) => x !== id);
            if (curr.length >= pickCount) return [...curr.slice(1), id];
            return [...curr, id];
        });
    };

    const canConfirm = selected.length === pickCount;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                className={cn(
                    "!bg-[hsl(var(--sidebar-background))] !text-white",
                    "flex flex-col p-0 gap-0",
                    "max-h-[85vh]",
                )}
            >
                <div className="px-6 pt-5 pb-3 shrink-0 border-b border-border">
                    <DialogTitle className="font-inter-tight font-black uppercase text-xl tracking-tight leading-tight">
                        {title}
                    </DialogTitle>
                    <DialogDescription className="mt-1.5 text-sm">
                        {description}
                    </DialogDescription>
                </div>

                <div className="flex-1 overflow-y-auto px-4 py-3 min-h-0 space-y-2">
                    {candidates.length === 0 ? (
                        <p className="text-sm text-muted-foreground italic text-center py-6">
                            No eligible cards in hand.
                        </p>
                    ) : (
                        candidates.map((card) => (
                            <PickCardRow
                                key={card.id}
                                card={card}
                                selected={selected.includes(card.id)}
                                onToggle={() => toggle(card.id)}
                            />
                        ))
                    )}
                </div>

                <DialogFooter className="px-6 py-4 shrink-0 border-t border-border gap-2 sm:gap-2 sm:justify-between">
                    <span className="text-xs text-muted-foreground">
                        {selected.length} / {pickCount} picked
                    </span>
                    <div className="flex gap-2">
                        <Button
                            variant="outline"
                            onClick={() => onOpenChange(false)}
                        >
                            Cancel
                        </Button>
                        <Button
                            onClick={() => {
                                if (!canConfirm) return;
                                onConfirm(selected);
                            }}
                            disabled={!canConfirm}
                            className="gap-1.5"
                        >
                            <Check className="w-4 h-4" />
                            {confirmLabel}
                        </Button>
                    </div>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function PickCardRow({
    card,
    selected,
    onToggle,
}: {
    card: Card;
    selected: boolean;
    onToggle: () => void;
}) {
    return (
        <button
            type="button"
            onClick={onToggle}
            aria-pressed={selected}
            className={cn(
                "w-full text-left rounded-sm border-2 transition-all",
                "px-3 py-2.5",
                selected
                    ? "border-primary bg-primary/10"
                    : "border-border bg-secondary/40 hover:bg-accent",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            )}
        >
            <div className="flex items-start gap-2.5">
                <KindIcon card={card} />
                <div className="min-w-0 flex-1">
                    <div className="flex items-center flex-wrap gap-1.5">
                        <span className="font-inter-tight font-bold uppercase tracking-wide text-xs leading-none">
                            {card.name}
                        </span>
                        {card.kind === "time-bonus" && (
                            <span className="text-[10px] font-mono text-yellow-500 tabular-nums ml-1">
                                S{card.minutes.small} · M{card.minutes.medium} ·
                                L{card.minutes.large}
                            </span>
                        )}
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-1 leading-snug line-clamp-2">
                        {card.description}
                    </p>
                </div>
                <div
                    className={cn(
                        "shrink-0 w-5 h-5 rounded-sm border-2 flex items-center justify-center",
                        selected
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border",
                    )}
                    aria-hidden="true"
                >
                    {selected && <Check className="w-3.5 h-3.5" />}
                </div>
            </div>
        </button>
    );
}

function KindIcon({ card }: { card: Card }) {
    switch (card.kind) {
        case "time-bonus":
            return (
                <Plus className="w-4 h-4 text-yellow-500 mt-0.5 shrink-0" />
            );
        case "powerup":
            return (
                <Sparkles className="w-4 h-4 text-primary mt-0.5 shrink-0" />
            );
        case "curse":
            return (
                <Zap className="w-4 h-4 text-purple-500 mt-0.5 shrink-0" />
            );
    }
}

export default HandCardPicker;
