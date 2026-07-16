import { useStore } from "@nanostores/react";
import {
    Camera,
    Check,
    Dice5,
    Minus,
    Play,
    Plus,
    RotateCw,
    Send,
    Square,
    Trash2,
    Video,
    Zap,
} from "lucide-react";
import type { CSSProperties } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "react-toastify";

import { renderBodyText } from "@/components/CardTile";
import { PhotoCensorDialog } from "@/components/PhotoCensorDialog";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogTitle,
} from "@/components/ui/dialog";
import { CATEGORIES, type CategoryId } from "@/lib/categories";
import {
    canPayDiscardCost,
    curseCostRequiresPhoto,
    curseCostRequiresRockCount,
    curseCostRequiresVideo,
    eligibleForDiscardCost,
    parseDiscardCost,
} from "@/lib/castingCost";
import { preparePhotoForSend } from "@/lib/photo";
import {
    activeBlockingCurse,
    CURSE_DRAINED_BRAIN,
    curseBlocksAsking,
} from "@/lib/curseEnforcement";
import { gameSize } from "@/lib/gameSetup";
import type { CurseCard } from "@/lib/hiderDeck";
import {
    activateOverflowingChalice,
    discardCard,
    hiderHand,
} from "@/lib/hiderRole";
import { currentGameCode, multiplayerEnabled } from "@/lib/multiplayer/session";
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
/** mm:ss (or h:mm:ss) from a whole-second count, for the film timer. */
function formatClock(totalSeconds: number): string {
    const s = Math.max(0, Math.floor(totalSeconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const pad = (n: number) => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

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
    const $hand = useStore(hiderHand);
    /** Cards the hider has selected to pay a *discard* casting cost
     *  (e.g. "Discard 2 cards"). Empty until they pick; the cast
     *  button stays gated until the right count is chosen. */
    const [costSelectedIds, setCostSelectedIds] = useState<string[]>([]);
    /** Drained Brain only: the 3 categories the hider picks to disable
     *  on the seekers for the rest of the run. */
    const [drainedCategories, setDrainedCategories] = useState<CategoryId[]>(
        [],
    );
    const isDrainedBrain = card?.name === CURSE_DRAINED_BRAIN;
    const $activeBlocker = useStore(activeBlockingCurse);
    // Rulebook p386: only one ask-blocking curse can be active at a time.
    // Block casting a SECOND one while a different ask-blocker the hider
    // cast is still active (the seekers must clear it first).
    const isBlockingCurse = card ? curseBlocksAsking(card.name) : false;
    const blockedByActiveCurse =
        isBlockingCurse &&
        $activeBlocker !== null &&
        $activeBlocker !== card?.name;
    const fizzleRule = card ? DICE_FIZZLE[card.name] : undefined;
    // Photo casting cost (Zoologist / Luxury Car): the hider attaches a
    // proof photo the seekers see. `photoFile` is the picked/edited file
    // awaiting the censor editor; `preparedPhoto` holds the uploaded R2
    // URL + local thumbnail once processed.
    const [photoFile, setPhotoFile] = useState<File | null>(null);
    const [photoBusy, setPhotoBusy] = useState(false);
    const [preparedPhoto, setPreparedPhoto] = useState<{
        url?: string;
        thumb: string;
    } | null>(null);
    const photoInputRef = useRef<HTMLInputElement | null>(null);
    // Film casting cost (Bird Guide): in-app stopwatch. `filmSeconds` is
    // the captured elapsed time (the target sent to the seekers);
    // `filmRunning` + `filmElapsedMs` drive the live display while timing.
    const [filmSeconds, setFilmSeconds] = useState<number | null>(null);
    const [filmRunning, setFilmRunning] = useState(false);
    const [filmElapsedMs, setFilmElapsedMs] = useState(0);
    const filmStartRef = useRef<number | null>(null);
    // Rock-tower casting cost (Curse of the Cairn): the number of rocks the
    // hider's tower reached — the target the seekers must match.
    const [rockCount, setRockCount] = useState<number | null>(null);
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
            setCostSelectedIds([]);
            setDrainedCategories([]);
            setPhotoFile(null);
            setPhotoBusy(false);
            setPreparedPhoto(null);
            setFilmSeconds(null);
            setFilmRunning(false);
            setFilmElapsedMs(0);
            filmStartRef.current = null;
        }
    }, [open, card?.id]);

    // Drive the live stopwatch display while a film timer is running.
    useEffect(() => {
        if (!filmRunning) return;
        const id = window.setInterval(() => {
            if (filmStartRef.current != null) {
                setFilmElapsedMs(Date.now() - filmStartRef.current);
            }
        }, 200);
        return () => window.clearInterval(id);
    }, [filmRunning]);

    if (!card) return null;

    // Structured discard cost (if any) + the hand cards eligible to
    // pay it. Non-discard costs (roll a die, photograph an animal, …)
    // parse to null and aren't enforced — they're real-life actions.
    const discardCost = parseDiscardCost(card.castingCost);
    const costEligible = discardCost
        ? eligibleForDiscardCost($hand, discardCost, card.id)
        : [];
    const costSatisfiable = discardCost
        ? canPayDiscardCost($hand, discardCost, card.id)
        : true;
    const costPaid =
        !discardCost ||
        discardCost.whole ||
        costSelectedIds.length === discardCost.count;

    const toggleCostCard = (id: string) => {
        if (!discardCost) return;
        setCostSelectedIds((curr) => {
            if (curr.includes(id)) return curr.filter((x) => x !== id);
            if (curr.length >= discardCost.count) return [...curr.slice(1), id];
            return [...curr, id];
        });
    };

    // Discard the cards paying the cost — all eligible for a whole-hand
    // cost, otherwise the cards the hider selected. Called from each
    // successful-cast branch alongside discarding the curse itself.
    const payCostDiscards = () => {
        if (!discardCost) return;
        const ids = discardCost.whole
            ? costEligible.map((c) => c.id)
            : costSelectedIds;
        for (const id of ids) discardCard(id);
    };

    // Photo casting cost. In multiplayer the app can DELIVER the photo to
    // the seekers, so it's required before casting; solo/link games keep
    // it a self-attested real-life action (no room to send it to) — the
    // capture UI is offered but doesn't gate the cast.
    const costRequiresPhoto = curseCostRequiresPhoto(card.castingCost);
    const online = $multiplayer && !!currentGameCode.get();
    const photoRequired = costRequiresPhoto && online;
    const photoSatisfied = !photoRequired || preparedPhoto !== null;

    // Run a picked/edited photo through the shared compress+upload
    // pipeline. On success we hold the R2 URL (sent to the seekers) plus
    // a local thumbnail for the preview strip.
    const commitPhoto = async (file: File) => {
        setPhotoBusy(true);
        try {
            const prepared = await preparePhotoForSend(file, online);
            setPreparedPhoto({
                url: prepared.photoUrl,
                thumb: prepared.photoUri,
            });
            if (prepared.fellBack) {
                toast.warn(
                    "Couldn't upload the full-size photo — sent a smaller preview instead.",
                    { autoClose: 3500 },
                );
            }
        } catch (e) {
            console.warn("curse photo failed", e);
            toast.error("Couldn't process that photo. Try another one.");
        } finally {
            setPhotoBusy(false);
        }
    };

    // Film casting cost (Bird Guide). Required in multiplayer (the target
    // duration is delivered to the seekers); solo/link keeps it a
    // self-attested action but still offers the stopwatch.
    const costRequiresVideo = curseCostRequiresVideo(card.castingCost);
    const videoRequired = costRequiresVideo && online;
    const videoSatisfied = !videoRequired || filmSeconds != null;

    // Rock-tower casting cost (Cairn). Required in multiplayer (the count is
    // delivered to the seekers); solo/link still offers the entry.
    const costRequiresRockCount = curseCostRequiresRockCount(card.castingCost);
    const rockRequired = costRequiresRockCount && online;
    const rockSatisfied =
        !rockRequired || (rockCount != null && rockCount >= 1);

    const startFilm = () => {
        filmStartRef.current = Date.now();
        setFilmElapsedMs(0);
        setFilmSeconds(null);
        setFilmRunning(true);
    };
    const stopFilm = () => {
        const start = filmStartRef.current;
        setFilmRunning(false);
        const secs = start != null ? Math.round((Date.now() - start) / 1000) : 0;
        setFilmSeconds(secs);
    };
    const resetFilm = () => {
        setFilmRunning(false);
        setFilmSeconds(null);
        setFilmElapsedMs(0);
        filmStartRef.current = null;
    };

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
        !photoBusy &&
        // Rulebook p386: can't stack a second ask-blocking curse.
        !blockedByActiveCurse &&
        // Cards with a fizzle rule need a SETTLED roll before the
        // action button enables; cards without can cast right away.
        (fizzleRule === undefined || settled !== null) &&
        // Discard casting costs must be payable AND paid (the hider has
        // designated the cards) before the curse can be cast.
        costSatisfiable &&
        costPaid &&
        // Photo casting cost (multiplayer): the proof photo must be
        // captured + uploaded before the curse can be sent.
        photoSatisfied &&
        // Film casting cost (multiplayer): the timer must be stopped with a
        // captured duration before the curse can be sent.
        videoSatisfied &&
        !filmRunning &&
        // Rock-tower casting cost (Cairn, multiplayer): the hider must enter
        // how many rocks their tower reached before casting.
        rockSatisfied &&
        // Drained Brain: exactly 3 categories must be chosen before the
        // curse can be cast (it disables those 3 on the seekers).
        (!isDrainedBrain || drainedCategories.length === 3);

    const toggleDrainedCategory = (id: CategoryId) => {
        setDrainedCategories((curr) => {
            if (curr.includes(id)) return curr.filter((x) => x !== id);
            if (curr.length >= 3) return curr; // cap at 3
            return [...curr, id];
        });
    };

    /** The curse-specific params carried in the cast payload: Drained
     *  Brain's disabled categories and, for a photo-cost curse, the R2
     *  URL of the hider's proof photo. Empty for every other curse. */
    const enforceParams = (): {
        disabledCategories?: string[];
        photoUrl?: string;
        filmSeconds?: number;
        rockCount?: number;
    } => ({
        ...(isDrainedBrain ? { disabledCategories: drainedCategories } : {}),
        ...(preparedPhoto?.url ? { photoUrl: preparedPhoto.url } : {}),
        ...(filmSeconds != null ? { filmSeconds } : {}),
        ...(rockCount != null && rockCount >= 1 ? { rockCount } : {}),
    });

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

    /**
     * Side effects that fire the moment a curse actually lands (after
     * the casting cost is paid and the curse is delivered). Currently
     * only the Overflowing Chalice, which arms the hider's own draw
     * boost. Called from each successful-cast branch below.
     */
    const onCurseLanded = () => {
        // Rulebook p386: record an ask-blocking curse as active so a
        // second one can't be cast until the seekers clear this one.
        if (curseBlocksAsking(card.name)) {
            activeBlockingCurse.set(card.name);
        }
        if (card.name === "Curse of the Overflowing Chalice") {
            activateOverflowingChalice();
            toast.info(
                "Overflowing Chalice armed: your next 3 question rewards each draw one extra card.",
                { autoClose: 4000 },
            );
        }
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
                ...enforceParams(),
            });
            payCostDiscards();
            discardCard(card.id);
            onCurseLanded();
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
                ...enforceParams(),
            });
            const result = await shareOrCopy({
                title: `${card.name} cast on you`,
                text: `${card.name}: ${card.description}`,
                url,
            });
            setLastShareResult(result.method);
            if (result.method === "share" || result.method === "copy") {
                payCostDiscards();
                discardCard(card.id);
                onCurseLanded();
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
        <>
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent
                className={cn(
                    "!bg-[hsl(var(--sidebar-background))] !text-[hsl(var(--sidebar-foreground))]",
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

                    {/* Drained Brain: pick the 3 categories to disable on
                        the seekers. The app ENFORCES these — the chosen
                        categories are greyed out in the seekers' New
                        question picker for the rest of the run. */}
                    {isDrainedBrain && (
                        <div className="rounded-sm border-2 border-purple-500/40 bg-purple-500/5 px-3 py-2.5">
                            <div className="flex items-center justify-between mb-1.5">
                                <span className="text-[10px] uppercase tracking-[0.16em] font-poppins font-bold text-purple-300">
                                    Pick 3 categories to disable
                                </span>
                                <span className="text-[11px] tabular-nums text-muted-foreground">
                                    {drainedCategories.length} / 3
                                </span>
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                                {(
                                    Object.keys(CATEGORIES) as CategoryId[]
                                ).map((id) => {
                                    const sel =
                                        drainedCategories.includes(id);
                                    const meta = CATEGORIES[id];
                                    const Icon = meta.icon;
                                    return (
                                        <button
                                            key={id}
                                            type="button"
                                            onClick={() =>
                                                toggleDrainedCategory(id)
                                            }
                                            aria-pressed={sel}
                                            className={cn(
                                                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors",
                                                sel
                                                    ? "border-purple-400 bg-purple-500/25 text-purple-100"
                                                    : "border-border bg-background/40 text-foreground/80 hover:border-purple-500/50",
                                            )}
                                        >
                                            <span
                                                className="inline-flex items-center justify-center w-4 h-4 rounded-sm shrink-0"
                                                style={{
                                                    backgroundColor:
                                                        meta.color,
                                                }}
                                                aria-hidden="true"
                                            >
                                                <Icon
                                                    size={10}
                                                    strokeWidth={2.5}
                                                    className="text-white"
                                                />
                                            </span>
                                            {meta.label}
                                        </button>
                                    );
                                })}
                            </div>
                            <p className="text-[11px] text-muted-foreground leading-snug mt-2">
                                These stay disabled for the seekers for the
                                rest of your run — the app enforces it.
                            </p>
                        </div>
                    )}

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
                                      ? "border-success/60 bg-success/10"
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
                                          ? "text-success"
                                          : "text-yellow-500",
                                )}
                            >
                                Casting cost
                            </div>
                            <p className="text-xs text-foreground/90 leading-snug mt-1">
                                {renderBodyText(card.castingCost, $gameSize)}
                            </p>

                            {/* Discard-cost enforcement (B3). Curses
                                whose cost is "Discard N cards / a
                                powerup / a time bonus / your hand"
                                require the hider to actually pay before
                                the cast button unlocks. Non-discard
                                costs (roll a die, photograph an animal)
                                parse to null and skip this entirely. */}
                            {discardCost && (
                                <div className="mt-2.5">
                                    {!costSatisfiable ? (
                                        <p className="text-xs text-destructive font-semibold leading-snug">
                                            You don&apos;t have enough eligible
                                            cards to pay this cost — the curse
                                            can&apos;t be cast.
                                        </p>
                                    ) : discardCost.whole ? (
                                        <p className="text-xs text-muted-foreground leading-snug">
                                            {costEligible.length === 0
                                                ? "No other cards to discard — your hand is just this curse."
                                                : `Casting this discards your ${costEligible.length} other card${
                                                      costEligible.length === 1
                                                          ? ""
                                                          : "s"
                                                  }.`}
                                        </p>
                                    ) : (
                                        <>
                                            <div className="flex items-center justify-between mb-1.5">
                                                <span className="text-[10px] uppercase tracking-[0.14em] font-poppins font-bold text-muted-foreground">
                                                    Pick {discardCost.count} to
                                                    discard
                                                </span>
                                                <span className="text-[11px] tabular-nums text-muted-foreground">
                                                    {costSelectedIds.length} /{" "}
                                                    {discardCost.count}
                                                </span>
                                            </div>
                                            <div className="flex flex-wrap gap-1.5">
                                                {costEligible.map((c) => {
                                                    const sel =
                                                        costSelectedIds.includes(
                                                            c.id,
                                                        );
                                                    return (
                                                        <button
                                                            key={c.id}
                                                            type="button"
                                                            onClick={() =>
                                                                toggleCostCard(
                                                                    c.id,
                                                                )
                                                            }
                                                            className={cn(
                                                                "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
                                                                sel
                                                                    ? "border-yellow-500 bg-yellow-500/20 text-yellow-100"
                                                                    : "border-border bg-background/40 text-foreground/80 hover:border-yellow-500/50",
                                                            )}
                                                        >
                                                            {sel && (
                                                                <Check className="w-3 h-3" />
                                                            )}
                                                            {c.name}
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        </>
                                    )}
                                </div>
                            )}

                            {/* Photo casting cost (Zoologist / Luxury
                                Car): capture a proof photo the seekers
                                see. Crop/censor before it sends, same as
                                a photo answer. In multiplayer the shot is
                                uploaded + required; solo/link games treat
                                it as a self-attested action (still
                                offered, not gated). */}
                            {costRequiresPhoto && (
                                <div className="mt-2.5">
                                    {preparedPhoto ? (
                                        <div className="flex items-center gap-3">
                                            <img
                                                src={preparedPhoto.thumb}
                                                alt="Curse proof photo"
                                                className="w-16 h-16 rounded-md object-cover border border-border shrink-0"
                                            />
                                            <div className="min-w-0 flex-1">
                                                <p className="text-xs text-success font-semibold leading-snug">
                                                    Photo attached — the
                                                    seekers will see it.
                                                </p>
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        setPreparedPhoto(null);
                                                        photoInputRef.current?.click();
                                                    }}
                                                    disabled={photoBusy}
                                                    className="mt-1 text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
                                                >
                                                    Retake
                                                </button>
                                            </div>
                                        </div>
                                    ) : (
                                        <>
                                            <Button
                                                type="button"
                                                size="sm"
                                                variant="outline"
                                                disabled={photoBusy}
                                                onClick={() =>
                                                    photoInputRef.current?.click()
                                                }
                                                className="w-full gap-1.5"
                                            >
                                                <Camera className="w-4 h-4" />
                                                {photoBusy
                                                    ? "Processing…"
                                                    : "Take or choose photo"}
                                            </Button>
                                            <p className="text-[11px] text-muted-foreground leading-snug mt-1.5">
                                                {photoRequired
                                                    ? "Attach the proof photo before casting — the seekers receive it with the curse."
                                                    : "Optional here — no room to send it to. Show it to the seekers in person."}
                                            </p>
                                        </>
                                    )}
                                    <input
                                        ref={photoInputRef}
                                        type="file"
                                        accept="image/*"
                                        capture="environment"
                                        className="sr-only"
                                        onChange={(e) => {
                                            const picked =
                                                e.currentTarget.files?.[0];
                                            e.currentTarget.value = "";
                                            if (picked) setPhotoFile(picked);
                                        }}
                                    />
                                </div>
                            )}

                            {/* Film casting cost (Bird Guide): an in-app
                                stopwatch. Start when the bird is in frame,
                                Stop when it leaves — the captured duration
                                is what the seekers must beat. */}
                            {costRequiresVideo && (
                                <div className="mt-2.5 flex flex-col items-center gap-2">
                                    <div className="font-inter-tight font-black tabular-nums text-4xl">
                                        {formatClock(
                                            (filmSeconds != null
                                                ? filmSeconds
                                                : filmElapsedMs / 1000) || 0,
                                        )}
                                    </div>
                                    {filmRunning ? (
                                        <Button
                                            type="button"
                                            size="sm"
                                            variant="destructive"
                                            onClick={stopFilm}
                                            className="gap-1.5"
                                        >
                                            <Square className="w-4 h-4" />
                                            Stop timer
                                        </Button>
                                    ) : filmSeconds != null ? (
                                        <div className="flex flex-col items-center gap-1">
                                            <p className="text-xs text-success font-semibold">
                                                Filmed {formatClock(filmSeconds)}{" "}
                                                — the seekers must beat it.
                                            </p>
                                            <button
                                                type="button"
                                                onClick={resetFilm}
                                                className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
                                            >
                                                Redo
                                            </button>
                                        </div>
                                    ) : (
                                        <>
                                            <Button
                                                type="button"
                                                size="sm"
                                                variant="outline"
                                                onClick={startFilm}
                                                className="gap-1.5"
                                            >
                                                <Play className="w-4 h-4" />
                                                Start timer
                                            </Button>
                                            <p className="text-[11px] text-muted-foreground leading-snug text-center inline-flex items-center gap-1">
                                                <Video className="w-3 h-3" />
                                                {videoRequired
                                                    ? "Time your filming — the duration is sent to the seekers."
                                                    : "Time your filming — tell the seekers the duration."}
                                            </p>
                                        </>
                                    )}
                                </div>
                            )}

                            {/* Rock-tower casting cost (Curse of the Cairn):
                                enter how many rocks the hider's tower reached —
                                the seekers must match it. */}
                            {costRequiresRockCount && (
                                <div className="mt-2.5 flex flex-col items-center gap-2">
                                    <div className="flex items-center gap-3">
                                        <Button
                                            type="button"
                                            size="icon"
                                            variant="outline"
                                            aria-label="Fewer rocks"
                                            className="h-10 w-10 shrink-0"
                                            disabled={(rockCount ?? 0) <= 1}
                                            onClick={() =>
                                                setRockCount((n) =>
                                                    Math.max(1, (n ?? 1) - 1),
                                                )
                                            }
                                        >
                                            <Minus className="w-4 h-4" />
                                        </Button>
                                        <div className="min-w-[3.5rem] text-center">
                                            <span className="font-inter-tight font-black tabular-nums text-4xl">
                                                {rockCount ?? "—"}
                                            </span>
                                        </div>
                                        <Button
                                            type="button"
                                            size="icon"
                                            variant="outline"
                                            aria-label="More rocks"
                                            className="h-10 w-10 shrink-0"
                                            onClick={() =>
                                                setRockCount((n) => (n ?? 0) + 1)
                                            }
                                        >
                                            <Plus className="w-4 h-4" />
                                        </Button>
                                    </div>
                                    <p className="text-[11px] text-muted-foreground leading-snug text-center">
                                        {rockRequired
                                            ? "How many rocks high was your tower? The count is sent to the seekers to match."
                                            : "How many rocks high was your tower? Tell the seekers to match it."}
                                    </p>
                                </div>
                            )}

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
                                                  : "border-success text-success",
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
                                            <span className="text-success font-semibold">
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
                                        ? "Share dismissed before it landed — tap Cast curse to retry."
                                        : "Sharing didn't work — tap Cast curse to retry."}
                                </span>
                            </div>
                        )}

                    {/* Rulebook p386: an ask-blocking curse is already
                        active, so this one can't be cast until the seekers
                        clear the first. The hider marks it cleared when the
                        seekers tell them (same trust model as real-world
                        curses). */}
                    {blockedByActiveCurse && (
                        <div
                            className={cn(
                                "rounded-sm border px-3 py-2 flex flex-col gap-2",
                                "border-destructive/40 bg-destructive/10",
                                "text-xs leading-snug",
                            )}
                            role="status"
                        >
                            <span>
                                <span className="font-semibold">
                                    {$activeBlocker}
                                </span>{" "}
                                is still blocking the seekers from asking. You
                                can only have one such curse active at a time —
                                wait for the seekers to clear it (rulebook p44).
                            </span>
                            <Button
                                size="sm"
                                variant="outline"
                                className="h-7 self-start text-xs"
                                onClick={() => activeBlockingCurse.set(null)}
                            >
                                Seekers cleared it
                            </Button>
                        </div>
                    )}

                    {/* v886: vertical, app-only. The curse is sent through the
                        app automatically (over the wire in multiplayer); the
                        old Copy-link / Share-again buttons were link-era
                        remnants and were removed. */}
                    <div className="flex flex-col gap-2">
                        {/* Hide the cast/discard action until *after* the dice
                            has settled for curses with a fizzle rule — the
                            pre-roll screen stays focused on the roll. Curses
                            without a fizzle rule show it from the start. */}
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
                                ) : (
                                    <>
                                        <Send className="w-4 h-4" />
                                        Cast curse
                                    </>
                                )}
                            </Button>
                        )}
                        {/* "Not now" only makes sense before the roll commits.
                            After a roll the curse is fated either way, so the
                            player can't back out keeping the card. */}
                        {!rolledAndCommitted && (
                            <Button
                                variant="outline"
                                onClick={() => onOpenChange(false)}
                            >
                                Cancel
                            </Button>
                        )}
                    </div>
                </DialogFooter>
                </div>
            </DialogContent>
        </Dialog>

        {/* Crop/censor editor for a picked photo-cost proof photo. Its own
            Dialog at z-[1070] (v869), so it layers over this cast dialog. */}
        {photoFile && (
            <PhotoCensorDialog
                file={photoFile}
                onCancel={() => setPhotoFile(null)}
                onConfirm={(redacted) => {
                    setPhotoFile(null);
                    commitPhoto(redacted);
                }}
            />
        )}
        </>
    );
}

export default CastCurseDialog;
