import { useStore } from "@nanostores/react";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogTitle,
} from "@/components/ui/dialog";
import { type GameSize, gameSize } from "@/lib/gameSetup";
import { pendingDraw, resolvePendingDraw } from "@/lib/hiderRole";
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
const FINAL_HOLD_MS = 200;

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
    // Card currently mid fly-to-hand. Used to apply the "flying"
    // transform exactly once per pick so the animation runs cleanly
    // before the card joins `keptIds` and becomes invisible.
    const [flyingId, setFlyingId] = useState<string | null>(null);
    // All picks made — remaining (un-kept) cards fade and fall. After
    // the fade we resolve the draw.
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
        setFlyingId(null);
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
        const isLastPick = keptIds.length + 1 >= keep;
        // v911: light swish as the kept card flies to the hand.
        play("cardDraw");
        setFlyingId(id);
        setSelectedId(null);

        if (isLastPick) {
            // v312: the non-picked cards' fade kicks off as part of
            // the same render that sets flyingId — the render
            // computes `flyingLast` from (flyingId !== null &&
            // keptIds.length === keep - 1), and `isFading` is
            // derived from that. So the picked card flies and the
            // discards fall away in lockstep with no setTimeout gap
            // between them. After the longer of the two animations
            // plus a tiny hold, we commit the kept entry and hand
            // off to the resolver.
            const t = window.setTimeout(() => {
                const next = [...keptIds, id];
                setKeptIds(next);
                setFlyingId(null);
                setFinished(true);
                const t2 = window.setTimeout(() => {
                    resolvePendingDraw(next);
                }, FINAL_HOLD_MS);
                timersRef.current.push(t2);
            }, Math.max(FLY_MS, FADE_MS));
            timersRef.current.push(t);
            return;
        }

        // Non-final pick: fly the kept card down, then commit to
        // keptIds so the picker presents the next pick.
        const t1 = window.setTimeout(() => {
            const nextKept = [...keptIds, id];
            setKeptIds(nextKept);
            setFlyingId(null);
            // v886: advance the stepper to the next card the hider hasn't kept
            // yet, so a multi-keep draw (e.g. tentacle: draw 4, keep 2) moves
            // on instead of sitting on the now-empty slide.
            const cards = $pending?.cards ?? [];
            for (let k = 1; k <= cards.length; k++) {
                const cand = (viewIndex + k) % cards.length;
                if (!nextKept.includes(cards[cand].id)) {
                    setViewIndex(cand);
                    break;
                }
            }
        }, FLY_MS);
        timersRef.current.push(t1);
    };

    const handleCardTap = (id: string) => {
        if (flyingId || finished) return;
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

    // v306: chrome fades both during the final card's fly AND
    // during the discard fade-out — they're now the same moment.
    // `flyingLast` flips the fade on the instant the last pick is
    // confirmed; `finished` keeps it faded after the fly completes
    // until resolvePendingDraw clears `pendingDraw`. Earlier
    // (v301) the fade only kicked in after the fly finished, so
    // the chrome was still solid while the kept card was already
    // flying down toward the hand.
    const flyingLast =
        flyingId !== null && keptIds.length === keep - 1;
    const chromeFadeOn = finished || flyingLast;
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
                                const isFlying = flyingId === card.id;
                                const isFading =
                                    chromeFadeOn && !isKept && !isFlying;
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
                                                isFlying={isFlying}
                                                isFading={isFading}
                                                disabled={
                                                    Boolean(flyingId) || finished
                                                }
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
    isFlying,
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
    isFlying: boolean;
    isFading: boolean;
    disabled: boolean;
    onTap: () => void;
    onConfirm: () => void;
}) {
    // v316: when the fly starts, measure the cell's current
    // viewport position and compute the delta to the actual hand
    // fan strip at the bottom of the screen. Without this the card
    // flew a fixed `translateY(70vh)` past the picker — way off
    // the bottom of the viewport. The new target is roughly the
    // centre of the HiderHandFan peek strip (~34 px above the
    // safe-area-aware viewport bottom), so the picked card visibly
    // tucks into where the hand actually sits.
    const wrapperRef = useRef<HTMLDivElement | null>(null);
    // v883: capture the cell's viewport rect at fly-start so the flying card
    // can go `position: fixed` and ESCAPE the carousel's `overflow-x-auto`
    // (which would otherwise clip the card as it flies down to the hand).
    const [flyRect, setFlyRect] = useState<{
        left: number;
        top: number;
        width: number;
        dx: number;
        dy: number;
    } | null>(null);
    useEffect(() => {
        if (!isFlying) {
            setFlyRect(null);
            return;
        }
        const el = wrapperRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const cellCx = rect.left + rect.width / 2;
        const cellCy = rect.top + rect.height / 2;
        const vh = window.innerHeight;
        const vw = window.innerWidth;
        // Aim for the centre of the resting fan strip — see
        // HiderHandFan PEEK_OFFSET (53 px below the viewport
        // bottom; the visible peek is ~26 px above bottom). 34 px
        // above bottom is a reliable landing for both Android and
        // iOS safe areas.
        const targetX = vw / 2;
        const targetY = vh - 34;
        setFlyRect({
            left: rect.left,
            top: rect.top,
            width: rect.width,
            dx: targetX - cellCx,
            dy: targetY - cellCy,
        });
    }, [isFlying]);

    // v1048: the GHOST card — a copy of the flying card portaled to <body>
    // (outside the dialog's transformed ancestor, so it's truly viewport-fixed
    // and un-clipped) that does the actual flight via the Web Animations API.
    const ghostRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        if (!isFlying || !flyRect) return;
        const el = ghostRef.current;
        if (!el) return;
        const anim = el.animate(
            [
                {
                    transform: "translate(0,0) scale(1) rotate(0deg)",
                    opacity: 1,
                    offset: 0,
                },
                {
                    transform: `translate(${flyRect.dx}px, ${flyRect.dy}px) scale(0.34) rotate(-4deg)`,
                    opacity: 0.95,
                    offset: 1,
                },
            ],
            {
                duration: FLY_MS,
                easing: "cubic-bezier(.4,0,.7,.2)",
                fill: "forwards",
            },
        );
        return () => anim.cancel();
    }, [isFlying, flyRect]);

    // Card transform per phase. Defaults (resting + highlighted) sit
    // in the grid spot; flying / fading / kept apply transforms with
    // their own transition profiles.
    const cardStyle: CSSProperties = (() => {
        if (isFlying) {
            // v1048: the in-grid card is only the MEASUREMENT anchor now. While
            // we measure (one render after isFlying flips) it stays visible; once
            // we have the rect, we HIDE it and a body-portaled GHOST card (below)
            // does the actual flight. The old `position: fixed` here did NOT
            // escape clipping — DialogContent has a centering `transform`, and a
            // transformed ancestor makes `position: fixed` resolve relative to
            // (and clip within) THAT ancestor, not the viewport (the reported
            // clipping). The ghost portals to <body>, outside the transform.
            if (!flyRect) {
                return { transition: "transform 120ms ease-out" };
            }
            return { opacity: 0 };
        }
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
            <div
                ref={wrapperRef}
                style={cardStyle}
                className="w-full"
                // Critical: don't let the flying transform get clipped
                // by an ancestor's overflow. The CardTile's own border
                // / shadow stays inside its bbox; only the position
                // moves.
            >
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
            {/* v1048: the flying GHOST — portaled to <body> so no transformed /
                overflow-clipping ancestor can clip it. Positioned at the source
                cell's measured viewport rect, then WAAPI-animated to the hand
                strip at the bottom-centre. Only mounts during the fly. */}
            {isFlying &&
                flyRect &&
                typeof document !== "undefined" &&
                createPortal(
                    <div
                        ref={ghostRef}
                        aria-hidden="true"
                        className="fixed pointer-events-none rounded-xl shadow-2xl will-change-transform"
                        style={{
                            left: flyRect.left,
                            top: flyRect.top,
                            width: flyRect.width,
                            zIndex: 2000,
                        }}
                    >
                        <CardTile
                            card={card}
                            gameSize={gameSize}
                            selectionIndicator="none"
                            className="w-full"
                        />
                    </div>,
                    document.body,
                )}
            {/* Confirm-pick button slot. Reserved height so selecting
                a card doesn't push the grid around. Renders the
                button only for the highlighted card. */}
            <div className="h-10 w-full flex items-center justify-center">
                {isSelected && isActive && !isFlying && !isFading && !isKept && (
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
