import { useStore } from "@nanostores/react";
import * as turf from "@turf/turf";
import { Check, CloudDownload, Loader2, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "react-toastify";

import { mapGeoJSON, polyGeoJSON } from "@/lib/context";
import { cn } from "@/lib/utils";

/**
 * "Pre-download offline tiles for this play area" — the feature the
 * user explicitly asked for. Walks the play-area bbox at each
 * user-selected zoom level (5–18), fetches each tile from CARTO
 * Voyager, and lets the service worker stash it in the `tiles-carto`
 * runtime cache. The tiles then serve offline on any subsequent
 * visit.
 *
 * UX shape:
 *
 *   • Per-zoom checklist — the user picks exactly which zooms to
 *     cache, and the row shows the tile count + estimated MB at
 *     that zoom. Replaces the older min/max number-input pair
 *     which was easy to clobber (typing "1" before "5" briefly
 *     made min=1 and was clamped back).
 *   • Sensible defaults — 11–15 selected on mount (city overview
 *     through street-level), matching the v15 default range.
 *   • Toast progress — the download runs in the background and
 *     surfaces progress in a sticky toast. Closing the sheet
 *     doesn't cancel it.
 *
 * Implementation notes:
 *
 *   • Concurrency capped at 8 in-flight requests so we don't
 *     hammer the tile provider (their TOS asks for "reasonable"
 *     use) and the browser doesn't choke on thousands of pending
 *     fetches.
 *   • `fetch(url)` looks identical to what MapLibre sends at
 *     runtime, so the SW's runtimeCaching picks each one up.
 *   • Tiles already cached hit the SW's CacheFirst handler and
 *     skip the network entirely — re-running the download is
 *     cheap.
 */

const TILE_URL = (z: number, x: number, y: number) =>
    `https://${["a", "b", "c", "d"][(x + y) % 4]}.basemaps.cartocdn.com/rastertiles/voyager/${z}/${x}/${y}.png`;

const CONCURRENCY = 8;

/** Bytes per tile estimate, by zoom. PNG tiles get larger as you
 *  zoom in (more pixel detail per tile). Numbers ballpark-sized
 *  from CARTO Voyager at typical city coverage. */
const TILE_BYTES_BY_ZOOM: Record<number, number> = {
    5: 6_000,
    6: 7_000,
    7: 8_000,
    8: 9_000,
    9: 10_000,
    10: 11_000,
    11: 12_000,
    12: 13_000,
    13: 14_000,
    14: 15_000,
    15: 16_000,
    16: 18_000,
    17: 20_000,
    18: 22_000,
};

const MIN_Z = 5;
const MAX_Z = 18;
const DEFAULT_SELECTED = new Set([11, 12, 13, 14, 15]);

/**
 * Background download handle. Surfaces only via the toast — the
 * component renders a small "running…" hint but the actual cancel
 * happens from the toast (so closing the More sheet doesn't kill
 * the run). Module-scoped so a re-mount of the component during a
 * sheet open/close cycle doesn't lose the reference.
 */
let activeRun: {
    token: { cancelled: boolean };
    toastId: number | string;
} | null = null;

export function OfflineTilePreloader() {
    const $polyGeoJSON = useStore(polyGeoJSON);
    const $mapGeoJSON = useStore(mapGeoJSON);

    const [selected, setSelected] = useState<Set<number>>(
        () => new Set(DEFAULT_SELECTED),
    );
    const [busy, setBusy] = useState<boolean>(activeRun !== null);

    // Sync local busy with the module-scoped run, so a re-mount
    // during an active download still shows the cancel UI.
    useEffect(() => {
        const id = setInterval(() => {
            setBusy(activeRun !== null);
        }, 500);
        return () => clearInterval(id);
    }, []);

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

    // Per-zoom breakdown — count + size bytes. Re-derived when the
    // play-area bbox changes; the per-row count is stable across
    // re-renders of the checklist.
    const perZoom = useMemo(() => {
        if (!bbox) return null;
        const rows: Array<{ z: number; tiles: number; bytes: number }> = [];
        for (let z = MIN_Z; z <= MAX_Z; z++) {
            const [x0, y0, x1, y1] = tileBounds(bbox, z);
            const tiles = (x1 - x0 + 1) * (y1 - y0 + 1);
            rows.push({
                z,
                tiles,
                bytes: tiles * (TILE_BYTES_BY_ZOOM[z] ?? 12_000),
            });
        }
        return rows;
    }, [bbox]);

    const totals = useMemo(() => {
        if (!perZoom) return null;
        let tiles = 0;
        let bytes = 0;
        for (const r of perZoom) {
            if (!selected.has(r.z)) continue;
            tiles += r.tiles;
            bytes += r.bytes;
        }
        return { tiles, bytes };
    }, [perZoom, selected]);

    const toggleZoom = (z: number) => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(z)) next.delete(z);
            else next.add(z);
            return next;
        });
    };

    const startDownload = async () => {
        if (!bbox || !totals || busy || totals.tiles === 0) return;

        const tiles: Array<{ z: number; x: number; y: number }> = [];
        const zooms = [...selected].sort((a, b) => a - b);
        for (const z of zooms) {
            const [x0, y0, x1, y1] = tileBounds(bbox, z);
            for (let x = x0; x <= x1; x++) {
                for (let y = y0; y <= y1; y++) {
                    tiles.push({ z, x, y });
                }
            }
        }

        const token = { cancelled: false };
        // Open a sticky toast we'll update with progress. The
        // close button on the toast doubles as Cancel, so the
        // user can dismiss the More sheet but still see the
        // download in the corner of the screen.
        const toastId = toast.info(
            renderToastBody(0, tiles.length, 0, () => {
                token.cancelled = true;
            }),
            {
                autoClose: false,
                closeOnClick: false,
                draggable: false,
                closeButton: false,
            },
        );
        activeRun = { token, toastId };
        setBusy(true);

        let done = 0;
        let failed = 0;
        let nextIdx = 0;
        const worker = async () => {
            while (true) {
                if (token.cancelled) return;
                const idx = nextIdx++;
                if (idx >= tiles.length) return;
                const t = tiles[idx];
                try {
                    const url = TILE_URL(t.z, t.x, t.y);
                    const r = await fetch(url, { cache: "default" });
                    if (!r.ok) failed++;
                } catch {
                    failed++;
                } finally {
                    done++;
                    // Throttle toast updates so we don't render-flood.
                    if (done % 10 === 0 || done === tiles.length) {
                        toast.update(toastId, {
                            render: renderToastBody(
                                done,
                                tiles.length,
                                failed,
                                () => {
                                    token.cancelled = true;
                                },
                            ),
                        });
                    }
                }
            }
        };
        const workers = Array.from({ length: CONCURRENCY }, () => worker());
        await Promise.all(workers);

        activeRun = null;
        setBusy(false);
        if (token.cancelled) {
            toast.update(toastId, {
                render: `Tile download cancelled (${done} of ${tiles.length}).`,
                type: "info",
                autoClose: 3000,
                closeButton: true,
            });
        } else if (failed > 0) {
            toast.update(toastId, {
                render: `Downloaded ${done - failed} of ${tiles.length} tiles (${failed} failed).`,
                type: "warning",
                autoClose: 4000,
                closeButton: true,
            });
        } else {
            toast.update(toastId, {
                render: `Cached ${tiles.length.toLocaleString()} tiles for offline use.`,
                type: "success",
                autoClose: 3000,
                closeButton: true,
            });
        }
    };

    const cancel = () => {
        if (activeRun) activeRun.token.cancelled = true;
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
                area so the app keeps working without signal. Pick
                the zoom levels you want — wider city overviews are
                small; street-level (16+) gets big fast.
            </p>

            {/* Per-zoom checklist. Each row: checkbox, zoom number,
                tile count, size estimate. Tap a row to toggle. */}
            <div
                className={cn(
                    "rounded-sm border border-border bg-secondary/30",
                    "overflow-hidden",
                )}
            >
                {perZoom!.map((row) => {
                    const on = selected.has(row.z);
                    return (
                        <button
                            type="button"
                            key={row.z}
                            onClick={() => toggleZoom(row.z)}
                            disabled={busy}
                            className={cn(
                                "w-full flex items-center gap-2 px-2.5 py-1.5 text-xs",
                                "border-b border-border last:border-b-0",
                                "hover:bg-accent/30 transition-colors text-left",
                                "disabled:opacity-50 disabled:cursor-not-allowed",
                                on && "bg-primary/10",
                            )}
                        >
                            <span
                                className={cn(
                                    "inline-flex w-4 h-4 rounded-sm border items-center justify-center shrink-0",
                                    on
                                        ? "bg-primary border-primary text-primary-foreground"
                                        : "border-border bg-background/60",
                                )}
                            >
                                {on && <Check className="w-3 h-3" />}
                            </span>
                            <span className="font-poppins font-bold tabular-nums w-8">
                                z{row.z}
                            </span>
                            <span
                                className={cn(
                                    "tabular-nums text-muted-foreground flex-1",
                                )}
                            >
                                {row.tiles.toLocaleString()} tiles
                            </span>
                            <span className="tabular-nums text-muted-foreground">
                                {formatBytes(row.bytes)}
                            </span>
                        </button>
                    );
                })}
            </div>

            {totals && (
                <div className="flex items-center justify-between text-[11px] text-muted-foreground tabular-nums px-0.5">
                    <span>
                        Selected · {totals.tiles.toLocaleString()} tiles
                    </span>
                    <span>≈ {formatBytes(totals.bytes)}</span>
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
                        Cancel download
                    </button>
                ) : (
                    <button
                        type="button"
                        onClick={startDownload}
                        disabled={!totals || totals.tiles === 0}
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

            {busy && (
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Download running in the background — check the toast
                    for live progress.
                </div>
            )}
        </div>
    );
}

/** Toast body with progress bar + inline cancel button. */
function renderToastBody(
    done: number,
    total: number,
    failed: number,
    onCancel: () => void,
) {
    const pct = total === 0 ? 0 : (done / total) * 100;
    return (
        <div className="space-y-1.5 min-w-[220px]">
            <div className="flex items-center justify-between text-xs">
                <span className="font-poppins font-bold">
                    Caching tiles
                </span>
                <button
                    type="button"
                    onClick={onCancel}
                    className="text-[10px] uppercase tracking-wider font-poppins font-bold opacity-80 hover:opacity-100"
                >
                    Cancel
                </button>
            </div>
            <div className="h-1.5 w-full bg-white/15 rounded-full overflow-hidden">
                <div
                    className="h-full bg-white/90"
                    style={{ width: `${pct}%` }}
                />
            </div>
            <div className="text-[10px] tabular-nums opacity-90">
                {done.toLocaleString()} / {total.toLocaleString()}
                {failed > 0 && ` · ${failed} failed`}
            </div>
        </div>
    );
}

function formatBytes(b: number): string {
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
    if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
    return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
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
