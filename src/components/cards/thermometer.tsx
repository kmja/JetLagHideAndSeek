import { useStore } from "@nanostores/react";
import { distance, point } from "@turf/turf";
import { Copy, Share2 } from "lucide-react";
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

import { QuestionCard, ManualAnswerDisclosure } from "./base";

export const ThermometerQuestionComponent = ({
    data,
    questionKey,
    forceExpanded,
    sub,
    className,
    compactAnswer,
}: {
    data: ThermometerQuestion;
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
                Share opens the OS share sheet (link previews in chat apps);
                Copy puts the URL on the clipboard for manual pasting. */}
            <div className="px-2 space-y-3">
                <ThermometerShareRow
                    label="Starting point"
                    text="Starting a thermometer question. From:"
                    lat={data.latA}
                    lng={data.lngA}
                    disabled={$isLoading}
                />
                <ThermometerShareRow
                    label="Ending point"
                    text="Now at:"
                    lat={data.latB}
                    lng={data.lngB}
                    disabled={$isLoading}
                />
            </div>

            {distanceValue !== null && (
                <div className="px-2 text-sm text-muted-foreground">
                    Distance:{" "}
                    <span className="font-medium text-foreground">
                        {distanceValue.toFixed(3)} {unitLabel}
                    </span>
                </div>
            )}

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
                        value={data.warmer ? "warmer" : "colder"}
                        onValueChange={(value: "warmer" | "colder") =>
                            questionModified(
                                (data.warmer = value === "warmer"),
                            )
                        }
                        disabled={!!$hiderMode || !data.drag || $isLoading}
                    >
                        <ToggleGroupItem color="red" value="colder">
                            Colder
                        </ToggleGroupItem>
                        <ToggleGroupItem value="warmer">Warmer</ToggleGroupItem>
                    </ToggleGroup>
                </div>
            </ManualAnswerDisclosure>
        </QuestionCard>
    );
};

/**
 * Inline row of Share + Copy buttons for one location (start or end) of a
 * thermometer question. Share opens the OS share sheet; Copy puts the URL
 * on the clipboard.
 */
function ThermometerShareRow({
    label,
    text,
    lat,
    lng,
    disabled,
}: {
    label: string;
    text: string;
    lat: number;
    lng: number;
    disabled?: boolean;
}) {
    const url = `https://maps.google.com/?q=${lat},${lng}`;
    const fullText = `${text} ${url}`;

    const handleShare = async () => {
        try {
            if (
                typeof navigator !== "undefined" &&
                typeof navigator.share === "function"
            ) {
                await navigator.share({ title: label, text: fullText, url });
            } else {
                await navigator.clipboard.writeText(fullText);
                toast.success(`${label} copied (sharing not supported)`, {
                    autoClose: 1800,
                });
            }
        } catch (err) {
            if (err instanceof Error && err.name === "AbortError") return;
            toast.error("Could not share");
        }
    };

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(fullText);
            toast.success(`${label} copied`, { autoClose: 1500 });
        } catch {
            toast.error("Could not copy");
        }
    };

    return (
        <div>
            <div className="text-xs uppercase tracking-wider text-muted-foreground font-poppins font-semibold mb-1.5">
                {label}
            </div>
            <div className="flex gap-2">
                <Button
                    onClick={handleShare}
                    disabled={disabled}
                    className="flex-1 gap-2"
                >
                    <Share2 className="w-4 h-4" />
                    Share
                </Button>
                <Button
                    onClick={handleCopy}
                    variant="outline"
                    disabled={disabled}
                    className="flex-1 gap-2"
                >
                    <Copy className="w-4 h-4" />
                    Copy
                </Button>
            </div>
        </div>
    );
}
