import { useStore } from "@nanostores/react";
import { Trash2, X } from "lucide-react";
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
import { appConfirm } from "@/lib/confirm";
import { endgameStartedAt, gameSize } from "@/lib/gameSetup";
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
import { playMovePowerup } from "@/lib/roundActions";
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
    // v300: dialog state hoisted out of CardActions. CardActions
    // lives inside Vaul's Content, so when the carousel closes (e.g.
    // because the user just tapped Play and the picker / cast
    // dialog needs to take over), CardActions used to unmount along
    // with the Vaul Content tree — taking the freshly-set dialog
    // state with it. The dialog would flicker into existence and
    // immediately disappear. Owning the state up here makes both
    // dialogs survive the carousel close.
    const [pickerAction, setPickerAction] = useState<PickerAction>(null);
    const [castCurse, setCastCurse] = useState<CurseCard | null>(null);

    if ($hand.length === 0 && pickerAction === null && castCurse === null) {
        // Empty hand: nothing to fan and no in-flight dialog flow to
        // finish. Unmount cleanly. Once a dialog is open we keep
        // ourselves mounted until it dismisses so the cast / pick
        // flow can complete even if the play burns down to zero
        // cards mid-flow.
        return null;
    }

    return (
        <>
            {$hand.length > 0 && (
                <Fan
                    hand={$hand}
                    gameSize={$gameSize}
                    onCardTap={(idx) => {
                        setInitialIndex(idx);
                        setOpen(true);
                    }}
                />
            )}
            {$hand.length > 0 && (
                <HandCarousel
                    open={open}
                    onOpenChange={setOpen}
                    hand={$hand}
                    gameSize={$gameSize}
                    initialIndex={initialIndex}
                    setPickerAction={setPickerAction}
                    setCastCurse={setCastCurse}
                />
            )}

            {/* v300: picker + curse dialogs live at the HiderHandFan
                level so they outlive a carousel close. CardActions
                reaches them via the setters threaded through
                HandCarousel. */}
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
                    pickerAction ? [pickerAction.powerupId] : []
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

            {/* v303: hand-cap enforcer. Watches hand vs limit; pops a
                non-dismissible picker whenever the hand is over.
                Round reset already zeroes hand + resets limit to 6
                (resetHiderRoundState), so this never fires off the
                top of a new round. */}
            <HandTrimPicker />
        </>
    );
}

/**
 * Hand-overflow enforcer. Rulebook (p44): the hider can hold at
 * most six cards (raisable via the Draw-1-Expand powerup). Draws
 * from question rewards, duplicate powerups, etc. can push the
 * hand past that. When they do, this picker opens — non-dismissible
 * — and forces the hider to choose which N cards to discard down
 * to the limit before the carousel / map become interactive
 * again. Click-outside / escape are blocked; the only way to
 * close it is to make the required picks.
 */
function HandTrimPicker() {
    const $hand = useStore(hiderHand);
    const $limit = useStore(hiderHandLimit);
    const overage = Math.max(0, $hand.length - $limit);

    if (overage === 0) return null;

    return (
        <HandCardPicker
            open={true}
            onOpenChange={() => {
                /* non-dismissible — the hider must trim to limit */
            }}
            nonDismissible
            title={`Hand cap ${$limit} — discard ${overage}`}
            description={`You're holding ${$hand.length} cards but the cap is ${$limit}. Pick ${overage === 1 ? "one card" : `${overage} cards`} to discard.`}
            pickCount={overage}
            excludeIds={[]}
            confirmLabel={`Discard ${overage}`}
            onConfirm={(ids) => {
                for (const id of ids) discardCard(id);
            }}
        />
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
    // Poker-card proportions (5:7). v289 nudged CARD_H from 104 →
    // 106 so the fan's miniature matches CardTile's `aspect-[5/7]`
    // exactly — the cards represent physical poker-format cards, so
    // their shape stays consistent across every surface.
    const CARD_W = 76;
    const CARD_H = 106;
    // The fan strip is a peek — only the top half of each card sits
    // above the viewport edge at rest, with the bottom half clipped
    // off-screen so the cards read as a hand resting in your lap. The
    // peek-on-press gesture (below) compensates for this baseline
    // offset so the lifted card still rises clear of the strip.
    const PEEK_OFFSET = Math.round(CARD_H / 2);
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
    // Stable resting hit rects captured at press start. The card the
    // user is currently peeking grows MUCH larger via transform —
    // getBoundingClientRect() returns those transformed bounds, which
    // moves the active hit area away from where the finger is. That
    // caused the v164 flicker bug. Using the resting rect captured
    // BEFORE any preview applies keeps the hit target stable through
    // the whole press.
    const stableRectsRef = useRef<DOMRect[]>([]);

    const setPreview = (idx: number | null) => {
        previewRef.current = idx;
        setPreviewIndex(idx);
    };

    const hitTest = (
        clientX: number,
        clientY: number,
        currentIdx: number | null,
    ): number | null => {
        const rects = stableRectsRef.current;
        // Hysteresis: prefer staying on the current card. The press
        // expands the active card's hit area by HYSTERESIS_PX on
        // every side, so jitter on the seam between two cards doesn't
        // flip the preview. Combined with the stable resting rects,
        // this keeps the focus locked to whatever the finger was on
        // until it has moved a clear distance away.
        const HYSTERESIS_PX = 14;
        if (currentIdx !== null) {
            const r = rects[currentIdx];
            if (r) {
                if (
                    clientX >= r.left - HYSTERESIS_PX &&
                    clientX <= r.right + HYSTERESIS_PX &&
                    clientY >= r.top - HYSTERESIS_PX &&
                    clientY <= r.bottom + HYSTERESIS_PX
                ) {
                    return currentIdx;
                }
            }
        }
        // Walk top-to-bottom of the z-order (last index = topmost) so
        // the front-facing card wins overlapping pixels.
        for (let i = rects.length - 1; i >= 0; i--) {
            const r = rects[i];
            if (!r) continue;
            if (
                clientX >= r.left &&
                clientX <= r.right &&
                clientY >= r.top &&
                clientY <= r.bottom
            ) {
                return i;
            }
        }
        return null;
    };

    const startPress = (e: React.PointerEvent, idx: number) => {
        if (activePointerRef.current !== null) return; // single-touch only
        activePointerRef.current = e.pointerId;
        // Snapshot the resting hit rects BEFORE we set the preview
        // state. setPreview synchronously triggers a re-render whose
        // transform would otherwise be reflected in the rects on the
        // next paint. Even though the rects we capture here come from
        // the un-previewed DOM (since no flush has happened yet), the
        // safer pattern is "snapshot first, transform second" — and
        // it makes the intent unambiguous to readers.
        stableRectsRef.current = cardRefs.current.map((btn) =>
            btn ? btn.getBoundingClientRect() : new DOMRect(),
        );
        setPreview(idx);

        const onMove = (ev: PointerEvent) => {
            if (ev.pointerId !== activePointerRef.current) return;
            setPreview(
                hitTest(ev.clientX, ev.clientY, previewRef.current),
            );
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
                // Resting strip is only the visible top half of the
                // cards plus a small chrome gap. The cards' bottom
                // halves extend off-screen (clipped by the viewport
                // edge); the peek-preview lifts the active card UP
                // above the strip — overflow is intentionally visible
                // so that gesture isn't clipped.
                height: PEEK_OFFSET + 16,
                paddingBottom: "env(safe-area-inset-bottom)",
            }}
        >
            {/* Backdrop matches the bottom nav exactly so nav + hand
                read as one continuous chrome bar. Sits below the cards
                via z-order (cards are in the absolutely-positioned
                inner div, painted after the backdrop). */}
            <div
                aria-hidden
                className={cn(
                    "absolute inset-0 pointer-events-none",
                    "bg-background/95 backdrop-blur-md border-t border-border",
                )}
            />
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
                    // previewed card stands upright, lift it well
                    // clear of the fan, and scale up considerably so
                    // it reads as the obvious focal point. The
                    // resting fan strip stays the same size, so the
                    // peek floats above any neighbouring card.
                    // previewTranslate absorbs PEEK_OFFSET (the
                    // baseline downward push that makes the cards peek
                    // at rest) so a lifted card ends up at the same
                    // absolute screen position it would have without
                    // the peek baseline.
                    const previewTranslate = previewed ? 70 + PEEK_OFFSET : 0;
                    const previewScale = previewed ? 1.9 : 1;
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
                                transform: `translateX(${x}px) translateY(${-yLift - previewTranslate + PEEK_OFFSET}px) rotate(${cardRotate}deg) scale(${previewScale})`,
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

// v909 peek-carousel geometry (mirrors DrawPickerDialog): the active
// card is CARD_BASIS_PCT% of the container, centred, so PEEK_PCT% of
// each neighbour shows at the edges. A horizontal drag past
// SWIPE_THRESHOLD px flicks to the neighbour. A TRANSLATED track (not
// scroll-snap) always locks onto exactly one card — the old scroll-snap
// version landed a few px off-centre and left the action row
// misaligned, which the v299–v311 rAF-scroll-polling never fully cured.
const CARD_BASIS_PCT = 80;
const PEEK_PCT = (100 - CARD_BASIS_PCT) / 2;
const SWIPE_THRESHOLD = 45;

function HandCarousel({
    open,
    onOpenChange,
    hand,
    gameSize: $gameSize,
    initialIndex,
    setPickerAction,
    setCastCurse,
}: {
    open: boolean;
    onOpenChange: (next: boolean) => void;
    hand: Card[];
    gameSize: ReturnType<typeof gameSize.get>;
    /** Index in `hand` to scroll to when the drawer opens. */
    initialIndex: number;
    /** Setters threaded down to CardActions so its Play/Powerup
     *  flows can hand off to dialogs that live one level higher
     *  (and thus survive the carousel close — see HiderHandFan
     *  v300 comment). */
    setPickerAction: (action: PickerAction) => void;
    setCastCurse: (card: CurseCard | null) => void;
}) {
    // Which card is centred. The action buttons below act on it. Driven
    // directly by swipe / tap / dots — no scroll-snap, so it's always
    // exact (v909; the old scroll-snap + rAF-polling version landed a few
    // px off-centre, misaligning the action row — v299–v311's whole saga).
    const [focusIndex, setFocusIndex] = useState(initialIndex);
    // v909: peek-carousel drag bookkeeping — live finger-follow via
    // `dragDx` (px), snapping on release; `dragRef.moved` marks a gesture
    // that became a SWIPE so its trailing tap is suppressed.
    const [dragDx, setDragDx] = useState(0);
    const [dragging, setDragging] = useState(false);
    const dragRef = useRef<{ x: number; y: number; moved: boolean } | null>(
        null,
    );

    // On open: clamp the requested initial index against the current
    // hand size and centre it. A translated track needs only the index —
    // no scrollLeft juggling / rAF race with iOS Safari snap-correction.
    useEffect(() => {
        if (!open) return;
        setFocusIndex(
            Math.max(0, Math.min(initialIndex, hand.length - 1)),
        );
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, initialIndex]);

    // Card the carousel actions act on. Out-of-bounds index is possible
    // right after a discard shrinks the hand below the previous focus.
    const focused = hand[focusIndex] ?? hand[hand.length - 1] ?? null;

    // v299: keep focusIndex in sync with the hand when a discard / draw
    // shrinks or grows it from under us, so the pagination dot + action
    // row stay on the card actually centred.
    const prevHandLen = useRef(hand.length);
    useEffect(() => {
        if (!open) return;
        if (hand.length === prevHandLen.current) return;
        prevHandLen.current = hand.length;
        if (hand.length === 0) return;
        setFocusIndex((i) => Math.min(i, hand.length - 1));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [hand.length, open]);

    // v299: Android back gesture / browser back button closes the
    // carousel instead of navigating away from the route. We push a
    // throwaway history entry on open; popstate fires on back. If
    // the drawer closes by other means (X button, click outside,
    // Vaul swipe-down), the cleanup pops the entry itself so we
    // don't leak history entries.
    const closedByPop = useRef(false);
    useEffect(() => {
        if (!open || typeof window === "undefined") return;
        const sentinel = "jl-hand-carousel";
        closedByPop.current = false;
        try {
            window.history.pushState({ [sentinel]: true }, "");
        } catch {
            /* history may be unavailable in some embedded views */
        }
        const onPopState = () => {
            // Back gesture popped our sentinel; don't try to pop it
            // again in cleanup or we'd eat the user's real history.
            closedByPop.current = true;
            onOpenChange(false);
        };
        window.addEventListener("popstate", onPopState);
        return () => {
            window.removeEventListener("popstate", onPopState);
            if (closedByPop.current) return;
            try {
                const state = window.history.state as Record<
                    string,
                    unknown
                > | null;
                if (state && state[sentinel]) {
                    window.history.back();
                }
            } catch {
                /* noop */
            }
        };
    }, [open, onOpenChange]);

    return (
        <VaulDrawer.Root
            open={open}
            onOpenChange={onOpenChange}
            shouldScaleBackground={false}
            // v302: turn off Vaul's drag-to-dismiss. The user was
            // able to swipe the entire Content (cards + close
            // button) around without ever crossing the dismiss
            // threshold, leaving the carousel half-shifted with the
            // map / nav peeking through behind it. Click-outside,
            // the X button, the back gesture, and Escape still
            // dismiss — the drag is the only thing we kill.
            dismissible={false}
        >
            <VaulDrawer.Portal>
                {/* Dim the UI behind so the focused card pops, but
                    no opaque sheet — this isn't a separate page,
                    it's "lift your cards up to your eyes". */}
                <VaulDrawer.Overlay className="fixed inset-0 z-[1050] bg-black/55 backdrop-blur-sm" />
                <VaulDrawer.Content
                    onClick={(e) => {
                        // v299: tapping the empty Content background
                        // (anywhere outside the carousel + action
                        // row + close button) closes the drawer. The
                        // Overlay sits underneath Content so its own
                        // dismiss behaviour is occluded; this onClick
                        // restores click-outside-to-close.
                        if (e.target === e.currentTarget) {
                            onOpenChange(false);
                        }
                    }}
                    className={cn(
                        "fixed inset-0 z-[1051]",
                        // Transparent container — no panel chrome
                        // (no background, border, drag handle, or
                        // page header). The card + its action row
                        // float over the dimmed UI.
                        "flex flex-col items-stretch justify-center",
                        "bg-transparent text-foreground",
                        "px-4 py-6",
                        "pb-[max(env(safe-area-inset-bottom),24px)]",
                    )}
                >
                    {/* v299: explicit close button. Sits top-right
                        of the viewport, above the safe-area inset
                        so it never clashes with the notch/island. */}
                    <button
                        type="button"
                        onClick={() => onOpenChange(false)}
                        aria-label="Close hand"
                        className={cn(
                            "absolute right-3 z-[1052]",
                            "top-[calc(env(safe-area-inset-top)+0.5rem)]",
                            "inline-flex items-center justify-center w-10 h-10",
                            "rounded-full bg-background/80 backdrop-blur-sm",
                            "border border-border text-foreground",
                            "hover:bg-background transition-colors",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        )}
                    >
                        <X className="w-5 h-5" />
                    </button>

                    {/* SR-only title — required by Vaul/Radix for
                        accessibility, but visually we keep the
                        carousel chrome-less to preserve the
                        "raising cards to eyes" feel. */}
                    <VaulDrawer.Title className="sr-only">
                        Hand · {focusIndex + 1} of {hand.length}
                    </VaulDrawer.Title>

                    {/* v909: peek-carousel — a TRANSLATED track (not
                        scroll-snap) centres the active card at
                        CARD_BASIS_PCT% width so the neighbours PEEK at the
                        edges (scaled + dimmed). A horizontal swipe flicks
                        between cards with a live finger-follow, snapping on
                        release; tapping a peeking neighbour centres it. The
                        translate always locks onto exactly one card, so the
                        action row below never drifts off-centre. */}
                    <div className="mx-auto w-full max-w-md">
                        <div
                            role="region"
                            aria-label="Hand cards"
                            className="relative overflow-hidden py-2"
                            onTouchStart={(e) => {
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
                                // Only a clearly-horizontal drag is a swipe.
                                if (
                                    Math.abs(dx) > 8 &&
                                    Math.abs(dx) > Math.abs(dy)
                                ) {
                                    d.moved = true;
                                    setDragDx(dx);
                                }
                            }}
                            onTouchEnd={() => {
                                const dx = dragDx;
                                setDragDx(0);
                                setDragging(false);
                                if (
                                    dx < -SWIPE_THRESHOLD &&
                                    focusIndex < hand.length - 1
                                ) {
                                    setFocusIndex((i) => i + 1);
                                } else if (
                                    dx > SWIPE_THRESHOLD &&
                                    focusIndex > 0
                                ) {
                                    setFocusIndex((i) => i - 1);
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
                                        focusIndex * CARD_BASIS_PCT
                                    }% + ${dragDx}px))`,
                                }}
                            >
                                {hand.map((card, i) => {
                                    const isActive = i === focusIndex;
                                    return (
                                        <div
                                            key={card.id}
                                            className="shrink-0 flex justify-center px-1.5"
                                            style={{
                                                flexBasis: `${CARD_BASIS_PCT}%`,
                                            }}
                                            aria-current={isActive}
                                        >
                                            <div
                                                className={cn(
                                                    "w-full transition-all duration-300 ease-out",
                                                    isActive
                                                        ? "scale-100 opacity-100"
                                                        : "scale-[0.86] opacity-45",
                                                )}
                                                onClick={() => {
                                                    // A swipe suppresses the
                                                    // trailing tap.
                                                    if (
                                                        dragRef.current?.moved
                                                    ) {
                                                        dragRef.current.moved =
                                                            false;
                                                        return;
                                                    }
                                                    if (!isActive)
                                                        setFocusIndex(i);
                                                }}
                                            >
                                                <div
                                                    className="w-full"
                                                    style={{
                                                        aspectRatio: "5 / 7",
                                                    }}
                                                >
                                                    <CardTile
                                                        card={card}
                                                        gameSize={$gameSize}
                                                        selectionIndicator="none"
                                                        className="h-full w-full"
                                                    />
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>

                        {/* Action row sits IMMEDIATELY below the card, not
                            stuck to the bottom of the viewport — the card +
                            actions read as a single object you've brought
                            up. Same max width as the active card. */}
                        {focused && (
                            <div className="mx-auto w-[80%] max-w-[360px] mt-3 px-[10%] sm:px-0">
                                <CardActions
                                    card={focused}
                                    onPickerOpen={() => onOpenChange(false)}
                                    setPickerAction={setPickerAction}
                                    setCastCurse={setCastCurse}
                                    onActionTaken={() => {
                                        // If we just discarded the last
                                        // card, close the sheet — fan
                                        // disappears on its own when the
                                        // hand empties.
                                        if (
                                            hiderHand.get().length === 0
                                        ) {
                                            onOpenChange(false);
                                        }
                                    }}
                                />
                            </div>
                        )}

                        {/* Pagination dots — cheap navigation hint. */}
                        {hand.length > 1 && (
                            <div className="flex items-center justify-center gap-1.5 mt-4">
                                {hand.map((_, i) => (
                                    <button
                                        key={i}
                                        type="button"
                                        aria-label={`Show card ${i + 1}`}
                                        onClick={() => setFocusIndex(i)}
                                        className={cn(
                                            "rounded-full transition-all duration-200",
                                            i === focusIndex
                                                ? "w-4 h-1.5 bg-primary"
                                                : "w-1.5 h-1.5 bg-white/40",
                                        )}
                                    />
                                ))}
                            </div>
                        )}
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
    setPickerAction,
    setCastCurse,
}: {
    card: Card;
    onPickerOpen: () => void;
    onActionTaken: () => void;
    /** v300: setters threaded down from HiderHandFan; the dialogs
     *  they drive are mounted up there too so they outlive the
     *  carousel-Content unmount. */
    setPickerAction: (action: PickerAction) => void;
    setCastCurse: (card: CurseCard | null) => void;
}) {
    const onPlayPowerup = async (c: PowerupCard) => {
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
                // v887: Randomize is a RESPONSE card — it swaps the question
                // you're answering for a random one, so it can only be played
                // FROM a question (the answer dialog's response actions), never
                // standalone from the hand. Direct the hider there instead of
                // discarding it for no effect.
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
                for (const c2 of [...hiderHand.get()]) {
                    discardCard(c2.id);
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
                onActionTaken();
                return;
            }
        }
    };

    // Action row: always Discard, plus a Play CTA for cards that
    // have an effect to fire. Time-bonus cards have no playable
    // effect (they only count when held at round end) so only
    // Discard shows. Powerups and curses both label their action
    // "Play" — unified language even though the underlying code
    // path differs (powerup → onPlayPowerup, curse → cast dialog).
    const playable = card.kind === "powerup" || card.kind === "curse";
    // v1020: the Move powerup can't be played during the endgame (the hider is
    // locked to their final spot — rulebook p7). Disable its Play button with
    // an explanation instead of letting the tap fire and error.
    const $endgame = useStore(endgameStartedAt);
    const moveBlocked =
        card.kind === "powerup" &&
        card.powerup === "move" &&
        $endgame !== null;
    return (
        <>
            <div className="flex items-stretch gap-2">
                <DiscardButton card={card} onDiscarded={onActionTaken} />
                {playable && (
                    <Button
                        type="button"
                        disabled={moveBlocked}
                        onClick={() => {
                            if (card.kind === "powerup") {
                                onPlayPowerup(card);
                            } else if (card.kind === "curse") {
                                onPickerOpen();
                                setCastCurse(card);
                            }
                        }}
                        className="flex-1 h-12 text-base font-semibold"
                    >
                        Play
                    </Button>
                )}
            </div>
            {moveBlocked && (
                <p className="mt-2 rounded-md border border-border bg-background px-3 py-2 text-xs text-foreground leading-snug text-center shadow-sm">
                    Move can't be played during the endgame — you're locked to
                    your final hiding spot.
                </p>
            )}
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
