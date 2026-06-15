import { useStore } from "@nanostores/react";
import { ArrowDown, Check } from "lucide-react";
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
import { SectionPill } from "./JetLagLogo";

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
        setFlyingId(id);
        setSelectedId(null);
        // After the fly animation, mark the card as kept (it becomes
        // invisible) and either present the next pick or kick off the
        // final fade-out of the discards.
        const t1 = window.setTimeout(() => {
            const next = [...keptIds, id];
            setKeptIds(next);
            setFlyingId(null);
            if (next.length >= keep) {
                setFinished(true);
                // Discards fade + fall, then we hand off to the
                // resolver which moves cards into hand / discard and
                // clears the pending atom (closes the dialog).
                const t2 = window.setTimeout(() => {
                    resolvePendingDraw(next);
                }, FADE_MS + FINAL_HOLD_MS);
                timersRef.current.push(t2);
            }
        }, FLY_MS);
        timersRef.current.push(t1);
    };

    const handleCardTap = (id: string) => {
        if (flyingId || finished) return;
        if (keptIds.includes(id)) return;
        setSelectedId((curr) => (curr === id ? null : id));
    };

    const cols = total <= 2 ? 2 : total === 3 ? 3 : 2; // 4 → 2x2

    return (
        <Dialog open={true}>
            <DialogContent
                className={cn(
                    "!bg-[hsl(var(--sidebar-background))] !text-[hsl(var(--sidebar-foreground))]",
                    "flex flex-col p-0 gap-0",
                    "max-h-[92vh] sm:max-w-lg",
                    // Allow the flying card to translate well below
                    // the dialog body without being clipped at the
                    // border — the modal itself stays in place; only
                    // the card animates beyond it.
                    "overflow-visible",
                )}
            >
                <div className="px-6 pt-5 pb-3 shrink-0 border-b border-border">
                    <div className="mb-2 flex items-center gap-2">
                        <SectionPill>Hider reward</SectionPill>
                        <span className="text-[10px] uppercase tracking-[0.18em] font-semibold text-muted-foreground ml-auto">
                            {capitalize($pending.sourceCategory)}
                        </span>
                    </div>
                    <DialogTitle className="font-inter-tight font-black uppercase text-xl tracking-tight leading-tight">
                        Draw {total}, keep {keep}
                    </DialogTitle>
                    <DialogDescription className="mt-1.5 text-sm">
                        Tap a card to highlight it, then tap{" "}
                        <span className="font-semibold text-foreground">
                            Keep this card
                        </span>{" "}
                        below it. The rest are discarded once you're
                        done picking.
                    </DialogDescription>
                </div>

                <div
                    className={cn(
                        "px-4 py-4 min-h-0",
                        // No scroll: 2-4 cards always fit. Keeping the
                        // container non-scrolling lets the flying card
                        // translate downward freely without clipping.
                        "overflow-visible",
                    )}
                >
                    <div
                        className={cn(
                            "grid gap-3",
                            cols === 2 && "grid-cols-2",
                            cols === 3 && "grid-cols-3",
                        )}
                    >
                        {$pending.cards.map((card) => {
                            const isSelected = selectedId === card.id;
                            const isKept = keptIds.includes(card.id);
                            const isFlying = flyingId === card.id;
                            const isFading =
                                finished && !keptIds.includes(card.id);
                            return (
                                <CardCell
                                    key={card.id}
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
                            );
                        })}
                    </div>
                </div>

                <div className="px-6 py-4 shrink-0 border-t border-border flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground tabular-nums">
                        {finished
                            ? "Discarding the rest…"
                            : `${picksRemaining} pick${picksRemaining === 1 ? "" : "s"} remaining`}
                    </span>
                    <span
                        className={cn(
                            "text-[10px] uppercase tracking-[0.16em] font-poppins font-bold",
                            picksRemaining === 0
                                ? "text-primary"
                                : "text-muted-foreground",
                        )}
                    >
                        {keptIds.length} / {keep} kept
                    </span>
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
    // Card transform per phase. Defaults (resting + highlighted) sit
    // in the grid spot; flying / fading / kept apply transforms with
    // their own transition profiles.
    const cardStyle: CSSProperties = (() => {
        if (isFlying) {
            return {
                transform: "translateY(70vh) scale(0.25) rotate(-3deg)",
                opacity: 0.6,
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
        <div className="flex flex-col items-center gap-2">
            <div
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
                        <ArrowDown className="w-3.5 h-3.5" />
                        Keep this card
                        <Check className="w-3.5 h-3.5" />
                    </Button>
                )}
            </div>
        </div>
    );
}

function capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

export default DrawPickerDialog;
