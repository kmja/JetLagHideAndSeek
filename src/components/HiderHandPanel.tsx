import { useStore } from "@nanostores/react";
import {
    AlertOctagon,
    Copy as CopyIcon,
    Plus,
    Shuffle,
    Sparkles,
    Timer,
    Trash2,
    Zap,
} from "lucide-react";
import { useState } from "react";
import { toast } from "react-toastify";

import { Button } from "@/components/ui/button";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { gameSize } from "@/lib/gameSetup";
import {
    discardCard,
    drawCards,
    hiderDeck,
    hiderDiscard,
    hiderHand,
    hiderHandLimit,
} from "@/lib/hiderRole";
import { tallyTimeBonusMinutes, type Card } from "@/lib/hiderDeck";
import { encodeCurseLink, shareOrCopy } from "@/lib/shareLinks";
import { cn } from "@/lib/utils";

import { SectionPill } from "./JetLagLogo";

/**
 * Hand panel: card list + per-card actions + projected-total banner.
 *
 * Powerups that only affect hand state (discard/draw, expand, duplicate)
 * are fully executable in-app. Curses send the hider's chosen card via
 * a share-link the seeker opens to see the curse text. Powerups that need
 * to bind to a specific incoming question or pause the game (veto,
 * randomize, move) are explained but not yet auto-applied — the hider
 * still plays them with the physical card while we wire up those flows.
 */
export function HiderHandPanel() {
    const $hand = useStore(hiderHand);
    const $deck = useStore(hiderDeck);
    const $discard = useStore(hiderDiscard);
    const $handLimit = useStore(hiderHandLimit);
    const $gameSize = useStore(gameSize);

    const bonusMinutes = tallyTimeBonusMinutes($hand, $gameSize);
    const overCap = $hand.length > $handLimit;

    return (
        <section className="mt-5">
            <div className="flex items-center gap-2 mb-2">
                <SectionPill>Hand</SectionPill>
                <span
                    className={cn(
                        "text-[10px] tabular-nums ml-auto",
                        overCap
                            ? "text-destructive font-semibold"
                            : "text-muted-foreground",
                    )}
                >
                    {$hand.length} / {$handLimit}{" "}
                    {overCap && "· over cap"}
                </span>
            </div>

            {/* Projected time-bonus banner */}
            {bonusMinutes > 0 && (
                <div className="rounded-sm border-2 border-yellow-500/40 bg-yellow-500/5 px-3 py-2 mb-3 flex items-center gap-2 text-sm">
                    <Timer className="w-4 h-4 text-yellow-500" />
                    <span className="font-semibold">
                        +{bonusMinutes} min
                    </span>
                    <span className="text-xs text-muted-foreground">
                        bonus locked in if held at round end
                    </span>
                </div>
            )}

            {overCap && (
                <div className="rounded-sm border-2 border-destructive/50 bg-destructive/5 px-3 py-2 mb-3 flex items-start gap-2 text-xs">
                    <AlertOctagon className="w-4 h-4 text-destructive mt-0.5 shrink-0" />
                    <p className="leading-snug">
                        Hand is over the cap. Discard until you're at{" "}
                        {$handLimit} before drawing more (rulebook p44).
                    </p>
                </div>
            )}

            {/* Deck + discard counters */}
            <div className="flex items-center gap-3 text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-2 px-1">
                <span className="flex items-center gap-1">
                    <Shuffle className="w-3 h-3" />
                    deck {$deck.length}
                </span>
                <span className="flex items-center gap-1">
                    <Trash2 className="w-3 h-3" />
                    discard {$discard.length}
                </span>
            </div>

            {$hand.length === 0 ? (
                <p className="text-xs text-muted-foreground italic px-1">
                    You'll draw cards after each question you answer. Pick
                    a category and the deck handles the rest — radar
                    answers earn 2 cards keep 1, matching earns 3 keep 1,
                    and so on (rulebook p16–37).
                </p>
            ) : (
                <ul className="space-y-1.5">
                    {$hand.map((card) => (
                        <HandCardRow key={card.id} card={card} />
                    ))}
                </ul>
            )}
        </section>
    );
}

/* ────────────────── per-card row ────────────────── */

function HandCardRow({ card }: { card: Card }) {
    const [shareBusy, setShareBusy] = useState(false);

    const onDiscard = () => discardCard(card.id);

    const onPowerup = () => {
        if (card.kind !== "powerup") return;
        const handBefore = hiderHand.get();
        const limitBefore = hiderHandLimit.get();
        switch (card.powerup) {
            case "discard1draw2": {
                // Need at least 1 other card to discard.
                if (handBefore.length < 2) {
                    toast.error(
                        "Need at least one other card to discard first.",
                    );
                    return;
                }
                const other = pickOldestOther(handBefore, card.id);
                if (!other) return;
                discardCard(other.id);
                discardCard(card.id); // The powerup itself is also spent
                const drawn = drawCards(2);
                toast.success(
                    `Discarded "${other.name}". Drew ${drawn.length} card${drawn.length === 1 ? "" : "s"}.`,
                    { autoClose: 2500 },
                );
                break;
            }
            case "discard2draw3": {
                if (handBefore.length < 3) {
                    toast.error("Need at least two other cards to discard.");
                    return;
                }
                const a = pickOldestOther(handBefore, card.id);
                if (!a) return;
                const b = pickOldestOther(handBefore, card.id, a.id);
                if (!b) return;
                discardCard(a.id);
                discardCard(b.id);
                discardCard(card.id);
                const drawn = drawCards(3);
                toast.success(
                    `Discarded "${a.name}" and "${b.name}". Drew ${drawn.length} new.`,
                    { autoClose: 2500 },
                );
                break;
            }
            case "draw1expand": {
                discardCard(card.id);
                hiderHandLimit.set(limitBefore + 1);
                const drawn = drawCards(1);
                toast.success(
                    `Hand cap raised to ${limitBefore + 1}. Drew ${drawn.length}.`,
                    { autoClose: 2500 },
                );
                break;
            }
            case "duplicate": {
                // Copy another card in hand and add a fresh instance.
                const other = pickOldestOther(handBefore, card.id);
                if (!other) {
                    toast.error("No other card in hand to duplicate.");
                    return;
                }
                discardCard(card.id);
                const clone: Card = {
                    ...other,
                    id: `${other.id}-dup-${Date.now()}`,
                } as Card;
                hiderHand.set([...hiderHand.get(), clone]);
                toast.success(`Duplicated "${other.name}".`, {
                    autoClose: 2500,
                });
                break;
            }
            case "veto":
            case "randomize":
            case "move":
                toast.info(
                    "This powerup needs the live game flow (still " +
                        "being wired up). Play the physical card with " +
                        "the seeker for now, then tap Discard.",
                    { autoClose: 4500 },
                );
                break;
        }
    };

    const onCastCurse = async () => {
        if (card.kind !== "curse") return;
        setShareBusy(true);
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
            } else {
                toast.error("Could not share the curse.");
            }
        } finally {
            setShareBusy(false);
        }
    };

    /* — Render — */
    return (
        <li
            className={cn(
                "rounded-sm border border-border px-3 py-2",
                "bg-secondary/40 text-sm",
                card.kind === "curse" && "border-l-[3px] border-l-purple-500",
                card.kind === "powerup" && "border-l-[3px] border-l-primary",
                card.kind === "time-bonus" &&
                    "border-l-[3px] border-l-yellow-500",
            )}
        >
            <div className="flex items-start gap-2">
                <CardKindIcon kind={card.kind} />
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
                    {card.kind === "curse" && card.castingCost && (
                        <p className="text-[11px] text-foreground/80 mt-1 leading-snug italic">
                            Casting cost: {card.castingCost}
                        </p>
                    )}
                </div>
            </div>
            <div className="flex gap-1.5 mt-2 justify-end">
                {card.kind === "powerup" && (
                    <Button
                        type="button"
                        variant="default"
                        size="sm"
                        onClick={onPowerup}
                        className="gap-1.5 h-7 px-2 text-[11px]"
                    >
                        <Sparkles className="w-3 h-3" />
                        Play
                    </Button>
                )}
                {card.kind === "curse" && (
                    <Button
                        type="button"
                        variant="default"
                        size="sm"
                        onClick={onCastCurse}
                        disabled={shareBusy}
                        className="gap-1.5 h-7 px-2 text-[11px]"
                    >
                        <Zap className="w-3 h-3" />
                        Cast on seeker
                    </Button>
                )}
                <AlertDialog>
                    <AlertDialogTrigger asChild>
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="gap-1.5 h-7 px-2 text-[11px]"
                        >
                            <Trash2 className="w-3 h-3" />
                            Discard
                        </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                        <AlertDialogHeader>
                            <AlertDialogTitle>
                                Discard {card.name}?
                            </AlertDialogTitle>
                            <AlertDialogDescription>
                                {card.kind === "time-bonus"
                                    ? "Time-bonus cards only count if held at round end. Discarding loses the minutes."
                                    : "The card moves to the discard pile and can't be played again this round."}
                            </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                            <AlertDialogCancel>Keep</AlertDialogCancel>
                            <AlertDialogAction onClick={onDiscard}>
                                Discard
                            </AlertDialogAction>
                        </AlertDialogFooter>
                    </AlertDialogContent>
                </AlertDialog>
            </div>
        </li>
    );
}

function CardKindIcon({ kind }: { kind: Card["kind"] }) {
    switch (kind) {
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

function pickOldestOther(
    hand: Card[],
    excludeId: string,
    alsoExclude?: string,
): Card | null {
    for (const c of hand) {
        if (c.id === excludeId) continue;
        if (alsoExclude && c.id === alsoExclude) continue;
        return c;
    }
    return null;
}

// Tiny helper so a possible future "copy raw card" action has its icon
// ready in this file's import list without sprinkling lint suppressions.
void CopyIcon;

export default HiderHandPanel;
