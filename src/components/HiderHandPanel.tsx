import { useStore } from "@nanostores/react";
import {
    AlertOctagon,
    ChevronDown,
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
import { tallyTimeBonusMinutes, type Card, type CurseCard, type PowerupCard } from "@/lib/hiderDeck";
import { cn } from "@/lib/utils";

import { CastCurseDialog } from "./CastCurseDialog";
import { HandCardPicker } from "./HandCardPicker";
import { SectionPill } from "./JetLagLogo";

/**
 * Hand panel: card list + per-card actions + projected-total banner.
 *
 * Powerups that resolve fully in-app (`discard1draw2`, `discard2draw3`,
 * `draw1expand`, `duplicate`) drive the HandCardPicker dialog so the
 * hider chooses *which* cards to spend/copy. Curses surface the
 * CastCurseDialog with the printed casting cost and (where applicable)
 * a pre-cast die roll. Veto / Randomize / Move still defer to physical
 * play but discard the card and toast the rules text so the hider
 * doesn't lose track.
 */

type PendingPickerAction =
    | {
          kind: "discard-and-draw";
          powerupId: string;
          discardCount: number;
          drawCount: number;
          /** Used in the success toast. */
          powerupName: string;
      }
    | {
          kind: "duplicate";
          powerupId: string;
      }
    | null;

export function HiderHandPanel() {
    const $hand = useStore(hiderHand);
    const $deck = useStore(hiderDeck);
    const $discard = useStore(hiderDiscard);
    const $handLimit = useStore(hiderHandLimit);
    const $gameSize = useStore(gameSize);

    const bonusMinutes = tallyTimeBonusMinutes($hand, $gameSize);
    const overCap = $hand.length > $handLimit;

    // One state machine for the powerup picker + one for the cast
    // dialog. Keeps each modal's lifecycle self-contained.
    const [pickerAction, setPickerAction] =
        useState<PendingPickerAction>(null);
    const [castCurse, setCastCurse] = useState<CurseCard | null>(null);

    const onPlayPowerup = (card: PowerupCard) => {
        const hand = hiderHand.get();
        switch (card.powerup) {
            case "discard1draw2":
                if (hand.length < 2) {
                    toast.error(
                        "Need at least one other card to discard first.",
                    );
                    return;
                }
                setPickerAction({
                    kind: "discard-and-draw",
                    powerupId: card.id,
                    powerupName: card.name,
                    discardCount: 1,
                    drawCount: 2,
                });
                return;
            case "discard2draw3":
                if (hand.length < 3) {
                    toast.error(
                        "Need at least two other cards to discard first.",
                    );
                    return;
                }
                setPickerAction({
                    kind: "discard-and-draw",
                    powerupId: card.id,
                    powerupName: card.name,
                    discardCount: 2,
                    drawCount: 3,
                });
                return;
            case "duplicate":
                if (hand.length < 2) {
                    toast.error(
                        "Need at least one other card in hand to duplicate.",
                    );
                    return;
                }
                setPickerAction({
                    kind: "duplicate",
                    powerupId: card.id,
                });
                return;
            case "draw1expand": {
                const limit = hiderHandLimit.get();
                discardCard(card.id);
                hiderHandLimit.set(limit + 1);
                const drawn = drawCards(1);
                toast.success(
                    `Hand cap raised to ${limit + 1}. Drew ${drawn.length} card${drawn.length === 1 ? "" : "s"}.`,
                    { autoClose: 2500 },
                );
                return;
            }
            case "veto":
                discardCard(card.id);
                toast.info(
                    "Veto played. Tell the seeker no answer is coming and earn no reward — they can still ask their next question.",
                    { autoClose: 5000 },
                );
                return;
            case "randomize":
                discardCard(card.id);
                toast.info(
                    "Randomize played. Pick a different un-asked question from the same category at random — answer that one instead.",
                    { autoClose: 5000 },
                );
                return;
            case "move":
                if (
                    !confirm(
                        "Move card: this discards your entire hand and sends your station to the seekers. A fresh hiding period starts after this confirms. Proceed?",
                    )
                ) {
                    return;
                }
                // Discard the entire hand (Move included) — the rulebook
                // is clear that no cards survive a Move.
                for (const c of [...hiderHand.get()]) {
                    discardCard(c.id);
                }
                toast.info(
                    "Hand discarded. Send your current station to the seekers and pick a new hiding zone — seekers are frozen during this period.",
                    { autoClose: 6000 },
                );
                return;
        }
    };

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

            {bonusMinutes > 0 && (
                <div className="rounded-sm border-2 border-yellow-500/40 bg-yellow-500/5 px-3 py-2 mb-3 flex items-center gap-2 text-sm">
                    <Timer className="w-4 h-4 text-yellow-500" />
                    <span className="font-semibold">+{bonusMinutes} min</span>
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
                        <HandCardRow
                            key={card.id}
                            card={card}
                            onPlayPowerup={onPlayPowerup}
                            onCastCurse={(c) => setCastCurse(c)}
                        />
                    ))}
                </ul>
            )}

            {/* Discard pile — collapsible read-only view */}
            <DiscardPile />

            {/* Powerup-resolution picker */}
            <HandCardPicker
                open={
                    pickerAction?.kind === "discard-and-draw" ||
                    pickerAction?.kind === "duplicate"
                }
                onOpenChange={(o) => {
                    if (!o) setPickerAction(null);
                }}
                title={
                    pickerAction?.kind === "discard-and-draw"
                        ? `${pickerAction.powerupName} — pick ${pickerAction.discardCount} to discard`
                        : pickerAction?.kind === "duplicate"
                          ? "Duplicate Another Card — pick the card to copy"
                          : ""
                }
                description={
                    pickerAction?.kind === "discard-and-draw"
                        ? `Pick ${pickerAction.discardCount} card${pickerAction.discardCount === 1 ? "" : "s"} from your hand to discard. You'll then draw ${pickerAction.drawCount}.`
                        : pickerAction?.kind === "duplicate"
                          ? "Pick the card you want to copy. A fresh duplicate lands in your hand."
                          : ""
                }
                pickCount={
                    pickerAction?.kind === "discard-and-draw"
                        ? pickerAction.discardCount
                        : 1
                }
                excludeIds={
                    pickerAction
                        ? [
                              pickerAction.kind === "discard-and-draw"
                                  ? pickerAction.powerupId
                                  : pickerAction.powerupId,
                          ]
                        : []
                }
                confirmLabel={
                    pickerAction?.kind === "discard-and-draw"
                        ? `Discard & draw ${pickerAction.drawCount}`
                        : "Duplicate"
                }
                onConfirm={(ids) => {
                    if (!pickerAction) return;
                    if (pickerAction.kind === "discard-and-draw") {
                        const handBefore = hiderHand.get();
                        const discardedNames = ids
                            .map(
                                (id) =>
                                    handBefore.find((c) => c.id === id)?.name ??
                                    "card",
                            )
                            .join(", ");
                        for (const id of ids) discardCard(id);
                        discardCard(pickerAction.powerupId);
                        const drawn = drawCards(pickerAction.drawCount);
                        toast.success(
                            `Discarded ${discardedNames}. Drew ${drawn.length} card${drawn.length === 1 ? "" : "s"}.`,
                            { autoClose: 2500 },
                        );
                    } else {
                        const original = hiderHand
                            .get()
                            .find((c) => c.id === ids[0]);
                        if (!original) return;
                        discardCard(pickerAction.powerupId);
                        const clone: Card = {
                            ...original,
                            id: `${original.id}-dup-${Date.now()}`,
                        } as Card;
                        hiderHand.set([...hiderHand.get(), clone]);
                        toast.success(`Duplicated "${original.name}".`, {
                            autoClose: 2500,
                        });
                    }
                    setPickerAction(null);
                }}
            />

            {/* Cast-curse dialog */}
            <CastCurseDialog
                open={castCurse !== null}
                onOpenChange={(o) => {
                    if (!o) setCastCurse(null);
                }}
                card={castCurse}
            />
        </section>
    );
}

/* ────────────────── Hand card row ────────────────── */

function HandCardRow({
    card,
    onPlayPowerup,
    onCastCurse,
}: {
    card: Card;
    onPlayPowerup: (c: PowerupCard) => void;
    onCastCurse: (c: CurseCard) => void;
}) {
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
                                S{card.minutes.small} · M{card.minutes.medium} ·
                                L{card.minutes.large}
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
                        onClick={() => onPlayPowerup(card)}
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
                        onClick={() => onCastCurse(card)}
                        className="gap-1.5 h-7 px-2 text-[11px]"
                    >
                        <Zap className="w-3 h-3" />
                        Cast on seeker
                    </Button>
                )}
                <DiscardCardButton card={card} />
            </div>
        </li>
    );
}

function DiscardCardButton({ card }: { card: Card }) {
    return (
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
                    <AlertDialogTitle>Discard {card.name}?</AlertDialogTitle>
                    <AlertDialogDescription>
                        {card.kind === "time-bonus"
                            ? "Time-bonus cards only count if held at round end. Discarding loses the minutes."
                            : "The card moves to the discard pile and can't be played again this round."}
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel>Keep</AlertDialogCancel>
                    <AlertDialogAction onClick={() => discardCard(card.id)}>
                        Discard
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}

/* ────────────────── Discard pile ────────────────── */

function DiscardPile() {
    const $discard = useStore(hiderDiscard);
    const [open, setOpen] = useState(false);
    if ($discard.length === 0) return null;

    return (
        <div className="mt-3">
            <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                className={cn(
                    "w-full flex items-center justify-between gap-2",
                    "px-3 py-2 rounded-sm border border-border",
                    "bg-secondary/30 hover:bg-secondary/50",
                    "text-xs font-poppins font-semibold",
                    "transition-colors",
                )}
            >
                <span className="flex items-center gap-1.5">
                    <Trash2 className="w-3.5 h-3.5 text-muted-foreground" />
                    Discard pile ({$discard.length})
                </span>
                <ChevronDown
                    className={cn(
                        "w-3.5 h-3.5 transition-transform",
                        open && "rotate-180",
                    )}
                />
            </button>
            {open && (
                <ul className="mt-2 space-y-1">
                    {[...$discard].reverse().map((card, i) => (
                        <li
                            key={`${card.id}-${i}`}
                            className={cn(
                                "flex items-center gap-2 px-2.5 py-1.5 rounded-sm",
                                "bg-secondary/20 border border-border/50",
                                "text-xs text-muted-foreground",
                            )}
                        >
                            <CardKindIcon kind={card.kind} />
                            <span className="font-inter-tight font-bold uppercase tracking-wide text-[11px]">
                                {card.name}
                            </span>
                            {card.kind === "time-bonus" && (
                                <span className="text-[10px] font-mono tabular-nums">
                                    S{card.minutes.small}/M{card.minutes.medium}/L{card.minutes.large}
                                </span>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </div>
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

export default HiderHandPanel;
