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
     *  Returns megabytes — the empirical coefficients come from spot
     *  checks across a handful of cities (Stockholm, Tokyo, Lausanne,
     *  Osaka): tile fetch sizes, the consolidated Overpass response,
     *  and the rail + arrivals payloads. Within an order of
     *  magnitude — good enough for "is this worth turning off". */
    estimateMb: (km2: number | null) => number;
}

const BUCKETS: BucketDef[] = [
    {
        id: "map",
        label: "Map",
        blurb:
            "Play-area boundary polygon + the base tiles around it. Recommended for everyone — the map can't render without it.",
        icon: MapIcon,
        // Boundary GeoJSON (~50 KB typical) + PMTiles range reads
        // for the viewport at zoom 10–14. Tile fetch grows roughly
        // linearly with area until the high zooms dominate.
        estimateMb: (km2) => 0.3 + (km2 ?? 100) * 0.018,
    },
    {
        id: "references",
        label: "Question references",
        blurb:
            "All 15 question categories (hospitals, parks, museums, train stations, …). Off-by-tap fallback still works without this.",
        icon: BookOpen,
        // One consolidated Overpass response covering all 14
        // out-center families + a smaller HSR query. Per
        // 100 km² of dense city this is ~1.2 MB; sparser
        // areas (mountains, rural play) trend lower but the
        // floor stays around 0.5 MB.
        estimateMb: (km2) => 0.5 + (km2 ?? 200) * 0.012,
    },
    {
        id: "transit",
        label: "Transit lines & arrivals",
        blurb:
            "High-speed rail data + journey arrival times. Drop this if you're on a slow connection — only matters for transit-themed questions.",
        icon: TramFront,
        // Rail relations + per-station arrival cache. Smaller
        // than the references bundle because there are fewer
        // rail features than POIs.
        estimateMb: (km2) => 0.2 + (km2 ?? 200) * 0.004,
    },
];

/** Render `1.4 MB`, `850 KB`, `12 MB`. */
function formatSize(mb: number): string {
    if (mb < 1) return `${Math.round(mb * 1000)} KB`;
    if (mb < 10) return `${mb.toFixed(1)} MB`;
    return `${Math.round(mb)} MB`;
}

function timeAgo(ts: number): string {
    const diffMs = Date.now() - ts;
    const diffMin = Math.floor(diffMs / 60_000);
    if (diffMin < 1) return "just now";
    if (diffMin < 60) return `${diffMin} min ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    return `${Math.floor(diffHr / 24)}d ago`;
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

                // Per-bucket download status (references + transit only;
                // map boundary is always loaded at game setup).
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

                        {/* Status bar — only for references + transit, only
                            when setup is complete (game is running). */}
                        {displayStatus && b.id !== "map" && (
                            <BucketStatus
                                inFlight={bucketInFlight}
                                completedAt={completedAt}
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
    completedAt,
    enabled,
}: {
    inFlight: boolean;
    completedAt: number | null;
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

    if (completedAt !== null) {
        return (
            <div className="px-3 py-2 border-t border-border/50 bg-secondary/10 rounded-b-md flex items-center gap-2">
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-green-400" />
                <span className="text-xs text-green-400 font-medium">
                    Downloaded {timeAgo(completedAt)}
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
