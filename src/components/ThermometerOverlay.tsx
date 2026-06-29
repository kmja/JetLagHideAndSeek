import { useStore } from "@nanostores/react";
import { distance, point } from "@turf/turf";
import { Flag, Thermometer } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "react-toastify";

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

/** Override the questions list to preview the running pill in the
 *  /debug/overlays gallery without touching global state. */
export interface ThermometerPreview {
    questions: ReturnType<typeof questions.get>;
}

export function ThermometerOverlay({
    preview,
}: { preview?: ThermometerPreview } = {}) {
    useStore(triggerLocalRefresh);
    let $questions = useStore(questions);
    if (preview) $questions = preview.questions;

    // Find the started thermometer, if any. Take the most recent by
    // startedAt timestamp to handle the unusual case of more than one.
    const started = findStartedThermometer($questions);

    // GPS watch — only runs when we actually have a thermometer to track,
    // so we don't pay the geolocation cost during normal play.
    const [pos, setPos] = useState<{ lat: number; lng: number } | null>(null);
    const [gpsError, setGpsError] = useState(false);

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

    // v339: single-target progress UI. The seeker chose a target
    // distance up front (targetSig — "1km", "5km", "15km", "75km"),
    // and the overlay tracks progress against THAT target only. The
    // "End thermometer & send question" button unlocks once they reach
    // it. Legacy thermometers without targetSig (pre-v339, or imported
    // from older saves) still render with the bare distance readout so
    // they don't lose UX entirely — but they can't be ended from the
    // overlay (use the card's preset picker instead).
    const target = data.targetSig
        ? THERMOMETER_PRESETS.find((p) => p.sig === data.targetSig)
        : undefined;
    const reachedTarget = target !== undefined && travelKm !== null && travelKm >= target.km;

    const endThermometer = () => {
        if (!pos || !target) return;
        data.latB = pos.lat;
        data.lngB = pos.lng;
        data.status = "finished";
        data.distance = target.sig;
        questionModified();
        toast.success(
            `Thermometer ended at ${target.label}. Sent to the hider.`,
            { autoClose: 3500 },
        );
    };

    // Bar progress percentage (0..100) toward the target. Clamped so a
    // seeker who overshoots stays at 100 % instead of running past.
    const targetKm = target?.km ?? 0;
    const progressPct =
        target && travelKm !== null
            ? Math.min(100, (travelKm / targetKm) * 100)
            : 0;

    return (
        <div
            className={cn(
                "pointer-events-none absolute left-1/2 -translate-x-1/2 z-[1030]",
                "bottom-[calc(96px+env(safe-area-inset-bottom))] md:bottom-20",
                "max-w-[90vw] w-[340px]",
            )}
        >
            <div
                className={cn(
                    "pointer-events-auto",
                    "px-3.5 py-2.5 rounded-2xl",
                    "bg-background/95 backdrop-blur-md shadow-lg",
                    "border border-primary/40",
                    "space-y-2",
                    // v446: fade + rise in instead of popping onto the map.
                    "animate-in fade-in slide-in-from-bottom-2 duration-200",
                )}
            >
                <div className="flex items-center gap-2">
                    <Thermometer className="w-4 h-4 text-primary shrink-0" />
                    <span className="text-xs uppercase tracking-wider font-poppins font-semibold text-muted-foreground">
                        Thermometer
                    </span>
                    {target && (
                        <span className="text-[10px] uppercase tracking-wider text-muted-foreground/80 ml-auto">
                            Target {target.label}
                        </span>
                    )}
                </div>
                <div className="flex items-baseline gap-2">
                    <span className="text-base font-poppins font-bold tabular-nums text-primary">
                        {travelKm === null
                            ? gpsError
                                ? "no GPS"
                                : "locating…"
                            : formatTravel(travelKm)}
                    </span>
                    {target && travelKm !== null && (
                        <span className="text-xs text-muted-foreground tabular-nums">
                            of {target.label}
                            {!reachedTarget && (
                                <>
                                    {" · "}
                                    {formatRemaining(
                                        target.km - travelKm,
                                    )}{" "}
                                    to go
                                </>
                            )}
                        </span>
                    )}
                </div>
                {target && (
                    <div className="h-1.5 w-full bg-secondary/60 rounded-full overflow-hidden">
                        <div
                            className={cn(
                                "h-full transition-[width] duration-300 ease-out",
                                reachedTarget
                                    ? "bg-success"
                                    : "bg-primary",
                            )}
                            style={{ width: `${progressPct.toFixed(1)}%` }}
                        />
                    </div>
                )}
                {target && (
                    <button
                        type="button"
                        onClick={endThermometer}
                        disabled={!reachedTarget || !pos}
                        title={
                            !pos
                                ? "Waiting for GPS"
                                : reachedTarget
                                  ? `End thermometer at ${target.label} and send to the hider`
                                  : `Move ${formatRemaining(
                                        target.km - (travelKm ?? 0),
                                    )} more to enable`
                        }
                        className={cn(
                            "w-full flex items-center justify-center gap-1.5 py-2 rounded-md text-xs",
                            "font-poppins font-semibold",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            reachedTarget
                                ? "bg-success text-white hover:bg-success/90"
                                : "bg-secondary text-muted-foreground cursor-not-allowed",
                        )}
                    >
                        <Flag className="w-3.5 h-3.5" />
                        End thermometer &amp; send question
                    </button>
                )}
                {!target && travelKm !== null && (
                    <p className="text-[10px] text-muted-foreground leading-snug">
                        Legacy thermometer — finish from the question
                        card&apos;s preset picker.
                    </p>
                )}
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
