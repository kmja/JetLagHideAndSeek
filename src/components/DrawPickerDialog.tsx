import { useStore } from "@nanostores/react";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import { type CSSProperties, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogTitle,
} from "@/components/ui/dialog";
import { type GameSize, gameSize } from "@/lib/gameSetup";
import {
    cardFlyToHand,
    pendingDraw,
    resolvePendingDraw,
} from "@/lib/hiderRole";
import { play } from "@/lib/sound";
import { cn } from "@/lib/utils";

import { CardTile } from "./CardTile";

/**
 * Modal that fires whenever `pendingDraw` is non-null. v252 reworks
 * the picker flow into a more tactile two-tap rhythm:
 *
 *   1. Tap a card to **highlight** it (ring + small lift).
 *   2. Tap the "Keep this card" button that pops up beneath it to
 *      **confirm** the pick. The card then animates downward off the
 *      tray — visually "flying to the hand" — and the picker stays
 *      open with the remaining cards to pick from.
 *   3. Once every `keep` slot is filled, the **discarded** cards fade
 *      and fall away. After the animation settles the dialog calls
 *      `resolvePendingDraw(keptIds)` and closes.
 *
 * The persistent `pendingDraw` atom means a reload mid-pick resumes
 * with the same cards and same `keep` budget; in-progress local
 * highlights / picks are NOT persisted (a reload restarts the pick
 * cleanly).
 *
 * Rulebook draw budgets (p16–37):
 *   - matching/measuring: draw 3, keep 1
 *   - radar/thermometer:  draw 2, keep 1
 *   - photo:              draw 1, keep 1   (auto-resolves, modal never shown)
 *   - tentacle:           draw 4, keep 2
 */

/** Animation timings — kept short enough not to slow the flow but
 *  long enough that the motion reads. Total time per pick is fly +
 *  small settle; the final discard adds one more fade pass. */
const FLY_MS = 450;
const FADE_MS = 600;

// v901 peek-carousel geometry: the active card is CARD_BASIS_PCT% of the
// container width, centred, so PEEK_PCT% of each neighbour shows at the edges.
// A horizontal drag past SWIPE_THRESHOLD px flicks to the neighbour.
const CARD_BASIS_PCT = 76;
const PEEK_PCT = (100 - CARD_BASIS_PCT) / 2;
const SWIPE_THRESHOLD = 45;

export function DrawPickerDialog() {
    const $pending = useStore(pendingDraw);
    const $gameSize = useStore(gameSize);
    // Currently highlighted (not yet confirmed). Tapping a card sets
    // this; tapping the same card again clears it; tapping a
    // different card swaps it.
    const [selectedId, setSelectedId] = useState<string | null>(null);
    // Cards the hider has already confirmed picking. Appended in
    // pick order; passed to `resolvePendingDraw` at the very end.
    const [keptIds, setKeptIds] = useState<string[]>([]);
    // All picks made — remaining (un-kept) cards fade and fall. After
    // the fade we resolve the draw. (v1050: the fly-to-hand itself is now
    // handled by the shared `CardFlyToHand` FLIP once the draw resolves, so
    // this picker no longer runs its own in-tray fly animation.)
    const [finished, setFinished] = useState(false);
    // Track timers across the kept lifecycle so a hot-reload or fast
    // reopen of the picker doesn't fire stale callbacks.
    const timersRef = useRef<number[]>([]);
    // v886: which card the stepper is showing. An index-based stepper (one
    // card centred at a time, prev/next) replaced the free-scroll carousel,
    // which snapped unreliably and didn't "lock on" to a card.
    const [viewIndex, setViewIndex] = useState(0);
    // v901: peek-carousel — the active card is centred at ~76% width so the
    // neighbours PEEK at the edges (scaled down + dimmed), and a swipe flicks
    // between them. Live finger-follow via `dragDx` (px), snapping on release.
    const [dragDx, setDragDx] = useState(0);
    const [dragging, setDragging] = useState(false);
    // Touch bookkeeping: start point + whether this gesture has moved enough
    // to count as a SWIPE (so it suppresses the trailing tap → no accidental
    // card select).
    const dragRef = useRef<{ x: number; y: number; moved: boolean } | null>(
        null,
    );

    // Reset local picker state whenever a fresh draw arrives. Reset on
    // both the question key AND the card-id signature so re-draws for
    // the same question key (impossible today but harmless to guard)
    // also reset.
    const cardKey = $pending?.cards.map((c) => c.id).join(",") ?? "";
    useEffect(() => {
        setSelectedId(null);
        setKeptIds([]);
        setFinished(false);
        setViewIndex(0);
        return () => {
            for (const t of timersRef.current) clearTimeout(t);
            timersRef.current = [];
        };
    }, [$pending?.sourceQuestionKey, cardKey]);

    if (!$pending) return null;

    const total = $pending.cards.length;
    const keep = $pending.keep;
    const picksRemaining = keep - keptIds.length;

    const confirmSelected = () => {
        if (selectedId === null) return;
        const id = selectedId;
        const next = [...keptIds, id];
        const isLastPick = next.length >= keep;
        // v911: light swish as the kept card heads to the hand.
        play("cardDraw");
        setSelectedId(null);

        if (isLastPick) {
            // v1050: hand the fly-to-hand off to the shared `CardFlyToHand`
            // FLIP instead of the DrawPicker's own straight-down animation.
            // `resolvePendingDraw` adds the kept cards to the hand (so the fan
            // renders their REAL slots) and clears `pendingDraw` (this dialog
            // unmounts); `cardFlyToHand.set` then flies each kept card from
            // centre to its actual slot — landing at the right spot in the fan,
            // shrinking to hand size, and revealing the slot only on arrival
            // (a seamless slot-in). This is the same measured FLIP the
            // photo-answer auto-keep uses, so the two flows now match.
            const keptCards = ($pending?.cards ?? []).filter((c) =>
                next.includes(c.id),
            );
            resolvePendingDraw(next);
            if (keptCards.length) cardFlyToHand.set(keptCards);
            return;
        }

        // Multi-keep, not the last pick yet: commit this pick (the card leaves
        // the tray) and advance the stepper to the next un-kept card. All kept
        // cards fly to the hand together when the final pick resolves.
        setKeptIds(next);
        const cards = $pending?.cards ?? [];
        for (let k = 1; k <= cards.length; k++) {
            const cand = (viewIndex + k) % cards.length;
            if (!next.includes(cards[cand].id)) {
                setViewIndex(cand);
                break;
            }
        }
    };

    const handleCardTap = (id: string) => {
        if (finished) return;
        if (keptIds.includes(id)) return;
        setSelectedId((curr) => (curr === id ? null : id));
    };

    // v886: the cards are shown in an index-based STEPPER (one card centred at
    // a time, prev/next arrows + dots) rather than a grid or free-scroll
    // carousel — at poker (5:7) proportions two+ cards side-by-side on a phone
    // were too small and clipped their descriptions, and the scroll carousel
    // snapped unreliably. The stepper always LOCKS onto exactly one card at a
    // comfortable size so ALL its content fits; the flying-to-hand card escapes
    // the viewport's overflow via `position: fixed` (see CardCell).

    // Chrome (title) fades once the draw is `finished` (all picks made). The
    // fly-to-hand itself is handled by CardFlyToHand after resolve.
    const chromeFadeOn = finished;
    const chromeFadeCls = cn(
        "transition-opacity ease-out",
        chromeFadeOn
            ? `opacity-0 pointer-events-none duration-[${FLY_MS}ms]`
            : "opacity-100 duration-200",
    );

    return (
        <Dialog open={true}>
            <DialogContent
                closeIcon={false}
                className={cn(
                    "!bg-transparent !border-0 !shadow-none",
                    "flex flex-col p-0 gap-3",
                    "!max-w-md w-[min(92vw,28rem)]",
                    "max-h-[92vh]",
                    "!overflow-visible",
                )}
            >
                {/* v306: one big, simple header. The "Hider reward",
                    category sub-pill, and long description that used
                    to sit here are gone — the action is obvious from
                    the title alone. */}
                <DialogTitle
                    className={cn(
                        "px-2 text-center font-inter-tight font-black uppercase",
                        // v886: white with a drop-shadow — the dialog is
                        // transparent over the dimmed map, so a dark title was
                        // unreadable.
                        "text-3xl tracking-tight leading-tight text-white",
                        "[text-shadow:0_2px_10px_rgba(0,0,0,0.55)]",
                        chromeFadeCls,
                    )}
                >
                    Pick {keep} card{keep === 1 ? "" : "s"}
                </DialogTitle>
                {/* SR-only description so Radix doesn't complain
                    about an undescribed dialog. */}
                <DialogDescription className="sr-only">
                    Pick {keep} card{keep === 1 ? "" : "s"} to keep
                    from the {total} drawn. The rest are discarded.
                </DialogDescription>

                {/* v901: peek-carousel — the active card is centred at
                    CARD_BASIS% width so the neighbours peek at the edges
                    (scaled down + dimmed); swipe flicks between them with a
                    live finger-follow, snapping on release. A translated track
                    (not free-scroll) still LOCKS onto exactly one card. */}
                <div className="relative py-2">
                    <div
                        // v1048: vertical padding gives the SELECTED card's lift
                        // (translateY(-6px) scale(1.02)) headroom inside the
                        // clip box — otherwise its top clipped against this
                        // `overflow-hidden` edge (the horizontal peek NEEDS the
                        // hidden overflow, and CSS can't do overflow-x:hidden +
                        // overflow-y:visible, so padding is the fix).
                        className="overflow-hidden py-4"
                        onTouchStart={(e) => {
                            if (chromeFadeOn) return;
                            const t = e.touches[0];
                            dragRef.current = {
                                x: t.clientX,
                                y: t.clientY,
                                moved: false,
                            };
                            setDragging(true);
                        }}
                        onTouchMove={(e) => {
                            const d = dragRef.current;
                            if (!d) return;
                            const t = e.touches[0];
                            const dx = t.clientX - d.x;
                            const dy = t.clientY - d.y;
                            // Only treat a clearly-horizontal drag as a swipe.
                            if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) {
                                d.moved = true;
                                setDragDx(dx);
                            }
                        }}
                        onTouchEnd={() => {
                            const dx = dragDx;
                            setDragDx(0);
                            setDragging(false);
                            if (dx < -SWIPE_THRESHOLD && viewIndex < total - 1) {
                                setViewIndex((i) => i + 1);
                            } else if (dx > SWIPE_THRESHOLD && viewIndex > 0) {
                                setViewIndex((i) => i - 1);
                            }
                        }}
                    >
                        <div
                            className={cn(
                                "flex",
                                !dragging &&
                                    "transition-transform duration-300 ease-out",
                            )}
                            style={{
                                transform: `translateX(calc(${PEEK_PCT}% - ${
                                    viewIndex * CARD_BASIS_PCT
                                }% + ${dragDx}px))`,
                            }}
                        >
                            {$pending.cards.map((card, i) => {
                                const isSelected = selectedId === card.id;
                                const isKept = keptIds.includes(card.id);
                                const isFading = chromeFadeOn && !isKept;
                                const isActive = i === viewIndex;
                                return (
                                    <div
                                        key={card.id}
                                        className="shrink-0 flex justify-center px-1.5"
                                        style={{ flexBasis: `${CARD_BASIS_PCT}%` }}
                                    >
                                        <div
                                            className={cn(
                                                "w-full transition-all duration-300 ease-out",
                                                isActive
                                                    ? "scale-100 opacity-100"
                                                    : "scale-[0.86] opacity-45",
                                            )}
                                        >
                                            <CardCell
                                                card={card}
                                                gameSize={$gameSize}
                                                isSelected={isSelected}
                                                isActive={isActive}
                                                isKept={isKept}
                                                isFading={isFading}
                                                disabled={finished}
                                                onTap={() => {
                                                    // A swipe suppresses the
                                                    // trailing tap.
                                                    if (dragRef.current?.moved) {
                                                        dragRef.current.moved =
                                                            false;
                                                        return;
                                                    }
                                                    if (!isActive) {
                                                        setViewIndex(i);
                                                        setSelectedId(null);
                                                        return;
                                                    }
                                                    handleCardTap(card.id);
                                                }}
                                                onConfirm={confirmSelected}
                                            />
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    {total > 1 && !chromeFadeOn && (
                        <>
                            <button
                                type="button"
                                aria-label="Previous card"
                                disabled={viewIndex === 0}
                                onClick={() =>
                                    setViewIndex((i) => Math.max(0, i - 1))
                                }
                                className={cn(
                                    "absolute left-0 top-1/2 -translate-y-1/2 z-10",
                                    "inline-flex h-10 w-10 items-center justify-center rounded-full",
                                    "bg-background/90 border border-border shadow-md text-foreground",
                                    "disabled:opacity-0 disabled:pointer-events-none",
                                )}
                            >
                                <ChevronLeft className="w-5 h-5" />
                            </button>
                            <button
                                type="button"
                                aria-label="Next card"
                                disabled={viewIndex >= total - 1}
                                onClick={() =>
                                    setViewIndex((i) =>
                                        Math.min(total - 1, i + 1),
                                    )
                                }
                                className={cn(
                                    "absolute right-0 top-1/2 -translate-y-1/2 z-10",
                                    "inline-flex h-10 w-10 items-center justify-center rounded-full",
                                    "bg-background/90 border border-border shadow-md text-foreground",
                                    "disabled:opacity-0 disabled:pointer-events-none",
                                )}
                            >
                                <ChevronRight className="w-5 h-5" />
                            </button>
                        </>
                    )}
                </div>

                {total > 1 && !chromeFadeOn && (
                    <div className="flex items-center justify-center gap-1.5">
                        {$pending.cards.map((card, i) => (
                            <button
                                key={card.id}
                                type="button"
                                aria-label={`Show card ${i + 1}`}
                                onClick={() => setViewIndex(i)}
                                className={cn(
                                    "h-2 rounded-full transition-all",
                                    i === viewIndex
                                        ? "w-5 bg-white"
                                        : keptIds.includes(card.id)
                                          ? "w-2 bg-primary"
                                          : "w-2 bg-white/50",
                                )}
                            />
                        ))}
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}

/* ────────────────── Single card cell ────────────────── */

function CardCell({
    card,
    gameSize,
    isSelected,
    isActive,
    isKept,
    isFading,
    disabled,
    onTap,
    onConfirm,
}: {
    card: import("@/lib/hiderDeck").Card;
    gameSize: GameSize;
    isSelected: boolean;
    isActive: boolean;
    isKept: boolean;
    isFading: boolean;
    disabled: boolean;
    onTap: () => void;
    onConfirm: () => void;
}) {
    // Card transform per phase. Defaults (resting + highlighted) sit in the
    // grid spot; fading / kept apply transforms with their own profiles.
    // (v1050: the fly-to-hand is no longer done here — once the draw resolves
    // the kept card is added to the hand and the shared `CardFlyToHand` FLIP
    // flies it to its real slot in the fan.)
    const cardStyle: CSSProperties = (() => {
        if (isKept) {
            return { opacity: 0, pointerEvents: "none" };
        }
        if (isFading) {
            // Slight stagger via per-card random offset so all
            // discards don't snap in unison. Math.random is OK here
            // — the stagger is purely cosmetic, no state depends on
            // the value.
            return {
                transform: `translateY(${30 + Math.random() * 20}px) rotate(${
                    (Math.random() - 0.5) * 12
                }deg)`,
                opacity: 0,
                transition: `transform ${FADE_MS}ms ease-in, opacity ${FADE_MS}ms ease-in`,
                pointerEvents: "none",
            };
        }
        // Highlighted: small lift, leaves the resting bbox slightly.
        if (isSelected) {
            return {
                transform: "translateY(-6px) scale(1.02)",
                transition: "transform 180ms ease-out",
            };
        }
        return { transition: "transform 180ms ease-out" };
    })();

    return (
        <div className="flex flex-col items-stretch gap-2">
            <div style={cardStyle} className="w-full">
                <CardTile
                    card={card}
                    gameSize={gameSize}
                    selected={isSelected}
                    onClick={disabled || isKept ? undefined : onTap}
                    selectionIndicator={isSelected ? "ring" : "none"}
                    // Keep the poker-card aspect ratio (CardTile's native
                    // `aspect-[5/7]`). Cards must never stretch — long
                    // descriptions scroll within the card body instead
                    // (CardTile's bodies are overflow-y-auto). When three
                    // cards can't fit a row at this ratio, the parent
                    // drops to a 2+1 layout rather than distorting them.
                    className="w-full"
                />
            </div>
            {/* Confirm-pick button slot. Reserved height so selecting
                a card doesn't push the grid around. Renders the
                button only for the highlighted card. */}
            <div className="h-10 w-full flex items-center justify-center">
                {isSelected && isActive && !isFading && !isKept && (
                    <Button
                        type="button"
                        size="sm"
                        onClick={onConfirm}
                        className={cn(
                            "gap-1.5 h-9 w-full text-xs font-semibold",
                            "animate-in fade-in slide-in-from-top-1 duration-150",
                        )}
                    >
                        Pick this card
                        <Check className="w-3.5 h-3.5" />
                    </Button>
                )}
            </div>
        </div>
    );
}


export default DrawPickerDialog;
