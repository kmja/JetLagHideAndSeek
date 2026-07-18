import { useStore } from "@nanostores/react";
import { Loader2, Locate, Thermometer } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "react-toastify";

import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {
    addQuestion,
    questionModified,
    questions,
} from "@/lib/context";
import { gameSize } from "@/lib/gameSetup";
import { thermometerPresetsForSize } from "@/lib/thermometerPresets";
import { resolvedUnits } from "@/lib/units";
import { askOncePerQuestion } from "@/lib/houseRules";
import { multiplayerEnabled } from "@/lib/multiplayer/session";
import { seekerResendQuestion } from "@/lib/multiplayer/store";
import { cn } from "@/lib/utils";
import type { Question, ThermometerQuestion } from "@/maps/schema";

/**
 * v339: thermometer configure dialog.
 *
 * Old flow (pre-v339): tapping the thermometer category in the picker
 * immediately created a started thermometer at the MAP CENTRE — wrong
 * per the rulebook, since the rulebook is unambiguous that the starting
 * point IS the seeker's current location (rulebook p31, "send them
 * your current location"). It also gave the seeker no agency over the
 * target distance: any preset they happened to reach could be the end
 * point.
 *
 * New flow (rulebook p31): pick target distance up front → tap "Start
 * and notify hider" → we grab a fresh GPS fix as the start point →
 * the overlay shows progress against that ONE target → when the seeker
 * reaches it, an "End thermometer & send" button appears in the overlay.
 *
 * Component responsibilities:
 *   1. Pick a target preset (filtered by game size per rulebook p31).
 *   2. Request a current GPS fix on press of "Start and notify hider".
 *   3. Insert a started thermometer with targetSig = chosen preset,
 *      latA / lngA = the live GPS fix, latB / lngB mirroring A.
 *   4. Trigger `questionModified()` so the question pushes to multiplayer
 *      (the "notify hider" half of the button label).
 *
 * The "what happens next" is owned by ThermometerOverlay + the question
 * card, both updated to track against targetSig.
 */

export interface ThermometerConfigureDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Called after a thermometer has been successfully added. The
     *  parent (AddQuestionDialog) closes its own picker. */
    onAdded?: () => void;
}

export function ThermometerConfigureDialog({
    open,
    onOpenChange,
    onAdded,
}: ThermometerConfigureDialogProps) {
    const $size = useStore(gameSize);
    const $questions = useStore(questions);
    const $askOnce = useStore(askOncePerQuestion);
    const $units = useStore(resolvedUnits);
    // v972: unit-aware presets (imperial → 0.5/3/10/45 mi) from the one
    // shared source; sigs stay stable so uniqueness + stored questions work.
    const presets = thermometerPresetsForSize($size, $units);

    // Per-preset repeat count among finished thermometers. The rulebook
    // (p65) allows the same question again at N× cost, so by default
    // we let the seeker re-pick a used preset (badge shows the next
    // multiplier). House rule `askOncePerQuestion` flips this to a
    // hard block.
    const sigCounts = new Map<string, number>();
    for (const q of $questions) {
        if (q.id !== "thermometer") continue;
        const d = q.data as ThermometerQuestion & { randomizedAway?: boolean };
        if (d.status === "started" || !d.distance) continue;
        // v673: a randomized-away thermometer isn't considered asked.
        if (d.randomizedAway === true) continue;
        sigCounts.set(d.distance, (sigCounts.get(d.distance) ?? 0) + 1);
    }
    const usedSigs = new Set(sigCounts.keys());

    // Default selection: pick the first preset that isn't a repeat —
    // a repeat is allowed (rulebook p65) but shouldn't be the
    // pre-selected default unless every preset is already used.
    const firstAvailable =
        presets.find((p) => !usedSigs.has(p.sig))?.sig ?? presets[0]?.sig;
    const [selected, setSelected] = useState<string | null>(
        firstAvailable ?? null,
    );
    const [submitting, setSubmitting] = useState(false);

    // Reset selection when the dialog reopens (fresh state per use).
    useEffect(() => {
        if (open) {
            setSelected(firstAvailable ?? null);
            setSubmitting(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    const handleStart = async () => {
        if (!selected) return;
        if (typeof navigator === "undefined" || !navigator.geolocation) {
            toast.error(
                "Location services aren't available — can't start a thermometer.",
            );
            return;
        }
        setSubmitting(true);
        try {
            const pos = await new Promise<GeolocationPosition>(
                (resolve, reject) => {
                    navigator.geolocation.getCurrentPosition(resolve, reject, {
                        enableHighAccuracy: true,
                        maximumAge: 5_000,
                        timeout: 15_000,
                    });
                },
            );
            const lat = pos.coords.latitude;
            const lng = pos.coords.longitude;
            // Sanity: a reasonable fix should be < 50 km from the seeker's
            // play area, but we don't gate on that here — the seeker might
            // be testing remotely.
            const q: Question = {
                id: "thermometer",
                key: Math.random(),
                data: {
                    latA: lat,
                    lngA: lng,
                    latB: lat,
                    lngB: lng,
                    warmer: true,
                    colorA: "red",
                    colorB: "green",
                    drag: true,
                    collapsed: true,
                    status: "started",
                    startedAt: Date.now(),
                    targetSig: selected,
                } as ThermometerQuestion,
            };
            addQuestion(q);
            questionModified();
            // v348: push to multiplayer at confirm time — that's the
            // "notify hider" half of the button label.
            // questionModified() above only updates local state;
            // seekerResendQuestion sends {addQ} to peers when MP is on.
            if (multiplayerEnabled.get()) {
                seekerResendQuestion(q.key);
            }
            const presetLabel =
                presets.find((p) => p.sig === selected)?.label ?? selected;
            toast.success(
                `Thermometer started — move ${presetLabel} to finish.`,
                { autoClose: 3500 },
            );
            onOpenChange(false);
            onAdded?.();
        } catch (err) {
            const code = (err as GeolocationPositionError)?.code;
            const msg =
                code === 1
                    ? "Location permission was denied."
                    : code === 3
                      ? "GPS timed out — try again outdoors."
                      : "Couldn't read GPS. Try again.";
            toast.error(msg);
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Thermometer className="w-5 h-5 text-primary" />
                        New thermometer
                    </DialogTitle>
                    <DialogDescription>
                        Pick how far you&apos;ll travel before sending the
                        question. Your current GPS is captured as the
                        starting point and notified to the hider.
                    </DialogDescription>
                </DialogHeader>
                <div className="mt-2 grid grid-cols-2 gap-2">
                    {presets.map((preset) => {
                        const askedTimes = sigCounts.get(preset.sig) ?? 0;
                        const used = askedTimes > 0;
                        const hardBlock = $askOnce && used;
                        const repeatMult = askedTimes + 1;
                        const active = selected === preset.sig;
                        return (
                            <button
                                key={preset.sig}
                                type="button"
                                onClick={() =>
                                    !hardBlock && setSelected(preset.sig)
                                }
                                disabled={hardBlock || submitting}
                                aria-pressed={active}
                                title={
                                    hardBlock
                                        ? `House rule: ${preset.label} already used this game`
                                        : used
                                          ? `Repeat: hider runs the draw-keep cycle ${repeatMult}× (rulebook p65)`
                                          : `Pick ${preset.label}`
                                }
                                className={cn(
                                    "relative flex flex-col items-center justify-center gap-1 py-4 rounded-md border-2 text-sm font-poppins font-semibold",
                                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                    hardBlock
                                        ? "border-border bg-secondary/40 text-muted-foreground line-through opacity-60 cursor-not-allowed"
                                        : active
                                          ? "border-primary bg-primary/15 text-primary"
                                          : "border-border bg-secondary/30 hover:bg-secondary/60",
                                )}
                            >
                                {used && !hardBlock && (
                                    <span className="absolute top-1 right-1 inline-flex items-center justify-center px-1.5 h-4 rounded-sm bg-yellow-500/90 text-black text-[10px] font-poppins font-bold leading-none">
                                        {repeatMult}×
                                    </span>
                                )}
                                <span className="text-base">{preset.label}</span>
                                {hardBlock && (
                                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                                        Used
                                    </span>
                                )}
                            </button>
                        );
                    })}
                </div>
                <div className="mt-4 flex flex-col gap-2">
                    <Button
                        type="button"
                        size="lg"
                        disabled={!selected || submitting}
                        onClick={handleStart}
                        className="gap-2"
                    >
                        {submitting ? (
                            <>
                                <Loader2 className="w-4 h-4 animate-spin" />
                                Getting GPS fix…
                            </>
                        ) : (
                            "Start and notify hider"
                        )}
                    </Button>
                    <Button
                        type="button"
                        variant="ghost"
                        onClick={() => onOpenChange(false)}
                        disabled={submitting}
                    >
                        Cancel
                    </Button>
                    <p className="text-[11px] text-muted-foreground flex items-start gap-1.5 leading-snug">
                        <Locate className="w-3 h-3 mt-0.5 shrink-0" />
                        <span>
                            We&apos;ll request a fresh GPS fix when you tap
                            Start, so make sure location services are on.
                        </span>
                    </p>
                </div>
            </DialogContent>
        </Dialog>
    );
}

export default ThermometerConfigureDialog;
