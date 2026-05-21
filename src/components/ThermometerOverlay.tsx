import { useStore } from "@nanostores/react";
import { distance, point } from "@turf/turf";
import { Thermometer } from "lucide-react";
import { useEffect, useState } from "react";

import { questions, triggerLocalRefresh } from "@/lib/context";
import { cn } from "@/lib/utils";
import type { ThermometerQuestion, Question } from "@/maps/schema";

/**
 * Floating distance-meter shown on top of the map while any thermometer
 * question is in its "started" state. Per the rulebook, the seeker needs
 * a clear, always-visible indication of how far they've moved since
 * starting the thermometer — that's what this is.
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
