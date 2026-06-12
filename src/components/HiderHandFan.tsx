import { useStore } from "@nanostores/react";
import { Sparkles, Trash2, X, Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "react-toastify";
import { Drawer as VaulDrawer } from "vaul";

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
import { gameSize } from "@/lib/gameSetup";
import {
    type Card,
    type CurseCard,
    type PowerupCard,
} from "@/lib/hiderDeck";
import {
    discardCard,
    drawCards,
    hiderHand,
    hiderHandLimit,
} from "@/lib/hiderRole";
import { cn } from "@/lib/utils";

import { CardTile } from "./CardTile";
import { CastCurseDialog } from "./CastCurseDialog";
import { HandCardPicker } from "./HandCardPicker";

/**
 * Bottom-of-screen fanned hand, Hearthstone-style. Replaces the
 * always-visible grid in HiderHandPanel with the spatial cue every
 * tabletop hider already knows from physical play — a curved spread
 * of cards across the bottom edge.
 *
 * Tapping anywhere on the fan opens a full-screen carousel where the
 * hider can swipe between cards and tap Play / Cast / Discard on
 * whichever's focused. The fan itself is non-interactive per-card —
 * it's a single tap target that hands off to the carousel.
 *
 * Mounted at the page level so it sits below all other content and
 * floats above the map / phase view. Hides itself entirely when the
 * hand is empty so the bottom-edge cue only appears when there's
 * something to play.
 */
export function HiderHandFan() {
    const $hand = useStore(hiderHand);
    const $gameSize = useStore(gameSize);
    const [open, setOpen] = useState(false);
    // Which card the carousel should land on when it opens. Set by
    // whichever card in the fan the hider tapped.
    const [initialIndex, setInitialIndex] = useState(0);

    if ($hand.length === 0) return null;

    return (
        <>
            <Fan
                hand={$hand}
                gameSize={$gameSize}
                onCardTap={(idx) => {
                    setInitialIndex(idx);
                    setOpen(true);
                }}
            />
            <HandCarousel
                open={open}
                onOpenChange={setOpen}
                hand={$hand}
                gameSize={$gameSize}
                initialIndex={initialIndex}
            />
        </>
    );
}

/* ────────────────── Fan strip ────────────────── */

function Fan({
    hand,
    gameSize: $gameSize,
    onCardTap,
}: {
    hand: Card[];
    gameSize: ReturnType<typeof gameSize.get>;
    onCardTap: (index: number) => void;
}) {
    // Card size + spacing. The fan renders CardTile at its FULL
    // default size inside a scale(MINIATURE) wrapper, so the
    // miniature is a faithful tiny copy of the real card (same
    // layout, same fonts shrunk). MINIATURE = 0.42 → 180x240 default
    // CardTile becomes 76x100 visible, which matches a standard
    // playing-card 3:4 aspect close enough.
    const N = hand.length;
    const CARD_MINIATURE_SCALE = 0.42;
    const CARD_W = 76;
    const CARD_H = 104;
    const TOTAL_ANGLE = N <= 1 ? 0 : Math.min(60, 9 * N);
    const stepAngle = N <= 1 ? 0 : TOTAL_ANGLE / (N - 1);
    const startAngle = -TOTAL_ANGLE / 2;
    const overlap = Math.min(50, 8 + 5 * N);
    const slotPx = CARD_W - overlap;
    const halfSpan = ((N - 1) * slotPx) / 2;

    // Press-and-drag peek: pointerdown on a card sets the previewed
    // index; pointermove anywhere on screen hit-tests against the
    // card AABBs and updates which card is lifted; pointerup commits
    // (opens the carousel to the lifted card) and pointercancel just
    // dismisses. The previewed card scales up and translates higher
    // than the rest of the fan; transitions are short enough to feel
    // tactile but not so short the change is invisible.
    const containerRef = useRef<HTMLDivElement | null>(null);
    const cardRefs = useRef<Array<HTMLButtonElement | null>>([]);
    const activePointerRef = useRef<number | null>(null);
    const previewRef = useRef<number | null>(null);
    const [previewIndex, setPreviewIndex] = useState<number | null>(null);

    const setPreview = (idx: number | null) => {
        previewRef.current = idx;
        setPreviewIndex(idx);
    };

    const hitTest = (clientX: number, clientY: number): number | null => {
        // Walk top-to-bottom of the z-order (last index = topmost) so
        // the front-facing card wins overlapping pixels.
        for (let i = cardRefs.current.length - 1; i >= 0; i--) {
            const btn = cardRefs.current[i];
            if (!btn) continue;
            const rect = btn.getBoundingClientRect();
            if (
                clientX >= rect.left &&
                clientX <= rect.right &&
                clientY >= rect.top &&
                clientY <= rect.bottom
            ) {
                return i;
            }
        }
        return null;
    };

    const startPress = (e: React.PointerEvent, idx: number) => {
        if (activePointerRef.current !== null) return; // single-touch only
        activePointerRef.current = e.pointerId;
        setPreview(idx);

        const onMove = (ev: PointerEvent) => {
            if (ev.pointerId !== activePointerRef.current) return;
            setPreview(hitTest(ev.clientX, ev.clientY));
        };
        const cleanup = () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            window.removeEventListener("pointercancel", onCancel);
        };
        const onUp = (ev: PointerEvent) => {
            if (ev.pointerId !== activePointerRef.current) return;
            const finalIdx = previewRef.current;
            activePointerRef.current = null;
            setPreview(null);
            cleanup();
            // Only commit if the finger came up over a card — a drag
            // off the fan + release just cancels.
            if (finalIdx !== null) onCardTap(finalIdx);
        };
        const onCancel = (ev: PointerEvent) => {
            if (ev.pointerId !== activePointerRef.current) return;
            activePointerRef.current = null;
            setPreview(null);
            cleanup();
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onCancel);
    };

    return (
        <div
            ref={containerRef}
            role="group"
            aria-label={`Hand of ${N} card${N === 1 ? "" : "s"}`}
            className={cn(
                "fixed inset-x-0 bottom-0 z-40",
                "flex items-end justify-center",
                "pointer-events-none",
            )}
            style={{
                // Container height covers the resting fan. The
                // peek-preview card extends ABOVE the container
                // (overflow is intentionally visible) so page footers
                // only need to clear the resting strip — they get
                // briefly covered while the user is peeking, but
                // peeking is a deliberate interaction with full focus,
                // so brief overlap is fine.
                height: CARD_H + 24,
                paddingBottom: "calc(env(safe-area-inset-bottom) + 4px)",
            }}
        >
            <div
                className="relative pointer-events-none"
                style={{ width: 0, height: CARD_H }}
            >
                {hand.map((card, i) => {
                    const angle = startAngle + i * stepAngle;
                    // Translate so each card's CENTRE sits at x
                    // (rather than the card's left edge). Without
                    // this -CARD_W/2 adjustment the whole fan
                    // appears shifted right by half a card width.
                    const x = -halfSpan + i * slotPx - CARD_W / 2;
                    // Lift the centre cards higher than the edges so
                    // the fan reads as a curve. cos() of the angle
                    // gives the vertical offset along the imaginary
                    // pivot circle.
                    const rad = (angle * Math.PI) / 180;
                    const yLift = (1 - Math.cos(rad)) * 28;
                    const previewed = previewIndex === i;
                    // Peek transform: undo the rotation so the
                    // previewed card stands upright, lift it higher,
                    // and scale slightly so it reads as foregrounded.
                    const previewTranslate = previewed ? 32 : 0;
                    const previewScale = previewed ? 1.25 : 1;
                    const cardRotate = previewed ? 0 : angle;
                    return (
                        <button
                            key={card.id}
                            ref={(el) => {
                                cardRefs.current[i] = el;
                            }}
                            type="button"
                            onPointerDown={(e) => startPress(e, i)}
                            // Keyboard fallback: Enter / Space on a
                            // focused card opens the carousel without
                            // any pointer dance.
                            onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    onCardTap(i);
                                }
                            }}
                            aria-label={`Open ${card.name}`}
                            className={cn(
                                "absolute bottom-0 left-0 p-0",
                                "pointer-events-auto",
                                "rounded-md overflow-hidden",
                                "border border-border bg-card",
                                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                "transition-transform duration-150 ease-out",
                                // touch-action: none prevents the
                                // press-and-drag gesture from being
                                // intercepted as a page scroll on
                                // touch devices.
                                "touch-none select-none",
                            )}
                            style={{
                                transform: `translateX(${x}px) translateY(${-yLift - previewTranslate}px) rotate(${cardRotate}deg) scale(${previewScale})`,
                                transformOrigin: "50% 100%",
                                width: CARD_W,
                                height: CARD_H,
                                // Lifted card jumps to the top of the
                                // stack so its scaled-up footprint
                                // isn't clipped by overlapping
                                // neighbours.
                                zIndex: previewed ? 1000 : 100 + i,
                                boxShadow: previewed
                                    ? "0 8px 24px rgba(0,0,0,0.6)"
                                    : "0 -2px 8px rgba(0,0,0,0.45)",
                            }}
                        >
                            {/* Render the full-size CardTile design
                                inside a CARD_MINIATURE_SCALE-down
                                wrapper so the fan card is a faithful
                                miniature of the real card — same layout
                                proportions, same fonts (just smaller),
                                same artwork. The inner wrapper sizes
                                up to 1/scale so the unscaled layout
                                fills the visible CARD_W x CARD_H box. */}
                            <div
                                style={{
                                    width: CARD_W / CARD_MINIATURE_SCALE,
                                    height: CARD_H / CARD_MINIATURE_SCALE,
                                    transform: `scale(${CARD_MINIATURE_SCALE})`,
                                    transformOrigin: "top left",
                                }}
                            >
                                <CardTile
                                    card={card}
                                    gameSize={$gameSize}
                                    selectionIndicator="none"
                                    className="h-full w-full"
                                />
                            </div>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

/* ────────────────── Carousel sheet ────────────────── */

function HandCarousel({
    open,
    onOpenChange,
    hand,
    gameSize: $gameSize,
    initialIndex,
}: {
    open: boolean;
    onOpenChange: (next: boolean) => void;
    hand: Card[];
    gameSize: ReturnType<typeof gameSize.get>;
    /** Index in `hand` to scroll to when the drawer opens. */
    initialIndex: number;
}) {
    // Track the currently-focused card so the action buttons below
    // act on whatever's centered in the scroll-snap row.
    const [focusIndex, setFocusIndex] = useState(initialIndex);
    const trackRef = useRef<HTMLDivElement | null>(null);

    // On open: clamp the requested initial index against the current
    // hand size, set focus, then jump the track to that slide once
    // the layout has settled. The slide must exist (rAF + nullable
    // guard) since the drawer animates in. `scrollIntoView` with
    // inline: "center" lines the chosen card up with the snap point.
    useEffect(() => {
        if (!open) return;
        const clamped = Math.max(
            0,
            Math.min(initialIndex, hand.length - 1),
        );
        setFocusIndex(clamped);
        const id = requestAnimationFrame(() => {
            const el = trackRef.current;
            if (!el) return;
            const slide = el.children[clamped] as
                | HTMLElement
                | undefined;
            if (!slide) return;
            // `scrollLeft` directly avoids triggering the scroll
            // listener's snap-correction race that scrollIntoView
            // sometimes loses to on iOS Safari.
            el.scrollLeft =
                slide.offsetLeft - (el.clientWidth - slide.clientWidth) / 2;
        });
        return () => cancelAnimationFrame(id);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, initialIndex]);

    // Watch scroll position; whichever slide's centre is closest to
    // the viewport centre is the focused one. Throttled via rAF so
    // the listener doesn't fire 60 times per scroll tick.
    useEffect(() => {
        if (!open) return;
        const el = trackRef.current;
        if (!el) return;
        let frame = 0;
        const onScroll = () => {
            if (frame) return;
            frame = requestAnimationFrame(() => {
                frame = 0;
                const cx = el.scrollLeft + el.clientWidth / 2;
                const slides = Array.from(el.children) as HTMLElement[];
                let bestIdx = 0;
                let bestDist = Infinity;
                for (let i = 0; i < slides.length; i++) {
                    const s = slides[i];
                    const sCenter = s.offsetLeft + s.clientWidth / 2;
                    const dist = Math.abs(sCenter - cx);
                    if (dist < bestDist) {
                        bestDist = dist;
                        bestIdx = i;
                    }
                }
                setFocusIndex(bestIdx);
            });
        };
        el.addEventListener("scroll", onScroll, { passive: true });
        return () => el.removeEventListener("scroll", onScroll);
    }, [open]);

    // Card to the carousel actions act on. Out-of-bounds index is
    // possible right after a discard shrinks the hand below the
    // previous focus.
    const focused = hand[focusIndex] ?? hand[hand.length - 1] ?? null;

    return (
        <VaulDrawer.Root
            open={open}
            onOpenChange={onOpenChange}
            shouldScaleBackground={false}
        >
            <VaulDrawer.Portal>
                <VaulDrawer.Overlay className="fixed inset-0 z-[1050] bg-black/80" />
                <VaulDrawer.Content
                    className={cn(
                        "fixed inset-0 z-[1051]",
                        "flex flex-col",
                        "bg-background text-foreground",
                        "pb-[env(safe-area-inset-bottom)]",
                    )}
                >
                    {/* Drag handle */}
                    <div className="mx-auto mt-3 mb-1 h-1.5 w-12 shrink-0 rounded-full bg-muted" />

                    {/* Header */}
                    <div className="flex items-center justify-between px-5 pt-2 pb-3 shrink-0">
                        <div className="flex items-center gap-2">
                            <VaulDrawer.Title className="text-sm font-poppins font-bold uppercase tracking-[0.16em]">
                                Hand
                            </VaulDrawer.Title>
                            <span className="text-[11px] tabular-nums text-muted-foreground">
                                {focusIndex + 1} / {hand.length}
                            </span>
                        </div>
                        <button
                            type="button"
                            onClick={() => onOpenChange(false)}
                            className={cn(
                                "inline-flex items-center justify-center w-8 h-8",
                                "rounded-md text-muted-foreground",
                                "hover:bg-accent hover:text-foreground",
                            )}
                            aria-label="Close hand"
                        >
                            <X className="w-4 h-4" />
                        </button>
                    </div>

                    {/* Carousel — horizontal scroll-snap row. Each
                        slide takes the full carousel width (with
                        small side-peek so the neighbour shows it can
                        be swiped to). Card maintains its natural
                        ~3:4 aspect with the height capped at the
                        available track height so it doesn't push
                        past the action row on short viewports. */}
                    <div
                        ref={trackRef}
                        role="region"
                        aria-label="Hand cards"
                        className={cn(
                            "flex-1 min-h-0 flex overflow-x-auto",
                            "snap-x snap-mandatory scroll-smooth",
                            "no-scrollbar gap-4 px-[10%] py-4",
                        )}
                    >
                        {hand.map((card, i) => (
                            <article
                                key={card.id}
                                className={cn(
                                    "snap-center shrink-0",
                                    "w-[80%] max-w-[360px]",
                                    "flex items-center justify-center",
                                    "transition-transform duration-200",
                                    i === focusIndex
                                        ? "scale-100"
                                        : "scale-95 opacity-70",
                                )}
                                aria-current={i === focusIndex}
                            >
                                <div
                                    className="w-full max-h-full"
                                    style={{ aspectRatio: "3 / 4" }}
                                >
                                    <CardTile
                                        card={card}
                                        gameSize={$gameSize}
                                        selectionIndicator="none"
                                        className="h-full w-full"
                                    />
                                </div>
                            </article>
                        ))}
                    </div>

                    {/* Pagination dots */}
                    <div
                        className="flex items-center justify-center gap-1.5 shrink-0 py-2"
                        aria-hidden
                    >
                        {hand.map((_, i) => (
                            <span
                                key={i}
                                className={cn(
                                    "rounded-full transition-all duration-200",
                                    i === focusIndex
                                        ? "w-4 h-1.5 bg-primary"
                                        : "w-1.5 h-1.5 bg-muted-foreground/40",
                                )}
                            />
                        ))}
                    </div>

                    {/* Action row — operates on the focused card. */}
                    <div className="shrink-0 px-5 pt-2 pb-4 border-t border-border">
                        {focused ? (
                            <CardActions
                                card={focused}
                                onPickerOpen={() => onOpenChange(false)}
                                onActionTaken={() => {
                                    // If we just discarded the last
                                    // card, close the sheet — fan
                                    // disappears on its own when the
                                    // hand empties.
                                    if (hiderHand.get().length === 0) {
                                        onOpenChange(false);
                                    }
                                }}
                            />
                        ) : null}
                    </div>
                </VaulDrawer.Content>
            </VaulDrawer.Portal>
        </VaulDrawer.Root>
    );
}

/* ────────────────── Per-card actions ────────────────── */

function CardActions({
    card,
    onPickerOpen,
    onActionTaken,
}: {
    card: Card;
    onPickerOpen: () => void;
    onActionTaken: () => void;
}) {
    const [pickerAction, setPickerAction] = useState<PickerAction>(null);
    const [castCurse, setCastCurse] = useState<CurseCard | null>(null);

    const onPlayPowerup = (c: PowerupCard) => {
        const hand = hiderHand.get();
        switch (c.powerup) {
            case "discard1draw2":
                if (hand.length < 2) {
                    toast.error(
                        "Need at least one other card to discard first.",
                    );
                    return;
                }
                onPickerOpen();
                setPickerAction({
                    kind: "discard-and-draw",
                    powerupId: c.id,
                    powerupName: c.name,
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
                onPickerOpen();
                setPickerAction({
                    kind: "discard-and-draw",
                    powerupId: c.id,
                    powerupName: c.name,
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
                onPickerOpen();
                setPickerAction({
                    kind: "duplicate",
                    powerupId: c.id,
                });
                return;
            case "draw1expand": {
                const limit = hiderHandLimit.get();
                discardCard(c.id);
                hiderHandLimit.set(limit + 1);
                const drawn = drawCards(1);
                toast.success(
                    `Hand cap raised to ${limit + 1}. Drew ${drawn.length} card${drawn.length === 1 ? "" : "s"}.`,
                    { autoClose: 2500 },
                );
                onActionTaken();
                return;
            }
            case "veto":
                discardCard(c.id);
                toast.info(
                    "Veto played. Tell the seeker no answer is coming and earn no reward — they can still ask their next question.",
                    { autoClose: 5000 },
                );
                onActionTaken();
                return;
            case "randomize":
                discardCard(c.id);
                toast.info(
                    "Randomize played. Pick a different un-asked question from the same category at random — answer that one instead.",
                    { autoClose: 5000 },
                );
                onActionTaken();
                return;
            case "move":
                if (
                    !confirm(
                        "Move card: this discards your entire hand and sends your station to the seekers. A fresh hiding period starts after this confirms. Proceed?",
                    )
                ) {
                    return;
                }
                for (const c2 of [...hiderHand.get()]) {
                    discardCard(c2.id);
                }
                toast.info(
                    "Hand discarded. Send your current station to the seekers and pick a new hiding zone — seekers are frozen during this period.",
                    { autoClose: 6000 },
                );
                onActionTaken();
                return;
        }
    };

    // Action row: always Discard, plus a Play CTA for cards that
    // have an effect to fire. Time-bonus cards have no playable
    // effect (they only count when held at round end) so only
    // Discard shows. Powerups and curses both label their action
    // "Play" — unified language even though the underlying code
    // path differs (powerup → onPlayPowerup, curse → cast dialog).
    const playable = card.kind === "powerup" || card.kind === "curse";
    return (
        <>
            <div className="flex items-stretch gap-2">
                <DiscardButton card={card} onDiscarded={onActionTaken} />
                {playable && (
                    <Button
                        type="button"
                        onClick={() => {
                            if (card.kind === "powerup") {
                                onPlayPowerup(card);
                            } else if (card.kind === "curse") {
                                onPickerOpen();
                                setCastCurse(card);
                            }
                        }}
                        className="flex-1 gap-1.5 h-12 text-base font-semibold"
                    >
                        {card.kind === "curse" ? (
                            <Zap className="w-5 h-5" />
                        ) : (
                            <Sparkles className="w-5 h-5" />
                        )}
                        Play
                    </Button>
                )}
            </div>

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

            <CastCurseDialog
                open={castCurse !== null}
                onOpenChange={(o) => {
                    if (!o) setCastCurse(null);
                }}
                card={castCurse}
            />
        </>
    );
}

type PickerAction =
    | {
          kind: "discard-and-draw";
          powerupId: string;
          discardCount: number;
          drawCount: number;
          powerupName: string;
      }
    | {
          kind: "duplicate";
          powerupId: string;
      }
    | null;

function DiscardButton({
    card,
    onDiscarded,
}: {
    card: Card;
    onDiscarded: () => void;
}) {
    return (
        <AlertDialog>
            <AlertDialogTrigger asChild>
                <Button
                    type="button"
                    variant="secondary"
                    className="flex-1 gap-1.5 h-12 text-base font-semibold"
                >
                    <Trash2 className="w-5 h-5" />
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
                    <AlertDialogAction
                        onClick={() => {
                            discardCard(card.id);
                            onDiscarded();
                        }}
                    >
                        Discard
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}

export default HiderHandFan;
