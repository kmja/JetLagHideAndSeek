import { useStore } from "@nanostores/react";
import { distance, point } from "@turf/turf";
import { Copy, Flag, Share2, Thermometer as ThermIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "react-toastify";

import { LatitudeLongitude } from "@/components/LatLngPicker";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { defaultUnit, leafletMapContext } from "@/lib/context";
import {
    hiderMode,
    isLoading,
    questionModified,
    questions,
    triggerLocalRefresh,
} from "@/lib/context";
import { cn } from "@/lib/utils";
import type { ThermometerQuestion } from "@/maps/schema";

import { ManualAnswerDisclosure, QuestionCard } from "./base";

/**
 * Thermometer presets. Per the rulebook, a thermometer is committed at one
 * of a fixed set of distances. We track which presets have been used
 * across all *finished* thermometer questions in this game so each
 * preset can only be picked once.
 *
 * `sig` is the signature stored in the question's `distance` field — used
 * to test uniqueness without ambiguity from unit conversion.
 */
const THERMOMETER_PRESETS: { km: number; label: string; sig: string }[] = [
    { km: 0.5, label: "500m", sig: "500m" },
    { km: 1, label: "1km", sig: "1km" },
    { km: 2, label: "2km", sig: "2km" },
    { km: 5, label: "5km", sig: "5km" },
    { km: 10, label: "10km", sig: "10km" },
];

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

    const status = data.status ?? "finished";
    const isStarted = status === "started";

    // Index of this thermometer among all thermometer questions, for label.
    const label = `Thermometer ${
        $questions
            .filter((q) => q.id === "thermometer")
            .map((q) => q.key)
            .indexOf(questionKey) + 1
    }`;

    // Which preset signatures are taken by *other* finished thermometer
    // questions in this game. The active question is excluded so when the
    // user is finishing this one, all presets are still candidates here.
    const usedPresetSigs = new Set(
        $questions
            .filter(
                (q) =>
                    q.id === "thermometer" &&
                    q.key !== questionKey &&
                    (q.data as ThermometerQuestion).status !== "started" &&
                    (q.data as ThermometerQuestion).distance,
            )
            .map((q) => (q.data as ThermometerQuestion).distance!),
    );

    /* ── Started branch: live distance + finish picker ────────────── */

    if (isStarted) {
        return (
            <QuestionCard
                questionKey={questionKey}
                label={label}
                sub={sub ?? "Started"}
                category="thermometer"
                summary="In progress"
                createdAt={data.createdAt}
                className={className}
                forceExpanded={forceExpanded}
                collapsed={data.collapsed}
                setCollapsed={(collapsed) => {
                    data.collapsed = collapsed;
                }}
                locked={!data.drag}
                setLocked={(locked) =>
                    questionModified((data.drag = !locked))
                }
            >
                <StartedBody
                    startLat={data.latA}
                    startLng={data.lngA}
                    unit={DISTANCE_UNIT}
                    usedPresetSigs={usedPresetSigs}
                    disabled={$isLoading}
                    onFinish={(preset, finishLat, finishLng) => {
                        data.latB = finishLat;
                        data.lngB = finishLng;
                        data.status = "finished";
                        data.distance = preset.sig;
                        questionModified();
                        toast.success(
                            `Thermometer finished at ${preset.label}`,
                            { autoClose: 2000 },
                        );
                    }}
                />
            </QuestionCard>
        );
    }

    /* ── Finished branch: existing share + warmer/colder UI ───────── */

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

    const summary = data.distance
        ? `${data.distance} · ${data.warmer ? "Warmer" : "Colder"}`
        : `${data.warmer ? "Warmer" : "Colder"} after move`;

    return (
        <QuestionCard
            questionKey={questionKey}
            label={label}
            sub={sub ?? data.distance}
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

            {/* Rule book: seekers should notify hiders when starting and
                when finishing a thermometer move, sending current location. */}
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
                        <ToggleGroupItem value="warmer">
                            Warmer
                        </ToggleGroupItem>
                    </ToggleGroup>
                </div>
            </ManualAnswerDisclosure>
        </QuestionCard>
    );
};

/* ──────────────────────────────────────────────────────────────────── */

/**
 * The body of a thermometer card while it's still "started". Watches the
 * seeker's GPS position, shows live distance from the start point, and
 * surfaces "Finish with X" buttons for any presets that are both (a)
 * reached by the current distance and (b) not yet taken by a finished
 * thermometer earlier in the game.
 */
function StartedBody({
    startLat,
    startLng,
    unit,
    usedPresetSigs,
    disabled,
    onFinish,
}: {
    startLat: number;
    startLng: number;
    unit: "miles" | "kilometers" | "meters";
    usedPresetSigs: Set<string>;
    disabled?: boolean;
    onFinish: (
        preset: { km: number; label: string; sig: string },
        finishLat: number,
        finishLng: number,
    ) => void;
}) {
    // Live seeker position. Falls back to map center if geolocation is
    // unavailable or denied — the seeker can still finish manually that
    // way (will use whatever the map is centered on).
    const [pos, setPos] = useState<{ lat: number; lng: number } | null>(null);
    const [gpsError, setGpsError] = useState<string | null>(null);

    useEffect(() => {
        if (typeof navigator === "undefined" || !navigator.geolocation) {
            setGpsError("Geolocation isn't available on this device.");
            return;
        }
        const id = navigator.geolocation.watchPosition(
            (p) => {
                setPos({ lat: p.coords.latitude, lng: p.coords.longitude });
                setGpsError(null);
            },
            (err) => {
                setGpsError(
                    err.code === err.PERMISSION_DENIED
                        ? "Location permission denied. Using map center as fallback."
                        : "Couldn't read location. Using map center as fallback.",
                );
            },
            { enableHighAccuracy: true, maximumAge: 5_000, timeout: 30_000 },
        );
        return () => navigator.geolocation.clearWatch(id);
    }, []);

    // Current effective position — GPS if we have it, otherwise the map's
    // visible center as a graceful fallback. The seeker can pan the map
    // to where they actually are when GPS isn't available.
    const map = leafletMapContext.get();
    const fallbackCenter = map?.getCenter();
    const currentLat = pos?.lat ?? fallbackCenter?.lat ?? startLat;
    const currentLng = pos?.lng ?? fallbackCenter?.lng ?? startLng;

    const travelKm = distance(
        point([startLng, startLat]),
        point([currentLng, currentLat]),
        { units: "kilometers" },
    );

    // Presets the seeker has reached AND haven't been used elsewhere.
    const reachedAvailable = THERMOMETER_PRESETS.filter(
        (p) => travelKm >= p.km && !usedPresetSigs.has(p.sig),
    );

    // Shortest preset that's still not used — what we tell the user to
    // aim for if they haven't yet reached anything.
    const nextTarget = THERMOMETER_PRESETS.find(
        (p) => !usedPresetSigs.has(p.sig),
    );

    const displayTravel =
        unit === "miles"
            ? `${(travelKm * 0.621371).toFixed(2)} mi`
            : unit === "meters"
              ? `${(travelKm * 1000).toFixed(0)} m`
              : `${travelKm.toFixed(2)} km`;

    return (
        <div className="px-2 space-y-3">
            <div className="flex items-start gap-2 px-3 py-2 rounded-md bg-secondary/40 border border-border">
                <ThermIcon className="w-4 h-4 mt-0.5 text-primary shrink-0" />
                <div className="text-sm">
                    <div className="text-xs uppercase tracking-wider text-muted-foreground font-poppins font-semibold">
                        Started here
                    </div>
                    <div className="text-foreground/80 tabular-nums text-xs">
                        {startLat.toFixed(5)}, {startLng.toFixed(5)}
                    </div>
                </div>
            </div>

            <div className="text-center py-3 rounded-md bg-secondary/30 border border-border">
                <div className="text-xs uppercase tracking-wider text-muted-foreground font-poppins font-semibold mb-1">
                    Distance traveled
                </div>
                <div className="text-2xl font-poppins font-bold tabular-nums text-primary">
                    {displayTravel}
                </div>
            </div>

            {gpsError && (
                <div className="text-xs text-amber-400/90 px-1">
                    {gpsError}
                </div>
            )}

            {reachedAvailable.length === 0 ? (
                <div className="text-sm text-muted-foreground px-1">
                    {nextTarget ? (
                        <>
                            Move{" "}
                            <span className="font-medium text-foreground">
                                {formatRemainingKm(
                                    nextTarget.km - travelKm,
                                    unit,
                                )}
                            </span>{" "}
                            more to finish at {nextTarget.label}.
                        </>
                    ) : (
                        <>
                            All thermometer presets have already been used in
                            this game.
                        </>
                    )}
                </div>
            ) : (
                <div className="space-y-2">
                    <div className="text-xs uppercase tracking-wider text-muted-foreground font-poppins font-semibold">
                        Finish with
                    </div>
                    <div className="grid grid-cols-5 gap-1.5">
                        {THERMOMETER_PRESETS.map((preset) => {
                            const reached = travelKm >= preset.km;
                            const used = usedPresetSigs.has(preset.sig);
                            const isAvailable = reached && !used;
                            return (
                                <button
                                    key={preset.sig}
                                    type="button"
                                    onClick={() =>
                                        onFinish(
                                            preset,
                                            currentLat,
                                            currentLng,
                                        )
                                    }
                                    disabled={!isAvailable || disabled}
                                    className={cn(
                                        "py-2 px-2 rounded-md text-sm font-poppins font-semibold",
                                        "border-2 transition-colors",
                                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                        isAvailable
                                            ? "bg-primary text-primary-foreground border-primary hover:bg-primary/90"
                                            : "bg-secondary text-muted-foreground border-border opacity-40 cursor-not-allowed",
                                    )}
                                    title={
                                        used
                                            ? `${preset.label} already used in this game`
                                            : !reached
                                              ? `Move further to unlock ${preset.label}`
                                              : `Finish at ${preset.label}`
                                    }
                                >
                                    <span className="block">
                                        {preset.label}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                    <div className="flex items-center gap-1 text-xs text-muted-foreground pt-1">
                        <Flag className="w-3 h-3" />
                        Pick the distance you want to commit to. Once chosen,
                        the question moves to share-ready.
                    </div>
                </div>
            )}
        </div>
    );
}

/** Pretty-print the remaining distance in the seeker's preferred unit. */
function formatRemainingKm(km: number, unit: string): string {
    if (km <= 0) return "0";
    if (unit === "miles") return `${(km * 0.621371).toFixed(2)} mi`;
    if (unit === "meters") return `${Math.ceil(km * 1000)} m`;
    return km < 1 ? `${Math.ceil(km * 1000)} m` : `${km.toFixed(2)} km`;
}

/**
 * Inline row of Share + Copy buttons for one location (start or end) of a
 * thermometer question.
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
