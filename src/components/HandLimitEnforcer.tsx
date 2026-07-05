import { useStore } from "@nanostores/react";
import { AlertOctagon, Sparkles, Timer, Zap } from "lucide-react";

import {
    AlertDialog,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import type { Card } from "@/lib/hiderDeck";
import { discardCard, hiderHand, hiderHandLimit } from "@/lib/hiderRole";
import { cn } from "@/lib/utils";

/**
 * Rulebook p71/p363: "If the hand limit is exceeded, the hider must
 * immediately play or discard until only 6 remain." (7 or 8 with the
 * hand-expand powerup.) This was previously advisory only — an "over
 * cap" banner that the hider could ignore while the hand grew unbounded.
 *
 * This enforces it: whenever the hider's hand exceeds their limit, a
 * non-dismissible modal takes over and forces them to discard down to
 * the limit before they can do anything else. It auto-closes the instant
 * the hand is back at/under the limit. Playing a card from elsewhere
 * (the fan / panel) also resolves it — this is purely the forced-discard
 * fast path so the hider can't proceed over-cap.
 *
 * Mounted once on `HiderPage`. Only the hide team ever holds a hand, and
 * an empty/at-limit hand renders nothing, so it's inert outside the
 * over-cap moment.
 */
export function HandLimitEnforcer() {
    const $hand = useStore(hiderHand);
    const $limit = useStore(hiderHandLimit);

    // The hand fan only mounts on the hider surface, and a seeker's local
    // hand is empty — so an over-cap hand here is always the hider's.
    const over = $hand.length - $limit;
    if (over <= 0) return null;

    return (
        <AlertDialog open>
            <AlertDialogContent
                className="max-w-md"
                // Force a decision — no outside-click / esc dismiss.
                onEscapeKeyDown={(e) => e.preventDefault()}
            >
                <AlertDialogHeader>
                    <AlertDialogTitle className="flex items-center gap-2">
                        <AlertOctagon className="w-5 h-5 text-destructive" />
                        Hand over the limit
                    </AlertDialogTitle>
                    <AlertDialogDescription className="leading-snug">
                        You&apos;re holding {$hand.length} cards but can keep
                        only {$limit}. Discard{" "}
                        <span className="font-bold text-destructive">
                            {over}
                        </span>{" "}
                        {over === 1 ? "card" : "cards"} to continue (rulebook
                        p44). Tip: keep your time-bonus cards — they add to your
                        final time.
                    </AlertDialogDescription>
                </AlertDialogHeader>

                <div className="mt-2 flex flex-col gap-1.5 max-h-[52vh] overflow-y-auto pr-1">
                    {$hand.map((card) => (
                        <HandCardRow
                            key={card.id}
                            card={card}
                            onDiscard={() => discardCard(card.id)}
                        />
                    ))}
                </div>
            </AlertDialogContent>
        </AlertDialog>
    );
}

const KIND_META: Record<
    Card["kind"],
    { icon: typeof Timer; label: string; className: string }
> = {
    "time-bonus": {
        icon: Timer,
        label: "Time bonus",
        className: "text-warning",
    },
    powerup: { icon: Zap, label: "Powerup", className: "text-info" },
    curse: { icon: Sparkles, label: "Curse", className: "text-primary" },
};

function HandCardRow({
    card,
    onDiscard,
}: {
    card: Card;
    onDiscard: () => void;
}) {
    const meta = KIND_META[card.kind];
    const Icon = meta.icon;
    return (
        <div className="flex items-center gap-2 rounded-sm border border-border bg-sidebar-accent/40 px-2.5 py-1.5">
            <Icon className={cn("w-4 h-4 shrink-0", meta.className)} />
            <div className="min-w-0 flex-1">
                <div className="text-xs font-semibold truncate">
                    {card.name}
                </div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    {meta.label}
                </div>
            </div>
            <Button
                size="sm"
                variant="destructive"
                className="h-7 px-2.5 text-xs shrink-0"
                onClick={onDiscard}
            >
                Discard
            </Button>
        </div>
    );
}

export default HandLimitEnforcer;
