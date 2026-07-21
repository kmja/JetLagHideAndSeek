import { useStore } from "@nanostores/react";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import {
    type CSSProperties,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
} from "react";

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
    discardRemainingDraw,
    keepCardFromDraw,
    pendingDraw,
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

// v901 peek-carousel geometry: the active card is CARD_BASIS_PCT% of the
// container width, centred, so PEEK_PCT% of each neighbour shows at the edges.
// A horizontal drag past SWIPE_THRESHOLD px flicks to the neighbour.
const CARD_BASIS_PCT = 76;
const PEEK_PCT = (100 - CARD_BASIS_PCT) / 2;
const SWIPE_THRESHOLD = 45;

export function DrawPickerDialog() {
    const $pending = useStore(pendingDraw);
    const $gameSize = useStore(gameSize);
    // Once the LAST keep is made, the remaining un-picked cards fall away to
    // the sides (sinking into the ocean) before the pending draw is cleared.
    const [finished, setFinished] = useState(false);
    // Track timers so a hot-reload or fast reopen doesn't fire stale callbacks.
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
    // v1062: FLIP so the remaining cards SLIDE to fill the gap when a picked
    // card leaves the carousel (instead of a new card snapping into its slot).
    // Each cell registers itself; after any render that moved a cell, we apply
    // the inverse offset then transition it to 0.
    const cellRefs = useRef(new Map<string, HTMLDivElement>());
    const prevLefts = useRef(new Map<string, number>());
    useLayoutEffect(() => {
        // Use offsetLeft (LAYOUT position within the track), NOT
        // getBoundingClientRect — the latter includes the track's own
        // translateX, so a swipe (viewIndex change) would fire a spurious FLIP
        // fighting the track's transition. offsetLeft only changes on a REFLOW
        // (a card leaving the list), which is exactly when we want the slide.
        cellRefs.current.forEach((el, id) => {
            const now = el.offsetLeft;
            const prev = prevLefts.current.get(id);
            if (prev != null && Math.abs(prev - now) > 1) {
                el.style.transition = "none";
                el.style.transform = `translateX(${prev - now}px)`;
                requestAnimationFrame(() => {
                    el.style.transition = "transform 300ms ease-out";
                    el.style.transform = "";
                });
            }
        });
        // Re-baseline to the settled positions for the next change.
        prevLefts.current.clear();
        cellRefs.current.forEach((el, id) => {
            prevLefts.current.set(id, el.offsetLeft);
        });
    });

    // Reset local picker state whenever a NEW draw session starts. Keyed on the
    // source question key only — NOT the card list, which now SHRINKS as each
    // keep is committed (v1059: `keepCardFromDraw` removes the kept card from
    // `pendingDraw.cards`), so keying on the cards would wrongly reset mid-pick.
    // A queued repeat-draw with the same key is reset explicitly in the discard
    // timeout below.
    useEffect(() => {
        setFinished(false);
        setViewIndex(0);
        return () => {
            for (const t of timersRef.current) clearTimeout(t);
            timersRef.current = [];
        };
    }, [$pending?.sourceQuestionKey]);

    if (!$pending) return null;

    const total = $pending.cards.length;
    const keep = $pending.keep;

    // v1053: the CENTERED (active) card is the pick target — like the hand
    // carousel. No separate two-tap highlight; the action applies to whatever
    // card is centred, so the "Pick this card" button can never end up on a
    // peeking neighbour.
    // v1059: each pick is committed IMMEDIATELY — the card lands in the hand
    // (flies there) and leaves the carousel, so a multi-keep draw never shows a
    // confusing empty gap and the hider sees each kept card arrive. On the LAST
    // keep the remaining un-picked cards fall away to the sides before the draw
    // clears.
    const confirmActive = () => {
        const cards = $pending?.cards ?? [];
        const card = cards[viewIndex];
        if (!card || finished) return;
        const id = card.id;
        // v911: light swish as the kept card heads to the hand.
        play("cardDraw");

        // Measure the on-screen carousel card NOW so the fly-to-hand starts
        // EXACTLY where this card is — a seamless continuation, not a new card
        // popping in.
        const el = document.querySelector<HTMLElement>(
            `[data-draw-card="${
                typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id
            }"]`,
        );
        const rect = el?.getBoundingClientRect();
        const fromRect =
            rect && rect.width > 0
                ? {
                      left: rect.left,
                      top: rect.top,
                      width: rect.width,
                      height: rect.height,
                  }
                : undefined;

        const wasLast = keep <= 1;
        // Commit the keep: card → hand, removed from the pending cards, keep--.
        keepCardFromDraw(id);
        cardFlyToHand.set({ cards: [card], fromRect });

        if (wasLast) {
            // The keep budget is spent — the remaining cards fall to the ocean,
            // then the draw is cleared (or the next queued cycle opens).
            setFinished(true);
            const t = window.setTimeout(() => {
                discardRemainingDraw();
                setFinished(false);
                setViewIndex(0);
            }, 760);
            timersRef.current.push(t);
        } else {
            // The kept card was removed from the carousel; keep the view within
            // the now-shorter list (the next card slides into this slot).
            setViewIndex((i) => Math.min(i, cards.length - 2));
        }
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
                        // v1059: while the discarded cards fall away to the
                        // sides, switch to `overflow-visible` so they aren't
                        // clipped by the peek box.
                        className={cn(
                            "py-4",
                            finished ? "overflow-visible" : "overflow-hidden",
                        )}
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
                                // v1059: once the last keep is made, the
                                // remaining un-picked cards fall away to the
                                // SIDES + sink (discarded into the ocean). Spread
                                // them left→right so they fan out as they drop.
                                const isFading = finished;
                                const isActive = i === viewIndex;
                                const fadeDir =
                                    total <= 1
                                        ? -1
                                        : (i / (total - 1)) * 2 - 1;
                                return (
                                    <div
                                        key={card.id}
                                        ref={(el) => {
                                            if (el)
                                                cellRefs.current.set(
                                                    card.id,
                                                    el,
                                                );
                                            else
                                                cellRefs.current.delete(
                                                    card.id,
                                                );
                                        }}
                                        className="shrink-0 flex justify-center px-1.5"
                                        style={{ flexBasis: `${CARD_BASIS_PCT}%` }}
                                    >
                                        <div
                                            className={cn(
                                                "w-full transition-all duration-300 ease-out",
                                                // v1061: KEEP the peek/active
                                                // scale while fading so the inner
                                                // shrink composes from the card's
                                                // CURRENT position (it recedes in
                                                // place). Resetting to scale-100
                                                // here made peek cards jump to
                                                // centre/full-size first.
                                                isActive
                                                    ? "scale-100 opacity-100"
                                                    : "scale-[0.86] opacity-45",
                                            )}
                                        >
                                            <CardCell
                                                card={card}
                                                gameSize={$gameSize}
                                                isActive={isActive}
                                                isFading={isFading}
                                                fadeDir={fadeDir}
                                                fadeDelay={i * 90}
                                                disabled={finished}
                                                onTap={() => {
                                                    // A swipe suppresses the
                                                    // trailing tap.
                                                    if (dragRef.current?.moved) {
                                                        dragRef.current.moved =
                                                            false;
                                                        return;
                                                    }
                                                    // Tapping a peeking neighbour
                                                    // centres it; the centred card
                                                    // is the pick target (its
                                                    // button confirms).
                                                    if (!isActive) setViewIndex(i);
                                                }}
                                                onConfirm={confirmActive}
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
    isActive,
    isFading,
    fadeDir,
    fadeDelay,
    disabled,
    onTap,
    onConfirm,
}: {
    card: import("@/lib/hiderDeck").Card;
    gameSize: GameSize;
    isActive: boolean;
    isFading: boolean;
    fadeDir: number;
    fadeDelay: number;
    disabled: boolean;
    onTap: () => void;
    onConfirm: () => void;
}) {
    // The centred (active), not-yet-discarded card is the pick target: it gets
    // the selected ring + the "Pick this card" button. Peeking neighbours are
    // dimmed and only tap-to-centre.
    const isTarget = isActive && !isFading;
    // Card transform per phase.
    const cardStyle: CSSProperties = (() => {
        if (isFading) {
            // v1060: the last keep was made — this un-picked card is discarded
            // INTO the screen (away from the viewer): it recedes (shrinks to a
            // point) with a slight sideways drift + rotate and fades, like a card
            // dropped into deep water sinking away from you — NOT a fall to the
            // bottom edge.
            return {
                transform: `translate(${fadeDir * 9}vw, 4vh) scale(0.06) rotate(${
                    fadeDir * 22
                }deg)`,
                opacity: 0,
                transition: `transform 760ms cubic-bezier(0.55,0,0.7,1) ${fadeDelay}ms, opacity 760ms ease-in ${fadeDelay + 220}ms`,
                pointerEvents: "none",
            };
        }
        // The centred pick target: small lift, leaves the resting bbox slightly.
        if (isTarget) {
            return {
                transform: "translateY(-6px) scale(1.02)",
                transition: "transform 180ms ease-out",
            };
        }
        return { transition: "transform 180ms ease-out" };
    })();

    return (
        <div className="flex flex-col items-stretch gap-2">
            <div style={cardStyle} className="w-full" data-draw-card={card.id}>
                <CardTile
                    card={card}
                    gameSize={gameSize}
                    selected={isTarget}
                    onClick={disabled ? undefined : onTap}
                    selectionIndicator={isTarget ? "ring" : "none"}
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
                {isTarget && (
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
