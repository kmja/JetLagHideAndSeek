import { useStore } from "@nanostores/react";
import React from "react";

import { LatitudeLongitude } from "@/components/LatLngPicker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import {
    MENU_ITEM_CLASSNAME,
    SidebarMenuItem,
} from "@/components/ui/sidebar-l";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { UnitSelect } from "@/components/UnitSelect";
import {
    hiderMode,
    isLoading,
    mapContext,
    questionModified,
    questions,
    triggerLocalRefresh,
} from "@/lib/context";
import { fitMapToRadius } from "@/lib/mapFit";
import { cn } from "@/lib/utils";
import type { RadiusQuestion, Units } from "@/maps/schema";

import { ManualAnswerDisclosure,QuestionCard } from "./base";

/** Rulebook radius presets, in display order. */
const RADIUS_PRESETS: {
    label: string;
    radius: number;
    unit: Units;
    /** Stable signature for uniqueness tracking */
    sig: string;
}[] = [
    { label: "500m", radius: 500, unit: "meters", sig: "500m" },
    { label: "1km", radius: 1, unit: "kilometers", sig: "1km" },
    { label: "2km", radius: 2, unit: "kilometers", sig: "2km" },
    { label: "5km", radius: 5, unit: "kilometers", sig: "5km" },
    { label: "10km", radius: 10, unit: "kilometers", sig: "10km" },
    { label: "15 km", radius: 15, unit: "kilometers", sig: "15km" },
    { label: "40 km", radius: 40, unit: "kilometers", sig: "40km" },
    { label: "80 km", radius: 80, unit: "kilometers", sig: "80km" },
    { label: "160 km", radius: 160, unit: "kilometers", sig: "160km" },
];

/** First 5 presets are shown as big buttons; the rest go in the "Other" popover. */
const PRIMARY_PRESETS = RADIUS_PRESETS.slice(0, 5);
const OTHER_PRESETS = RADIUS_PRESETS.slice(5);

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
            collapsed={data.collapsed}
            setCollapsed={(collapsed) => {
                data.collapsed = collapsed; // Doesn't trigger a re-render so no need for questionModified
            }}
            locked={!data.drag}
            setLocked={(locked) => questionModified((data.drag = !locked))}
        >
            <SidebarMenuItem>
                {(() => {
                    // Compute current preset signature (which preset matches data values).
                    // Compare to RADIUS_PRESETS by radius + unit.
                    const currentSig = data.useCustom
                        ? "custom"
                        : RADIUS_PRESETS.find(
                              (p) =>
                                  p.radius === data.radius &&
                                  p.unit === data.unit,
                          )?.sig ?? "custom";

                    // Game rule: each preset (or Custom slot) can only be used
                    // once. Disable presets used by OTHER radius questions.
                    const usedSigs = new Set(
                        $questions
                            .filter(
                                (q) =>
                                    q.id === "radius" && q.key !== questionKey,
                            )
                            .map((q) => {
                                const d = q.data as RadiusQuestion;
                                if (d.useCustom) return "custom";
                                return (
                                    RADIUS_PRESETS.find(
                                        (p) =>
                                            p.radius === d.radius &&
                                            p.unit === d.unit,
                                    )?.sig ?? "custom"
                                );
                            }),
                    );

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

                    const pickPreset = (preset: typeof RADIUS_PRESETS[0]) => {
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

                    const presetBtnClass = (sig: string) =>
                        cn(
                            "py-2 px-2 rounded-md text-sm font-poppins font-semibold",
                            "bg-secondary text-foreground hover:bg-accent",
                            "transition-colors whitespace-nowrap leading-none",
                            "disabled:opacity-30 disabled:cursor-not-allowed",
                            currentSig === sig &&
                                "ring-2 ring-primary bg-primary/20 text-primary",
                        );

                    return (
                        <div
                            className={cn(
                                MENU_ITEM_CLASSNAME,
                                "flex flex-col gap-3",
                            )}
                        >
                            {/* Primary preset row — responsive 3-col on
                                narrow phones, 5-col once we have a wider
                                dialog body. The old `grid-cols-5` forced
                                five ~60 px buttons on ~310 px-wide bodies
                                and they ended up clipping into each
                                other; switching to a flex-wrap with a
                                65 px basis lets the row reflow to a 3+2
                                layout when it has to. */}
                            <div className="flex flex-wrap gap-1.5">
                                {PRIMARY_PRESETS.map((preset) => (
                                    <button
                                        key={preset.sig}
                                        type="button"
                                        onClick={() => pickPreset(preset)}
                                        disabled={
                                            !data.drag ||
                                            $isLoading ||
                                            (usedSigs.has(preset.sig) &&
                                                currentSig !== preset.sig)
                                        }
                                        className={cn(
                                            presetBtnClass(preset.sig),
                                            "flex-1 basis-[65px]",
                                        )}
                                    >
                                        {preset.label}
                                    </button>
                                ))}
                            </div>

                            {/* Other + Custom row. `whitespace-nowrap`
                                stops "Other ▾" from wrapping to two
                                lines when the button is narrow — that
                                wrap was what made these look much
                                taller than the primary row. */}
                            <div className="flex flex-wrap gap-1.5">
                                <Popover>
                                    <PopoverTrigger asChild>
                                        <button
                                            type="button"
                                            disabled={!data.drag || $isLoading}
                                            className={cn(
                                                "flex-1 basis-[120px] py-2 px-2 rounded-md text-sm font-poppins font-semibold",
                                                "bg-secondary text-foreground hover:bg-accent",
                                                "transition-colors whitespace-nowrap leading-none",
                                                "disabled:opacity-30 disabled:cursor-not-allowed",
                                                OTHER_PRESETS.some(
                                                    (p) =>
                                                        currentSig === p.sig,
                                                ) &&
                                                    "ring-2 ring-primary bg-primary/20 text-primary",
                                            )}
                                        >
                                            Other ▾
                                        </button>
                                    </PopoverTrigger>
                                    <PopoverContent className="w-40 p-1">
                                        <div className="flex flex-col gap-1">
                                            {OTHER_PRESETS.map((preset) => (
                                                <button
                                                    key={preset.sig}
                                                    type="button"
                                                    onClick={() =>
                                                        pickPreset(preset)
                                                    }
                                                    disabled={
                                                        usedSigs.has(
                                                            preset.sig,
                                                        ) &&
                                                        currentSig !==
                                                            preset.sig
                                                    }
                                                    className={cn(
                                                        "text-left px-3 py-1.5 rounded-sm text-sm",
                                                        "hover:bg-accent",
                                                        "disabled:opacity-30 disabled:cursor-not-allowed",
                                                        currentSig ===
                                                            preset.sig &&
                                                            "bg-primary/20 text-primary",
                                                    )}
                                                >
                                                    {preset.label}
                                                </button>
                                            ))}
                                        </div>
                                    </PopoverContent>
                                </Popover>
                                <button
                                    type="button"
                                    onClick={() => {
                                        data.useCustom = true;
                                        questionModified();
                                    }}
                                    disabled={
                                        !data.drag ||
                                        $isLoading ||
                                        (usedSigs.has("custom") &&
                                            !data.useCustom)
                                    }
                                    className={cn(
                                        "flex-1 basis-[120px] py-2 px-2 rounded-md text-sm font-poppins font-semibold",
                                        "bg-secondary text-foreground hover:bg-accent",
                                        "transition-colors whitespace-nowrap leading-none",
                                        "disabled:opacity-30 disabled:cursor-not-allowed",
                                        data.useCustom &&
                                            "ring-2 ring-primary bg-primary/20 text-primary",
                                    )}
                                >
                                    Custom
                                </button>
                            </div>

                            {/* Custom slider — only when Custom is active */}
                            {data.useCustom && (
                                <div className="flex flex-col gap-2 pt-1">
                                    <div className="flex items-baseline justify-between">
                                        <span className="text-3xl font-poppins font-semibold tabular-nums">
                                            {data.radius}
                                        </span>
                                        <UnitSelect
                                            unit={data.unit}
                                            disabled={
                                                !data.drag || $isLoading
                                            }
                                            onChange={(unit) =>
                                                questionModified(
                                                    (data.unit = unit),
                                                )
                                            }
                                        />
                                    </div>
                                    <input
                                        type="range"
                                        min={0}
                                        max={SLIDER_TRACK}
                                        step={1}
                                        value={radiusToSlider(data.radius)}
                                        disabled={!data.drag || $isLoading}
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
                                            "h-2 rounded-full bg-secondary",
                                            "accent-primary",
                                            "[&::-webkit-slider-thumb]:appearance-none",
                                            "[&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:w-5",
                                            "[&::-webkit-slider-thumb]:rounded-full",
                                            "[&::-webkit-slider-thumb]:bg-primary",
                                            "[&::-webkit-slider-thumb]:shadow-md",
                                            "[&::-moz-range-thumb]:h-5 [&::-moz-range-thumb]:w-5",
                                            "[&::-moz-range-thumb]:rounded-full",
                                            "[&::-moz-range-thumb]:bg-primary",
                                            "[&::-moz-range-thumb]:border-0",
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
                    if (lat !== null) {
                        data.lat = lat;
                    }
                    if (lng !== null) {
                        data.lng = lng;
                    }
                    questionModified();
                }}
                disabled={!data.drag || $isLoading}
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
            <ManualAnswerDisclosure compact={compactAnswer}>
                <div className="flex gap-2 items-center p-2">
                    <Label
                        className={cn(
                            "font-semibold text-lg",
                            $isLoading && "text-muted-foreground",
                        )}
                    >
                        Result
                    </Label>
                    <ToggleGroup
                        className="grow"
                        type="single"
                        // Show no preselected answer while the question is
                        // still a draft (`drag: true`). Once the user picks
                        // Inside/Outside we both record the answer AND
                        // commit the question (drag:false) — this single
                        // tap is the seeker's "the hider says ..." action.
                        value={
                            data.drag
                                ? ""
                                : data.within
                                  ? "inside"
                                  : "outside"
                        }
                        onValueChange={(value: "inside" | "outside") => {
                            if (!value) return;
                            data.within = value === "inside";
                            data.drag = false;
                            questionModified();
                        }}
                        disabled={!!$hiderMode || $isLoading}
                    >
                        <ToggleGroupItem value="outside">
                            Outside
                        </ToggleGroupItem>
                        <ToggleGroupItem value="inside">Inside</ToggleGroupItem>
                    </ToggleGroup>
                </div>
            </ManualAnswerDisclosure>
        </QuestionCard>
    );
};
