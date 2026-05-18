import { useStore } from "@nanostores/react";
import { distance, point } from "@turf/turf";
import { Share2 } from "lucide-react";
import { toast } from "react-toastify";

import { LatitudeLongitude } from "@/components/LatLngPicker";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { defaultUnit } from "@/lib/context";
import {
    hiderMode,
    isLoading,
    questionModified,
    questions,
    triggerLocalRefresh,
} from "@/lib/context";
import { cn } from "@/lib/utils";
import type { ThermometerQuestion } from "@/maps/schema";

import { QuestionCard } from "./base";

export const ThermometerQuestionComponent = ({
    data,
    questionKey,
    forceExpanded,
    sub,
    className,
}: {
    data: ThermometerQuestion;
    questionKey: number;
    sub?: string;
    forceExpanded?: boolean;
    className?: string;
}) => {
    useStore(triggerLocalRefresh);
    const $hiderMode = useStore(hiderMode);
    const $questions = useStore(questions);
    const $isLoading = useStore(isLoading);

    const $defaultUnit = useStore(defaultUnit);
    const DISTANCE_UNIT = $defaultUnit ?? "miles";

    const label = `Thermometer
    ${
        $questions
            .filter((q) => q.id === "thermometer")
            .map((q) => q.key)
            .indexOf(questionKey) + 1
    }`;

    const hasCoords =
        data.latA !== null &&
        data.lngA !== null &&
        data.latB !== null &&
        data.lngB !== null;

    const distanceValue = hasCoords
        ? distance(
              point([data.lngA!, data.latA!]),
              point([data.lngB!, data.latB!]),
              { units: DISTANCE_UNIT },
          )
        : null;

    const unitLabel =
        DISTANCE_UNIT === "meters"
            ? "Meters"
            : DISTANCE_UNIT === "kilometers"
              ? "KM"
              : "Miles";

    const summary = `${data.warmer ? "Warmer" : "Colder"} after move`;

    return (
        <QuestionCard
            questionKey={questionKey}
            label={label}
            sub={sub}
            category="thermometer"
            summary={summary}
            createdAt={data.createdAt}
            className={className}
            forceExpanded={forceExpanded}
            collapsed={data.collapsed}
            setCollapsed={(collapsed) => {
                data.collapsed = collapsed;
            }}
            locked={!data.drag}
            setLocked={(locked) => questionModified((data.drag = !locked))}
        >
            <LatitudeLongitude
                latitude={data.latA}
                longitude={data.lngA}
                label="Start"
                colorName={data.colorA}
                onChange={(lat, lng) => {
                    if (lat !== null) data.latA = lat;
                    if (lng !== null) data.lngA = lng;
                    questionModified();
                }}
                disabled={!data.drag || $isLoading}
            />

            <LatitudeLongitude
                latitude={data.latB}
                longitude={data.lngB}
                label="End"
                colorName={data.colorB}
                onChange={(lat, lng) => {
                    if (lat !== null) data.latB = lat;
                    if (lng !== null) data.lngB = lng;
                    questionModified();
                }}
                disabled={!data.drag || $isLoading}
            />

            {/* Rule book: seekers should notify hiders when starting (and when
                finishing) a thermometer move, sending their current location.
                Uses the Web Share API where available (opens the OS share
                sheet on mobile) and falls back to clipboard on browsers that
                don't support it (notably desktop Firefox). */}
            <div className="flex gap-2 px-2">
                <Button
                    variant="outline"
                    size="sm"
                    className="flex-1 gap-1.5"
                    disabled={$isLoading}
                    onClick={async () => {
                        const url = `https://maps.google.com/?q=${data.latA},${data.lngA}`;
                        const text = `Starting a thermometer question. From: ${url}`;
                        try {
                            if (
                                typeof navigator !== "undefined" &&
                                typeof navigator.share === "function"
                            ) {
                                await navigator.share({
                                    title: "Thermometer start",
                                    text,
                                    url,
                                });
                            } else {
                                await navigator.clipboard.writeText(text);
                                toast.success(
                                    "Start message copied (sharing not supported)",
                                    { autoClose: 1800 },
                                );
                            }
                        } catch (err) {
                            // User cancelled share dialog → silently ignore
                            if (
                                err instanceof Error &&
                                err.name === "AbortError"
                            ) {
                                return;
                            }
                            toast.error("Could not share");
                        }
                    }}
                >
                    <Share2 className="w-3 h-3" />
                    Share start
                </Button>
                <Button
                    variant="outline"
                    size="sm"
                    className="flex-1 gap-1.5"
                    disabled={$isLoading}
                    onClick={async () => {
                        const url = `https://maps.google.com/?q=${data.latB},${data.lngB}`;
                        const text = `Now at: ${url}`;
                        try {
                            if (
                                typeof navigator !== "undefined" &&
                                typeof navigator.share === "function"
                            ) {
                                await navigator.share({
                                    title: "Thermometer end",
                                    text,
                                    url,
                                });
                            } else {
                                await navigator.clipboard.writeText(text);
                                toast.success(
                                    "End message copied (sharing not supported)",
                                    { autoClose: 1800 },
                                );
                            }
                        } catch (err) {
                            if (
                                err instanceof Error &&
                                err.name === "AbortError"
                            ) {
                                return;
                            }
                            toast.error("Could not share");
                        }
                    }}
                >
                    <Share2 className="w-3 h-3" />
                    Share end
                </Button>
            </div>

            {distanceValue !== null && (
                <div className="px-2 text-sm text-muted-foreground">
                    Distance:{" "}
                    <span className="font-medium text-foreground">
                        {distanceValue.toFixed(3)} {unitLabel}
                    </span>
                </div>
            )}

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
                    value={data.warmer ? "warmer" : "colder"}
                    onValueChange={(value: "warmer" | "colder") =>
                        questionModified((data.warmer = value === "warmer"))
                    }
                    disabled={!!$hiderMode || !data.drag || $isLoading}
                >
                    <ToggleGroupItem color="red" value="colder">
                        Colder
                    </ToggleGroupItem>
                    <ToggleGroupItem value="warmer">Warmer</ToggleGroupItem>
                </ToggleGroup>
            </div>
        </QuestionCard>
    );
};
