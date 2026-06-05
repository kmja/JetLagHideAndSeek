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

                    // Range/step for custom slider, unit-dependent.
                    const sliderConfig =
                        data.unit === "miles"
                            ? { min: 0.5, max: 30, step: 0.5 }
                            : data.unit === "meters"
                              ? { min: 50, max: 5000, step: 50 }
                              : { min: 0.5, max: 50, step: 0.5 };

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
                            "flex-1 min-w-[60px] py-2 px-1 rounded-md text-sm font-poppins font-semibold",
                            "bg-secondary text-foreground hover:bg-accent",
                            "transition-colors",
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
                            {/* Primary preset row — 5 equal columns so the
                                last preset (10 km) doesn't wrap onto its own
                                line on narrow mobile widths. */}
                            <div className="grid grid-cols-5 gap-1.5">
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
                                        className={presetBtnClass(preset.sig)}
                                    >
                                        {preset.label}
                                    </button>
                                ))}
                            </div>

                            {/* Other + Custom row */}
                            <div className="flex gap-1.5">
                                <Popover>
                                    <PopoverTrigger asChild>
                                        <button
                                            type="button"
                                            disabled={!data.drag || $isLoading}
                                            className={cn(
                                                "flex-1 py-2 px-2 rounded-md text-sm font-poppins font-semibold",
                                                "bg-secondary text-foreground hover:bg-accent",
                                                "transition-colors",
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
                                        "flex-1 py-2 px-2 rounded-md text-sm font-poppins font-semibold",
                                        "bg-secondary text-foreground hover:bg-accent",
                                        "transition-colors",
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
                                        min={sliderConfig.min}
                                        max={sliderConfig.max}
                                        step={sliderConfig.step}
                                        value={data.radius}
                                        disabled={!data.drag || $isLoading}
                                        onChange={(e) =>
                                            questionModified(
                                                (data.radius = parseFloat(
                                                    e.target.value,
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
