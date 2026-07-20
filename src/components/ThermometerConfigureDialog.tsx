import { useStore } from "@nanostores/react";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "react-toastify";

import {
    QuestionOverlayCard,
    summarizeQuestion,
} from "@/components/questionOverlayCard";
import { ThermometerPreviewMap } from "@/components/ThermometerPreviewMap";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {
    addQuestion,
    lastKnownPosition,
    questionModified,
    questions,
    randomizeThermoTarget,
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
    const $gps = useStore(lastKnownPosition);
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

    // v1038: a Randomize re-roll can pre-select a specific target size — consume
    // the handoff atom when the dialog opens and select the rolled preset.
    useEffect(() => {
        if (!open) return;
        const forced = randomizeThermoTarget.get();
        if (forced && presets.some((p) => p.sig === forced)) {
            setSelected(forced);
        }
        randomizeThermoTarget.set(null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);
    // The currently-selected preset — shared by the carousel + the
    // travel-distance map below it.
    const current = presets.find((p) => p.sig === selected);

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
                {/* v1005: header restyled to the shared question-card chrome
                    (solid category-colour icon block + big label), matching the
                    radar/configure dialogs. The visible title is the card; a
                    visually-hidden DialogTitle keeps Radix a11y happy. */}
                <DialogHeader className="sr-only">
                    <DialogTitle>New thermometer</DialogTitle>
                </DialogHeader>
                <QuestionOverlayCard
                    categoryId="thermometer"
                    summary={summarizeQuestion({
                        id: "thermometer",
                        data: {},
                    })}
                    flat
                />
                <p className="mt-2 text-sm text-muted-foreground">
                    Pick how far you&apos;ll travel before sending the question.
                </p>
                {/* v987: distance CAROUSEL (matches the radar picker) — one
                    prominent target at a time, prev/next cycles the presets.
                    A repeat-used preset (rulebook p65) shows the N× badge; the
                    house rule `askOncePerQuestion` skips used presets. */}
                {(() => {
                    const selectable = $askOnce
                        ? presets.filter((p) => (sigCounts.get(p.sig) ?? 0) === 0)
                        : presets;
                    const idx = selectable.findIndex((p) => p.sig === selected);
                    const cycle = (dir: 1 | -1) => {
                        if (selectable.length === 0) return;
                        const base = idx === -1 ? (dir === 1 ? -1 : 0) : idx;
                        const next =
                            (base + dir + selectable.length) % selectable.length;
                        setSelected(selectable[next].sig);
                    };
                    const navBtn = cn(
                        "h-20 w-14 shrink-0 flex items-center justify-center rounded-md",
                        "bg-secondary text-foreground hover:bg-accent transition-colors",
                        "disabled:opacity-30 disabled:cursor-not-allowed",
                    );
                    const repeatMult = (sigCounts.get(selected ?? "") ?? 0) + 1;
                    const showRepeat = !$askOnce && repeatMult > 1;
                    const canCycle = selectable.length > 0 && !submitting;
                    return (
                        <div className="mt-2 flex items-center gap-2">
                            <button
                                type="button"
                                aria-label="Shorter distance"
                                onClick={() => cycle(-1)}
                                disabled={!canCycle}
                                className={navBtn}
                            >
                                <ChevronLeft className="w-8 h-8" />
                            </button>
                            <div className="relative flex-1 h-20 flex flex-col items-center justify-center rounded-md px-4 py-3 ring-2 ring-primary bg-primary/15">
                                {showRepeat && (
                                    <span
                                        title={`Repeat: hider runs the draw-keep cycle ${repeatMult}× (rulebook p65)`}
                                        className="absolute top-1.5 right-1.5 inline-flex items-center justify-center px-1.5 h-4 rounded-sm bg-yellow-500/90 text-black text-[10px] font-poppins font-bold leading-none"
                                    >
                                        {repeatMult}×
                                    </span>
                                )}
                                <span className="text-3xl font-poppins font-bold text-primary tabular-nums leading-none">
                                    {current?.label ?? "—"}
                                </span>
                                <span className="text-[11px] uppercase tracking-wider text-muted-foreground mt-2">
                                    Travel distance
                                </span>
                            </div>
                            <button
                                type="button"
                                aria-label="Longer distance"
                                onClick={() => cycle(1)}
                                disabled={!canCycle}
                                className={navBtn}
                            >
                                <ChevronRight className="w-8 h-8" />
                            </button>
                        </div>
                    );
                })()}
                {/* v1005: directional hotter/colder preview — the endpoint ring
                    + the D/2 bisector cut for a tapped travel direction, with
                    the warm (hotter) / cool (colder) half-planes. Reframes as
                    the distance changes so the ring always fits. */}
                <div className="mt-3">
                    {$gps && current ? (
                        <ThermometerPreviewMap
                            lat={$gps.lat}
                            lng={$gps.lng}
                            radiusMeters={Math.round(current.km * 1000)}
                            className="w-full aspect-[4/3] rounded-lg overflow-hidden border border-border"
                        />
                    ) : (
                        <div className="w-full aspect-[4/3] rounded-lg border border-dashed border-border bg-secondary/30 flex items-center justify-center text-center px-6">
                            <span className="text-xs text-muted-foreground leading-snug">
                                {$gps
                                    ? "Pick a distance to preview how far you'll travel."
                                    : "Waiting for your location — the travel-distance circle will appear once GPS is ready."}
                            </span>
                        </div>
                    )}
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
                </div>
            </DialogContent>
        </Dialog>
    );
}

export default ThermometerConfigureDialog;
