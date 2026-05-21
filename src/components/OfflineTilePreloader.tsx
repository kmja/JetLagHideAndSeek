import { useStore } from "@nanostores/react";
import * as turf from "@turf/turf";
import { CloudDownload, Loader2, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "react-toastify";

import { mapGeoJSON, polyGeoJSON } from "@/lib/context";
import { cn } from "@/lib/utils";

/**
 * "Pre-download offline tiles for this play area" — the feature the
 * user explicitly asked for. Walks the play-area bbox at zoom levels
 * 11-15 (sane default range that covers city-wide overview through
 * street-level), fetches each tile from CARTO Voyager, and lets the
 * service worker stash it in the `tiles-carto` runtime cache. The
 * tiles then serve offline on any subsequent visit.
 *
 * Implementation notes:
 *
 *   • Concurrency is capped at 8 in-flight requests so we don't
 *     hammer the tile provider (their TOS asks for "reasonable" use)
 *     and so the browser doesn't choke on thousands of pending
 *     fetches. Cancel is honored between batches.
 *
 *   • `fetch(url, { mode: "no-cors" })` is *not* used — the SW
 *     intercepts the request via `runtimeCaching` and stores the
 *     response in its named cache. The fetch must look identical to
 *     what Leaflet sends at runtime.
 *
 *   • Tiles already cached are still re-fetched as no-ops by the
 *     SW (CacheFirst hits cache, doesn't touch the network). Cheap.
 *
 *   • This component is rendered inside the More panel; lazy-import
 *     it from there so the leaflet/turf machinery doesn't load on
 *     first paint.
 */

interface ZoomRange {
    min: number;
    max: number;
}

const TILE_URL = (z: number, x: number, y: number) =>
    `https://${["a", "b", "c", "d"][(x + y) % 4]}.basemaps.cartocdn.com/rastertiles/voyager/${z}/${x}/${y}.png`;

const CONCURRENCY = 8;

export function OfflineTilePreloader() {
    const $polyGeoJSON = useStore(polyGeoJSON);
    const $mapGeoJSON = useStore(mapGeoJSON);

    const [zoomRange, setZoomRange] = useState<ZoomRange>({
        min: 11,
        max: 15,
    });
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState<{
        done: number;
        total: number;
        failed: number;
    } | null>(null);
    const [cancelToken, setCancelToken] = useState<{ cancelled: boolean }>({
        cancelled: false,
    });

    const playPoly = $polyGeoJSON ?? $mapGeoJSON;
    const bbox = useMemo(() => {
        if (!playPoly) return null;
        try {
            return turf.bbox(playPoly as any) as [
                number,
                number,
                number,
                number,
            ];
        } catch {
            return null;
        }
    }, [playPoly]);

    const estimate = useMemo(() => {
        if (!bbox) return null;
        let count = 0;
        for (let z = zoomRange.min; z <= zoomRange.max; z++) {
            const [x0, y0, x1, y1] = tileBounds(bbox, z);
            count += (x1 - x0 + 1) * (y1 - y0 + 1);
        }
        // Rough size estimate: 12 KB / tile average for raster PNGs
        // at city zoom. Used purely as a friendly hint, not a hard
        // accounting.
        const sizeMb = (count * 12) / 1024;
        return { count, sizeMb };
    }, [bbox, zoomRange]);

    const startDownload = async () => {
        if (!bbox || !estimate || busy) return;
        setBusy(true);
        const token = { cancelled: false };
        setCancelToken(token);
        setProgress({ done: 0, total: estimate.count, failed: 0 });

        const tiles: Array<{ z: number; x: number; y: number }> = [];
        for (let z = zoomRange.min; z <= zoomRange.max; z++) {
            const [x0, y0, x1, y1] = tileBounds(bbox, z);
            for (let x = x0; x <= x1; x++) {
                for (let y = y0; y <= y1; y++) {
                    tiles.push({ z, x, y });
                }
            }
        }

        let done = 0;
        let failed = 0;
        // Run a fixed-size pool of workers pulling from a shared index.
        let nextIdx = 0;
        const worker = async () => {
            while (true) {
                if (token.cancelled) return;
                const idx = nextIdx++;
                if (idx >= tiles.length) return;
                const t = tiles[idx];
                try {
                    const url = TILE_URL(t.z, t.x, t.y);
                    const r = await fetch(url, {
                        // Default mode: CORS; CARTO tiles are
                        // Access-Control-Allow-Origin: *, so the
                        // browser stores them in the SW cache.
                        cache: "default",
                    });
                    if (!r.ok) failed++;
                } catch {
                    failed++;
                } finally {
                    done++;
                    // Throttle setProgress so we don't render-flood.
                    if (done % 5 === 0 || done === tiles.length) {
                        setProgress({
                            done,
                            total: tiles.length,
                            failed,
                        });
                    }
                }
            }
        };
        const workers = Array.from({ length: CONCURRENCY }, () => worker());
        await Promise.all(workers);

        setBusy(false);
        if (token.cancelled) {
            toast.info(`Tile download cancelled (${done} done).`, {
                autoClose: 3000,
            });
        } else if (failed > 0) {
            toast.warning(
                `Downloaded ${done - failed} of ${tiles.length} tiles (${failed} failed).`,
                { autoClose: 4000 },
            );
        } else {
            toast.success(
                `Cached ${tiles.length} tiles for offline use.`,
                { autoClose: 3000 },
            );
        }
        setProgress({ done, total: tiles.length, failed });
    };

    const cancel = () => {
        cancelToken.cancelled = true;
    };

    const clearTileCache = async () => {
        if (
            !confirm(
                "Clear all cached map tiles? This frees up storage but means the next load will re-fetch them from the network.",
            )
        ) {
            return;
        }
        try {
            const names = await caches.keys();
            const tileCaches = names.filter((n) => n.startsWith("tiles-"));
            await Promise.all(tileCaches.map((n) => caches.delete(n)));
            toast.success(
                `Cleared ${tileCaches.length} tile cache${tileCaches.length === 1 ? "" : "s"}.`,
                { autoClose: 2000 },
            );
        } catch (e) {
            toast.error(`Couldn't clear caches: ${(e as Error).message}`);
        }
    };

    if (!bbox) {
        return (
            <div
                className={cn(
                    "w-full text-xs text-muted-foreground italic px-3 py-2 rounded-md",
                    "bg-secondary/30 border border-dashed border-border",
                )}
            >
                Set a play area first — offline tiles are scoped to its
                bounding box.
            </div>
        );
    }

    return (
        <div className="w-full space-y-2 text-sm">
            <div className="flex items-center gap-2">
                <CloudDownload className="w-4 h-4 text-primary shrink-0" />
                <span className="font-poppins font-semibold">
                    Offline tiles
                </span>
            </div>

            <p className="text-xs text-muted-foreground leading-snug">
                Pre-download Voyager basemap tiles covering the play
                area so the app keeps working without signal. Tiles
                stay cached for ~60 days or until you clear them.
            </p>

            {/* Zoom range — defaults cover overview → street-level. */}
            <div className="flex items-center gap-2 text-xs">
                <span className="text-muted-foreground">Zoom</span>
                <input
                    type="number"
                    min={5}
                    max={18}
                    value={zoomRange.min}
                    onChange={(e) =>
                        setZoomRange((r) => ({
                            ...r,
                            min: Math.max(
                                5,
                                Math.min(parseInt(e.target.value, 10) || 5, r.max),
                            ),
                        }))
                    }
                    disabled={busy}
                    className={cn(
                        "w-14 px-2 py-1 rounded-sm border border-border",
                        "bg-secondary/40 text-sm tabular-nums",
                    )}
                />
                <span className="text-muted-foreground">to</span>
                <input
                    type="number"
                    min={5}
                    max={18}
                    value={zoomRange.max}
                    onChange={(e) =>
                        setZoomRange((r) => ({
                            ...r,
                            max: Math.min(
                                18,
                                Math.max(parseInt(e.target.value, 10) || 18, r.min),
                            ),
                        }))
                    }
                    disabled={busy}
                    className={cn(
                        "w-14 px-2 py-1 rounded-sm border border-border",
                        "bg-secondary/40 text-sm tabular-nums",
                    )}
                />
            </div>

            {estimate && (
                <div className="text-[11px] text-muted-foreground tabular-nums">
                    ≈ {estimate.count.toLocaleString()} tiles · ≈{" "}
                    {estimate.sizeMb < 1
                        ? `${(estimate.sizeMb * 1024).toFixed(0)} KB`
                        : `${estimate.sizeMb.toFixed(1)} MB`}
                </div>
            )}

            {progress && (
                <div className="space-y-1">
                    <div className="h-1.5 w-full bg-secondary rounded-full overflow-hidden">
                        <div
                            className="h-full bg-primary transition-all duration-150"
                            style={{
                                width: `${
                                    progress.total === 0
                                        ? 0
                                        : (progress.done / progress.total) *
                                          100
                                }%`,
                            }}
                        />
                    </div>
                    <div className="text-[10px] text-muted-foreground tabular-nums">
                        {progress.done.toLocaleString()} /{" "}
                        {progress.total.toLocaleString()}
                        {progress.failed > 0 &&
                            ` · ${progress.failed} failed`}
                    </div>
                </div>
            )}

            <div className="flex gap-2 pt-1">
                {busy ? (
                    <button
                        type="button"
                        onClick={cancel}
                        className={cn(
                            "flex-1 flex items-center justify-center gap-1.5",
                            "px-2.5 py-1.5 rounded-sm text-xs font-poppins font-semibold",
                            "bg-destructive/15 hover:bg-destructive/25 text-destructive border border-destructive/40",
                            "transition-colors",
                        )}
                    >
                        Cancel
                    </button>
                ) : (
                    <button
                        type="button"
                        onClick={startDownload}
                        disabled={
                            !estimate || estimate.count === 0
                        }
                        className={cn(
                            "flex-1 flex items-center justify-center gap-1.5",
                            "px-2.5 py-1.5 rounded-sm text-xs font-poppins font-bold",
                            "bg-primary text-primary-foreground hover:bg-primary/90",
                            "transition-colors",
                            "disabled:opacity-50 disabled:cursor-not-allowed",
                        )}
                    >
                        <CloudDownload className="w-3.5 h-3.5" />
                        Download tiles
                    </button>
                )}
                <button
                    type="button"
                    onClick={clearTileCache}
                    disabled={busy}
                    className={cn(
                        "px-2.5 py-1.5 rounded-sm text-xs font-poppins font-semibold",
                        "bg-secondary hover:bg-accent border border-border",
                        "transition-colors gap-1.5 flex items-center",
                    )}
                    title="Clear all cached tiles"
                >
                    <Trash2 className="w-3 h-3" />
                </button>
            </div>

            {busy && progress && progress.done === 0 && (
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Starting…
                </div>
            )}
        </div>
    );
}

/**
 * Convert a lat/lng bbox to inclusive tile-coordinate bounds at a
 * given zoom. Uses the standard Slippy-map tile-coordinate formula.
 */
function tileBounds(
    [minLng, minLat, maxLng, maxLat]: [number, number, number, number],
    z: number,
): [number, number, number, number] {
    const n = 2 ** z;
    const lng2x = (lng: number) =>
        Math.floor(((lng + 180) / 360) * n);
    const lat2y = (lat: number) =>
        Math.floor(
            ((1 -
                Math.log(
                    Math.tan((lat * Math.PI) / 180) +
                        1 / Math.cos((lat * Math.PI) / 180),
                ) /
                    Math.PI) /
                2) *
                n,
        );
    return [
        Math.max(0, lng2x(minLng)),
        Math.max(0, lat2y(maxLat)),
        Math.min(n - 1, lng2x(maxLng)),
        Math.min(n - 1, lat2y(minLat)),
    ];
}

export default OfflineTilePreloader;
