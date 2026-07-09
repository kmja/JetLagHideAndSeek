import { ArrowLeft } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import MapGL, { Layer, type MapRef, Source } from "react-map-gl/maplibre";
import { Link } from "react-router-dom";

import type { TransitMode } from "@/lib/gameSetup";
import { PLAY_AREA_COLOR } from "@/lib/playAreaStyle";
import { protomapsMapLibreStyle } from "@/lib/protomapsStyle";
import { resolvedTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { geocode } from "@/maps/api/geocode";
import { findExtensionCandidates } from "@/maps/api/playAreaExtensions";
import { fetchRawBoundaryPolygon } from "@/maps/api/polygonsOsmFr";
import {
    dropFarExclaves,
    findTransitReachCandidates,
    type RailRouteKind,
    type TransitReachResult,
} from "@/maps/api/transitReach";
import type { OpenStreetMap } from "@/maps/api/types";
import { useStore } from "@nanostores/react";

function bboxPolygonFromExtent(
    ext: [number, number, number, number],
): GeoJSON.Polygon {
    // extent order: [maxLat, minLng, minLat, maxLng].
    const [maxLat, minLng, minLat, maxLng] = ext;
    return {
        type: "Polygon",
        coordinates: [
            [
                [minLng, minLat],
                [maxLng, minLat],
                [maxLng, maxLat],
                [minLng, maxLat],
                [minLng, minLat],
            ],
        ],
    };
}

/**
 * Developer comparison at `/debug/adjacency` (Topic 2 prototype) — for a
 * searched city, run BOTH the shipped ADMIN-ADJACENCY selector
 * (`findExtensionCandidates`) and the prototype TRANSIT-REACH selector
 * (`findTransitReachCandidates`) and show the two candidate sets side by
 * side, so the transit-reach idea ("everywhere the subway / commuter train
 * runs") can be eyeballed on Stockholm + test cities before it becomes the
 * default. Writes NO global state — purely a read-only inspector.
 */

const ALL_MODES: TransitMode[] = ["bus", "tram", "train", "subway", "ferry"];
const KIND_OPTIONS: RailRouteKind[] = [
    "subway",
    "light_rail",
    "commuter",
    "tram",
    "ferry",
    "bus",
];
const PRESETS = [
    "Stockholm",
    "New York City",
    "Chicago",
    "London",
    "Paris",
    "Berlin",
    "Munich",
    "Hamburg",
    "Madrid",
    "Barcelona",
    "Amsterdam",
    "Copenhagen",
    "Oslo",
    "Helsinki",
    "Vienna",
    "Prague",
    "Warsaw",
    "Budapest",
    "Rome",
    "Milan",
    "Lisbon",
    "Zurich",
    "Brussels",
    "Toronto",
    "Montreal",
    "Vancouver",
    "Boston",
    "Washington",
    "San Francisco",
    "Los Angeles",
    "Philadelphia",
    "Sydney",
    "Melbourne",
    "Tokyo",
    "Osaka",
    "Seoul",
    "Singapore",
    "Hong Kong",
];

const ADMIN_LEVELS: { label: string; value: string }[] = [
    { label: "auto", value: "auto" },
    { label: "6 (county)", value: "6" },
    { label: "7", value: "7" },
    { label: "8 (city)", value: "8" },
];
type SortKey = "area" | "stops" | "distance";

interface AdminCandidate {
    name: string;
    relationId: number;
    distanceKm: number;
    hasMatchingTransit: boolean;
}

export function DebugAdjacencyPage() {
    const [query, setQuery] = useState("Stockholm");
    const [radiusKm, setRadiusKm] = useState(40);
    // Default to ALL the game's transit modes (bus + ferry included) — the
    // reach is "everywhere any allowed mode goes", not just rail. Bus is
    // heavy; toggle it off if a run is slow.
    const [kinds, setKinds] = useState<RailRouteKind[]>([
        "subway",
        "light_rail",
        "commuter",
        "tram",
        "ferry",
        "bus",
    ]);
    const [adminLevel, setAdminLevel] = useState("auto");
    const [sortKey, setSortKey] = useState<SortKey>("area");
    const [minAreaKm2, setMinAreaKm2] = useState(0);
    const [minStops, setMinStops] = useState(2);
    const [contiguousOnly, setContiguousOnly] = useState(true);
    const [maxAreaRatio, setMaxAreaRatio] = useState(10);
    const [minDensity, setMinDensity] = useState(0);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [primaryName, setPrimaryName] = useState<string | null>(null);
    const [admin, setAdmin] = useState<AdminCandidate[] | null>(null);
    const [reach, setReach] = useState<TransitReachResult | null>(null);
    const [primaryPoly, setPrimaryPoly] = useState<
        GeoJSON.Polygon | GeoJSON.MultiPolygon | null
    >(null);
    const dark = useStore(resolvedTheme) === "dark";
    const mapRef = useRef<MapRef | null>(null);

    const toggleKind = (k: RailRouteKind) =>
        setKinds((prev) =>
            prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k],
        );

    const run = async () => {
        setLoading(true);
        setError(null);
        setAdmin(null);
        setReach(null);
        setPrimaryName(null);
        setPrimaryPoly(null);
        try {
            const results = (await geocode(query, "en")) as OpenStreetMap[];
            const primary = results?.[0];
            if (!primary) {
                setError(`No play area found for "${query}"`);
                return;
            }
            setPrimaryName(primary.properties.name ?? query);
            void fetchRawBoundaryPolygon(primary.properties.osm_id)
                .then((p) => setPrimaryPoly(p ? dropFarExclaves(p) : null))
                .catch(() => setPrimaryPoly(null));
            const [adminRes, reachRes] = await Promise.all([
                findExtensionCandidates(primary, ALL_MODES, {
                    radiusKm,
                    limit: 40,
                })
                    .then((cs) =>
                        cs.map((c) => ({
                            name:
                                (c.feature.properties.name as string) ??
                                `r${c.feature.properties.osm_id}`,
                            relationId: c.feature.properties.osm_id,
                            distanceKm: c.distanceKm,
                            hasMatchingTransit: c.hasMatchingTransit,
                        })),
                    )
                    .catch((e) => {
                        console.warn("admin adjacency failed", e);
                        return [] as AdminCandidate[];
                    }),
                findTransitReachCandidates(primary, {
                    radiusKm,
                    kinds,
                    adminLevel: adminLevel === "auto" ? undefined : adminLevel,
                    contiguousOnly,
                    maxAreaRatio,
                }).catch((e) => {
                    console.warn("transit reach failed", e);
                    return null;
                }),
            ]);
            setAdmin(adminRes);
            setReach(reachRes);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setLoading(false);
        }
    };

    const adminIds = new Set((admin ?? []).map((a) => a.relationId));
    const reachCandidates = useMemo(
        () =>
            (reach?.candidates ?? [])
                .filter(
                    (c) =>
                        c.areaKm2 >= minAreaKm2 &&
                        c.stopCount >= minStops &&
                        c.stopsPerKm2 >= minDensity,
                )
                .slice()
                .sort((a, b) => {
                    if (sortKey === "area") return b.areaKm2 - a.areaKm2;
                    if (sortKey === "stops") return b.stopCount - a.stopCount;
                    return a.distanceKm - b.distanceKm;
                }),
        [reach, minAreaKm2, minStops, minDensity, sortKey],
    );
    const reachIds = new Set(reachCandidates.map((c) => c.relationId));

    // Map data — candidate polygons (real boundary, bbox fallback) coloured
    // by in-both vs rail-only, rail stops, and the primary boundary.
    const reachFC = useMemo<GeoJSON.FeatureCollection>(
        () => ({
            type: "FeatureCollection",
            features: reachCandidates.map((c) => ({
                type: "Feature",
                properties: {
                    inBoth: adminIds.has(c.relationId),
                    name: c.name,
                },
                geometry: c.polygon ?? bboxPolygonFromExtent(c.extent),
            })),
        }),
        // adminIds is derived from `admin`; recompute when either changes.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [reachCandidates, admin],
    );
    const stopsFC = useMemo<GeoJSON.FeatureCollection>(
        () => ({
            type: "FeatureCollection",
            features: (reach?.stops ?? []).map((s) => ({
                type: "Feature",
                properties: { kind: s.kind },
                geometry: { type: "Point", coordinates: [s.lon, s.lat] },
            })),
        }),
        [reach],
    );
    const primaryFC = useMemo<GeoJSON.FeatureCollection>(
        () => ({
            type: "FeatureCollection",
            features: primaryPoly
                ? [{ type: "Feature", properties: {}, geometry: primaryPoly }]
                : [],
        }),
        [primaryPoly],
    );

    // Fit the map to the candidate set + primary whenever results change.
    useEffect(() => {
        const map = mapRef.current?.getMap();
        if (!map) return;
        const exts = reachCandidates.map((c) => c.extent);
        if (primaryPoly) {
            const c = reach;
            if (c)
                exts.push([
                    c.stops.reduce((m, s) => Math.max(m, s.lat), -90),
                    c.stops.reduce((m, s) => Math.min(m, s.lon), 180),
                    c.stops.reduce((m, s) => Math.min(m, s.lat), 90),
                    c.stops.reduce((m, s) => Math.max(m, s.lon), -180),
                ]);
        }
        if (exts.length === 0) return;
        let n = -90,
            s = 90,
            w = 180,
            e = -180;
        for (const [mx, mnLng, mn, mxLng] of exts) {
            n = Math.max(n, mx);
            s = Math.min(s, mn);
            w = Math.min(w, mnLng);
            e = Math.max(e, mxLng);
        }
        if (n <= s || e <= w) return;
        try {
            map.fitBounds(
                [
                    [w, s],
                    [e, n],
                ],
                { padding: 30, duration: 500, maxZoom: 12 },
            );
        } catch {
            /* ignore */
        }
    }, [reachCandidates, primaryPoly, reach]);

    return (
        <div className="min-h-screen bg-background text-foreground p-4 md:p-8">
            <div className="max-w-5xl mx-auto space-y-6">
                <div className="flex items-center gap-3">
                    <Link
                        to="/welcome"
                        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
                    >
                        <ArrowLeft className="w-4 h-4" /> Back
                    </Link>
                    <h1 className="text-xl font-semibold">
                        Adjacency comparison
                    </h1>
                </div>
                <p className="text-sm text-muted-foreground">
                    Admin-adjacency (shipped) vs. transit-reach (prototype:
                    every municipality the subway / commuter train actually
                    stops in). Read-only — nothing is saved.
                </p>

                <div className="space-y-3 rounded-lg border border-border p-4">
                    <div className="flex flex-wrap gap-2">
                        {PRESETS.map((p) => (
                            <button
                                key={p}
                                type="button"
                                onClick={() => setQuery(p)}
                                className={cn(
                                    "rounded-full border px-3 py-1 text-xs",
                                    query === p
                                        ? "bg-primary text-primary-foreground border-primary"
                                        : "border-border hover:bg-accent",
                                )}
                            >
                                {p}
                            </button>
                        ))}
                    </div>
                    <div className="flex flex-wrap items-end gap-4">
                        <label className="flex flex-col gap-1 text-xs">
                            City
                            <input
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter") void run();
                                }}
                                className="rounded-md border border-border bg-background px-2 py-1 text-sm w-56"
                            />
                        </label>
                        <label className="flex flex-col gap-1 text-xs">
                            Radius: {radiusKm} km
                            <input
                                type="range"
                                min={10}
                                max={80}
                                step={5}
                                value={radiusKm}
                                onChange={(e) =>
                                    setRadiusKm(Number(e.target.value))
                                }
                            />
                        </label>
                        <div className="flex flex-col gap-1 text-xs">
                            Rail kinds
                            <div className="flex gap-2">
                                {KIND_OPTIONS.map((k) => (
                                    <button
                                        key={k}
                                        type="button"
                                        onClick={() => toggleKind(k)}
                                        className={cn(
                                            "rounded-md border px-2 py-1",
                                            kinds.includes(k)
                                                ? "bg-primary/15 border-primary text-foreground"
                                                : "border-border text-muted-foreground",
                                        )}
                                    >
                                        {k}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <button
                            type="button"
                            onClick={() => void run()}
                            disabled={loading}
                            className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
                        >
                            {loading ? "Running…" : "Compare"}
                        </button>
                    </div>
                    <div className="flex flex-wrap items-end gap-4 border-t border-border/60 pt-3">
                        <div className="flex flex-col gap-1 text-xs">
                            Candidate level (re-run to apply)
                            <div className="flex gap-2">
                                {ADMIN_LEVELS.map((lvl) => (
                                    <button
                                        key={lvl.value}
                                        type="button"
                                        onClick={() => setAdminLevel(lvl.value)}
                                        className={cn(
                                            "rounded-md border px-2 py-1",
                                            adminLevel === lvl.value
                                                ? "bg-primary/15 border-primary text-foreground"
                                                : "border-border text-muted-foreground",
                                        )}
                                    >
                                        {lvl.label}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <div className="flex flex-col gap-1 text-xs">
                            Sort transit-reach
                            <div className="flex gap-2">
                                {(
                                    [
                                        ["area", "largest"],
                                        ["stops", "most stops"],
                                        ["distance", "nearest"],
                                    ] as [SortKey, string][]
                                ).map(([k, label]) => (
                                    <button
                                        key={k}
                                        type="button"
                                        onClick={() => setSortKey(k)}
                                        className={cn(
                                            "rounded-md border px-2 py-1",
                                            sortKey === k
                                                ? "bg-primary/15 border-primary text-foreground"
                                                : "border-border text-muted-foreground",
                                        )}
                                    >
                                        {label}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <label className="flex flex-col gap-1 text-xs">
                            Min stops: {minStops}
                            <input
                                type="range"
                                min={0}
                                max={20}
                                step={1}
                                value={minStops}
                                onChange={(e) =>
                                    setMinStops(Number(e.target.value))
                                }
                            />
                        </label>
                        <label className="flex flex-col gap-1 text-xs">
                            Min area: {minAreaKm2} km²
                            <input
                                type="range"
                                min={0}
                                max={100}
                                step={5}
                                value={minAreaKm2}
                                onChange={(e) =>
                                    setMinAreaKm2(Number(e.target.value))
                                }
                            />
                        </label>
                        <label className="flex flex-col gap-1 text-xs">
                            Max area ×primary: {maxAreaRatio}
                            <input
                                type="range"
                                min={2}
                                max={40}
                                step={1}
                                value={maxAreaRatio}
                                onChange={(e) =>
                                    setMaxAreaRatio(Number(e.target.value))
                                }
                            />
                        </label>
                        <label className="flex flex-col gap-1 text-xs">
                            Min density: {minDensity.toFixed(2)} /km²
                            <input
                                type="range"
                                min={0}
                                max={1}
                                step={0.02}
                                value={minDensity}
                                onChange={(e) =>
                                    setMinDensity(Number(e.target.value))
                                }
                            />
                        </label>
                        <button
                            type="button"
                            onClick={() => setContiguousOnly((v) => !v)}
                            className={cn(
                                "rounded-md border px-2 py-1 text-xs self-end",
                                contiguousOnly
                                    ? "bg-primary/15 border-primary text-foreground"
                                    : "border-border text-muted-foreground",
                            )}
                            title="Keep only reached areas connected to the primary (re-run to apply)"
                        >
                            contiguous only
                        </button>
                    </div>
                </div>

                {error && (
                    <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                        {error}
                    </div>
                )}

                {primaryName && (
                    <div className="text-sm">
                        Primary: <strong>{primaryName}</strong>
                        {reach && (
                            <span className="text-muted-foreground">
                                {" "}
                                — {reach.stops.length} rail stops found
                            </span>
                        )}
                    </div>
                )}

                {reach && (
                    <div className="h-[420px] w-full overflow-hidden rounded-lg border border-border">
                        <MapGL
                            ref={mapRef}
                            initialViewState={{
                                longitude: reach.stops.length
                                    ? reach.stops[0].lon
                                    : 0,
                                latitude: reach.stops.length
                                    ? reach.stops[0].lat
                                    : 20,
                                zoom: 8,
                            }}
                            style={{ width: "100%", height: "100%" }}
                            mapStyle={protomapsMapLibreStyle(
                                dark ? "dark" : "light",
                            )}
                            attributionControl={false}
                            dragRotate={false}
                        >
                            <Source
                                id="tr-reach"
                                type="geojson"
                                data={reachFC}
                            >
                                <Layer
                                    id="tr-reach-fill"
                                    type="fill"
                                    paint={{
                                        "fill-color": [
                                            "case",
                                            ["get", "inBoth"],
                                            "#22c55e",
                                            "#3b82f6",
                                        ],
                                        "fill-opacity": 0.25,
                                    }}
                                />
                                <Layer
                                    id="tr-reach-line"
                                    type="line"
                                    paint={{
                                        "line-color": [
                                            "case",
                                            ["get", "inBoth"],
                                            "#16a34a",
                                            "#2563eb",
                                        ],
                                        "line-width": 1.5,
                                    }}
                                />
                            </Source>
                            <Source
                                id="tr-primary"
                                type="geojson"
                                data={primaryFC}
                            >
                                <Layer
                                    id="tr-primary-line"
                                    type="line"
                                    paint={{
                                        "line-color": PLAY_AREA_COLOR,
                                        "line-width": 2.5,
                                    }}
                                />
                            </Source>
                            <Source
                                id="tr-stops"
                                type="geojson"
                                data={stopsFC}
                            >
                                <Layer
                                    id="tr-stops-dots"
                                    type="circle"
                                    paint={{
                                        "circle-radius": 2.5,
                                        "circle-color": "#f59e0b",
                                        "circle-stroke-width": 0.5,
                                        "circle-stroke-color": "#78350f",
                                    }}
                                />
                            </Source>
                        </MapGL>
                    </div>
                )}
                {reach && (
                    <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                        <span>
                            <span className="inline-block w-3 h-3 rounded-sm bg-[#22c55e]/40 border border-[#16a34a] align-middle" />{" "}
                            in both
                        </span>
                        <span>
                            <span className="inline-block w-3 h-3 rounded-sm bg-[#3b82f6]/40 border border-[#2563eb] align-middle" />{" "}
                            rail-only (transit-reach adds)
                        </span>
                        <span>
                            <span className="inline-block w-3 h-3 rounded-full bg-[#f59e0b] align-middle" />{" "}
                            rail stop
                        </span>
                        <span>
                            <span className="inline-block w-3 h-[2px] bg-primary align-middle" />{" "}
                            primary boundary
                        </span>
                    </div>
                )}

                {(admin || reach) && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {/* Admin adjacency */}
                        <div className="rounded-lg border border-border">
                            <div className="border-b border-border px-3 py-2 text-sm font-semibold">
                                Admin-adjacency (shipped) — {admin?.length ?? 0}
                            </div>
                            <ul className="divide-y divide-border/60 max-h-[60vh] overflow-y-auto">
                                {(admin ?? []).map((a) => (
                                    <li
                                        key={a.relationId}
                                        className="flex items-center justify-between px-3 py-1.5 text-sm"
                                    >
                                        <span className="flex items-center gap-2">
                                            <span
                                                className={cn(
                                                    "w-1.5 h-1.5 rounded-full",
                                                    reachIds.has(a.relationId)
                                                        ? "bg-success"
                                                        : "bg-warning",
                                                )}
                                                title={
                                                    reachIds.has(a.relationId)
                                                        ? "also in transit-reach"
                                                        : "admin-only (no rail)"
                                                }
                                            />
                                            {a.name}
                                        </span>
                                        <span className="text-xs text-muted-foreground tabular-nums">
                                            {a.distanceKm.toFixed(1)} km
                                            {a.hasMatchingTransit ? " · transit" : ""}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        </div>

                        {/* Transit reach */}
                        <div className="rounded-lg border border-border">
                            <div className="border-b border-border px-3 py-2 text-sm font-semibold">
                                Transit-reach (prototype) —{" "}
                                {reachCandidates.length}
                            </div>
                            <ul className="divide-y divide-border/60 max-h-[60vh] overflow-y-auto">
                                {reachCandidates.map((c) => (
                                    <li
                                        key={c.relationId}
                                        className="flex items-center justify-between px-3 py-1.5 text-sm"
                                    >
                                        <span className="flex items-center gap-2 min-w-0">
                                            <span
                                                className={cn(
                                                    "w-1.5 h-1.5 rounded-full shrink-0",
                                                    adminIds.has(c.relationId)
                                                        ? "bg-success"
                                                        : "bg-info",
                                                )}
                                                title={
                                                    adminIds.has(c.relationId)
                                                        ? "also in admin-adjacency"
                                                        : "rail-only (not admin-adjacent)"
                                                }
                                            />
                                            <span className="truncate">
                                                {c.name}
                                            </span>
                                            {c.adminLevel && (
                                                <span className="shrink-0 text-[10px] text-muted-foreground">
                                                    L{c.adminLevel}
                                                </span>
                                            )}
                                        </span>
                                        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                                            {Math.round(c.areaKm2)} km² ·{" "}
                                            {c.stopCount} stops ·{" "}
                                            {c.stopsPerKm2.toFixed(2)}/km²
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    </div>
                )}

                {reach && reach.candidates.length > 0 && (
                    <div className="text-xs text-muted-foreground space-y-1">
                        <div>
                            <span className="inline-block w-2 h-2 rounded-full bg-success align-middle" />{" "}
                            in both ·{" "}
                            <span className="inline-block w-2 h-2 rounded-full bg-info align-middle" />{" "}
                            rail-only (transit-reach adds these) ·{" "}
                            <span className="inline-block w-2 h-2 rounded-full bg-warning align-middle" />{" "}
                            admin-only (no rail — transit-reach drops these)
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

export default DebugAdjacencyPage;
