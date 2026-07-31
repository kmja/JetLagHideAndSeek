import { useStore } from "@nanostores/react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import React from "react";

import { LatitudeLongitude } from "@/components/LatLngPicker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SidebarMenuItem } from "@/components/ui/sidebar-l";
import {
    hiderMode,
    isLoading,
    isQuestionEditable,
    mapContext,
    questionModified,
    questions,
    triggerLocalRefresh,
} from "@/lib/context";
import { askOncePerQuestion } from "@/lib/houseRules";
import { fitMapToRadius } from "@/lib/mapFit";
import {
    formatMeters,
    gameRadius,
    resolvedUnits,
    type UnitSystem,
} from "@/lib/units";
import { cn } from "@/lib/utils";
import type { RadiusQuestion, Units } from "@/maps/schema";

import { QuestionCard } from "./base";

/** Rulebook radar size tiers, in display order — the METRIC distance
 *  (in meters) + a stable, unit-independent `sig` used for uniqueness
 *  tracking. The actual value + unit shown/stored is derived per the
 *  selected unit system (v972), so an imperial player picks 0.25/0.5/1/
 *  3/6/10/25/50/100 mi and a metric player picks the km sizes. */
export const RADIUS_TIERS: { sig: string; meters: number }[] = [
    { sig: "500m", meters: 500 },
    { sig: "1km", meters: 1000 },
    { sig: "2km", meters: 2000 },
    { sig: "5km", meters: 5000 },
    { sig: "10km", meters: 10000 },
    { sig: "15km", meters: 15000 },
    { sig: "40km", meters: 40000 },
    { sig: "80km", meters: 80000 },
    { sig: "160km", meters: 160000 },
];

interface RadiusPreset {
    label: string;
    radius: number;
    unit: Units;
    sig: string;
}

/** Build the radar presets for a unit system, sharing the tier sigs. */
function radiusPresetsFor(system: UnitSystem): RadiusPreset[] {
    return RADIUS_TIERS.map((t) => {
        const { radius, unit } = gameRadius(t.meters, system);
        return { sig: t.sig, radius, unit, label: formatMeters(t.meters, system) };
    });
}

/** Identify the tier `sig` a stored (radius, unit) belongs to — matching
 *  EITHER system's form, so a unit switch mid-game still recognises an
 *  already-asked size for the one-per-game rule. "custom" otherwise. */
export function sigForRadius(radius: number, unit: Units): string {
    for (const t of RADIUS_TIERS) {
        for (const system of ["metric", "imperial"] as const) {
            const f = gameRadius(t.meters, system);
            if (radius === f.radius && unit === f.unit) return t.sig;
        }
    }
    return "custom";
}

/**
 * Pick a "nice" step for snapping the logarithmic slider's output:
 * tighter intervals around small radii (where seekers really do need
 * sub-100 m resolution) and progressively looser ones higher up so
 * we don't pretend a 30 km vs 30.3 km guess matters.
 */
function snapToNiceStep(value: number, unit: Units): number {
    if (unit === "meters") {
        if (value < 200) return Math.round(value / 10) * 10;
        if (value < 1000) return Math.round(value / 50) * 50;
        return Math.round(value / 100) * 100;
    }
    // miles + kilometers share the same shape in "1 unit" terms.
    if (value < 1) return Math.round(value * 10) / 10;
    if (value < 5) return Math.round(value * 4) / 4;
    if (value < 20) return Math.round(value * 2) / 2;
    return Math.round(value);
}

/**
 * v1198: editable custom-radar distance. The slider snaps to "nice" steps, so it
 * can't express e.g. 637 m or 1.35 km — this number is a real text field for fine
 * control. Typing any positive value writes `data.radius` directly (bypassing the
 * slider's snap), and because the slider reads `radiusToSlider(data.radius)` and
 * the map preview derives its circle from `data.radius`, BOTH respond instantly to
 * an edit. Clamped to the slider's [min, max] so the thumb + number stay in sync.
 * A local string state lets the user type freely (partial "1." / "") without those
 * intermediate values corrupting the radius; it reflects external changes (slider
 * drag / preset pick) whenever the field isn't focused.
 */
const CustomRadiusInput = ({
    data,
    disabled,
    min,
    max,
}: {
    data: RadiusQuestion;
    disabled?: boolean;
    min: number;
    max: number;
}) => {
    const unitLabel =
        data.unit === "meters" ? "m" : data.unit === "miles" ? "mi" : "km";
    const round = (n: number) =>
        data.unit === "meters" ? Math.round(n) : Math.round(n * 100) / 100;
    const fmt = (n: number) => String(round(n));
    // `draft` = the in-progress typed string; null = mirror `data.radius`. Using a
    // draft (instead of a `focused`-guarded copy) fixes the v1199 bug where editing
    // the number then dragging the slider RIGHT AWAY froze both the number and the
    // map: the old `onBlur` committed the stale typed value back onto `data.radius`
    // (overwriting the slider), and the `!focused` guard blocked the display from
    // following the slider. Now an EXTERNAL change to `data.radius` (slider / preset)
    // drops the draft so the field tracks it, and blur never overwrites.
    const [draft, setDraft] = React.useState<string | null>(null);
    // The radius value WE last wrote — so a change from ANY other source is
    // detectable and clears the draft (our own writes don't).
    const ourValueRef = React.useRef(data.radius);
    React.useEffect(() => {
        if (data.radius !== ourValueRef.current) {
            ourValueRef.current = data.radius;
            setDraft(null); // external change (slider / preset) → show live value
        }
    }, [data.radius]);
    const value = draft ?? fmt(data.radius);
    const commit = (raw: string) => {
        const n = parseFloat(raw);
        if (!Number.isFinite(n) || n <= 0) return; // ignore partial / empty input
        const clamped = round(Math.max(min, Math.min(max, n)));
        ourValueRef.current = clamped; // our own write — not an "external" change
        if (clamped !== data.radius) questionModified((data.radius = clamped));
    };
    return (
        <div className="flex items-end justify-center gap-1.5">
            <input
                type="number"
                inputMode="decimal"
                step="any"
                min={min}
                max={max}
                value={value}
                disabled={disabled}
                aria-label="Custom radar distance"
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => {
                    setDraft(e.target.value);
                    commit(e.target.value);
                }}
                onBlur={() => setDraft(null)}
                className={cn(
                    "w-24 text-center text-3xl font-poppins font-bold text-primary tabular-nums leading-none",
                    "bg-transparent outline-none",
                    "border-b-2 border-primary/40 focus:border-primary transition-colors",
                    // Hide the native spinner buttons — the field reads as the big
                    // number it replaces (arrow keys still increment).
                    "[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-inner-spin-button]:m-0",
                    "disabled:opacity-50 disabled:cursor-not-allowed",
                )}
            />
            <span className="text-lg font-poppins font-semibold text-muted-foreground pb-0.5">
                {unitLabel}
            </span>
        </div>
    );
};

export const RadiusQuestionComponent = ({
    data,
    questionKey,
    forceExpanded,
    sub,
    className,
    compactAnswer,
}: {
    data: RadiusQuestion;
    questionKey: number;
    sub?: string;
    forceExpanded?: boolean;
    className?: string;
    compactAnswer?: boolean;
}) => {
    useStore(triggerLocalRefresh);
    const $hiderMode = useStore(hiderMode);
    const $questions = useStore(questions);
    const $isLoading = useStore(isLoading);
    const $askOnce = useStore(askOncePerQuestion);
    const $units = useStore(resolvedUnits);
    const presets = radiusPresetsFor($units);
    const label = `Radar
    ${
        $questions
            .filter((q) => q.id === "radius")
            .map((q) => q.key)
            .indexOf(questionKey) + 1
    }`;

    const unitAbbrev =
        data.unit === "miles" ? "mi" : data.unit === "meters" ? "m" : "km";
    const summary = data.drag
        ? `${data.radius} ${unitAbbrev} · awaiting answer`
        : `${data.radius} ${unitAbbrev} · ${data.within ? "Inside" : "Outside"}`;

    return (
        <QuestionCard
            questionKey={questionKey}
            label={label}
            sub={sub}
            category="radius"
            summary={summary}
            createdAt={data.createdAt}
            className={className}
            forceExpanded={forceExpanded}
            // In the configure dialog the header size is redundant with the
            // size carousel right below, so show just "Radar" (v747).
            titleOverride={forceExpanded ? "Radar" : undefined}
            collapsed={data.collapsed}
            setCollapsed={(collapsed) => {
                data.collapsed = collapsed; // Doesn't trigger a re-render so no need for questionModified
            }}
            locked={!data.drag}
            setLocked={(locked) => questionModified((data.drag = !locked))}
        >
            <SidebarMenuItem>
                {(() => {
                    // Compute current preset signature (which tier matches the
                    // stored radius+unit — in EITHER unit system, v972).
                    const currentSig = data.useCustom
                        ? "custom"
                        : sigForRadius(data.radius, data.unit);

                    // Game rule: each preset (or Custom slot) can only be used
                    // once. Disable presets used by OTHER radius questions.
                    // v970 (rulebook audit D): also count how many times each
                    // size was asked, so the carousel can show a "Repeat · N×"
                    // badge in rulebook-repeat mode (matching thermometer).
                    const usedSigCounts = new Map<string, number>();
                    for (const q of $questions) {
                        if (
                            q.id !== "radius" ||
                            q.key === questionKey ||
                            // v673: a randomized-away radar is NOT considered
                            // asked (rulebook p376), so its preset stays
                            // re-selectable at its original cost.
                            (q.data as { randomizedAway?: boolean })
                                .randomizedAway === true
                        ) {
                            continue;
                        }
                        const d = q.data as RadiusQuestion;
                        const sig = d.useCustom
                            ? "custom"
                            : sigForRadius(d.radius, d.unit);
                        usedSigCounts.set(
                            sig,
                            (usedSigCounts.get(sig) ?? 0) + 1,
                        );
                    }
                    const usedSigs = new Set(usedSigCounts.keys());

                    // Range for the custom slider, unit-dependent. The
                    // slider itself runs on a 0..1000 integer track and
                    // maps that logarithmically onto the [min, max]
                    // radius window — small values get most of the
                    // travel so a seeker can tune a 600 m radar pixel-
                    // perfect, while still reaching the 50 km end from
                    // the same control. Snapping to a magnitude-aware
                    // step (0.1 → 1 km, 10 → 100 m, etc.) keeps the
                    // visible number tidy.
                    const sliderConfig =
                        data.unit === "miles"
                            ? { min: 0.5, max: 30 }
                            : data.unit === "meters"
                              ? { min: 50, max: 5000 }
                              : { min: 0.5, max: 50 };
                    const SLIDER_TRACK = 1000;
                    const logMin = Math.log(sliderConfig.min);
                    const logMax = Math.log(sliderConfig.max);
                    const sliderToRadius = (s: number): number => {
                        const r = Math.exp(
                            logMin + ((logMax - logMin) * s) / SLIDER_TRACK,
                        );
                        return snapToNiceStep(r, data.unit);
                    };
                    const radiusToSlider = (r: number): number => {
                        const clamped = Math.max(
                            sliderConfig.min,
                            Math.min(sliderConfig.max, r),
                        );
                        return Math.round(
                            ((Math.log(clamped) - logMin) /
                                (logMax - logMin)) *
                                SLIDER_TRACK,
                        );
                    };

                    const pickPreset = (preset: RadiusPreset) => {
                        data.radius = preset.radius;
                        data.unit = preset.unit;
                        data.useCustom = false;
                        questionModified();
                        // Re-fit the map to the new radius so the entire
                        // circle stays visible — picking 10 km from a
                        // 500 m starting view would otherwise leave most
                        // of the question off-screen.
                        const map = mapContext.get();
                        if (map) {
                            fitMapToRadius(
                                map,
                                data.lat,
                                data.lng,
                                preset.radius,
                                preset.unit,
                            );
                        }
                    };

                    return (
                        // v1200: a plain full-width column — NOT MENU_ITEM_CLASSNAME
                        // (which added a `p-2` inset + a stray hover tint), so the
                        // carousel + slider span the full dialog content width.
                        <div className="flex w-full flex-col gap-3">
                            {/* Radar-size CAROUSEL (v747). The old 5-up
                                preset grid + "Other" popover was replaced
                                with a single prev/next cycler over all nine
                                rulebook sizes — one prominent size at a time,
                                so changing it reads as a deliberate step and
                                the map preview can animate between sizes.
                                Presets already used by another radar question
                                are skipped (the one-preset-per-game rule), so
                                the carousel only lands on selectable sizes. */}
                            {(() => {
                                const selectable = $askOnce
                                    ? presets.filter(
                                          (p) => !usedSigs.has(p.sig),
                                      )
                                    : presets;
                                const idx = selectable.findIndex(
                                    (p) => p.sig === currentSig,
                                );
                                const currentPreset = presets.find(
                                    (p) => p.sig === currentSig,
                                );
                                const cycle = (dir: 1 | -1) => {
                                    if (selectable.length === 0) return;
                                    // From Custom (idx === -1) step into the
                                    // list at the near end; otherwise wrap.
                                    const base = idx === -1 ? (dir === 1 ? -1 : 0) : idx;
                                    const next =
                                        (base + dir + selectable.length) %
                                        selectable.length;
                                    pickPreset(selectable[next]);
                                };
                                const navBtn = cn(
                                    "h-20 w-16 shrink-0 flex items-center justify-center rounded-md",
                                    // A visible border + a stronger surface so the
                                    // chevrons read clearly in dark mode (bg-secondary
                                    // alone was too low-contrast against the card).
                                    "border border-border bg-secondary text-foreground",
                                    "hover:bg-accent hover:text-accent-foreground transition-colors",
                                    "disabled:opacity-30 disabled:cursor-not-allowed",
                                );
                                const canCycle =
                                    data.drag && selectable.length > 0;
                                // v970: in rulebook-repeat mode a used size
                                // stays selectable at N× cost — show the same
                                // "N×" badge the thermometer picker uses.
                                const repeatMult =
                                    (usedSigCounts.get(currentSig) ?? 0) + 1;
                                const showRepeat =
                                    !$askOnce &&
                                    !data.useCustom &&
                                    repeatMult > 1;
                                return (
                                    <div className="flex items-center gap-2">
                                        <button
                                            type="button"
                                            aria-label="Smaller radar size"
                                            onClick={() => cycle(-1)}
                                            disabled={!canCycle}
                                            className={navBtn}
                                        >
                                            <ChevronLeft className="w-8 h-8" />
                                        </button>
                                        <div className="relative flex-1 h-20 flex flex-col items-center justify-center px-4">
                                            {showRepeat && (
                                                <span
                                                    title={`Repeat: hider runs the draw-keep cycle ${repeatMult}× (rulebook p65)`}
                                                    className="absolute top-1.5 right-1.5 inline-flex items-center justify-center px-1.5 h-4 rounded-sm bg-yellow-500/90 text-black text-[10px] font-poppins font-bold leading-none"
                                                >
                                                    {repeatMult}×
                                                </span>
                                            )}
                                            {data.useCustom ? (
                                                // The custom radius is edited RIGHT
                                                // HERE (fine control), so the main
                                                // selector both shows AND edits it.
                                                <CustomRadiusInput
                                                    data={data}
                                                    disabled={
                                                        !isQuestionEditable(
                                                            data,
                                                        ) || $isLoading
                                                    }
                                                    min={sliderConfig.min}
                                                    max={sliderConfig.max}
                                                />
                                            ) : (
                                                <span className="text-3xl font-poppins font-bold text-primary tabular-nums leading-none">
                                                    {currentPreset?.label ??
                                                        "Custom"}
                                                </span>
                                            )}
                                            <span className="text-xs uppercase tracking-wider text-muted-foreground mt-2">
                                                {data.useCustom
                                                    ? "Custom size"
                                                    : "Radar size"}
                                            </span>
                                        </div>
                                        <button
                                            type="button"
                                            aria-label="Larger radar size"
                                            onClick={() => cycle(1)}
                                            disabled={!canCycle}
                                            className={navBtn}
                                        >
                                            <ChevronRight className="w-8 h-8" />
                                        </button>
                                    </div>
                                );
                            })()}

                            {/* Custom-size toggle — full manual control via
                                the slider below. Kept as a compact secondary
                                action beneath the carousel. */}
                            <button
                                type="button"
                                onClick={() => {
                                    data.useCustom = !data.useCustom;
                                    questionModified();
                                }}
                                disabled={
                                    !data.drag ||
                                    ($askOnce &&
                                        usedSigs.has("custom") &&
                                        !data.useCustom)
                                }
                                className={cn(
                                    "self-center py-2.5 px-6 rounded-md text-sm font-poppins font-semibold",
                                    "bg-secondary text-foreground hover:bg-accent",
                                    "transition-colors whitespace-nowrap leading-none",
                                    "disabled:opacity-30 disabled:cursor-not-allowed",
                                    data.useCustom &&
                                        "ring-2 ring-primary bg-primary/20 text-primary",
                                )}
                            >
                                Custom size
                            </button>

                            {/* Custom slider — only when Custom is active. v747:
                                dropped the unit selector (the slider range is a
                                sensible km window); the number is centered above
                                the slider with a bigger handle + more-visible
                                track. */}
                            {data.useCustom && (
                                <div className="flex flex-col gap-3 pt-1">
                                    <input
                                        type="range"
                                        min={0}
                                        max={SLIDER_TRACK}
                                        step={1}
                                        value={radiusToSlider(data.radius)}
                                        disabled={!isQuestionEditable(data) || $isLoading}
                                        onChange={(e) =>
                                            questionModified(
                                                (data.radius = sliderToRadius(
                                                    parseInt(
                                                        e.target.value,
                                                        10,
                                                    ),
                                                )),
                                            )
                                        }
                                        className={cn(
                                            "w-full appearance-none cursor-pointer",
                                            // Higher-contrast track — bg-muted was
                                            // nearly invisible in dark mode.
                                            "h-3 rounded-full bg-foreground/20 ring-1 ring-inset ring-foreground/25",
                                            "accent-primary",
                                            "[&::-webkit-slider-thumb]:appearance-none",
                                            "[&::-webkit-slider-thumb]:h-7 [&::-webkit-slider-thumb]:w-7",
                                            "[&::-webkit-slider-thumb]:rounded-full",
                                            "[&::-webkit-slider-thumb]:bg-primary",
                                            "[&::-webkit-slider-thumb]:shadow-md",
                                            "[&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white",
                                            "[&::-webkit-slider-thumb]:-mt-2",
                                            "[&::-moz-range-thumb]:h-7 [&::-moz-range-thumb]:w-7",
                                            "[&::-moz-range-thumb]:rounded-full",
                                            "[&::-moz-range-thumb]:bg-primary",
                                            "[&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-white",
                                            "disabled:opacity-50 disabled:cursor-not-allowed",
                                        )}
                                    />
                                </div>
                            )}
                        </div>
                    );
                })()}
            </SidebarMenuItem>
            <LatitudeLongitude
                latitude={data.lat}
                longitude={data.lng}
                colorName={data.color}
                onChange={(lat, lng) => {
                    // A question's location is immutable once it has been
                    // sent (committed / answered). Drop any write — incl.
                    // the inline picker's on-mount GPS auto-seed — so a
                    // later re-mount can't relocate an answered question.
                    if (!isQuestionEditable(data)) return;
                    if (lat !== null) {
                        data.lat = lat;
                    }
                    if (lng !== null) {
                        data.lng = lng;
                    }
                    questionModified();
                }}
                disabled={!isQuestionEditable(data) || $isLoading}
                // Pass the current radius (converted to meters) so the
                // inline picker draws a preview circle while the user
                // positions the pin.
                radiusMeters={
                    data.unit === "meters"
                        ? data.radius
                        : data.unit === "miles"
                          ? data.radius * 1609.344
                          : data.radius * 1000
                }
            />
        </QuestionCard>
    );
};
