import { Database, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "react-toastify";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Local-cache status panel. Surfaces what the app has stored on the
 * device — boundary data, map tiles, geocoder results, the bundled
 * coastline asset — so the player can confirm a play area is fully
 * pre-loaded and can clear individual buckets when they're running
 * low on browser storage.
 *
 * Data sources:
 *   - `navigator.storage.estimate()` for the overall usage / quota.
 *   - `caches.keys()` + per-cache `.keys()` for every Cache API bucket.
 *     This catches both the workbox-managed SW caches (tiles-carto,
 *     tiles-satellite, …) and the cacheFetch ones (jlhs-…).
 *   - localStorage byte count for "everything else" (settings,
 *     persisted atoms, the tile-size cache, the discoverable-cities
 *     list, etc.).
 *
 * Best-effort: every read is wrapped in a try/catch so a hostile
 * browser (Safari Private mode, embedded webview) just shows blanks
 * for the unsupported sources.
 */

interface CacheBucket {
    key: string;
    label: string;
    description: string;
    entries: number;
    /** Bytes occupied by this bucket, when computable. Otherwise null
     *  (browsers don't expose per-cache size; we can only get the
     *  total via storage.estimate). */
    bytes: number | null;
}

const BUCKET_LABELS: Record<string, { label: string; description: string }> = {
    "jlhs-map-generator-cache": {
        label: "Question data",
        description:
            "Overpass query results for question subtypes (airports, cities, museums, etc.).",
    },
    "jlhs-map-generator-zone-cache": {
        label: "Zone places",
        description:
            "Per-zone place lookups (poly-filtered finds for hiding zones).",
    },
    "jlhs-map-generator-permanent-cache": {
        label: "World coastline",
        description:
            "The Natural Earth 1:50m coastline asset used for nearest-coast lookups and the land-clipping trim.",
    },
    "tiles-carto": {
        label: "Map tiles (CARTO)",
        description: "Cached base-map tiles (CARTO voyager / light / dark).",
    },
    "tiles-satellite": {
        label: "Satellite tiles",
        description: "Cached Esri World Imagery tiles when satellite mode is on.",
    },
    "tiles-osm": {
        label: "OpenStreetMap tiles",
        description: "Plain OSM Carto tiles, if used as the base.",
    },
    "tiles-thunderforest": {
        label: "Thunderforest tiles",
        description: "Thunderforest tiles when configured with an API key.",
    },
    "api-geocode": {
        label: "Geocoder results",
        description: "Photon search + reverse-geocode results.",
    },
    "asset-coastline": {
        label: "Coastline asset",
        description: "SW-cached copy of coastline50.geojson.",
    },
};

function humanBytes(n: number | null): string {
    if (n === null) return "—";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024)
        return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function localStorageBytes(): number {
    try {
        let total = 0;
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k === null) continue;
            const v = localStorage.getItem(k) ?? "";
            // UTF-16 keys + values, 2 bytes each. Rough but stable.
            total += (k.length + v.length) * 2;
        }
        return total;
    } catch {
        return 0;
    }
}

async function scan(): Promise<{
    buckets: CacheBucket[];
    quota: number | null;
    usage: number | null;
    lsBytes: number;
}> {
    const buckets: CacheBucket[] = [];
    if (typeof caches !== "undefined") {
        try {
            const names = await caches.keys();
            for (const name of names) {
                try {
                    const c = await caches.open(name);
                    const reqs = await c.keys();
                    const meta = BUCKET_LABELS[name] ?? {
                        label: name,
                        description: "",
                    };
                    buckets.push({
                        key: name,
                        label: meta.label,
                        description: meta.description,
                        entries: reqs.length,
                        bytes: null,
                    });
                } catch {
                    /* skip unreadable bucket */
                }
            }
        } catch {
            /* Cache API unavailable */
        }
    }
    buckets.sort((a, b) => a.label.localeCompare(b.label));

    let quota: number | null = null;
    let usage: number | null = null;
    try {
        if (
            typeof navigator !== "undefined" &&
            navigator.storage &&
            typeof navigator.storage.estimate === "function"
        ) {
            const est = await navigator.storage.estimate();
            quota = typeof est.quota === "number" ? est.quota : null;
            usage = typeof est.usage === "number" ? est.usage : null;
        }
    } catch {
        /* estimate unavailable */
    }
    return { buckets, quota, usage, lsBytes: localStorageBytes() };
}

export function CacheStatus({ className }: { className?: string }) {
    const [state, setState] = useState<{
        loading: boolean;
        buckets: CacheBucket[];
        quota: number | null;
        usage: number | null;
        lsBytes: number;
    }>({
        loading: true,
        buckets: [],
        quota: null,
        usage: null,
        lsBytes: 0,
    });
    const refresh = async () => {
        setState((s) => ({ ...s, loading: true }));
        const r = await scan();
        setState({ loading: false, ...r });
    };
    useEffect(() => {
        void refresh();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const clearOne = async (name: string) => {
        try {
            await caches.delete(name);
            toast.success(`Cleared ${name}`, { autoClose: 1200 });
            await refresh();
        } catch (e) {
            toast.error(
                `Couldn't clear ${name}: ${
                    e instanceof Error ? e.message : String(e)
                }`,
            );
        }
    };

    const usagePct =
        state.quota && state.usage
            ? Math.min(100, Math.round((state.usage / state.quota) * 100))
            : null;
    const totalEntries = state.buckets.reduce((a, b) => a + b.entries, 0);

    return (
        <div className={cn("flex flex-col gap-2", className)}>
            <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                    <Database className="w-4 h-4 text-muted-foreground" />
                    <span className="text-sm font-poppins font-semibold">
                        Cached data
                    </span>
                </div>
                <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void refresh()}
                    disabled={state.loading}
                    className="gap-1.5 h-7 px-2 text-xs"
                >
                    <RefreshCw
                        className={cn(
                            "w-3.5 h-3.5",
                            state.loading && "animate-spin",
                        )}
                    />
                    Refresh
                </Button>
            </div>

            {/* Overall storage line. */}
            <div className="rounded-md border border-border bg-secondary/30 px-3 py-2 text-xs leading-snug space-y-1.5">
                <div className="flex justify-between gap-2">
                    <span className="text-muted-foreground">
                        Total used
                    </span>
                    <span className="font-medium tabular-nums">
                        {humanBytes(state.usage)}
                        {state.quota !== null && (
                            <span className="text-muted-foreground">
                                {" / "}
                                {humanBytes(state.quota)}
                                {usagePct !== null
                                    ? ` (${usagePct}%)`
                                    : ""}
                            </span>
                        )}
                    </span>
                </div>
                <div className="flex justify-between gap-2">
                    <span className="text-muted-foreground">
                        Settings (localStorage)
                    </span>
                    <span className="font-medium tabular-nums">
                        {humanBytes(state.lsBytes)}
                    </span>
                </div>
                <div className="flex justify-between gap-2">
                    <span className="text-muted-foreground">
                        Cached entries (all buckets)
                    </span>
                    <span className="font-medium tabular-nums">
                        {totalEntries}
                    </span>
                </div>
            </div>

            {/* Per-bucket list with clear buttons. */}
            {state.buckets.length === 0 ? (
                <div className="text-xs italic text-muted-foreground">
                    {state.loading
                        ? "Reading caches…"
                        : "No caches in use yet."}
                </div>
            ) : (
                <ul className="flex flex-col gap-1.5">
                    {state.buckets.map((b) => (
                        <li
                            key={b.key}
                            className="rounded-md border border-border bg-secondary/30 px-3 py-2 flex items-start gap-3"
                        >
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center justify-between gap-2">
                                    <span className="text-sm font-medium truncate">
                                        {b.label}
                                    </span>
                                    <span className="text-xs tabular-nums text-muted-foreground shrink-0">
                                        {b.entries}{" "}
                                        {b.entries === 1
                                            ? "entry"
                                            : "entries"}
                                    </span>
                                </div>
                                {b.description && (
                                    <div className="text-[11px] text-muted-foreground leading-snug mt-0.5">
                                        {b.description}
                                    </div>
                                )}
                            </div>
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => void clearOne(b.key)}
                                title={`Clear ${b.label}`}
                                aria-label={`Clear ${b.label}`}
                                className="h-7 px-2 text-destructive hover:text-destructive hover:bg-destructive/10"
                            >
                                <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                        </li>
                    ))}
                </ul>
            )}
            <p className="text-[10px] text-muted-foreground italic">
                Browsers don't expose per-bucket sizes — only the total
                across everything. Use "Total used" to gauge pressure.
            </p>
        </div>
    );
}

export default CacheStatus;
