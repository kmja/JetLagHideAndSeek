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
    Play,
    Square,
    TramFront,
} from "lucide-react";

import {
    hidingPeriodEndsAt,
    preloadBucketBytes,
    preloadBucketInFlight,
    preloadBucketTimestamps,
    preloadChoices,
    preloadMapProgress,
    preloadPaused,
    preloadTransitProgress,
    type TransitPreloadStep,
    setupCompleted,
    type PreloadChoices,
} from "@/lib/gameSetup";
import { resumePreload, runPreloadForBucket, stopPreload } from "@/lib/preload";
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
            "The play-area outline and the map imagery around it, so the map stays smooth when you zoom in during the game.",
        icon: MapIcon,
        // v263: bumped from 0.55 → 1.5 multiplier after London (~1500 km²)
        // came in at ~80 MB once z15 (street zoom) was actually preloaded.
        // sqrt(1500) * 1.5 ≈ 58 MB; smaller cities scale linearly with
        // sqrt(area) so a 100 km² city is ~15 MB — calibrated to real
        // observed downloads, not z14-only estimates.
        estimateMb: (km2) => 0.5 + Math.sqrt(km2 ?? 100) * 1.5,
    },
    {
        id: "references",
        label: "Question references",
        blurb:
            "The places questions compare against — airports, stations, parks, museums, hospitals and the like. Questions still work without it, just a little slower the first time you ask.",
        icon: BookOpen,
        // sqrt(200) * 0.17 ≈ 2.9 MB at null fallback (200 km²)
        estimateMb: (km2) => 0.5 + Math.sqrt(km2 ?? 200) * 0.17,
    },
    {
        id: "transit",
        label: "Transit lines & arrivals",
        blurb:
            "The transit route lines for the map overlay (metro, tram, bus, train, ferry), plus high-speed rail and station arrival times. Mainly for transit questions and the line overlay — safe to skip on a slow connection.",
        icon: TramFront,
        // sqrt(200) * 0.057 ≈ 1.0 MB at null fallback (200 km²)
        estimateMb: (km2) => 0.2 + Math.sqrt(km2 ?? 200) * 0.057,
    },
];

/**
 * Total estimated download size, in MB, for all three buckets at the
 * given play-area size. Used by the wizard's simplified single
 * checkbox to render "Preload game data (~45 MB)" without exposing
 * the per-bucket breakdown.
 */
export function estimatePreloadMb(areaKm2: number | null): number {
    return BUCKETS.reduce((sum, b) => sum + b.estimateMb(areaKm2), 0);
}

/** Render `1.4 MB`, `850 KB`, `12 MB`. */
export function formatSize(mb: number): string {
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
    /** v944: render ONE combined progress bar instead of the three
     *  per-bucket rows. Used in the lobby, where the detailed breakdown is
     *  noise — the player just wants "is the offline map ready yet?". */
    compact?: boolean;
    className?: string;
}

export function PreloadChoicesPanel({
    areaKm2 = null,
    runImmediatelyOnEnable = false,
    showStatus,
    compact = false,
    className,
}: PreloadChoicesPanelProps) {
    if (compact) {
        return <CompactPreloadBar areaKm2={areaKm2} className={className} />;
    }
    return (
        <PreloadChoicesPanelFull
            areaKm2={areaKm2}
            runImmediatelyOnEnable={runImmediatelyOnEnable}
            showStatus={showStatus}
            className={className}
        />
    );
}

function PreloadChoicesPanelFull({
    areaKm2 = null,
    runImmediatelyOnEnable = false,
    showStatus,
    className,
}: Omit<PreloadChoicesPanelProps, "compact">) {
    const choices = useStore(preloadChoices);
    const timestamps = useStore(preloadBucketTimestamps);
    const inFlight = useStore(preloadBucketInFlight);
    const bucketBytes = useStore(preloadBucketBytes);
    const $setup = useStore(setupCompleted);
    const paused = useStore(preloadPaused);

    // Default: show status once game is set up
    const displayStatus = showStatus ?? $setup;

    const anyLoading = inFlight.map || inFlight.references || inFlight.transit;

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

    // Per-bucket download state (shared by the rows + the total).
    const bucketState = (id: keyof PreloadChoices) => {
        const completedAt =
            id === "map"
                ? timestamps.map
                : id === "references"
                  ? timestamps.references
                  : timestamps.transit;
        const actualBytes =
            id === "map"
                ? bucketBytes.map
                : id === "references"
                  ? bucketBytes.references
                  : bucketBytes.transit;
        return {
            completedAt,
            actualBytes,
            downloaded: displayStatus && completedAt !== null,
        };
    };

    // Total that RECONCILES with the per-row numbers: a downloaded bucket
    // contributes its ACTUAL bytes (0 for a cached hit), a not-yet-loaded
    // one contributes its rough estimate. So the footer can't read "~63 MB"
    // while the Map row alone already shows "Downloaded — 94 MB". The
    // "Estimated" qualifier only shows while at least one enabled bucket is
    // still an estimate (e.g. the wizard, pre-download).
    let totalMb = 0;
    let anyEstimate = false;
    for (const b of BUCKETS) {
        if (!choices[b.id]) continue;
        const { downloaded, actualBytes } = bucketState(b.id);
        if (downloaded) {
            if (actualBytes !== null) totalMb += actualBytes / 1_000_000;
        } else {
            totalMb += b.estimateMb(areaKm2);
            anyEstimate = true;
        }
    }

    return (
        <div className={cn("space-y-2", className)}>
            {BUCKETS.map((b) => {
                const Icon = b.icon;
                const on = choices[b.id];
                const sizeMb = b.estimateMb(areaKm2);

                const bucketInFlight =
                    b.id === "map"
                        ? inFlight.map
                        : b.id === "references"
                          ? inFlight.references
                          : b.id === "transit"
                            ? inFlight.transit
                            : false;
                const completedAt =
                    b.id === "map"
                        ? timestamps.map
                        : b.id === "references"
                          ? timestamps.references
                          : b.id === "transit"
                            ? timestamps.transit
                            : null;
                const actualBytes =
                    b.id === "map"
                        ? bucketBytes.map
                        : b.id === "references"
                          ? bucketBytes.references
                          : b.id === "transit"
                            ? bucketBytes.transit
                            : null;

                // Once the game's running, a finished bucket shows as a
                // read-only "done" card. v262: this now applies to the
                // map bucket too — it actually preloads tiles into the
                // browser HTTP cache.
                const isDownloaded = displayStatus && completedAt !== null;

                if (isDownloaded) {
                    // v273: mirrors the active card's two-row layout
                    // (label header + status footer) so the row height
                    // stays stable when a bucket flips from
                    // "downloading" → "downloaded" mid-session.
                    return (
                        <div
                            key={b.id}
                            className="rounded-md border border-primary/30"
                        >
                            <div className="flex gap-3 items-start p-3 bg-primary/5 rounded-md rounded-b-none">
                                <CheckCircle2 className="w-4 h-4 shrink-0 text-green-400 mt-0.5" />
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                                        <Icon className="w-4 h-4 shrink-0" />
                                        <span className="flex-1 min-w-0">
                                            {b.label}
                                        </span>
                                    </div>
                                    <p className="text-xs text-muted-foreground mt-1 leading-snug">
                                        {b.blurb}
                                    </p>
                                </div>
                            </div>
                            <div className="px-3 py-2 border-t border-border/50 bg-primary/10 rounded-b-md flex items-center gap-2">
                                <span className="w-2 h-2 rounded-full shrink-0 bg-green-400" />
                                <span className="text-xs text-green-400 font-medium">
                                    {actualBytes === null
                                        ? "Downloaded"
                                        : actualBytes === 0
                                          ? "Downloaded (cached)"
                                          : `Downloaded — ${formatSize(actualBytes / 1_000_000)}`}
                                </span>
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
                                displayStatus && "rounded-b-none",
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

                        {displayStatus && (
                            <BucketStatus
                                bucketId={b.id}
                                inFlight={bucketInFlight}
                                enabled={on}
                            />
                        )}
                    </div>
                );
            })}
            <div className="flex items-center justify-between pt-1 px-1 text-xs">
                <span className="text-muted-foreground">
                    {anyEstimate ? "Estimated total" : "Total downloaded"}
                </span>
                <span className="font-mono tabular-nums font-semibold text-foreground">
                    {totalMb > 0
                        ? `${anyEstimate ? "~" : ""}${formatSize(totalMb)}`
                        : "0 KB"}
                </span>
            </div>

            {/* Stop / Resume the whole preload (v931). Shown once a game is
                set up — while loading, offer Stop; while paused, offer
                Resume. Stop aborts the heavy map download; resume continues
                (completed work is a cache hit). */}
            {displayStatus && (paused || anyLoading) && (
                <button
                    type="button"
                    onClick={() => (paused ? resumePreload() : stopPreload())}
                    className={cn(
                        "w-full mt-1 inline-flex items-center justify-center gap-1.5",
                        "rounded-md border px-3 py-2 text-xs font-poppins font-semibold transition-colors",
                        paused
                            ? "border-primary bg-primary/10 text-primary hover:bg-primary/20"
                            : "border-border bg-secondary/60 text-foreground hover:bg-secondary",
                    )}
                >
                    {paused ? (
                        <>
                            <Play className="w-3.5 h-3.5" />
                            Resume preloading
                        </>
                    ) : (
                        <>
                            <Square className="w-3.5 h-3.5" />
                            Stop preloading
                        </>
                    )}
                </button>
            )}
        </div>
    );
}

/**
 * v944: the lobby's compact preload view — ONE combined progress bar across
 * every enabled bucket instead of the three detailed rows. Progress is a
 * byte-weighted blend (the Map bucket dominates the download, so it drives
 * most of the bar). Falls back to an indeterminate look before the first
 * fraction lands. Carries the same Stop / Resume affordance.
 */
function CompactPreloadBar({
    areaKm2,
    className,
}: {
    areaKm2: number | null;
    className?: string;
}) {
    const choices = useStore(preloadChoices);
    const timestamps = useStore(preloadBucketTimestamps);
    const inFlight = useStore(preloadBucketInFlight);
    const paused = useStore(preloadPaused);
    const mapProgress = useStore(preloadMapProgress);
    const transitProgress = useStore(preloadTransitProgress);

    const ids = ["map", "references", "transit"] as const;
    const enabled = ids.filter((id) => choices[id]);
    if (enabled.length === 0) return null;

    const doneAt = (id: keyof PreloadChoices) =>
        id === "map"
            ? timestamps.map
            : id === "references"
              ? timestamps.references
              : timestamps.transit;
    const isInFlight = (id: keyof PreloadChoices) =>
        id === "map"
            ? inFlight.map
            : id === "references"
              ? inFlight.references
              : inFlight.transit;
    const weightOf = (id: keyof PreloadChoices) =>
        BUCKETS.find((b) => b.id === id)!.estimateMb(areaKm2);

    const fracOf = (id: keyof PreloadChoices): number => {
        if (doneAt(id) !== null) return 1;
        if (!isInFlight(id)) return 0;
        if (id === "map") {
            if (!mapProgress || mapProgress.phase === "header") return 0.02;
            if (mapProgress.phase === "pack") {
                return mapProgress.packTotalBytes
                    ? Math.min(1, mapProgress.bytesFetched / mapProgress.packTotalBytes)
                    : 0.5;
            }
            // range walk
            return mapProgress.tilesTotal
                ? Math.min(1, mapProgress.tilesDone / mapProgress.tilesTotal)
                : 0.05;
        }
        if (id === "transit") {
            if (!transitProgress || transitProgress.total === 0) return 0.5;
            return Math.min(1, transitProgress.done.length / transitProgress.total);
        }
        return 0.5; // references in flight (fast, no fine-grained progress)
    };

    let wSum = 0;
    let fSum = 0;
    for (const id of enabled) {
        const w = weightOf(id);
        wSum += w;
        fSum += w * fracOf(id);
    }
    const pct = wSum > 0 ? Math.min(100, Math.round((fSum / wSum) * 100)) : 0;
    const anyLoading = enabled.some(isInFlight);
    const allDone = enabled.every((id) => doneAt(id) !== null);

    return (
        <div className={cn("space-y-2", className)}>
            <div className="rounded-md border border-primary/30 bg-secondary/20 px-3 py-2.5 space-y-1.5">
                <div className="flex items-center gap-2">
                    {allDone ? (
                        <CheckCircle2 className="w-4 h-4 shrink-0 text-green-400" />
                    ) : paused ? (
                        <Square className="w-4 h-4 shrink-0 text-muted-foreground" />
                    ) : (
                        <Loader2 className="w-4 h-4 shrink-0 animate-spin text-primary" />
                    )}
                    <span className="text-sm font-medium text-foreground flex-1 min-w-0">
                        {allDone
                            ? "Map ready"
                            : paused
                              ? "Preload paused"
                              : "Preloading the map…"}
                    </span>
                    {!allDone && (
                        <span className="text-xs font-mono tabular-nums text-muted-foreground shrink-0">
                            {pct}%
                        </span>
                    )}
                </div>
                {!allDone && (
                    <div className="h-1.5 w-full bg-background/60 rounded-full overflow-hidden">
                        <div
                            className="h-full bg-primary transition-[width] duration-300 ease-out"
                            style={{ width: `${pct}%` }}
                        />
                    </div>
                )}
            </div>
            {(paused || anyLoading) && (
                <button
                    type="button"
                    onClick={() => (paused ? resumePreload() : stopPreload())}
                    className={cn(
                        "w-full inline-flex items-center justify-center gap-1.5",
                        "rounded-md border px-3 py-1.5 text-xs font-poppins font-semibold transition-colors",
                        paused
                            ? "border-primary bg-primary/10 text-primary hover:bg-primary/20"
                            : "border-border bg-secondary/60 text-foreground hover:bg-secondary",
                    )}
                >
                    {paused ? (
                        <>
                            <Play className="w-3.5 h-3.5" />
                            Resume
                        </>
                    ) : (
                        <>
                            <Square className="w-3.5 h-3.5" />
                            Stop
                        </>
                    )}
                </button>
            )}
        </div>
    );
}

function BucketStatus({
    bucketId,
    inFlight,
    enabled,
}: {
    bucketId: keyof PreloadChoices;
    inFlight: boolean;
    enabled: boolean;
}) {
    // v701: is the hiding period already underway? The idle-enabled copy
    // below said "will run at hiding period start" unconditionally, which
    // was stale once hiding had begun (the preload window has passed —
    // e.g. the run failed / was rate-limited / left no timestamp).
    const gameStarted = useStore(hidingPeriodEndsAt) !== null;
    if (inFlight) {
        // v324: the map bucket gets a detailed progress bar — it can
        // be thousands of byte-range requests against the PMTiles
        // archive, so a generic "Downloading…" reads as stalled when
        // it's actually busy paging through z14 / z15. References +
        // transit are fast enough that the spinner is sufficient
        // signal; they keep the original look.
        if (bucketId === "map") return <MapBucketProgress />;
        if (bucketId === "transit") return <TransitBucketProgress />;
        return (
            <div className="px-3 py-2 border-t border-border/50 bg-secondary/10 rounded-b-md flex items-center gap-2">
                <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin text-primary" />
                <span className="text-xs text-muted-foreground">
                    Downloading…
                </span>
            </div>
        );
    }

    if (!enabled) {
        return (
            <div className="px-3 py-2 border-t border-border/50 bg-secondary/10 rounded-b-md flex items-center gap-2">
                <span className="w-2 h-2 rounded-full shrink-0 bg-muted-foreground/30" />
                <span className="text-xs text-muted-foreground">
                    Disabled — won't be downloaded
                </span>
            </div>
        );
    }
    // Enabled but not downloaded / not in flight. v703: give the user a
    // real "Load now" button — the preload otherwise runs only at hiding-
    // period start, and a partially-failed run (a timed-out step) leaves the
    // bucket un-downloaded with no way to retry from the UI.
    return (
        <div className="px-3 py-2 border-t border-border/50 bg-secondary/10 rounded-b-md flex items-center gap-2 justify-between">
            <div className="flex items-center gap-2 min-w-0">
                <span className="w-2 h-2 rounded-full shrink-0 bg-yellow-400/70" />
                <span className="text-xs text-muted-foreground truncate">
                    {gameStarted
                        ? "Not downloaded"
                        : "Not downloaded yet — loads at hiding-period start"}
                </span>
            </div>
            <button
                type="button"
                onClick={() => runPreloadForBucket(bucketId)}
                className="shrink-0 rounded-md px-2 py-1 text-xs font-semibold text-primary hover:bg-primary/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
                Load now
            </button>
        </div>
    );
}

function MapBucketProgress() {
    const progress = useStore(preloadMapProgress);

    // Pre-tile header read — short but visible on slow networks. Show
    // a generic "Reading archive header…" so the bar doesn't sit empty
    // and labelled with stale tile counts from the previous run.
    if (!progress || progress.phase === "header") {
        return (
            <div className="px-3 py-2 border-t border-border/50 bg-secondary/10 rounded-b-md flex items-center gap-2">
                <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin text-primary" />
                <span className="text-xs text-muted-foreground">
                    {progress?.phase === "header"
                        ? "Reading archive header…"
                        : "Downloading…"}
                </span>
            </div>
        );
    }

    // v336: city-pack download phase — a single-file download with a
    // byte-based bar, distinct from the per-tile range walk.
    if (progress.phase === "pack") {
        const { bytesFetched, packTotalBytes } = progress;
        const packPct =
            packTotalBytes && packTotalBytes > 0
                ? Math.min(100, (bytesFetched / packTotalBytes) * 100)
                : 0;
        return (
            <div className="px-3 py-2 border-t border-border/50 bg-secondary/10 rounded-b-md space-y-1.5">
                <div className="flex items-center gap-2">
                    <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin text-primary" />
                    <span className="text-xs text-muted-foreground flex-1 min-w-0 truncate">
                        Downloading city map pack…
                    </span>
                </div>
                <div className="h-1 w-full bg-background/60 rounded-full overflow-hidden">
                    <div
                        className="h-full bg-primary transition-[width] duration-200 ease-out"
                        style={{
                            width: packTotalBytes
                                ? `${packPct.toFixed(1)}%`
                                : "100%",
                        }}
                    />
                </div>
                <div className="flex items-center justify-between text-[10px] text-muted-foreground tabular-nums">
                    <span>
                        {packTotalBytes ? `${packPct.toFixed(0)}%` : "…"}
                    </span>
                    <span>
                        {formatSize(bytesFetched / 1_000_000)}
                        {packTotalBytes
                            ? ` / ${formatSize(packTotalBytes / 1_000_000)}`
                            : " downloaded"}
                    </span>
                </div>
            </div>
        );
    }

    const { tilesDone, tilesTotal, currentZoom, bytesFetched } = progress;
    const pct =
        tilesTotal === 0 ? 0 : Math.min(100, (tilesDone / tilesTotal) * 100);

    return (
        <div className="px-3 py-2 border-t border-border/50 bg-secondary/10 rounded-b-md space-y-1.5">
            <div className="flex items-center gap-2">
                <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin text-primary" />
                <span className="text-xs text-muted-foreground flex-1 min-w-0 truncate">
                    Caching z{currentZoom} tiles…
                </span>
                <span className="text-[10px] font-mono tabular-nums text-muted-foreground shrink-0">
                    {tilesDone.toLocaleString()} / {tilesTotal.toLocaleString()}
                </span>
            </div>
            {/* Slim progress track. tabular-nums on the byte readout
                keeps the rightmost digit from jittering as it updates. */}
            <div className="h-1 w-full bg-background/60 rounded-full overflow-hidden">
                <div
                    className="h-full bg-primary transition-[width] duration-200 ease-out"
                    style={{ width: `${pct.toFixed(1)}%` }}
                />
            </div>
            <div className="flex items-center justify-between text-[10px] text-muted-foreground tabular-nums">
                <span>{pct.toFixed(0)}%</span>
                <span>{formatSize(bytesFetched / 1_000_000)} downloaded</span>
            </div>
        </div>
    );
}

/** Display labels for each transit preload step, used in the
 *  "Subway, Bus + 2 more…" running summary. Keep short — the
 *  panel row is space-constrained on phones. */
const TRANSIT_STEP_LABELS: Record<TransitPreloadStep, string> = {
    hsr: "High-speed rail",
    subway: "Subway",
    bus: "Bus",
    ferry: "Ferry",
    train: "Train",
    tram: "Tram",
    arrivals: "Arrivals",
};

function TransitBucketProgress() {
    const progress = useStore(preloadTransitProgress);

    // Atom hasn't been initialised yet — the parallel modes were
    // dispatched but the first finally() hasn't run. Show the same
    // generic "Downloading…" so the panel isn't blank.
    if (!progress) {
        return (
            <div className="px-3 py-2 border-t border-border/50 bg-secondary/10 rounded-b-md flex items-center gap-2">
                <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin text-primary" />
                <span className="text-xs text-muted-foreground">
                    Downloading…
                </span>
            </div>
        );
    }

    const { active, done, total } = progress;
    // Compose the summary line. With 5 modes + HSR running in
    // parallel the active list can be long; cap the named-in-line
    // count at 3 and roll the rest into a "+ N more…" tail.
    const NAMED = 3;
    const named = active.slice(0, NAMED).map((s) => TRANSIT_STEP_LABELS[s]);
    const extra = active.length - named.length;
    const summary =
        active.length === 0
            ? "Finishing…"
            : `${named.join(", ")}${extra > 0 ? ` + ${extra} more` : ""}…`;
    // The three async producers (modes loop, arrivals add, arrivals finally)
    // race on this atom, so `done` can briefly exceed `total` (the "6/5" bug).
    // Clamp so the fraction + bar are always coherent: the denominator is at
    // least the number completed, and the numerator never exceeds it.
    const shownTotal = Math.max(total, done.length);
    const shownDone = Math.min(done.length, shownTotal);
    const pct = shownTotal === 0 ? 0 : Math.min(100, (shownDone / shownTotal) * 100);

    return (
        <div className="px-3 py-2 border-t border-border/50 bg-secondary/10 rounded-b-md space-y-1.5">
            <div className="flex items-center gap-2">
                <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin text-primary" />
                <span className="text-xs text-muted-foreground flex-1 min-w-0 truncate">
                    {summary}
                </span>
                <span className="text-[10px] font-mono tabular-nums text-muted-foreground shrink-0">
                    {shownDone} / {shownTotal}
                </span>
            </div>
            <div className="h-1 w-full bg-background/60 rounded-full overflow-hidden">
                <div
                    className="h-full bg-primary transition-[width] duration-200 ease-out"
                    style={{ width: `${pct.toFixed(1)}%` }}
                />
            </div>
        </div>
    );
}
