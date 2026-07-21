import { useStore } from "@nanostores/react";
import {
    AlertOctagon,
    ChevronDown,
    Shuffle,
    Sparkles,
    Timer,
    Trash2,
} from "lucide-react";

import { SkullCrossbones } from "@/components/icons/gameIcons";
import { useState } from "react";
import { toast } from "react-toastify";

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
import { Button } from "@/components/ui/button";
import { appConfirm } from "@/lib/confirm";
import { canPayDiscardCost, parseDiscardCost } from "@/lib/castingCost";
import {
    activeBlockingCurse,
    activeBlockingCurseCastAt,
    curseBlockedByActive,
} from "@/lib/curseEnforcement";
import { endgameStartedAt, gameSize } from "@/lib/gameSetup";
import { type Card, type CurseCard, type PowerupCard,tallyTimeBonusMinutes } from "@/lib/hiderDeck";
import {
    discardCard,
    drawCards,
    hiderDeck,
    hiderDiscard,
    hiderHand,
    hiderHandLimit,
} from "@/lib/hiderRole";
import { playMovePowerup } from "@/lib/roundActions";
import { cn } from "@/lib/utils";

import { CardTile } from "./CardTile";
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
    // v1020: Move can't be played during the endgame (locked to the final
    // spot) — disable its Play button.
    const $endgame = useStore(endgameStartedAt);
    // v1031: one ask/transit-blocking curse at a time — disable Cast in the
    // hand for a second blocker while one is active (rulebook p44/p386).
    const $activeBlocker = useStore(activeBlockingCurse);
    const $activeBlockerAt = useStore(activeBlockingCurseCastAt);

    const bonusMinutes = tallyTimeBonusMinutes($hand, $gameSize);
    const overCap = $hand.length > $handLimit;

    // One state machine for the powerup picker + one for the cast
    // dialog. Keeps each modal's lifecycle self-contained.
    const [pickerAction, setPickerAction] =
        useState<PendingPickerAction>(null);
    const [castCurse, setCastCurse] = useState<CurseCard | null>(null);

    const onPlayPowerup = async (card: PowerupCard) => {
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
                // v887: Randomize is a RESPONSE card — it swaps the
                // question you're answering for a random one, so it can
                // only be played FROM a question (the answer dialog's
                // response actions), never standalone from the hand.
                // Direct the hider there instead of discarding it for no
                // effect.
                toast.info(
                    "Randomize is played in response to a question — open the question you want to answer and play it from there.",
                    { autoClose: 5000 },
                );
                return;
            case "move": {
                const ok = await appConfirm({
                    title: "Play Move?",
                    description:
                        "Discards your entire hand and sends your station to the seekers. A fresh hiding period starts after this confirms.",
                    confirmLabel: "Play Move",
                    destructive: true,
                });
                if (!ok) return;
                // Discard the entire hand (Move included) — the rulebook
                // is clear that no cards survive a Move.
                for (const c of [...hiderHand.get()]) {
                    discardCard(c.id);
                }
                {
                    const moved = playMovePowerup();
                    toast.info(
                        moved
                            ? "Move played. Your station was sent to the seekers and they're frozen for the new hiding period — pick a new hiding zone."
                            : "Hand discarded, but Move had no clock to re-anchor (no hiding period running, or the endgame has begun).",
                        { autoClose: 6000 },
                    );
                }
                return;
            }
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
                /* Each hand card renders as a CardTile (visual,
                   matching the physical cards) wrapped with the
                   action row BELOW it. The card itself stays
                   "untouched" — no buttons baked into the tile —
                   so it reads like the real card. The actions
                   (Play / Cast / Discard) sit on a separate row
                   beneath, attributed to the card via the shared
                   column. */
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {$hand.map((card) => (
                        <div key={card.id} className="flex flex-col gap-1.5">
                            <CardTile
                                card={card}
                                gameSize={$gameSize}
                                selectionIndicator="none"
                            />
                            <div className="flex gap-1">
                                {card.kind === "powerup" && (
                                    <Button
                                        type="button"
                                        variant="default"
                                        size="sm"
                                        disabled={
                                            card.powerup === "move" &&
                                            $endgame !== null
                                        }
                                        title={
                                            card.powerup === "move" &&
                                            $endgame !== null
                                                ? "Can't play Move during the endgame"
                                                : undefined
                                        }
                                        onClick={() => onPlayPowerup(card)}
                                        className="flex-1 gap-1 h-7 px-2 text-[10px]"
                                    >
                                        <Sparkles className="w-3 h-3" />
                                        Play
                                    </Button>
                                )}
                                {card.kind === "curse" &&
                                    (() => {
                                        const blocked = curseBlockedByActive(
                                            card,
                                            $activeBlocker,
                                            $activeBlockerAt,
                                            $gameSize,
                                            Date.now(),
                                        );
                                        // v1068: unpayable casting cost → disable
                                        // Cast up-front (not only in the dialog).
                                        const cost = parseDiscardCost(
                                            card.castingCost,
                                        );
                                        const cantAfford =
                                            cost !== null &&
                                            !canPayDiscardCost(
                                                $hand,
                                                cost,
                                                card.id,
                                            );
                                        return (
                                            <Button
                                                type="button"
                                                variant="default"
                                                size="sm"
                                                disabled={blocked || cantAfford}
                                                title={
                                                    blocked
                                                        ? `${$activeBlocker} is still blocking the seekers — only one such curse at a time (rulebook p44).`
                                                        : cantAfford
                                                          ? `Not enough eligible cards to pay the casting cost (${card.castingCost}).`
                                                          : undefined
                                                }
                                                onClick={() =>
                                                    setCastCurse(card)
                                                }
                                                className="flex-1 gap-1 h-7 px-2 text-[10px]"
                                            >
                                                <SkullCrossbones className="w-3 h-3" />
                                                Cast
                                            </Button>
                                        );
                                    })()}
                                <DiscardCardButton card={card} />
                            </div>
                        </div>
                    ))}
                </div>
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

function DiscardCardButton({ card }: { card: Card }) {
    return (
        <AlertDialog>
            <AlertDialogTrigger asChild>
                {/* "secondary" variant rather than "outline" — the
                    outline variant on a dark page background just
                    shows a subtle border + foreground text, which
                    reads as disabled next to the bright Play/Cast
                    button. Secondary gives the button a clearly
                    clickable filled appearance without competing
                    with the primary action's color. */}
                <Button
                    type="button"
                    variant="secondary"
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
    const $gameSize = useStore(gameSize);
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
                <div className="mt-2 grid grid-cols-2 sm:grid-cols-3 gap-2 opacity-70">
                    {[...$discard].reverse().map((card, i) => (
                        <CardTile
                            key={`${card.id}-${i}`}
                            card={card}
                            gameSize={$gameSize}
                            size="compact"
                            selectionIndicator="none"
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

export default HiderHandPanel;
