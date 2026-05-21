import { useStore } from "@nanostores/react";
import { distance, point } from "@turf/turf";
import { Flag, Thermometer } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "react-toastify";

import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import {
    questionModified,
    questions,
    triggerLocalRefresh,
} from "@/lib/context";
import { cn } from "@/lib/utils";
import type { Question, ThermometerQuestion } from "@/maps/schema";

/**
 * Floating distance-meter shown on top of the map while any thermometer
 * question is in its "started" state. Per the rulebook, the seeker needs
 * a clear, always-visible indication of how far they've moved since
 * starting the thermometer — that's what this is. It also doubles as the
 * "Finish here" affordance: tapping the pill opens a popover with finish
 * presets so the seeker can commit without opening the questions sidebar.
 *
 * Mounted globally (in index.astro) but renders nothing unless there's
 * exactly one started thermometer to track. Multiple simultaneous
 * thermometers aren't a thing per rules, but if it ever happens we just
 * pick the most recent.
 *
 * Layout: bottom-center, just above the bottom nav on mobile. Top-right
 * map controls own that corner; putting the pill at the bottom keeps it
 * out of the way of the map-display controls and the wizard.
 */
const THERMOMETER_PRESETS: { km: number; label: string; sig: string }[] = [
    { km: 0.5, label: "500m", sig: "500m" },
    { km: 1, label: "1km", sig: "1km" },
    { km: 2, label: "2km", sig: "2km" },
    { km: 5, label: "5km", sig: "5km" },
    { km: 10, label: "10km", sig: "10km" },
    { km: 15, label: "15km", sig: "15km" },
    { km: 75, label: "75km", sig: "75km" },
];

export function ThermometerOverlay() {
    useStore(triggerLocalRefresh);
    const $questions = useStore(questions);

    // Find the started thermometer, if any. Take the most recent by
    // startedAt timestamp to handle the unusual case of more than one.
    const started = findStartedThermometer($questions);

    // GPS watch — only runs when we actually have a thermometer to track,
    // so we don't pay the geolocation cost during normal play.
    const [pos, setPos] = useState<{ lat: number; lng: number } | null>(null);
    const [gpsError, setGpsError] = useState(false);
    const [finishOpen, setFinishOpen] = useState(false);

    useEffect(() => {
        if (!started) {
            setPos(null);
            setGpsError(false);
            return;
        }
        if (typeof navigator === "undefined" || !navigator.geolocation) {
            setGpsError(true);
            return;
        }
        const id = navigator.geolocation.watchPosition(
            (p) => {
                setPos({ lat: p.coords.latitude, lng: p.coords.longitude });
                setGpsError(false);
            },
            () => setGpsError(true),
            { enableHighAccuracy: true, maximumAge: 5_000, timeout: 30_000 },
        );
        return () => navigator.geolocation.clearWatch(id);
    }, [started?.key]);

    if (!started) return null;

    const data = started.data as ThermometerQuestion;
    const travelKm = pos
        ? distance(
              point([data.lngA, data.latA]),
              point([pos.lng, pos.lat]),
              { units: "kilometers" },
          )
        : null;

    // Which preset signatures are taken by other finished thermometer
    // questions in this game. The active question is excluded so all
    // presets are candidates here.
    const usedPresetSigs = new Set(
        $questions
            .filter(
                (q) =>
                    q.id === "thermometer" &&
                    q.key !== started.key &&
                    (q.data as ThermometerQuestion).status !== "started" &&
                    (q.data as ThermometerQuestion).distance,
            )
            .map((q) => (q.data as ThermometerQuestion).distance!),
    );

    const canFinish = travelKm !== null;
    const finishThermometer = (
        preset: { km: number; label: string; sig: string },
        finishLat: number,
        finishLng: number,
    ) => {
        data.latB = finishLat;
        data.lngB = finishLng;
        data.status = "finished";
        data.distance = preset.sig;
        questionModified();
        setFinishOpen(false);
        toast.success(
            `Thermometer finished at ${preset.label}. Share the ending point to send to the hider.`,
            { autoClose: 3500 },
        );
    };

    return (
        <div
            className={cn(
                // Bottom-center, lifted above the mobile bottom nav (and
                // Leaflet's attribution that we already push up above the
                // nav in globals.css). On desktop, sits above the bottom-
                // right OptionDrawers cluster.
                "pointer-events-none absolute left-1/2 -translate-x-1/2 z-[1030]",
                "bottom-[calc(96px+env(safe-area-inset-bottom))] md:bottom-20",
                "max-w-[90vw]",
            )}
        >
            <div
                className={cn(
                    "pointer-events-auto",
                    "flex items-center gap-2.5 px-3.5 py-2 rounded-full",
                    "bg-background/95 backdrop-blur-md shadow-lg",
                    "border border-primary/40",
                )}
            >
                <Thermometer className="w-4 h-4 text-primary shrink-0" />
                <span className="text-xs uppercase tracking-wider font-poppins font-semibold text-muted-foreground">
                    Thermometer
                </span>
                <span className="text-sm font-poppins font-bold tabular-nums text-primary min-w-[70px] text-right">
                    {travelKm === null
                        ? gpsError
                            ? "no GPS"
                            : "locating…"
                        : formatTravel(travelKm)}
                </span>
                <Popover open={finishOpen} onOpenChange={setFinishOpen}>
                    <PopoverTrigger asChild>
                        <button
                            type="button"
                            disabled={!canFinish}
                            title={
                                canFinish
                                    ? "Finish thermometer at your current location"
                                    : "Waiting for GPS"
                            }
                            className={cn(
                                "flex items-center gap-1 px-2.5 py-1 rounded-full text-xs",
                                "bg-primary text-primary-foreground font-poppins font-semibold",
                                "hover:bg-primary/90 transition-colors",
                                "disabled:opacity-40 disabled:cursor-not-allowed",
                                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            )}
                        >
                            <Flag className="w-3 h-3" />
                            Finish here
                        </button>
                    </PopoverTrigger>
                    <PopoverContent className="w-[260px] p-3" align="end">
                        <div className="text-xs font-poppins font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                            Finish at preset
                        </div>
                        <div className="grid grid-cols-3 gap-1.5">
                            {THERMOMETER_PRESETS.map((preset) => {
                                const reached =
                                    travelKm !== null && travelKm >= preset.km;
                                const used = usedPresetSigs.has(preset.sig);
                                const enabled = reached && !used;
                                return (
                                    <button
                                        key={preset.sig}
                                        type="button"
                                        onClick={() => {
                                            if (!pos) return;
                                            finishThermometer(
                                                preset,
                                                pos.lat,
                                                pos.lng,
                                            );
                                        }}
                                        disabled={!enabled || !pos}
                                        title={
                                            used
                                                ? `${preset.label} already used`
                                                : !reached
                                                  ? `Move ${formatRemaining(
                                                        preset.km -
                                                            (travelKm ?? 0),
                                                    )} more`
                                                  : `Finish at ${preset.label}`
                                        }
                                        className={cn(
                                            "py-1.5 px-1 rounded-md text-xs font-poppins font-semibold",
                                            "border transition-colors",
                                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                            enabled
                                                ? "bg-primary text-primary-foreground border-primary hover:bg-primary/90"
                                                : "bg-secondary text-muted-foreground border-border opacity-50 cursor-not-allowed",
                                        )}
                                    >
                                        {preset.label}
                                    </button>
                                );
                            })}
                        </div>
                        <p className="text-[10px] text-muted-foreground mt-2 leading-snug">
                            Grey presets aren&apos;t reached yet or have
                            already been used in this game.
                        </p>
                    </PopoverContent>
                </Popover>
            </div>
        </div>
    );
}

function findStartedThermometer(qs: Question[]): Question | null {
    const candidates = qs.filter((q) => {
        if (q.id !== "thermometer") return false;
        const d = q.data as ThermometerQuestion;
        return (d.status ?? "finished") === "started";
    });
    if (candidates.length === 0) return null;
    // Pick the most recently started one (or by key as a fallback).
    candidates.sort((a, b) => {
        const ta = (a.data as ThermometerQuestion).startedAt ?? 0;
        const tb = (b.data as ThermometerQuestion).startedAt ?? 0;
        return tb - ta;
    });
    return candidates[0];
}

function formatTravel(km: number): string {
    if (km < 1) return `${Math.round(km * 1000)} m`;
    return `${km.toFixed(2)} km`;
}

function formatRemaining(km: number): string {
    if (km <= 0) return "0";
    if (km < 1) return `${Math.ceil(km * 1000)} m`;
    return `${km.toFixed(1)} km`;
}
