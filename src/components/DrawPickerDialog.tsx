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
import { pendingDraw, resolvePendingDraw } from "@/lib/hiderRole";
import type { Card } from "@/lib/hiderDeck";
import { cn } from "@/lib/utils";

import { SectionPill } from "./JetLagLogo";

/**
 * Modal that fires whenever `pendingDraw` is non-null. Renders the N drawn
 * cards as a selectable grid and asks the hider to keep K of them; the
 * rest go to discard. Persists across reloads thanks to the persistent
 * atom — if the page closes mid-pick the hider can resume on the next
 * visit.
 *
 * Rulebook draw budgets (p16–37):
 *   - matching/measuring: draw 3, keep 1
 *   - radar/thermometer:  draw 2, keep 1
 *   - photo:              draw 1, keep 1   (auto-resolves, modal never shown)
 *   - tentacle:           draw 4, keep 2
 */
export function DrawPickerDialog() {
    const $pending = useStore(pendingDraw);
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
                    "!bg-[hsl(var(--sidebar-background))] !text-white",
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

                <div className="flex-1 overflow-y-auto px-4 py-3 min-h-0 space-y-2">
                    {$pending.cards.map((card) => {
                        const selected = selectedIds.includes(card.id);
                        return (
                            <DrawCard
                                key={card.id}
                                card={card}
                                selected={selected}
                                onToggle={() => toggle(card.id)}
                            />
                        );
                    })}
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

function DrawCard({
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
            className={cn(
                "w-full text-left rounded-sm border-2 transition-all",
                "px-3 py-2.5",
                selected
                    ? "border-primary bg-primary/10"
                    : "border-border bg-secondary/40 hover:bg-accent",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            )}
            aria-pressed={selected}
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
                                S{card.minutes.small} · M{card.minutes.medium} · L{card.minutes.large}
                            </span>
                        )}
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-1 leading-snug">
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

function capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

export default DrawPickerDialog;
