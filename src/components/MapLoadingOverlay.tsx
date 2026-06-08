import { useStore } from "@nanostores/react";
import { Check, Loader2, X } from "lucide-react";
import { useState } from "react";

import { useVisibleInterval } from "@/hooks/useVisibleInterval";
import {
    mapGeoJSON,
    mapGeoLocation,
    polyGeoJSON,
} from "@/lib/context";
import { playArea } from "@/lib/gameSetup";
import {
    estimateEtaMs,
    formatBytes,
    formatDurationMs,
    loadingPieces,
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
 *      is null AND `mapGeoLocation` points at a real OSM relation
 *      AND the wizard has been completed. Covers the cold-start
 *      case where the boundary load hasn't called startLoading
 *      yet. The setupCompleted gate matters: mapGeoLocation
 *      defaults to Japan (the persistent atom's initial value)
 *      on a fresh load, so without it the overlay would flash
 *      'Loading Japan' for a frame between mount and the welcome
 *      dialog rendering on top of it.
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
    const $pieces = useStore(loadingPieces);
    const $playArea = useStore(playArea);

    // 1 Hz tick so the elapsed + ETA labels update while we sit on
    // the overlay. Gated on the overlay being meaningful + the tab
    // being visible — there's no point ticking when the page is
    // hidden or no progress is being tracked.
    const [, setNow] = useState(() => Date.now());
    const shouldTick =
        $progress !== null ||
        (!($mapGeoJSON || $polyGeoJSON) &&
            ($mapGeoLocation?.properties?.osm_id ?? 0) > 0 &&
            $playArea !== null);
    useVisibleInterval(() => setNow(Date.now()), 1000, shouldTick);

    const haveBoundary = Boolean($mapGeoJSON || $polyGeoJSON);
    const haveValidLocation =
        ($mapGeoLocation?.properties?.osm_id ?? 0) > 0;

    // Show overlay when EITHER explicit progress is reported OR
    // we're cold-loading a boundary AFTER the wizard has been
    // committed. Without setupCompleted, the implicit branch
    // would fire on the default mapGeoLocation (Japan) during
    // first paint and flash a 'Loading Japan' veil before the
    // welcome dialog rendered on top.
    const shouldShow =
        $progress !== null ||
        (!haveBoundary && haveValidLocation && $playArea !== null);

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
        // Non-blocking status card pinned to the top of the map.
        // pointer-events-none on the outer wrapper means pinch / pan
        // gestures still reach the map underneath — historically the
        // overlay covered the map with an opaque backdrop and ate
        // every touch, so if the boundary fetch hung the user saw a
        // dark screen and pinching did nothing. The inner card opts
        // back into pointer events for the retry button.
        <div
            className={cn(
                "absolute left-0 right-0 top-[68px] md:top-12 z-[1020]",
                "flex items-start justify-center px-2",
                "pointer-events-none",
            )}
            role="status"
            aria-live="polite"
        >
            <div
                className={cn(
                    "pointer-events-auto",
                    "flex flex-col gap-3 px-5 py-4 rounded-md",
                    "bg-card/95 backdrop-blur-sm border-2 border-primary shadow-xl",
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

                {/* Per-piece progress list. Only shown when there's
                    more than one piece (single-area games have all
                    the info they need in the aggregate line above).
                    Each row is a parallel Overpass fetch — surfacing
                    them individually so the user can tell that the
                    overall progress isn't stalled, just waiting on
                    one slow server-computed piece. */}
                {$pieces.length > 1 && (
                    <ul className="flex flex-col gap-1.5 pt-1 border-t border-border/50">
                        {$pieces.map((p) => (
                            <li
                                key={p.id}
                                className="flex items-center justify-between gap-2 text-[11px]"
                            >
                                <span className="flex items-center gap-1.5 min-w-0">
                                    <PieceIcon state={p.state} />
                                    <span
                                        className={cn(
                                            "truncate",
                                            p.state === "done" &&
                                                "text-muted-foreground line-through decoration-muted-foreground/40",
                                            p.state === "failed" &&
                                                "text-destructive",
                                        )}
                                    >
                                        {p.label}
                                    </span>
                                </span>
                                <span className="tabular-nums text-muted-foreground shrink-0">
                                    {pieceStatusLabel(p)}
                                </span>
                            </li>
                        ))}
                    </ul>
                )}

                {/* Manual retry — visible after 20 s without progress.
                    Public Overpass mirrors occasionally hang silently
                    (no headers, no error, no timeout for ages); the
                    retry just reloads the page so the boundary fetch
                    starts fresh against the failover chain. This is
                    the "force-close and reopen" recovery surfaced as
                    a button. */}
                {elapsed !== null && elapsed >= 20000 && downloaded === 0 && (
                    <div className="pt-1 border-t border-border/50 space-y-1.5">
                        <p className="text-[11px] text-muted-foreground leading-snug">
                            Taking longer than expected — the public
                            Overpass mirrors are sometimes overloaded.
                        </p>
                        <button
                            type="button"
                            onClick={() => {
                                if (typeof window !== "undefined") {
                                    window.location.reload();
                                }
                            }}
                            className={cn(
                                "w-full rounded-sm border border-primary/60",
                                "bg-primary/10 text-primary",
                                "text-xs font-display font-extrabold uppercase tracking-[0.08em]",
                                "py-2",
                                "hover:bg-primary/20",
                                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                            )}
                        >
                            Try again
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}

function PieceIcon({
    state,
}: {
    state: "waiting" | "streaming" | "done" | "failed";
}) {
    if (state === "done")
        return <Check className="w-3 h-3 text-primary shrink-0" />;
    if (state === "failed")
        return <X className="w-3 h-3 text-destructive shrink-0" />;
    if (state === "streaming")
        return (
            <Loader2 className="w-3 h-3 text-primary animate-spin shrink-0" />
        );
    // waiting
    return (
        <span className="w-3 h-3 rounded-full border border-muted-foreground/40 shrink-0" />
    );
}

function pieceStatusLabel(p: {
    state: "waiting" | "streaming" | "done" | "failed";
    downloaded: number;
    total: number | null;
}): string {
    if (p.state === "waiting") return "queued";
    if (p.state === "failed") return "failed";
    if (p.state === "done") {
        return p.downloaded > 0 ? formatBytes(p.downloaded) : "done";
    }
    // streaming
    if (p.downloaded <= 0) return "starting…";
    if (p.total !== null && p.total > 0) {
        return `${formatBytes(p.downloaded)} / ~${formatBytes(p.total)}`;
    }
    return formatBytes(p.downloaded);
}

export default MapLoadingOverlay;
