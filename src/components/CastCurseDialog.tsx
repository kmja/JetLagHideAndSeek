import { useStore } from "@nanostores/react";
import { Copy, Dice5, RotateCw, Share2, Trash2, Zap } from "lucide-react";
import type { CSSProperties } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "react-toastify";

import { renderBodyText } from "@/components/CardTile";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogTitle,
} from "@/components/ui/dialog";
import { gameSize } from "@/lib/gameSetup";
import type { CurseCard } from "@/lib/hiderDeck";
import { discardCard } from "@/lib/hiderRole";
import { multiplayerEnabled } from "@/lib/multiplayer/session";
import { hiderCastCurse } from "@/lib/multiplayer/store";
import { encodeCurseLink, shareOrCopy } from "@/lib/shareLinks";
import { cn } from "@/lib/utils";

/**
 * Confirm-and-cast dialog for curses. Surfaces:
 *
 *   • Casting cost — the printed condition the hider must satisfy
 *     (carry an egg, photograph an animal, etc.). Reading it once
 *     here means the hider can't miss it.
 *
 *   • Inline dice roller when the casting cost involves rolling a
 *     die that can fizzle the curse outright (Endless Tumble fizzles
 *     on 5/6; Gambler's Feet fizzles on even). The roller has the
 *     primary "Cast" button gated until the roll has happened, and
 *     swaps the success message when the curse auto-fizzles.
 *
 *   • The "Cast on seekers" action — shares the curse via
 *     `encodeCurseLink` so the seekers can tap to receive it, then
 *     moves the card to discard regardless of share outcome (since
 *     casting cost has already been paid by the hider).
 *
 * Falls through silently for curses with no special pre-cast roll —
 * the dialog still surfaces the cost but skips the dice widget.
 */

/**
 * Per-card fizzle rules. Each entry maps the curse name to:
 *   - a brief explainer of the dice mechanic
 *   - the set of die-roll values that *fizzle* (no effect, card still
 *     spent — the curse is wasted)
 *
 * Exported so other modules (e.g. the debug panel's "Add random
 * rollable curse" button) can identify which curses trigger the
 * dice-roll flow without duplicating the list.
 */
export const DICE_FIZZLE: Record<
    string,
    { fizzleOn: number[]; explainer: string } | undefined
> = {
    "Curse of the Endless Tumble": {
        fizzleOn: [5, 6],
        explainer: "Roll a die. On 5 or 6 the curse has no effect.",
    },
    "Curse of the Gambler's Feet": {
        fizzleOn: [2, 4, 6],
        explainer: "Roll a die. On an even number the curse has no effect.",
    },
};

export function CastCurseDialog({
    open,
    onOpenChange,
    card,
}: {
    open: boolean;
    onOpenChange: (o: boolean) => void;
    card: CurseCard | null;
}) {
    const $gameSize = useStore(gameSize);
    const $multiplayer = useStore(multiplayerEnabled);
    const fizzleRule = card ? DICE_FIZZLE[card.name] : undefined;
    const [rolled, setRolled] = useState<number | null>(null);
    const [rolling, setRolling] = useState(false);
    const [sharing, setSharing] = useState(false);
    /** Tracks the most recent shareOrCopy outcome so we can show a
     *  retry hint when the user dismissed / failed the share sheet
     *  without sending. Cleared on dialog re-open. */
    const [lastShareResult, setLastShareResult] = useState<
        "share" | "copy" | "cancelled" | "failed" | null
    >(null);
    /** Set briefly after the tumble settles so the dice display
     *  scales up via the jlDiceReveal keyframe — the "big reveal"
     *  moment before any side-effects (confetti, fizzle) fire. */
    const [reveal, setReveal] = useState(false);
    /** Set on a successful (non-fizzle) settle to trigger the
     *  confetti burst. Cleared automatically after the animation
     *  finishes so re-opening the dialog for another curse doesn't
     *  show stale pieces. */
    const [showConfetti, setShowConfetti] = useState(false);
    /** Set on a fizzle settle to trigger the red shake + flash on
     *  the dialog content. */
    const [showFizzleEffect, setShowFizzleEffect] = useState(false);
    /** ID-incrementing rollKey so repeat rolls on the same dialog
     *  instance get fresh animation runs. */
    const rollKeyRef = useRef(0);

    // Pre-compute confetti piece directions so the burst feels
    // organic. Memoised per roll — `showConfetti` going false→true
    // is the signal for a fresh layout, and the recompute fires
    // before render so the pieces are already in place when the
    // confetti container mounts.
    //
    // ⚠ This hook MUST stay above the early `if (!card) return null`
    // below, otherwise the React hook order changes between renders
    // where `card` is null (8 hooks) and renders where `card` is
    // populated (9 hooks). That's a hard Rules-of-Hooks violation
    // and it blew the whole hider page up with the "change in the
    // order of Hooks" warning + a crashed render tree the first
    // time the user opened a curse dialog.
    const confettiPieces = useMemo(() => {
        return Array.from({ length: 48 }, () => {
            const angle = Math.random() * Math.PI * 2;
            const dist = 140 + Math.random() * 220;
            return {
                dx: Math.cos(angle) * dist,
                dy: Math.sin(angle) * dist - 60, // bias slightly upward
                rot: (Math.random() - 0.5) * 1080,
                color: [
                    "#DC3D38", // red — brand
                    "#F5C842", // yellow — small size
                    "#F19748", // orange — medium size
                    "#3B82F6", // blue
                    "#22C55E", // green
                    "#A855F7", // purple — curse theme
                    "#FFFFFF", // white
                ][Math.floor(Math.random() * 7)],
                delay: Math.random() * 0.25,
            };
        });
    }, [showConfetti]);

    useEffect(() => {
        if (open) {
            setRolled(null);
            setRolling(false);
            setSharing(false);
            setReveal(false);
            setShowConfetti(false);
            setShowFizzleEffect(false);
            setLastShareResult(null);
        }
    }, [open, card?.id]);

    if (!card) return null;

    // `rolled` is the *live* tumble display — it cycles through
    // random values every animation frame, so reading it directly
    // in derived state (canCast / fizzles / outcome colors / button
    // labels) would make the rest of the UI flicker on every tick.
    // `settled` is the post-tumble committed value: null while the
    // dice is in flight, the final value once `rolling` flips false.
    // Everything downstream that should react to the *outcome*
    // reads `settled`, not `rolled`.
    const settled: number | null = !rolling ? rolled : null;

    const fizzles =
        fizzleRule !== undefined &&
        settled !== null &&
        fizzleRule.fizzleOn.includes(settled);

    const canCast =
        !sharing &&
        // Cards with a fizzle rule need a SETTLED roll before the
        // action button enables; cards without can cast right away.
        (fizzleRule === undefined || settled !== null);

    const roll = () => {
        if (rolling) return;
        setRolling(true);
        rollKeyRef.current += 1;
        const start = Date.now();
        // Total tumble length — generous so the player has time to
        // build tension and read the moving values, then a slowdown
        // at the end before the big reveal.
        const totalMs = 2400;
        const tick = () => {
            const elapsed = Date.now() - start;
            const fraction = Math.min(1, elapsed / totalMs);
            const next = 1 + Math.floor(Math.random() * 6);
            setRolled(next);
            if (fraction < 1) {
                // Delay grows with a cubic curve so the early
                // tumble cycles fast (~50 ms) and the last few
                // cycles linger noticeably (~500 ms). This is the
                // "deceleration" feel — the die appears to lose
                // momentum.
                const baseDelay = 45;
                const peakDelay = 480;
                const delay = baseDelay + (peakDelay - baseDelay) * Math.pow(fraction, 3);
                window.setTimeout(tick, delay);
            } else {
                setRolling(false);
                // Big-reveal pop on the dice itself.
                setReveal(true);
                window.setTimeout(() => setReveal(false), 700);

                // Branch by outcome — but wait a beat so the player
                // has time to read the final value before the side
                // effect fires.
                const isFizzle =
                    fizzleRule !== undefined &&
                    fizzleRule.fizzleOn.includes(next);
                window.setTimeout(() => {
                    if (isFizzle) {
                        setShowFizzleEffect(true);
                        window.setTimeout(
                            () => setShowFizzleEffect(false),
                            900,
                        );
                    } else {
                        setShowConfetti(true);
                        window.setTimeout(
                            () => setShowConfetti(false),
                            1600,
                        );
                    }
                }, 350);

                // No auto-discard. Once the dice settles on a fizzle
                // value, the result stays on screen — letting the
                // hider sit with the disappointment — until they
                // explicitly tap "Discard fizzled curse" themselves.
                // The dialog is locked against escape / outside-
                // clicks by `rolledAndCommitted`, so they still
                // can't back out keeping the card; they just choose
                // when to acknowledge the failure.
            }
        };
        tick();
    };

    const cast = async () => {
        if (!canCast) return;

        // Fizzled curse: spend the card without sharing.
        if (fizzles) {
            discardCard(card.id);
            toast.info(
                `${card.name} fizzled on a ${rolled}. Card moved to discard.`,
                { autoClose: 3000 },
            );
            onOpenChange(false);
            return;
        }

        // In multiplayer the curse travels over the WebSocket — no link needed.
        if ($multiplayer) {
            hiderCastCurse({
                name: card.name,
                description: card.description,
                castingCost: card.castingCost ?? null,
            });
            discardCard(card.id);
            toast.success(`${card.name} cast on seekers.`, { autoClose: 2500 });
            onOpenChange(false);
            return;
        }

        setSharing(true);
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
            setLastShareResult(result.method);
            if (result.method === "share" || result.method === "copy") {
                discardCard(card.id);
                toast.success(
                    `${card.name} sent. Curse moved to discard.`,
                    { autoClose: 2500 },
                );
                onOpenChange(false);
            } else if (result.method === "failed") {
                toast.error(
                    "Could not share the curse — use Copy link below or tap to retry.",
                );
            }
            // "cancelled" → leave the dialog open so the hider can
            // retry. Their casting cost is still paid in real life.
            // The retry hint below the action buttons surfaces the
            // recovery path explicitly.
        } finally {
            setSharing(false);
        }
    };

    /**
     * Manual fallback: copy the curse link to the clipboard. Same
     * end-state as a successful share (card → discard, dialog
     * closes) — gives the hider a single-tap recovery for when the
     * share sheet was dismissed without sending, or when the OS
     * share sheet doesn't include the recipient they need.
     */
    const copyLink = async () => {
        if (!canCast) return;
        if (fizzles) {
            // Defensive: copy shouldn't show on fizzles, but if a
            // future refactor surfaces it, behave like Discard.
            discardCard(card.id);
            onOpenChange(false);
            return;
        }
        setSharing(true);
        try {
            const url = encodeCurseLink({
                name: card.name,
                description: card.description,
                castingCost: card.castingCost ?? null,
            });
            try {
                await navigator.clipboard.writeText(url);
                setLastShareResult("copy");
                discardCard(card.id);
                toast.success(
                    `${card.name} link copied. Curse moved to discard.`,
                    { autoClose: 2500 },
                );
                onOpenChange(false);
            } catch {
                setLastShareResult("failed");
                toast.error(
                    "Couldn't access the clipboard — try the Share button.",
                );
            }
        } finally {
            setSharing(false);
        }
    };

    // Once the player has rolled and the tumble has settled, the
    // dialog becomes committing. Refuse close attempts (Escape,
    // click outside) until the appropriate action is taken —
    // discard the fizzled curse, or cast on the seekers. Without
    // this guard the player could just walk away from a 5/6 roll
    // and keep the curse, which is exactly the cheat the user
    // reported originally.
    const rolledAndCommitted = fizzleRule !== undefined && settled !== null;
    const handleOpenChange = (next: boolean) => {
        if (!next && rolledAndCommitted) {
            // Don't shout — but tell the player why their close
            // attempt didn't take. Use a toastId so spamming Escape
            // doesn't stack toasts.
            toast.info(
                fizzles
                    ? "Roll committed — the curse will fizzle to discard."
                    : "Roll committed — cast the curse to finish.",
                { autoClose: 2500, toastId: "curse-dialog-locked" },
            );
            return;
        }
        onOpenChange(next);
    };

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent
                className={cn(
                    "!bg-[hsl(var(--sidebar-background))] !text-white",
                    "flex flex-col p-0 gap-0",
                    "max-h-[85vh]",
                )}
                // ⚠ Do NOT add `position: relative` here. Radix sets
                // `position: fixed` + a centring transform on the
                // DialogContent root by default, and overriding it
                // with `relative` pushes the content into document
                // flow (it landed at y=1405 below the viewport,
                // leaving the user staring at just the overlay).
                // The confetti container below still anchors fine
                // because absolute children of a fixed parent
                // position relative to that parent.
                //
                // ⚠ Don't put a `transform`-based animation here
                // either. Radix's centring uses `transform:
                // translate(-50%, -50%)` on this element; any
                // animation that sets `transform` (e.g. the fizzle
                // shake) would clobber the centring and the dialog
                // would jump to top-left for the duration. The
                // shake lives on the inner wrapper below; only the
                // box-shadow flash (which doesn't conflict with
                // transform) stays on the outer DialogContent.
                style={
                    showFizzleEffect
                        ? {
                              animation: "jlFizzleFlash 0.9s ease-out",
                          }
                        : undefined
                }
            >
                {/* Inner wrapper just for the shake animation —
                    keeps the transform-based motion off the outer
                    DialogContent so Radix's centring stays put. */}
                <div
                    className="flex flex-col flex-1 min-h-0"
                    style={
                        showFizzleEffect
                            ? {
                                  animation:
                                      "jlFizzleShake 0.9s ease-in-out",
                              }
                            : undefined
                    }
                >
                {/* Confetti burst on a successful roll. Pieces are
                    absolutely positioned at the centre of the dialog
                    content and fly outward using --dx/--dy CSS
                    variables passed in inline style. Mounted only
                    while `showConfetti` is true so the animation
                    plays from t=0 each roll. */}
                {showConfetti && (
                    <div
                        className="pointer-events-none absolute inset-0 z-[100] flex items-center justify-center overflow-visible"
                        aria-hidden="true"
                    >
                        {confettiPieces.map((p, i) => (
                            <span
                                key={i}
                                className="absolute w-2 h-3 rounded-sm"
                                style={
                                    {
                                        background: p.color,
                                        animation: `jlConfettiPop 1.5s cubic-bezier(0.16, 1, 0.3, 1) ${p.delay}s forwards`,
                                        "--dx": `${p.dx}px`,
                                        "--dy": `${p.dy}px`,
                                        "--rot": `${p.rot}deg`,
                                    } as CSSProperties
                                }
                            />
                        ))}
                    </div>
                )}
                <div className="px-6 pt-5 pb-3 shrink-0 border-b border-border flex items-start gap-3">
                    <span className="inline-flex items-center justify-center w-9 h-9 rounded shrink-0 bg-purple-500/20 mt-0.5">
                        <Zap className="w-4 h-4 text-purple-400" />
                    </span>
                    <div className="min-w-0 flex-1">
                        <div className="text-[10px] uppercase tracking-[0.16em] font-poppins font-bold text-muted-foreground">
                            Cast curse
                        </div>
                        <DialogTitle className="font-inter-tight font-black uppercase text-lg tracking-tight leading-tight mt-1">
                            {card.name}
                        </DialogTitle>
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto px-6 py-4 min-h-0 space-y-3 text-sm">
                    <DialogDescription
                        asChild
                        className="text-sm leading-snug text-foreground/90"
                    >
                        {/* `asChild` lets DialogDescription wrap our
                            own <p> so renderBodyText's mix of strings
                            + inline <SizeBadge> spans is valid React
                            without breaking the Radix description
                            semantics (sr-only label still works). */}
                        <p>{renderBodyText(card.description, $gameSize)}</p>
                    </DialogDescription>

                    {card.castingCost && (
                        // One unified "Casting cost" box. For curses
                        // with a dice-fizzle rule the dice widget +
                        // outcome message live INSIDE this box rather
                        // than as a second card below — the printed
                        // casting cost ("Roll a die. On a 5 or 6 …")
                        // is already the instruction the player needs.
                        // Repeating it as a separate explainer just
                        // added visual noise.
                        //
                        // The border/background re-tints once the roll
                        // settles to communicate the outcome — yellow
                        // (pending) → red (fizzle) or green (success).
                        <div
                            className={cn(
                                "rounded-sm border-2 px-3 py-2.5 transition-colors",
                                fizzleRule && settled !== null && fizzles
                                    ? "border-destructive/60 bg-destructive/10"
                                    : fizzleRule &&
                                        settled !== null &&
                                        !fizzles
                                      ? "border-emerald-500/60 bg-emerald-500/10"
                                      : "border-yellow-500/40 bg-yellow-500/5",
                            )}
                        >
                            <div
                                className={cn(
                                    "text-[10px] uppercase tracking-[0.16em] font-poppins font-bold transition-colors",
                                    fizzleRule && settled !== null && fizzles
                                        ? "text-destructive"
                                        : fizzleRule &&
                                            settled !== null &&
                                            !fizzles
                                          ? "text-emerald-400"
                                          : "text-yellow-500",
                                )}
                            >
                                Casting cost
                            </div>
                            <p className="text-xs text-foreground/90 leading-snug mt-1">
                                {renderBodyText(card.castingCost, $gameSize)}
                            </p>

                            {fizzleRule && (
                                <div className="flex flex-col items-center gap-3 pt-4">
                                    <button
                                        type="button"
                                        onClick={roll}
                                        disabled={rolling || rolled !== null}
                                        aria-label="Roll d6"
                                        className={cn(
                                            "shrink-0 w-24 h-24 rounded-xl",
                                            "bg-background border-4 flex items-center justify-center",
                                            "font-inter-tight italic font-black text-6xl tabular-nums",
                                            "transition-all",
                                            // Match the die border to
                                            // the outcome tint — but
                                            // only once the tumble
                                            // settles, so it doesn't
                                            // strobe red/green per
                                            // tick during the roll.
                                            settled === null
                                                ? "border-primary text-primary"
                                                : fizzles
                                                  ? "border-destructive text-destructive"
                                                  : "border-emerald-400 text-emerald-400",
                                            rolling &&
                                                "animate-[jlDiceTumble_300ms_ease-in-out_infinite]",
                                            reveal &&
                                                "animate-[jlDiceReveal_700ms_cubic-bezier(0.34,1.56,0.64,1)_forwards]",
                                            !rolling &&
                                                rolled === null &&
                                                "hover:scale-[1.05] active:scale-95",
                                            "disabled:cursor-default",
                                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                        )}
                                    >
                                        {rolled ?? (
                                            <Dice5 className="w-10 h-10" />
                                        )}
                                    </button>
                                    <div className="text-sm text-center leading-snug">
                                        {rolled === null ? (
                                            <div className="space-y-1.5">
                                                <div className="text-muted-foreground">
                                                    Tap to roll the die.
                                                </div>
                                                <div className="text-[11px] uppercase tracking-[0.12em] font-poppins font-bold text-yellow-500/90">
                                                    ⚠ This commits you to
                                                    playing the curse
                                                </div>
                                                <div className="text-[11px] text-muted-foreground italic leading-snug">
                                                    Once rolled, you can&apos;t
                                                    back out — the card either
                                                    casts on the seekers or
                                                    fizzles to discard.
                                                </div>
                                            </div>
                                        ) : rolling ? (
                                            <span className="text-muted-foreground">
                                                Rolling…
                                            </span>
                                        ) : fizzles ? (
                                            <span className="text-destructive font-semibold">
                                                💀 The curse fizzles — card
                                                moves to discard.
                                            </span>
                                        ) : (
                                            <span className="text-emerald-400 font-semibold">
                                                🎉 The curse stands — cast it
                                                on the seekers.
                                            </span>
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}
                </div>

                <DialogFooter className="px-6 py-4 shrink-0 border-t border-border gap-2 sm:gap-2 sm:flex-col sm:items-stretch sm:justify-end">
                    {/* Retry hint surfaced when the share sheet was
                        dismissed without sending (or the share API
                        itself failed). The "Cast on seekers" button
                        below stays enabled and re-tappable, but the
                        hint makes the recovery path obvious instead
                        of relying on the hider noticing the dialog
                        is still open. */}
                    {(lastShareResult === "cancelled" ||
                        lastShareResult === "failed") &&
                        !fizzles && (
                            <div
                                className={cn(
                                    "rounded-sm border px-3 py-2 flex items-start gap-2",
                                    "border-yellow-500/40 bg-yellow-500/10",
                                    "text-xs text-yellow-100 leading-snug",
                                )}
                                role="status"
                                aria-live="polite"
                            >
                                <RotateCw className="w-3.5 h-3.5 mt-0.5 shrink-0 text-yellow-300" />
                                <span>
                                    {lastShareResult === "cancelled"
                                        ? "Share dismissed before it landed. Tap Cast on seekers again, or use Copy link."
                                        : "Sharing didn't work. Use Copy link instead, or tap Cast on seekers to retry."}
                                </span>
                            </div>
                        )}

                    <div className="flex flex-row gap-2 sm:justify-end">
                        {/* "Not now" only makes sense before the roll
                            commits. After a roll, the curse is fated
                            either way — either to discard (fizzle) or
                            to the seekers (success) — and the player
                            doesn't get to back out keeping the card. */}
                        {!rolledAndCommitted && (
                            <Button
                                variant="outline"
                                onClick={() => onOpenChange(false)}
                            >
                                {/* "Cancel" reads as "abort this attempt"
                                    — fitting once the dialog is staged
                                    around an action (the dice roll) the
                                    player is about to commit. For curses
                                    without a roll, "Not now" reads more
                                    naturally — there's no committed
                                    action to abort, the player is just
                                    deferring the cast. */}
                                {fizzleRule ? "Cancel" : "Not now"}
                            </Button>
                        )}
                        {/* Manual copy fallback — same end-state as a
                            successful share (card → discard) but uses
                            the clipboard, so the hider always has a
                            single-tap recovery even when the OS share
                            sheet keeps getting dismissed. Hidden on
                            fizzle and in multiplayer (curse goes over
                            the wire, not a link). */}
                        {(fizzleRule === undefined || settled !== null) &&
                            !fizzles &&
                            !$multiplayer && (
                                <Button
                                    variant="outline"
                                    onClick={copyLink}
                                    disabled={!canCast}
                                    className="gap-1.5"
                                >
                                    <Copy className="w-4 h-4" />
                                    Copy link
                                </Button>
                            )}
                        {/* Hide the cast/discard action button entirely
                            until *after* the dice has settled for
                            curses with a fizzle rule — the pre-roll
                            screen should be 100% focused on the roll,
                            with no Share/Cast button hanging around
                            disabled and distracting from the dice.
                            Curses without a fizzle rule have no roll
                            step at all, so the button shows from the
                            start. */}
                        {(fizzleRule === undefined || settled !== null) && (
                            <Button
                                onClick={cast}
                                disabled={!canCast}
                                className={cn(
                                    "gap-1.5",
                                    fizzles &&
                                        "bg-destructive hover:bg-destructive/90",
                                )}
                            >
                                {fizzles ? (
                                    <>
                                        <Trash2 className="w-4 h-4" />
                                        Discard fizzled curse
                                    </>
                                ) : lastShareResult === "cancelled" ||
                                  lastShareResult === "failed" ? (
                                    <>
                                        <RotateCw className="w-4 h-4" />
                                        Share again
                                    </>
                                ) : (
                                    <>
                                        <Share2 className="w-4 h-4" />
                                        Cast on seekers
                                    </>
                                )}
                            </Button>
                        )}
                    </div>
                </DialogFooter>
                </div>
            </DialogContent>
        </Dialog>
    );
}

export default CastCurseDialog;
