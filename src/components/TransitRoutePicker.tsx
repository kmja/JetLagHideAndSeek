import "maplibre-gl/dist/maplibre-gl.css";

import { useStore } from "@nanostores/react";
import { bbox as turfBbox } from "@turf/turf";
import { Loader2, RefreshCw, Train } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import MapGL, { Layer, type MapRef, Source } from "react-map-gl/maplibre";
import { toast } from "react-toastify";

import { lastKnownPosition } from "@/lib/context";
import { baseTileLayer, thunderforestApiKey } from "@/lib/context";
import {
    allowedTransit,
    satelliteView,
    TRANSIT_ICONS,
    type TransitMode,
} from "@/lib/gameSetup";
import { buildStyle } from "@/lib/mapStyle";
import { resolvedTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import {
    fetchTransitRouteDetail,
    findTransitRoutesNear,
    type TransitRouteSummary,
} from "@/maps/api/overpass";
import type { MatchingQuestion } from "@/maps/schema";

/**
 * v966: the seeker's route picker for the `same-train-line` matching question.
 * Per the rulebook the answer is "yes if the transit the seekers are currently
 * riding would stop at the hider's station" — the app can't detect what you're
 * riding, so the SEEKER picks it. This lists the transit routes near the
 * seeker's live GPS (filtered to the game's allowed transit modes); picking one
 * fetches its stops + line geometry and bakes them onto the question
 * (`data.transitRoute`), which drives the elimination + the hider's auto-grade.
 * Read-only once the question is sent.
 */

/** Map the game's allowed transit modes → the OSM `route` tag values to query. */
function osmRouteModes(allowed: TransitMode[]): string[] {
    const set = new Set<string>();
    for (const m of allowed) {
        if (m === "subway") set.add("subway"), set.add("monorail");
        else if (m === "train") set.add("train");
        else if (m === "tram") set.add("tram"), set.add("light_rail");
        else if (m === "bus") set.add("bus");
        else if (m === "ferry") set.add("ferry");
    }
    if (set.size === 0) {
        // No modes configured — offer the rail-based set so the picker isn't
        // empty (walking-only games can't meaningfully ask this anyway).
        ["subway", "train", "light_rail", "tram", "monorail"].forEach((m) =>
            set.add(m),
        );
    }
    return [...set];
}

/** The transit mode-icon that best matches an OSM `route` value. */
function modeIcon(mode: string) {
    if (mode === "subway" || mode === "monorail") return TRANSIT_ICONS.subway;
    if (mode === "tram" || mode === "light_rail") return TRANSIT_ICONS.tram;
    if (mode === "ferry") return TRANSIT_ICONS.ferry;
    if (mode === "bus") return TRANSIT_ICONS.bus;
    return TRANSIT_ICONS.train;
}

export function TransitRoutePicker({
    data,
    onChange,
    disabled = false,
}: {
    data: MatchingQuestion;
    onChange: () => void;
    disabled?: boolean;
}) {
    const $allowed = useStore(allowedTransit);
    const $gps = useStore(lastKnownPosition);

    const [routes, setRoutes] = useState<TransitRouteSummary[] | null>(null);
    const [loadingList, setLoadingList] = useState(false);
    const [pickingId, setPickingId] = useState<string | null>(null);

    const picked = data.transitRoute ?? null;

    const loadRoutes = async () => {
        const pos = $gps ?? lastKnownPosition.get();
        if (!pos) {
            toast.error("Waiting for your location to find nearby routes.");
            return;
        }
        setLoadingList(true);
        try {
            const found = await findTransitRoutesNear(
                pos.lat,
                pos.lng,
                osmRouteModes($allowed),
            );
            setRoutes(found);
            if (found.length === 0)
                toast.info(
                    "No transit routes found near you — move onto the line you're riding and refresh.",
                );
        } catch {
            toast.error("Couldn't load nearby routes. Try again.");
        } finally {
            setLoadingList(false);
        }
    };

    // Load once on first mount (editable path only), when a GPS fix exists.
    const loadedRef = useRef(false);
    useEffect(() => {
        if (disabled || picked || loadedRef.current) return;
        const pos = $gps ?? lastKnownPosition.get();
        if (!pos) return;
        loadedRef.current = true;
        void loadRoutes();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [$gps, disabled, picked]);

    const pick = async (route: TransitRouteSummary) => {
        setPickingId(route.id);
        try {
            const detail = await fetchTransitRouteDetail(route.id);
            if (detail.stops.length === 0) {
                toast.error(
                    "That route has no mapped stops — pick another, or a different line.",
                );
                return;
            }
            data.transitRoute = {
                id: route.id,
                name: route.name,
                ref: route.ref,
                mode: route.mode,
                stops: detail.stops.map((s) => ({
                    lat: s.lat,
                    lng: s.lng,
                    name: s.name,
                })),
                geometry: detail.geometry.length ? detail.geometry : undefined,
            };
            onChange();
        } catch {
            toast.error("Couldn't load that route's stops. Try again.");
        } finally {
            setPickingId(null);
        }
    };

    const clearPick = () => {
        data.transitRoute = undefined;
        onChange();
        if (!routes) void loadRoutes();
    };

    // ── Picked: show the route + its stops on a mini map ──
    if (picked) {
        return (
            <div className="space-y-2">
                <div className="flex items-center gap-2 rounded-md border-2 border-primary bg-primary/10 p-2.5">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
                        {(() => {
                            const Icon = modeIcon(picked.mode);
                            return <Icon className="h-5 w-5" />;
                        })()}
                    </span>
                    <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-semibold">
                            {picked.name}
                        </div>
                        <div className="text-xs text-muted-foreground">
                            {picked.stops.length} stops · you're riding this
                        </div>
                    </div>
                    {!disabled && (
                        <button
                            type="button"
                            onClick={clearPick}
                            className="shrink-0 rounded-md px-2 py-1 text-xs font-semibold text-primary hover:bg-primary/15"
                        >
                            Change
                        </button>
                    )}
                </div>
                <RoutePreviewMap
                    geometry={picked.geometry}
                    stops={picked.stops}
                    className="h-52 w-full"
                />
                <p className="text-[11px] leading-snug text-muted-foreground">
                    The hider answers &quot;yes&quot; if their station is one of
                    these stops.
                </p>
            </div>
        );
    }

    // ── Not picked yet: the route list ──
    return (
        <div className="space-y-2">
            <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">
                    Pick the transit line you&apos;re riding right now:
                </p>
                <button
                    type="button"
                    onClick={() => void loadRoutes()}
                    disabled={loadingList}
                    className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold text-primary hover:bg-primary/10 disabled:opacity-50"
                >
                    {loadingList ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                        <RefreshCw className="h-3.5 w-3.5" />
                    )}
                    Refresh
                </button>
            </div>
            {loadingList && routes === null ? (
                <div className="flex items-center justify-center gap-2 rounded-md border border-dashed border-border/60 py-8 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Finding routes near you…
                </div>
            ) : routes && routes.length > 0 ? (
                <div className="max-h-64 space-y-1.5 overflow-y-auto pr-1">
                    {routes.map((r) => {
                        const Icon = modeIcon(r.mode);
                        const busy = pickingId === r.id;
                        return (
                            <button
                                key={r.id}
                                type="button"
                                onClick={() => void pick(r)}
                                disabled={pickingId !== null}
                                className={cn(
                                    "flex w-full items-center gap-2.5 rounded-md border-2 border-border bg-secondary p-2.5 text-left transition-all",
                                    "hover:bg-accent active:scale-[0.99] disabled:opacity-60",
                                )}
                            >
                                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-background/70 text-muted-foreground">
                                    <Icon className="h-5 w-5" />
                                </span>
                                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                                    {r.name}
                                </span>
                                {busy && (
                                    <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
                                )}
                            </button>
                        );
                    })}
                </div>
            ) : (
                <div className="flex flex-col items-center gap-1 rounded-md border border-dashed border-border/60 py-6 text-center text-sm text-muted-foreground">
                    <Train className="h-5 w-5" />
                    <span>No routes found near you.</span>
                    <span className="text-xs">
                        Board the line you&apos;re riding, then Refresh.
                    </span>
                </div>
            )}
        </div>
    );
}

/** Non-interactive mini map: the route line + its stops, framed to the line. */
function RoutePreviewMap({
    geometry,
    stops,
    className,
}: {
    geometry?: number[][];
    stops: { lat: number; lng: number; name?: string }[];
    className?: string;
}) {
    const $theme = useStore(resolvedTheme);
    const $tileKey = useStore(baseTileLayer);
    const $satellite = useStore(satelliteView);
    const $tfKey = useStore(thunderforestApiKey);
    const mapRef = useRef<MapRef | null>(null);

    const lineFC = useMemo(() => {
        if (!geometry || geometry.length < 2) return null;
        return {
            type: "Feature" as const,
            geometry: { type: "LineString" as const, coordinates: geometry },
            properties: {},
        };
    }, [geometry]);
    const stopsFC = useMemo(
        () => ({
            type: "FeatureCollection" as const,
            features: stops.map((s) => ({
                type: "Feature" as const,
                geometry: {
                    type: "Point" as const,
                    coordinates: [s.lng, s.lat],
                },
                properties: {},
            })),
        }),
        [stops],
    );

    const mapStyle = useMemo(
        () =>
            buildStyle(
                $tileKey,
                $satellite,
                $tfKey,
                $theme === "dark" ? "dark" : "light",
            ),
        [$tileKey, $satellite, $tfKey, $theme],
    );

    const fit = () => {
        const map = mapRef.current?.getMap();
        if (!map) return;
        try {
            const fc = lineFC
                ? { type: "FeatureCollection", features: [lineFC] }
                : stopsFC;
            if (
                (fc as { features: unknown[] }).features.length === 0 &&
                !lineFC
            )
                return;
            const [minX, minY, maxX, maxY] = turfBbox(
                lineFC
                    ? (lineFC as never)
                    : (stopsFC as never),
            );
            if (![minX, minY, maxX, maxY].every(Number.isFinite)) return;
            map.fitBounds(
                [
                    [minX, minY],
                    [maxX, maxY],
                ],
                { padding: 28, duration: 0, maxZoom: 15 },
            );
        } catch {
            /* keep the default view */
        }
    };

    const center = stops[0] ?? { lat: 0, lng: 0 };

    return (
        <div
            className={cn(
                "relative overflow-hidden rounded-lg border",
                className,
            )}
        >
            <MapGL
                ref={mapRef}
                initialViewState={{
                    longitude: center.lng,
                    latitude: center.lat,
                    zoom: 11,
                }}
                mapStyle={mapStyle}
                interactive={false}
                attributionControl={false}
                onLoad={fit}
                style={{ width: "100%", height: "100%" }}
            >
                {lineFC && (
                    <Source id="route-line-src" type="geojson" data={lineFC}>
                        <Layer
                            id="route-line-casing"
                            type="line"
                            layout={{ "line-cap": "round", "line-join": "round" }}
                            paint={{
                                "line-color": "#ffffff",
                                "line-width": 6,
                                "line-opacity": 0.7,
                            }}
                        />
                        <Layer
                            id="route-line-core"
                            type="line"
                            layout={{ "line-cap": "round", "line-join": "round" }}
                            paint={{
                                "line-color": "hsl(266,60%,45%)",
                                "line-width": 3,
                            }}
                        />
                    </Source>
                )}
                <Source id="route-stops-src" type="geojson" data={stopsFC}>
                    <Layer
                        id="route-stops"
                        type="circle"
                        paint={{
                            "circle-radius": 4,
                            "circle-color": "#ffffff",
                            "circle-stroke-color": "hsl(266,60%,40%)",
                            "circle-stroke-width": 2,
                        }}
                    />
                </Source>
            </MapGL>
        </div>
    );
}

export default TransitRoutePicker;
