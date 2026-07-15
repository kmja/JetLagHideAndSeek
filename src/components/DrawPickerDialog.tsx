import { useStore } from "@nanostores/react";
import { Check } from "lucide-react";
import { type CSSProperties, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogTitle,
} from "@/components/ui/dialog";
import { type GameSize, gameSize } from "@/lib/gameSetup";
import { pendingDraw, resolvePendingDraw } from "@/lib/hiderRole";
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
            setKeptIds([...keptIds, id]);
            setFlyingId(null);
        }, FLY_MS);
        timersRef.current.push(t1);
    };

    const handleCardTap = (id: string) => {
        if (flyingId || finished) return;
        if (keptIds.includes(id)) return;
        setSelectedId((curr) => (curr === id ? null : id));
    };

    // v883: the cards are shown in a horizontal CAROUSEL (scroll-snap) rather
    // than a grid — at poker (5:7) proportions two or more cards side-by-side
    // on a phone became too small and clipped their descriptions. Each card is
    // ~one-at-a-time width so ALL its content fits; the hider swipes between
    // them and taps "Pick this card". The flying-to-hand card escapes the
    // carousel's overflow via `position: fixed` (see CardCell).

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
                        "text-3xl tracking-tight leading-tight text-foreground",
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

                <div
                    className={cn(
                        "flex gap-3 items-start px-[11%] py-2",
                        // Horizontal scroll-snap carousel — one card at a time
                        // with the neighbours peeking. Scrollbar hidden.
                        "overflow-x-auto snap-x snap-mandatory",
                        "[scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden",
                    )}
                >
                    {$pending.cards.map((card) => {
                        const isSelected = selectedId === card.id;
                        const isKept = keptIds.includes(card.id);
                        const isFlying = flyingId === card.id;
                        const isFading =
                            chromeFadeOn && !isKept && !isFlying;
                        return (
                            <div
                                key={card.id}
                                className="snap-center shrink-0 w-[78%] max-w-[15rem]"
                            >
                                <CardCell
                                    card={card}
                                    gameSize={$gameSize}
                                    isSelected={isSelected}
                                    isKept={isKept}
                                    isFlying={isFlying}
                                    isFading={isFading}
                                    disabled={Boolean(flyingId) || finished}
                                    onTap={() => handleCardTap(card.id)}
                                    onConfirm={confirmSelected}
                                />
                            </div>
                        );
                    })}
                </div>
            </DialogContent>
        </Dialog>
    );
}

/* ────────────────── Single card cell ────────────────── */

function CardCell({
    card,
    gameSize,
    isSelected,
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

    // Card transform per phase. Defaults (resting + highlighted) sit
    // in the grid spot; flying / fading / kept apply transforms with
    // their own transition profiles.
    const cardStyle: CSSProperties = (() => {
        if (isFlying) {
            // v316: until we've measured (one render after isFlying
            // flips true) keep the resting transform so the card
            // doesn't jump. The next render applies the measured
            // translate and the CSS transition fires from rest →
            // target in one smooth motion.
            if (!flyRect) {
                return { transition: "transform 180ms ease-out" };
            }
            // v883: pin to the measured viewport rect so the fly escapes the
            // carousel's overflow clipping, then translate to the hand.
            return {
                position: "fixed",
                left: flyRect.left,
                top: flyRect.top,
                width: flyRect.width,
                zIndex: 60,
                transform: `translate(${flyRect.dx}px, ${flyRect.dy}px) scale(0.36) rotate(-3deg)`,
                opacity: 0.9,
                transition: `transform ${FLY_MS}ms cubic-bezier(.4,.0,.7,.2), opacity ${FLY_MS}ms ease-in`,
                pointerEvents: "none",
            };
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
            {/* Confirm-pick button slot. Reserved height so selecting
                a card doesn't push the grid around. Renders the
                button only for the highlighted card. */}
            <div className="h-10 w-full flex items-center justify-center">
                {isSelected && !isFlying && !isFading && !isKept && (
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
