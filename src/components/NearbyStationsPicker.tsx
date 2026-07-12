import { useStore } from "@nanostores/react";
import { convertLength } from "@turf/turf";
import { Loader2, LocateFixed } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
    allowedTransit,
    TRANSIT_ICONS,
    type TransitMode,
} from "@/lib/gameSetup";
import { hidingRadius, hidingRadiusUnits } from "@/lib/context";
import { findZonesNearPoint } from "@/lib/journey/stations";
import { cn } from "@/lib/utils";

/**
 * GPS-based hiding-zone picker for the hider during the hiding period —
 * "which hiding zones am I standing in?". Lists the candidate stations
 * whose hiding-radius circle CONTAINS the hider's current GPS fix, and
 * lets the hider commit one as their zone in a single tap.
 *
 * v665: resolves against the game's OWN candidate-zone set
 * (`findZonesNearPoint` — the same shared play-area-keyed fetch the
 * hiding-zones overlay uses) instead of firing a live `around:GPS`
 * Overpass query. That's both self-hosted (one cached query per game)
 * and CORRECT: a station outside the play area, or of a disallowed
 * mode, is not a legal zone and no longer shows up.
 *
 * The containment radius is the game's `hidingRadius` (rulebook default
 * 500 m): any farther and the hider's actual spot would sit outside the
 * zone they declared — which would let the seekers eliminate the wrong
 * territory.
 */


const MODE_LABELS: Record<TransitMode, string> = {
    bus: "Bus stop",
    tram: "Tram",
    train: "Train",
    subway: "Subway",
    ferry: "Ferry",
};

export interface FoundStation {
    id: number;
    name: string;
    lat: number;
    lng: number;
    mode: TransitMode;
    distanceMeters: number;
}

export function NearbyStationsPicker({
    onPick,
    onCancel,
}: {
    onPick: (s: FoundStation) => void;
    onCancel?: () => void;
}) {
    const $allowed = useStore(allowedTransit);
    const $hidingRadius = useStore(hidingRadius);
    const $hidingRadiusUnits = useStore(hidingRadiusUnits);
    const radiusMeters = Math.round(
        convertLength($hidingRadius, $hidingRadiusUnits, "meters"),
    );
    const [state, setState] = useState<
        | { status: "idle" }
        | { status: "locating" }
        | { status: "fetching"; lat: number; lng: number }
        | {
              status: "results";
              stations: FoundStation[];
              lat: number;
              lng: number;
          }
        | { status: "error"; message: string }
    >({ status: "idle" });

    const run = () => {
        if (typeof navigator === "undefined" || !navigator.geolocation) {
            setState({
                status: "error",
                message: "Location access isn't available on this device.",
            });
            return;
        }
        setState({ status: "locating" });
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                const { latitude: lat, longitude: lng } = pos.coords;
                setState({ status: "fetching", lat, lng });
                findZonesNearPoint(lat, lng, {
                    allowed: $allowed,
                    radiusMeters,
                })
                    .then((stations) => {
                        if (stations.length === 0) {
                            setState({
                                status: "error",
                                message: `No hiding zone of the allowed modes contains your position (nearest station must be within ${radiusMeters} m). Move closer to one, or pick a zone manually below.`,
                            });
                            return;
                        }
                        setState({
                            status: "results",
                            stations,
                            lat,
                            lng,
                        });
                    })
                    .catch((e) => {
                        console.warn("Nearby-stations fetch failed", e);
                        setState({
                            status: "error",
                            message:
                                "Couldn't fetch nearby stations — try again or pick manually below.",
                        });
                    });
            },
            (err) => {
                setState({
                    status: "error",
                    message:
                        err.code === err.PERMISSION_DENIED
                            ? "Location permission denied — pick a zone manually below."
                            : "Couldn't get your GPS location.",
                });
            },
            { enableHighAccuracy: true, timeout: 8000 },
        );
    };

    // Auto-run on mount.
    useEffect(() => {
        run();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    if (state.status === "idle" || state.status === "locating") {
        return (
            <Pane>
                <Loader2 className="w-4 h-4 animate-spin text-primary" />
                <span>
                    {state.status === "idle" ? "Reading GPS…" : "Locating you…"}
                </span>
            </Pane>
        );
    }

    if (state.status === "fetching") {
        return (
            <Pane>
                <Loader2 className="w-4 h-4 animate-spin text-primary" />
                <span>Fetching nearby stations…</span>
            </Pane>
        );
    }

    if (state.status === "error") {
        return (
            <Pane>
                <div className="space-y-2 w-full">
                    <p className="text-xs text-muted-foreground leading-snug">
                        {state.message}
                    </p>
                    <div className="flex gap-2">
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={run}
                            className="gap-1.5"
                        >
                            <LocateFixed className="w-3.5 h-3.5" />
                            Retry GPS
                        </Button>
                        {onCancel && (
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={onCancel}
                            >
                                Cancel
                            </Button>
                        )}
                    </div>
                </div>
            </Pane>
        );
    }

    return (
        <div
            className={cn(
                "rounded-sm border border-border bg-secondary/40 p-3 space-y-2",
            )}
        >
            <div className="flex items-center justify-between gap-2">
                <div className="text-[10px] uppercase tracking-[0.16em] font-poppins font-bold text-muted-foreground">
                    Zones you're in · within {radiusMeters} m
                </div>
                <Button
                    size="sm"
                    variant="ghost"
                    onClick={run}
                    className="gap-1.5 h-7 text-xs"
                >
                    <LocateFixed className="w-3 h-3" />
                    Refresh
                </Button>
            </div>
            <ul className="space-y-2.5">
                {state.stations.slice(0, 8).map((s) => {
                    const Icon = TRANSIT_ICONS[s.mode];
                    return (
                        <li key={s.id}>
                            {/* v786: bigger icon/text/spacing, and an explicit
                                "Select" button instead of a trailing checkmark
                                on a whole-row tap target. */}
                            <div className="w-full flex items-center gap-3 px-3 py-3 rounded-md bg-background/60 border border-border">
                                <span className="inline-flex items-center justify-center w-11 h-11 rounded-md shrink-0 bg-primary/20">
                                    <Icon className="w-5 h-5 text-primary" />
                                </span>
                                <div className="min-w-0 flex-1">
                                    <div className="text-base font-inter-tight font-bold leading-tight truncate">
                                        {s.name}
                                    </div>
                                    <div className="text-xs text-muted-foreground tabular-nums mt-0.5">
                                        {MODE_LABELS[s.mode]} ·{" "}
                                        {Math.round(s.distanceMeters)} m
                                    </div>
                                </div>
                                <Button
                                    size="sm"
                                    onClick={() => onPick(s)}
                                    className="shrink-0"
                                >
                                    Select
                                </Button>
                            </div>
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}

function Pane({ children }: { children: React.ReactNode }) {
    return (
        <div
            className={cn(
                "rounded-sm border border-border bg-secondary/40 p-3",
                "flex items-center gap-2 text-xs text-muted-foreground",
            )}
        >
            {children}
        </div>
    );
}

export default NearbyStationsPicker;
