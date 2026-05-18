import { useStore } from "@nanostores/react";

import { LatitudeLongitude } from "@/components/LatLngPicker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    MENU_ITEM_CLASSNAME,
    SidebarMenuItem,
} from "@/components/ui/sidebar-l";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { UnitSelect } from "@/components/UnitSelect";
import {
    hiderMode,
    isLoading,
    questionModified,
    questions,
    triggerLocalRefresh,
} from "@/lib/context";
import { cn } from "@/lib/utils";
import type { RadiusQuestion } from "@/maps/schema";

import { QuestionCard } from "./base";

export const RadiusQuestionComponent = ({
    data,
    questionKey,
    forceExpanded,
    sub,
    className,
}: {
    data: RadiusQuestion;
    questionKey: number;
    sub?: string;
    forceExpanded?: boolean;
    className?: string;
}) => {
    useStore(triggerLocalRefresh);
    const $hiderMode = useStore(hiderMode);
    const $questions = useStore(questions);
    const $isLoading = useStore(isLoading);
    const label = `Radius
    ${
        $questions
            .filter((q) => q.id === "radius")
            .map((q) => q.key)
            .indexOf(questionKey) + 1
    }`;

    const unitAbbrev =
        data.unit === "miles" ? "mi" : data.unit === "meters" ? "m" : "km";
    const summary = `${data.radius} ${unitAbbrev} · ${data.within ? "Inside" : "Outside"}`;

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
                    // Range/step depends on the chosen unit.
                    const sliderConfig =
                        data.unit === "miles"
                            ? { min: 0.5, max: 30, step: 0.5 }
                            : data.unit === "meters"
                              ? { min: 50, max: 5000, step: 50 }
                              : { min: 0.5, max: 50, step: 0.5 };
                    return (
                        <div
                            className={cn(
                                MENU_ITEM_CLASSNAME,
                                "flex flex-col gap-3",
                            )}
                        >
                            <div className="flex items-baseline justify-between">
                                <span className="text-3xl font-poppins font-semibold tabular-nums">
                                    {data.radius}
                                </span>
                                <UnitSelect
                                    unit={data.unit}
                                    disabled={!data.drag || $isLoading}
                                    onChange={(unit) =>
                                        questionModified((data.unit = unit))
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
                            <div className="flex justify-between text-[10px] text-muted-foreground font-mono">
                                <span>{sliderConfig.min}</span>
                                <span>{sliderConfig.max}</span>
                            </div>
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
            />
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
                    value={data.within ? "inside" : "outside"}
                    onValueChange={(value: "inside" | "outside") =>
                        questionModified((data.within = value === "inside"))
                    }
                    disabled={!!$hiderMode || !data.drag || $isLoading}
                >
                    <ToggleGroupItem value="outside">Outside</ToggleGroupItem>
                    <ToggleGroupItem value="inside">Inside</ToggleGroupItem>
                </ToggleGroup>
            </div>
        </QuestionCard>
    );
};
