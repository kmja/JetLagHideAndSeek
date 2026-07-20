import { useStore } from "@nanostores/react";
import { Dices } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { RADIUS_TIERS, sigForRadius } from "@/components/cards/radius";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { CATEGORIES, type CategoryId } from "@/lib/categories";
import {
    addQuestionSignal,
    pendingRandomize,
    questions,
    type RandomizeChoice,
    randomizeReplacement,
    randomizeRollOpen,
} from "@/lib/context";
import { type GameSize, gameSize } from "@/lib/gameSetup";
import { getSubtypes } from "@/lib/subtypes";
import { thermometerPresetsForSize } from "@/lib/thermometerPresets";
import { formatMeters, resolvedUnits, type UnitSystem } from "@/lib/units";
import { cn } from "@/lib/utils";
import type { Question } from "@/maps/schema";

/**
 * v1038: the Randomize RE-ROLL dialog. When the hider plays Randomize, the
 * seeker owes a fresh question of the SAME category (rulebook p376). Tapping
 * "Ask new" on the answered-question overlay opens THIS dialog, which spins
 * through the remaining UN-ASKED questions of that category (dice-roller-style)
 * and settles on ONE. The settled choice is persisted on `pendingRandomize.rolled`
 * the first time, so cancelling + reopening always lands on the SAME question —
 * only the first open randomizes. Confirming sends the seeker to that question's
 * configure step (via `randomizeReplacement` + `addQuestionSignal`).
 */

interface RollOption {
    id: string;
    label: string;
    choice: RandomizeChoice;
}

/** The remaining un-asked questions of a category, as roller options. */
function randomizeOptions(
    category: CategoryId,
    size: GameSize,
    units: UnitSystem,
    qs: Question[],
): RollOption[] {
    if (category === "radius") {
        const used = new Set<string>();
        for (const q of qs) {
            if (q.id !== "radius") continue;
            const d = q.data as {
                radius: number;
                unit: "meters" | "kilometers" | "miles";
                randomizedAway?: boolean;
            };
            if (d.randomizedAway) continue;
            used.add(sigForRadius(d.radius, d.unit));
        }
        const unused = RADIUS_TIERS.filter((t) => !used.has(t.sig));
        const pool = unused.length > 0 ? unused : RADIUS_TIERS;
        return pool.map((t) => {
            const label = formatMeters(t.meters, units);
            return {
                id: t.sig,
                label,
                choice: { radiusMeters: t.meters, label },
            };
        });
    }
    if (category === "thermometer") {
        const used = new Set<string>();
        for (const q of qs) {
            if (q.id !== "thermometer") continue;
            const d = q.data as {
                distance?: string;
                targetSig?: string;
                randomizedAway?: boolean;
            };
            if (d.randomizedAway) continue;
            const sig = d.distance ?? d.targetSig;
            if (sig) used.add(sig);
        }
        const presets = thermometerPresetsForSize(size, units);
        const unused = presets.filter((p) => !used.has(p.sig));
        const pool = unused.length > 0 ? unused : presets;
        return pool.map((p) => ({
            id: p.sig,
            label: p.label,
            choice: { thermoSig: p.sig, label: p.label },
        }));
    }
    // Subtyped categories: matching / measuring / tentacles / photo.
    const subs = getSubtypes(category, size) ?? [];
    const used = new Set<string>();
    for (const q of qs) {
        if (q.id !== category) continue;
        const d = q.data as {
            type?: string;
            locationType?: string;
            randomizedAway?: boolean;
        };
        if (d.randomizedAway) continue;
        const s = category === "tentacles" ? d.locationType : d.type;
        if (s) used.add(s);
    }
    const unused = subs.filter((s) => !used.has(s.value));
    const pool = unused.length > 0 ? unused : subs;
    return pool.map((s) => ({
        id: s.value,
        label: s.label,
        choice: { subtype: s.value, label: s.label },
    }));
}

/** Does a roller option match the persisted `rolled` choice? */
function matchesRolled(o: RollOption, rolled: RandomizeChoice): boolean {
    if (rolled.subtype != null) return o.choice.subtype === rolled.subtype;
    if (rolled.radiusMeters != null)
        return o.choice.radiusMeters === rolled.radiusMeters;
    if (rolled.thermoSig != null) return o.choice.thermoSig === rolled.thermoSig;
    return false;
}

export function RandomizeRollDialog() {
    const open = useStore(randomizeRollOpen);
    const $pending = useStore(pendingRandomize);
    const $size = useStore(gameSize);
    const $units = useStore(resolvedUnits);
    useStore(questions);

    const category = $pending?.category ?? null;
    const options =
        category !== null
            ? randomizeOptions(category, $size, $units, questions.get())
            : [];

    // Decide the settled choice ONCE (persist on pendingRandomize.rolled), so
    // reopening always lands on the same question. Runs on open.
    useEffect(() => {
        if (!open || !$pending || options.length === 0) return;
        if ($pending.rolled) return;
        const pick = options[Math.floor(Math.random() * options.length)];
        pendingRandomize.set({ ...$pending, rolled: pick.choice });
        // options recompute is derived; deps intentionally minimal.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, $pending?.originalKey, options.length]);

    const rolled = $pending?.rolled ?? null;
    const targetIdx = rolled
        ? options.findIndex((o) => matchesRolled(o, rolled))
        : -1;

    // Slot animation: cycle displayed labels quickly, decelerate, land on the
    // target index (deterministic — the rolled choice), then reveal the actions.
    const [displayIdx, setDisplayIdx] = useState(0);
    const [settled, setSettled] = useState(false);
    const timerRef = useRef<number | null>(null);

    useEffect(() => {
        if (!open || targetIdx < 0 || options.length === 0) {
            setSettled(false);
            return;
        }
        setSettled(false);
        let cancelled = false;
        const totalSteps = Math.max(14, options.length * 2 + 8);
        let step = 0;
        const tick = () => {
            if (cancelled) return;
            if (step >= totalSteps) {
                setDisplayIdx(targetIdx);
                setSettled(true);
                return;
            }
            setDisplayIdx(step % options.length);
            step += 1;
            // ease-out: fast at first (60ms), slowing to ~280ms near the end.
            const frac = step / totalSteps;
            const delay = 55 + frac * frac * 230;
            timerRef.current = window.setTimeout(tick, delay);
        };
        tick();
        return () => {
            cancelled = true;
            if (timerRef.current) window.clearTimeout(timerRef.current);
        };
        // Re-run the spin whenever the dialog (re)opens or the target changes.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, targetIdx, options.length]);

    if (!open || category === null) return null;

    const cat = CATEGORIES[category];
    const shown = options[displayIdx] ?? options[0];

    const confirm = () => {
        if (!rolled) return;
        randomizeReplacement.set({
            category,
            subtype: rolled.subtype,
            radiusMeters: rolled.radiusMeters,
            thermoSig: rolled.thermoSig,
        });
        addQuestionSignal.set(addQuestionSignal.get() + 1);
        randomizeRollOpen.set(false);
    };

    return (
        <Dialog
            open={open}
            onOpenChange={(o) => {
                if (!o) randomizeRollOpen.set(false);
            }}
        >
            <DialogContent className="z-[1075] max-w-sm" overlayClassName="z-[1075]">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Dices className="w-5 h-5 text-primary" />
                        Random {cat?.label ?? category} question
                    </DialogTitle>
                    <DialogDescription>
                        The hider randomized your question. Roll a new{" "}
                        {cat?.label?.toLowerCase() ?? "question"} you haven't
                        asked yet, then send it.
                    </DialogDescription>
                </DialogHeader>

                {/* Slot display — the category-colour block cycling labels. */}
                <div className="my-2 flex flex-col items-center gap-3">
                    <div
                        className={cn(
                            "w-full rounded-xl border-2 px-4 py-6 text-center",
                            "flex flex-col items-center justify-center gap-1 min-h-[7rem]",
                            settled
                                ? "border-primary bg-primary/10"
                                : "border-border bg-secondary/40",
                        )}
                        style={{ borderColor: settled ? undefined : cat?.color }}
                    >
                        <span className="text-[10px] uppercase tracking-[0.16em] font-poppins font-bold text-muted-foreground">
                            {cat?.label ?? category}
                        </span>
                        <span
                            className={cn(
                                "font-display font-black uppercase leading-none",
                                settled
                                    ? "text-2xl text-foreground"
                                    : "text-xl text-muted-foreground blur-[0.3px]",
                                !settled &&
                                    "animate-[jlDiceReveal_120ms_ease-out]",
                            )}
                        >
                            {shown?.label ?? "…"}
                        </span>
                    </div>
                    {!settled && (
                        <span className="text-xs text-muted-foreground">
                            Rolling…
                        </span>
                    )}
                </div>

                <div className="flex flex-col gap-2">
                    <Button
                        type="button"
                        onClick={confirm}
                        disabled={!settled || !rolled}
                        className="w-full gap-1.5"
                    >
                        <Dices className="w-4 h-4" />
                        Ask this question
                    </Button>
                    <Button
                        type="button"
                        variant="ghost"
                        onClick={() => randomizeRollOpen.set(false)}
                        className="w-full"
                    >
                        Cancel
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}

export default RandomizeRollDialog;
