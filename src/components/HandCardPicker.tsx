import { useStore } from "@nanostores/react";
import { Check } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogTitle,
} from "@/components/ui/dialog";
import { gameSize } from "@/lib/gameSetup";
import { hiderHand } from "@/lib/hiderRole";
import { cn } from "@/lib/utils";

import { CardTile } from "./CardTile";

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
    const $gameSize = useStore(gameSize);
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

                <div className="flex-1 overflow-y-auto px-4 py-3 min-h-0">
                    {candidates.length === 0 ? (
                        <p className="text-sm text-muted-foreground italic text-center py-6">
                            No eligible cards in hand.
                        </p>
                    ) : (
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                            {candidates.map((card) => (
                                <CardTile
                                    key={card.id}
                                    card={card}
                                    gameSize={$gameSize}
                                    selected={selected.includes(card.id)}
                                    onClick={() => toggle(card.id)}
                                    selectionIndicator="checkbox"
                                    ariaLabel={`Toggle ${card.name}`}
                                />
                            ))}
                        </div>
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

export default HandCardPicker;
