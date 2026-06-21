import { useStore } from "@nanostores/react";
import type { LucideIcon } from "lucide-react";
import {
    Bus,
    Check,
    Loader2,
    LocateFixed,
    Ship,
    Train,
    TrainTrack,
    TramFront,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "react-toastify";

import { Button } from "@/components/ui/button";
import { allowedTransit, type TransitMode } from "@/lib/gameSetup";
import { haversineMeters } from "@/lib/geo";
import { cn } from "@/lib/utils";
import { getOverpassData } from "@/maps/api/overpass";

/**
 * GPS-based hiding-zone picker for the hider during the hiding period.
 * Fetches transit stations matching `allowedTransit` within ~500 m of
 * the hider's current GPS location, lists them with names and
 * distance, and lets the hider commit one as their hiding zone in a
 * single tap.
 *
 * The 500 m radius is deliberately tight: the rulebook puts the
 * hiding zone at 500 m around the chosen station, so anything farther
 * than that from the hider's current position would mean their actual
 * hiding spot is outside the zone they declared — which would let the
 * seeker eliminate the wrong territory.
 */

const MODE_ICONS: Record<TransitMode, LucideIcon> = {
    bus: Bus,
    tram: TramFront,
    train: Train,
    subway: TrainTrack,
    ferry: Ship,
};

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
                fetchNearbyStations(lat, lng, $allowed)
                    .then((stations) => {
                        if (stations.length === 0) {
                            setState({
                                status: "error",
                                message:
                                    "No transit stations of the allowed modes within 500 m. Move closer to one, or pick a zone manually below.",
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
                    Nearby stations · within 500 m
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
            <ul className="space-y-1.5">
                {state.stations.slice(0, 8).map((s) => {
                    const Icon = MODE_ICONS[s.mode];
                    return (
                        <li key={s.id}>
                            <button
                                type="button"
                                onClick={() => {
                                    onPick(s);
                                    toast.success(`Picked ${s.name}`, {
                                        autoClose: 1500,
                                    });
                                }}
                                className={cn(
                                    "w-full text-left flex items-center gap-2 px-2.5 py-2 rounded-sm",
                                    "bg-background/60 hover:bg-accent border border-border",
                                    "transition-colors",
                                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                )}
                            >
                                <span className="inline-flex items-center justify-center w-7 h-7 rounded shrink-0 bg-primary/20">
                                    <Icon className="w-3.5 h-3.5 text-primary" />
                                </span>
                                <div className="min-w-0 flex-1">
                                    <div className="text-sm font-inter-tight font-bold leading-tight truncate">
                                        {s.name}
                                    </div>
                                    <div className="text-[10px] text-muted-foreground tabular-nums">
                                        {MODE_LABELS[s.mode]} ·{" "}
                                        {Math.round(s.distanceMeters)} m
                                    </div>
                                </div>
                                <Check className="w-4 h-4 text-muted-foreground/50 shrink-0" />
                            </button>
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

async function fetchNearbyStations(
    lat: number,
    lng: number,
    allowed: TransitMode[],
): Promise<FoundStation[]> {
    const r = 500; // meters
    const queries: string[] = [];
    if (allowed.includes("train")) {
        queries.push(
            `node[railway=station][!"subway"](around:${r},${lat},${lng});`,
        );
    }
    if (allowed.includes("subway")) {
        queries.push(`node[station=subway](around:${r},${lat},${lng});`);
        queries.push(
            `node[railway=station][subway=yes](around:${r},${lat},${lng});`,
        );
    }
    if (allowed.includes("tram")) {
        queries.push(`node[railway=tram_stop](around:${r},${lat},${lng});`);
    }
    if (allowed.includes("bus")) {
        queries.push(`node[highway=bus_stop](around:${r},${lat},${lng});`);
        queries.push(
            `node[public_transport=stop_position][bus=yes](around:${r},${lat},${lng});`,
        );
    }
    if (allowed.includes("ferry")) {
        queries.push(
            `node[amenity=ferry_terminal](around:${r},${lat},${lng});`,
        );
    }
    if (queries.length === 0) return [];

    const query = `
[out:json][timeout:30];
(
${queries.join("\n")}
);
out;
`;
    const data = await getOverpassData(query, undefined);
    const elements = (data as { elements?: any[] }).elements ?? [];

    const seen = new Set<number>();
    const stations: FoundStation[] = [];
    for (const el of elements) {
        if (typeof el.lat !== "number" || typeof el.lon !== "number") continue;
        if (seen.has(el.id)) continue;
        seen.add(el.id);
        const name = el.tags?.["name:en"] ?? el.tags?.name;
        if (!name) continue;
        const mode = inferMode(el.tags ?? {});
        if (!mode || !allowed.includes(mode)) continue;
        stations.push({
            id: el.id,
            name,
            lat: el.lat,
            lng: el.lon,
            mode,
            distanceMeters: haversineMeters(lat, lng, el.lat, el.lon),
        });
    }
    stations.sort((a, b) => a.distanceMeters - b.distanceMeters);

    // De-duplicate by station identity. OSM often returns the same
    // station as 2–6 separate nodes — one per platform, one per
    // entrance, one per subway-railway tag combo — so a naive id-only
    // dedupe (above) still leaves the list visibly cluttered (the
    // user reported "duplicate nearby stations"). We collapse anything
    // with the same normalised name within ~120 m down to the first
    // (closest) entry. The mode that survives is the mode of that
    // closest node, which is usually the right one (e.g. the subway
    // tag wins over the bus stop tag when the user is on a metro
    // platform).
    const deduped: FoundStation[] = [];
    for (const s of stations) {
        const norm = normaliseName(s.name);
        const dup = deduped.find(
            (d) =>
                normaliseName(d.name) === norm &&
                haversineMeters(d.lat, d.lng, s.lat, s.lng) < 120,
        );
        if (dup) continue;
        deduped.push(s);
    }
    return deduped;
}

function normaliseName(name: string): string {
    return name
        .toLocaleLowerCase()
        .replace(/\s+/g, " ")
        .replace(/[.,()/-]/g, "")
        .replace(/\bstation\b|\bstn\b|\bstop\b/g, "")
        .trim();
}

function inferMode(tags: Record<string, string>): TransitMode | null {
    if (tags.subway === "yes" || tags.station === "subway") return "subway";
    if (tags.railway === "station") return "train";
    if (tags.railway === "tram_stop" || tags.tram === "yes") return "tram";
    if (tags.amenity === "ferry_terminal" || tags.ferry === "yes")
        return "ferry";
    if (tags.highway === "bus_stop" || tags.bus === "yes") return "bus";
    return null;
}

export default NearbyStationsPicker;
