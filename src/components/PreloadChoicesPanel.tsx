/**
 * Shared three-bucket preload-choice picker used by both:
 *
 *   - The wizard's Step 4 ("What should we preload?") — fresh-game
 *     defaults applied via the persisted store, user adjusts before
 *     starting the hiding period.
 *   - The Settings sheet — mid-game adjustments. Flipping a bucket
 *     from off → on calls `runPreloadForBucket(name)` immediately so
 *     the user doesn't have to wait for the next hiding period to
 *     load deferred data.
 *
 * Single source of truth = the `preloadChoices` persistent atom in
 * `gameSetup.ts`. This component just renders the three rows and
 * dispatches.
 */

import { useStore } from "@nanostores/react";
import {
    BookOpen,
    CheckCircle2,
    Loader2,
    Map as MapIcon,
    TramFront,
} from "lucide-react";

import {
    preloadBucketInFlight,
    preloadBucketTimestamps,
    preloadChoices,
    setupCompleted,
    type PreloadChoices,
} from "@/lib/gameSetup";
import { runPreloadForBucket } from "@/lib/preload";
import { cn } from "@/lib/utils";

import { Checkbox } from "./ui/checkbox";

interface BucketDef {
    id: keyof PreloadChoices;
    label: string;
    blurb: string;
    icon: React.ComponentType<{ className?: string }>;
    /** Per-bucket size estimator. `km2` is the play area's polygon
     *  estimate (from the wizard's draftFeature, or null if unknown).
     *  Returns megabytes. Uses a square-root curve so large play areas
     *  (country-scale) don't produce absurdly large estimates — real
     *  Overpass / tile data is concentrated in the urban core regardless
     *  of administrative boundary size. Null fallbacks are calibrated
     *  to match observed download sizes for a typical city-scale area. */
    estimateMb: (km2: number | null) => number;
}

const BUCKETS: BucketDef[] = [
    {
        id: "map",
        label: "Map",
        blurb:
            "Play-area boundary polygon + the base tiles around it. Recommended for everyone — the map can't render without it.",
        icon: MapIcon,
        // sqrt(100) * 0.18 ≈ 2.1 MB at null fallback (100 km²)
        estimateMb: (km2) => 0.3 + Math.sqrt(km2 ?? 100) * 0.18,
    },
    {
        id: "references",
        label: "Question references",
        blurb:
            "All 15 question categories (hospitals, parks, museums, train stations, …). Off-by-tap fallback still works without this.",
        icon: BookOpen,
        // sqrt(200) * 0.17 ≈ 2.9 MB at null fallback (200 km²)
        estimateMb: (km2) => 0.5 + Math.sqrt(km2 ?? 200) * 0.17,
    },
    {
        id: "transit",
        label: "Transit lines & arrivals",
        blurb:
            "High-speed rail data + journey arrival times. Drop this if you're on a slow connection — only matters for transit-themed questions.",
        icon: TramFront,
        // sqrt(200) * 0.057 ≈ 1.0 MB at null fallback (200 km²)
        estimateMb: (km2) => 0.2 + Math.sqrt(km2 ?? 200) * 0.057,
    },
];

/** Render `1.4 MB`, `850 KB`, `12 MB`. */
function formatSize(mb: number): string {
    if (mb < 1) return `${Math.round(mb * 1000)} KB`;
    if (mb < 10) return `${mb.toFixed(1)} MB`;
    return `${Math.round(mb)} MB`;
}


interface PreloadChoicesPanelProps {
    /** Play-area polygon area in km². Drives per-bucket size
     *  estimates. Null = wizard hasn't picked an area yet or the
     *  Settings sheet doesn't know — falls back to a generic
     *  city-sized estimate inside `estimateMb`. */
    areaKm2?: number | null;
    /** When true, flipping a bucket from off → on runs that bucket's
     *  preload immediately. Use in Settings (mid-game). Wizard mode
     *  defers until the hiding period actually starts. */
    runImmediatelyOnEnable?: boolean;
    /** When true, show per-bucket download status (timestamp + spinner).
     *  Defaults to true when setup is complete (game is running). */
    showStatus?: boolean;
    className?: string;
}

export function PreloadChoicesPanel({
    areaKm2 = null,
    runImmediatelyOnEnable = false,
    showStatus,
    className,
}: PreloadChoicesPanelProps) {
    const choices = useStore(preloadChoices);
    const timestamps = useStore(preloadBucketTimestamps);
    const inFlight = useStore(preloadBucketInFlight);
    const $setup = useStore(setupCompleted);

    // Default: show status once game is set up
    const displayStatus = showStatus ?? $setup;

    const toggle = (id: keyof PreloadChoices) => {
        const wasOn = choices[id];
        const next = { ...choices, [id]: !wasOn };
        preloadChoices.set(next);
        // off → on while a game is running → fire the preload now so
        // the user doesn't wait for the next hiding period.
        if (runImmediatelyOnEnable && !wasOn) {
            runPreloadForBucket(id);
        }
    };

    const totalMb = BUCKETS.reduce(
        (sum, b) => (choices[b.id] ? sum + b.estimateMb(areaKm2) : sum),
        0,
    );

    return (
        <div className={cn("space-y-2", className)}>
            {BUCKETS.map((b) => {
                const Icon = b.icon;
                const on = choices[b.id];
                const sizeMb = b.estimateMb(areaKm2);

                const bucketInFlight =
                    b.id === "references"
                        ? inFlight.references
                        : b.id === "transit"
                          ? inFlight.transit
                          : false;
                const completedAt =
                    b.id === "references"
                        ? timestamps.references
                        : b.id === "transit"
                          ? timestamps.transit
                          : null;

                // Map is always ready once the game starts; downloaded
                // ref/transit buckets become read-only "done" cards.
                const isMapReady = displayStatus && b.id === "map";
                const isDownloaded = displayStatus && completedAt !== null;

                if (isMapReady || isDownloaded) {
                    return (
                        <div
                            key={b.id}
                            className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2.5 flex items-center gap-3"
                        >
                            <CheckCircle2 className="w-4 h-4 shrink-0 text-green-400 mt-0.5" />
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                                    <Icon className="w-4 h-4 shrink-0" />
                                    <span className="flex-1 min-w-0">
                                        {b.label}
                                    </span>
                                </div>
                                <p
                                    className={cn(
                                        "text-xs mt-0.5 font-medium",
                                        isDownloaded
                                            ? "text-green-400"
                                            : "text-muted-foreground",
                                    )}
                                >
                                    {isDownloaded
                                        ? "Downloaded"
                                        : "Loaded at game setup"}
                                </p>
                            </div>
                        </div>
                    );
                }

                return (
                    <div
                        key={b.id}
                        className={cn(
                            "rounded-md border transition-colors",
                            on ? "border-primary/50" : "border-border",
                        )}
                    >
                        <label
                            className={cn(
                                "flex gap-3 items-start p-3 cursor-pointer",
                                "bg-secondary/30 hover:bg-secondary/60 transition-colors rounded-md",
                                displayStatus &&
                                    b.id !== "map" &&
                                    "rounded-b-none",
                            )}
                        >
                            <Checkbox
                                checked={on}
                                onCheckedChange={() => toggle(b.id)}
                                className="mt-0.5"
                                aria-label={b.label}
                            />
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                                    <Icon className="w-4 h-4 shrink-0" />
                                    <span className="flex-1 min-w-0">
                                        {b.label}
                                    </span>
                                    <span
                                        className={cn(
                                            "text-[10px] font-mono tabular-nums shrink-0",
                                            "px-1.5 py-0.5 rounded-sm border",
                                            on
                                                ? "bg-primary/10 border-primary/30 text-primary"
                                                : "bg-secondary/60 border-border text-muted-foreground",
                                        )}
                                        title={
                                            areaKm2
                                                ? `Rough estimate for ${Math.round(areaKm2)} km² play area`
                                                : "Rough estimate — pick a play area for a more accurate number"
                                        }
                                    >
                                        ~{formatSize(sizeMb)}
                                    </span>
                                </div>
                                <p className="text-xs text-muted-foreground mt-1 leading-snug">
                                    {b.blurb}
                                </p>
                            </div>
                        </label>

                        {displayStatus && b.id !== "map" && (
                            <BucketStatus
                                inFlight={bucketInFlight}
                                enabled={on}
                            />
                        )}
                    </div>
                );
            })}
            <div className="flex items-center justify-between pt-1 px-1 text-xs">
                <span className="text-muted-foreground">
                    Estimated total
                </span>
                <span className="font-mono tabular-nums font-semibold text-foreground">
                    {totalMb > 0 ? `~${formatSize(totalMb)}` : "0 KB"}
                </span>
            </div>
        </div>
    );
}

function BucketStatus({
    inFlight,
    enabled,
}: {
    inFlight: boolean;
    enabled: boolean;
}) {
    if (inFlight) {
        return (
            <div className="px-3 py-2 border-t border-border/50 bg-secondary/10 rounded-b-md flex items-center gap-2">
                <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin text-primary" />
                <span className="text-xs text-muted-foreground">
                    Downloading…
                </span>
            </div>
        );
    }

    return (
        <div className="px-3 py-2 border-t border-border/50 bg-secondary/10 rounded-b-md flex items-center gap-2">
            <span
                className={cn(
                    "w-2 h-2 rounded-full shrink-0",
                    enabled ? "bg-yellow-400/70" : "bg-muted-foreground/30",
                )}
            />
            <span className="text-xs text-muted-foreground">
                {enabled
                    ? "Not downloaded yet — will run at hiding period start"
                    : "Disabled — won't be downloaded"}
            </span>
        </div>
    );
}
