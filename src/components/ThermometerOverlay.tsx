import { useStore } from "@nanostores/react";
import { distance, point } from "@turf/turf";
import { Flag } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "react-toastify";

import { CATEGORIES } from "@/lib/categories";
import {
    questionModified,
    questions,
    triggerLocalRefresh,
} from "@/lib/context";
import { multiplayerEnabled } from "@/lib/multiplayer/session";
import { seekerResendQuestion } from "@/lib/multiplayer/store";
import { cn } from "@/lib/utils";
import type { Question, ThermometerQuestion } from "@/maps/schema";

import { QuestionOverlayCard } from "./questionOverlayCard";

const THERM_COLOR = CATEGORIES.thermometer?.color ?? "#f5d268";

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
        // Stamp createdAt NOW — finishing is the moment the question is
        // actually sent, so this starts the hider's answer window and
        // flips the seeker's PendingAnswerOverlay out of the "not sent"
        // state into a clean "waiting for answer" countdown. (The started
        // phase deliberately had no createdAt — the seeker was still
        // moving.) Without this the question read as never-sent and no
        // overlay appeared.
        (data as { createdAt?: number }).createdAt = Date.now();
        questionModified();
        // Push the FINISHED question to the hider. At start we only sent a
        // "started" placeholder; the hider can't answer until they receive
        // this finished version with the end point + distance.
        if (multiplayerEnabled.get()) {
            seekerResendQuestion(started.key);
        }
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

    // Match the show-style chrome of the other question overlays: the
    // shared QuestionOverlayCard (solid category icon block + big label +
    // status), with the live travelled distance as the hero label and the
    // progress bar + End action attached below in the same surface.
    const distanceLabel =
        travelKm === null
            ? gpsError
                ? "No GPS"
                : "Locating…"
            : formatTravel(travelKm);
    const eyebrow = (
        <span className="text-[color:var(--cat-label)]">
            Thermometer{target ? ` · target ${target.label}` : ""}
        </span>
    );
    const detail =
        travelKm === null
            ? undefined
            : !target
              ? "Distance from where you started"
              : reachedTarget
                ? "Target reached — end below"
                : `${formatRemaining(target.km - travelKm)} to go`;

    return (
        <div
            className={cn(
                "pointer-events-none absolute left-1/2 -translate-x-1/2 z-[1030]",
                "bottom-[calc(96px+env(safe-area-inset-bottom))] md:bottom-20",
                "max-w-[92vw] w-[min(92vw,420px)]",
                // v446: fade + rise in instead of popping onto the map.
                "animate-in fade-in slide-in-from-bottom-2 duration-200",
            )}
        >
            {/* One cohesive overlay card: the QuestionOverlayCard header
                (its own border/shadow stripped) sits inside a wrapper that
                owns the border + shadow, with the progress bar and End
                action attached beneath so it reads as a single unit. */}
            <div className="overflow-hidden border border-[color:var(--overlay-card-border)] bg-[var(--overlay-card)] shadow-xl">
                <QuestionOverlayCard
                    categoryId="thermometer"
                    eyebrow={eyebrow}
                    summary={{ bigLabel: distanceLabel, detail }}
                    className="!border-0 !shadow-none"
                    right={
                        target ? (
                            <div className="flex flex-col items-center leading-none">
                                <span className="text-[8px] uppercase tracking-[0.14em] font-poppins font-bold text-[color:var(--overlay-card-desc)] mb-0.5">
                                    Target
                                </span>
                                <span className="text-xl font-poppins font-black tabular-nums leading-none text-[color:var(--cat-label)]">
                                    {target.label}
                                </span>
                            </div>
                        ) : undefined
                    }
                />

                {target && (
                    <div className="h-1.5 w-full bg-foreground/10">
                        <div
                            className={cn(
                                "h-full transition-[width] duration-300 ease-out",
                                reachedTarget && "bg-success",
                            )}
                            style={{
                                width: `${progressPct.toFixed(1)}%`,
                                ...(reachedTarget
                                    ? {}
                                    : { backgroundColor: THERM_COLOR }),
                            }}
                        />
                    </div>
                )}

                {target && (
                    <div className="pointer-events-auto p-2">
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
                                "flex w-full items-center justify-center gap-1.5 rounded-md py-2.5 text-xs",
                                "font-poppins font-bold uppercase tracking-wide",
                                "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                reachedTarget
                                    ? "bg-success text-white hover:bg-success/90"
                                    : "bg-foreground/10 text-muted-foreground cursor-not-allowed",
                            )}
                        >
                            <Flag className="h-3.5 w-3.5" strokeWidth={2.5} />
                            End thermometer &amp; send question
                        </button>
                    </div>
                )}

                {!target && travelKm !== null && (
                    <p className="px-4 pb-3 pt-1 text-[11px] leading-snug text-[color:var(--overlay-card-desc)]">
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
