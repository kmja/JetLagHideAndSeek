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
import { pendingDraw, resolvePendingDraw } from "@/lib/hiderRole";
import { cn } from "@/lib/utils";

import { CardTile } from "./CardTile";
import { SectionPill } from "./JetLagLogo";

/**
 * Modal that fires whenever `pendingDraw` is non-null. Renders the N drawn
 * cards as a selectable grid of CardTiles and asks the hider to keep K of
 * them; the rest go to discard. Persists across reloads thanks to the
 * persistent atom — if the page closes mid-pick the hider can resume on
 * the next visit.
 *
 * Rulebook draw budgets (p16–37):
 *   - matching/measuring: draw 3, keep 1
 *   - radar/thermometer:  draw 2, keep 1
 *   - photo:              draw 1, keep 1   (auto-resolves, modal never shown)
 *   - tentacle:           draw 4, keep 2
 */
export function DrawPickerDialog() {
    const $pending = useStore(pendingDraw);
    const $gameSize = useStore(gameSize);
    const [selectedIds, setSelectedIds] = useState<string[]>([]);

    // Reset selection whenever a new draw arrives.
    useEffect(() => {
        setSelectedIds([]);
    }, [$pending?.sourceQuestionKey, $pending?.cards.length]);

    if (!$pending) return null;

    const toggle = (id: string) => {
        setSelectedIds((curr) => {
            if (curr.includes(id)) {
                return curr.filter((x) => x !== id);
            }
            // Cap at the keep count; replacing the oldest pick when at cap
            // makes the picker feel responsive ("just tap to swap").
            if (curr.length >= $pending.keep) {
                return [...curr.slice(1), id];
            }
            return [...curr, id];
        });
    };

    const canConfirm = selectedIds.length === $pending.keep;

    const onConfirm = () => {
        resolvePendingDraw(selectedIds);
    };

    return (
        <Dialog open={true}>
            <DialogContent
                className={cn(
                    "!bg-[hsl(var(--sidebar-background))] !text-[hsl(var(--sidebar-foreground))]",
                    "flex flex-col p-0 gap-0",
                    "max-h-[90vh]",
                )}
            >
                <div className="px-6 pt-5 pb-3 shrink-0 border-b border-border">
                    <div className="mb-2 flex items-center gap-2">
                        <SectionPill>Hider reward</SectionPill>
                        <span className="text-[10px] uppercase tracking-[0.18em] font-semibold text-muted-foreground ml-auto">
                            {capitalize($pending.sourceCategory)}
                        </span>
                    </div>
                    <DialogTitle className="font-inter-tight font-black uppercase text-xl tracking-tight leading-tight">
                        Draw {$pending.cards.length}, keep {$pending.keep}
                    </DialogTitle>
                    <DialogDescription className="mt-1.5 text-sm">
                        Pick {$pending.keep} of these{" "}
                        {$pending.cards.length} to keep. The rest are
                        discarded.
                    </DialogDescription>
                </div>

                <div className="flex-1 overflow-y-auto px-4 py-3 min-h-0">
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                        {$pending.cards.map((card) => (
                            <CardTile
                                key={card.id}
                                card={card}
                                gameSize={$gameSize}
                                selected={selectedIds.includes(card.id)}
                                onClick={() => toggle(card.id)}
                                selectionIndicator="checkbox"
                                ariaLabel={`Pick ${card.name}`}
                            />
                        ))}
                    </div>
                </div>

                <DialogFooter className="px-6 py-4 shrink-0 border-t border-border gap-2 sm:gap-2 sm:justify-between">
                    <span className="text-xs text-muted-foreground">
                        {selectedIds.length} / {$pending.keep} picked
                    </span>
                    <Button
                        onClick={onConfirm}
                        disabled={!canConfirm}
                        className="gap-1.5"
                    >
                        <Check className="w-4 h-4" />
                        Keep selected
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

export default DrawPickerDialog;
