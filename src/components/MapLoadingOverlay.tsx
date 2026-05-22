import { useStore } from "@nanostores/react";
import { Loader2 } from "lucide-react";
import { useState } from "react";

import { useVisibleInterval } from "@/hooks/useVisibleInterval";
import {
    mapGeoJSON,
    mapGeoLocation,
    polyGeoJSON,
} from "@/lib/context";
import {
    estimateEtaMs,
    formatBytes,
    formatDurationMs,
    loadingProgress,
} from "@/lib/loadingProgress";
import { cn } from "@/lib/utils";

/**
 * Full-bleed loading veil over the map while the boundary polygon
 * (or any other tracked operation) is being fetched + processed.
 * Shows up in two cases:
 *
 *   1. The `loadingProgress` atom is non-null — explicit progress
 *      reported from a pipeline that wants to surface bytes / phase
 *      / ETA (e.g. determineMapBoundaries).
 *
 *   2. Implicit fallback: `mapGeoJSON` is null AND `polyGeoJSON`
 *      is null AND `mapGeoLocation` points at a real OSM relation.
 *      Covers the cold-start case where the boundary load hasn't
 *      called startLoading yet.
 *
 * In the explicit case we render byte progress + ETA where
 * available; in the implicit case we fall back to the old "Loading
 * play area" card.
 */
export function MapLoadingOverlay() {
    const $mapGeoJSON = useStore(mapGeoJSON);
    const $polyGeoJSON = useStore(polyGeoJSON);
    const $mapGeoLocation = useStore(mapGeoLocation);
    const $progress = useStore(loadingProgress);

    // 1 Hz tick so the elapsed + ETA labels update while we sit on
    // the overlay. Gated on the overlay being meaningful + the tab
    // being visible — there's no point ticking when the page is
    // hidden or no progress is being tracked.
    const [, setNow] = useState(() => Date.now());
    const shouldTick =
        $progress !== null ||
        (!Boolean($mapGeoJSON || $polyGeoJSON) &&
            ($mapGeoLocation?.properties?.osm_id ?? 0) > 0);
    useVisibleInterval(() => setNow(Date.now()), 1000, shouldTick);

    const haveBoundary = Boolean($mapGeoJSON || $polyGeoJSON);
    const haveValidLocation =
        ($mapGeoLocation?.properties?.osm_id ?? 0) > 0;

    // Show overlay when EITHER explicit progress is reported OR
    // we're cold-loading a boundary.
    const shouldShow =
        $progress !== null || (!haveBoundary && haveValidLocation);

    if (!shouldShow) return null;

    const name =
        ($mapGeoLocation?.properties as { name?: string })?.name ?? "play area";

    // Prefer the explicit progress's title; fall back to the
    // location name for the implicit cold-load case.
    const title = $progress?.title ?? `Loading ${name}`;
    const phase = $progress?.phase ?? "Fetching boundary…";

    const elapsed = $progress
        ? Date.now() - $progress.startedAt
        : null;
    const eta = $progress ? estimateEtaMs($progress) : null;
    const downloaded = $progress?.bytesDownloaded ?? 0;
    const total = $progress?.totalBytes ?? null;

    // Determinate progress bar when we have a content-length; an
    // indeterminate animated bar otherwise (still communicates
    // "something is moving" for streams that don't expose totals).
    const pct =
        total !== null && total > 0
            ? Math.min(100, Math.round((downloaded / total) * 100))
            : null;

    return (
        <div
            className={cn(
                "absolute inset-0 z-[1020]",
                "flex items-center justify-center",
                "bg-background/80 backdrop-blur-sm",
                "transition-opacity duration-200",
            )}
            role="status"
            aria-live="polite"
        >
            <div
                className={cn(
                    "pointer-events-auto",
                    "flex flex-col gap-3 px-5 py-4 rounded-md",
                    "bg-card border-2 border-primary shadow-xl",
                    "max-w-[90vw] w-[min(360px,90vw)]",
                )}
            >
                <div className="flex items-center gap-3">
                    <Loader2 className="w-5 h-5 text-primary animate-spin shrink-0" />
                    <div className="min-w-0">
                        <div className="font-inter-tight font-black uppercase text-[11px] tracking-[0.12em] text-primary">
                            Loading play area
                        </div>
                        <div className="text-sm font-medium truncate">
                            {title}
                        </div>
                    </div>
                </div>

                {/* Phase label */}
                <div className="text-xs text-muted-foreground leading-snug">
                    {phase}
                </div>

                {/* Progress bar */}
                <div className="h-1.5 w-full rounded-full bg-secondary overflow-hidden">
                    {pct !== null ? (
                        <div
                            className="h-full bg-primary transition-[width] duration-150"
                            style={{ width: `${pct}%` }}
                        />
                    ) : (
                        <div className="h-full bg-primary/70 animate-[jlIndeterminate_1.4s_ease-in-out_infinite] origin-left" />
                    )}
                </div>

                {/* Stats line: bytes + elapsed + ETA. The total is
                    prefixed `~` when it came from our localStorage
                    size cache rather than a real Content-Length —
                    most Overpass mirrors stream chunked so the
                    cached number is our only estimate. */}
                <div className="flex items-center justify-between gap-2 text-[11px] tabular-nums text-muted-foreground">
                    <span>
                        {total !== null && downloaded > 0
                            ? `${formatBytes(downloaded)} / ~${formatBytes(total)}`
                            : downloaded > 0
                              ? `${formatBytes(downloaded)} downloaded`
                              : "Starting…"}
                    </span>
                    <span className="flex gap-2">
                        {elapsed !== null && elapsed >= 1000 && (
                            <span>{formatDurationMs(elapsed)} elapsed</span>
                        )}
                        {eta !== null && eta > 0 && (
                            <span>· ~{formatDurationMs(eta)} left</span>
                        )}
                    </span>
                </div>
            </div>
        </div>
    );
}

export default MapLoadingOverlay;
