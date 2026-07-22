import { useStore } from "@nanostores/react";
import { BookOpen } from "lucide-react";
import { useMemo, useState } from "react";

import { renderBodyText } from "@/components/CardTile";
import { HandCardPicker } from "@/components/HandCardPicker";
import { SkullCrossbones } from "@/components/icons/gameIcons";
import {
    AlertDialog,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { eligibleForDiscardCost, parseDiscardCost } from "@/lib/castingCost";
import { performNoActionCurseCast } from "@/lib/curseCast";
import { curseCastSummary } from "@/lib/curseCastSummary";
import { gameSize } from "@/lib/gameSetup";
import type { CurseCard } from "@/lib/hiderDeck";
import { hiderHand } from "@/lib/hiderRole";
import { multiplayerEnabled } from "@/lib/multiplayer/session";
import { openRulebookAt, RULEBOOK_ANCHORS } from "@/lib/rulebook";

/**
 * Lightweight confirmation for casting a NO-ACTION curse straight from the
 * hand (v1108). No-action curses (see `curseNeedsCastAction`) don't need the
 * full `CastCurseDialog` — no map, camera, dice, or word input — so the hand
 * plays them through this compact confirm: the curse name + short summary +
 * casting cost + Cast/Cancel. If the curse has a discard cost that needs a
 * SELECTION (e.g. "discard 2 cards"), tapping Cast first opens the shared
 * `HandCardPicker` to choose which cards, then casts. Reuses the exact casting
 * core (`performNoActionCurseCast`) so it's identical to the full dialog.
 */
export function QuickCastCurseDialog({
    card,
    open,
    onOpenChange,
    onCast,
}: {
    card: CurseCard | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Fired after a successful cast (so the hand can close/refresh). */
    onCast?: () => void;
}) {
    const $gameSize = useStore(gameSize);
    const $mp = useStore(multiplayerEnabled);
    const $hand = useStore(hiderHand);
    const [picking, setPicking] = useState(false);
    const [busy, setBusy] = useState(false);

    const discardCost = card ? parseDiscardCost(card.castingCost) : null;
    // A discard cost that needs the hider to CHOOSE which cards (not a whole-
    // hand discard, which is unambiguous).
    const needsPick =
        !!discardCost && !discardCost.whole && discardCost.count > 0;

    // Cards the picker should leave out — everything not eligible to pay the
    // cost (the eligible set already excludes the curse card itself).
    const excludeIds = useMemo(() => {
        if (!card || !needsPick || !discardCost) return [];
        const eligible = new Set(
            eligibleForDiscardCost($hand, discardCost, card.id).map(
                (c) => c.id,
            ),
        );
        return $hand.map((c) => c.id).filter((id) => !eligible.has(id));
    }, [card, needsPick, discardCost, $hand]);

    if (!card) return null;

    const doCast = async (discardIds: string[]) => {
        setBusy(true);
        const ok = await performNoActionCurseCast(card, $mp, discardIds).catch(
            () => false,
        );
        setBusy(false);
        setPicking(false);
        if (ok) {
            onCast?.();
            onOpenChange(false);
        }
    };

    const onConfirm = () => {
        // Whole-hand discard: pay it with every eligible card, no selection.
        if (discardCost?.whole) {
            void doCast(
                eligibleForDiscardCost($hand, discardCost, card.id).map(
                    (c) => c.id,
                ),
            );
            return;
        }
        if (needsPick) {
            setPicking(true);
            return;
        }
        void doCast([]);
    };

    const cost = card.castingCost?.trim();

    return (
        <>
            <AlertDialog
                open={open && !picking}
                onOpenChange={(o) => {
                    if (!o && !busy) onOpenChange(false);
                }}
            >
                <AlertDialogContent className="max-w-sm">
                    <div className="flex items-start gap-3">
                        <span className="inline-flex items-center justify-center w-9 h-9 rounded shrink-0 bg-purple-500/20 mt-0.5">
                            <SkullCrossbones className="w-4 h-4 text-purple-400" />
                        </span>
                        <div className="min-w-0 flex-1">
                            <div className="text-[10px] uppercase tracking-[0.16em] font-poppins font-bold text-muted-foreground">
                                Cast curse
                            </div>
                            <AlertDialogTitle className="font-inter-tight font-black uppercase text-base leading-tight mt-0.5">
                                {card.name}
                            </AlertDialogTitle>
                        </div>
                        <button
                            type="button"
                            onClick={() =>
                                openRulebookAt(RULEBOOK_ANCHORS.curses)
                            }
                            className="shrink-0 inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-semibold text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
                        >
                            <BookOpen className="w-3.5 h-3.5" />
                            Rules
                        </button>
                    </div>

                    <AlertDialogDescription
                        asChild
                        className="text-sm leading-snug text-foreground/90 mt-2"
                    >
                        <p>
                            {renderBodyText(
                                curseCastSummary(card.name, card.description),
                                $gameSize,
                            )}
                        </p>
                    </AlertDialogDescription>

                    {cost && (
                        <div className="mt-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2">
                            <div className="text-[10px] uppercase tracking-[0.14em] font-poppins font-bold text-warning">
                                Casting cost
                            </div>
                            <div className="text-sm leading-snug text-foreground/90">
                                {renderBodyText(cost, $gameSize)}
                            </div>
                        </div>
                    )}

                    <AlertDialogFooter className="mt-3">
                        <AlertDialogCancel disabled={busy}>
                            Cancel
                        </AlertDialogCancel>
                        <Button
                            type="button"
                            onClick={onConfirm}
                            disabled={busy}
                        >
                            {needsPick ? "Cast curse…" : "Cast curse"}
                        </Button>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>

            {/* Discard-selection step (only for count-based discard costs). */}
            {needsPick && discardCost && (
                <HandCardPicker
                    open={picking}
                    onOpenChange={(o) => {
                        if (!o) {
                            setPicking(false);
                            // Back to the confirm — don't cancel the whole cast.
                        }
                    }}
                    title={`Pay the casting cost`}
                    description={`Choose ${discardCost.count} card${
                        discardCost.count > 1 ? "s" : ""
                    } to discard to cast ${card.name}.`}
                    pickCount={discardCost.count}
                    excludeIds={excludeIds}
                    confirmLabel="Discard & cast"
                    onConfirm={(ids) => void doCast(ids)}
                />
            )}
        </>
    );
}

export default QuickCastCurseDialog;
