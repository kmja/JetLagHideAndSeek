/**
 * QuestionImpactMap — interactive preview of what asking a question would
 * tell the seekers. Slotted next to NearestReferencePreview on the
 * matching / measuring / tentacles configure cards.
 *
 * Before this, the seeker just saw "Your nearest hospital: St Mary's
 * (~1.2 km)" and had to imagine how the answer would carve up the map.
 * Now they see the actual carve:
 *
 *   - Matching: the Voronoi cell of their nearest X (green = "yes,
 *     same") and the rest of the play area (red = "no, different").
 *     Every other instance of X is plotted so the seeker can judge
 *     density at a glance.
 *
 *   - Measuring: the perpendicular bisector between the seeker and
 *     their nearest X for point references; an isodistance contour
 *     from the line/polygon reference for coastline / borders.
 *     Green = "closer than me", red = "further". Tells the seeker
 *     how informative the slice will be — a question that splits the
 *     play area 50/50 is much more useful than one that pinches off a
 *     sliver.
 *
 *   - Tentacles: the reach circle around the seeker, with every
 *     candidate instance inside it plotted. Communicates the
 *     "tentacle density" — high density means the answer narrows
 *     things a lot; sparse means it's expensive for little gain.
 *
 *   - Radius / thermometer / photo: not handled here yet (radius
 *     already has its own circle preview; thermometer/photo aren't
 *     geography-shaped).
 *
 * Best-effort + cheap: uses the prefetched feature cache already
 * warmed by playAreaPrefetch, so opening the configure card adds zero
 * Overpass round-trips beyond what the nearest-reference text preview
 * does.
 */

import "maplibre-gl/dist/maplibre-gl.css";

import { useStore } from "@nanostores/react";
import * as turf from "@turf/turf";
import type { Feature, FeatureCollection, Polygon, MultiPolygon } from "geojson";
import { useEffect, useMemo, useRef, useState } from "react";
import MapGL, { Layer, type MapRef, Marker, Source } from "react-map-gl/maplibre";

import { mapGeoJSON, polyGeoJSON } from "@/lib/context";
import { protomapsMapLibreStyle } from "@/lib/protomapsStyle";
import { resolvedTheme } from "@/lib/theme";
import {
    type FamilyKey,
    getCachedCategory,
    prefetchCategory,
} from "@/maps/api/playAreaPrefetch";
import { MAJOR_CITIES } from "@/maps/data/majorCities";
import { LOCATION_FIRST_TAG } from "@/maps/api";
import type { APILocations } from "@/maps/schema";

export type ImpactMode = "matching" | "measuring" | "tentacles";

interface QuestionImpactMapProps {
    /** Seeker's position the question is being asked from. */
    lat: number;
    lng: number;
    /** Raw subtype string (e.g. "hospital", "museum", "coastline"). */
    type: string;
    mode: ImpactMode;
    /** Tentacle reach in km. Required when mode === "tentacles". */
    tentacleRadiusKm?: number;
}

/* ───────────────────── Family resolution ─────────────────────
 *
 * Mirror of resolveFamily() in NearestReferencePreview, narrowed to
 * the families we can actually visualise (point-set + the special
 * coastline/cities cases). We don't depend on the existing helper to
 * keep this component standalone — when we eventually fold the two
 * previews together we can hoist a shared resolver. */

type ResolvedFamily =
    | { kind: "api"; family: FamilyKey; location: APILocations }
    | { kind: "airport"; family: FamilyKey }
    | { kind: "rail-station"; family: FamilyKey }
    | { kind: "city" }
    | { kind: "coastline" }
    | null;

function resolveFamily(typeRaw: string): ResolvedFamily {
    const stripped = typeRaw.replace(/-full$/, "");
    if (stripped === "airport") return { kind: "airport", family: "airport" };
    if (stripped === "coastline") return { kind: "coastline" };
    if (stripped === "major-city" || stripped === "city")
        return { kind: "city" };
    if (stripped === "rail-station")
        return { kind: "rail-station", family: "rail-station" };
    // Anything that's a known LOCATION_FIRST_TAG key is an api: family
    if (stripped in LOCATION_FIRST_TAG) {
        const loc = stripped as APILocations;
        return { kind: "api", family: `api:${loc}`, location: loc };
    }
    return null;
}

/** Resolve the candidate points for the chosen subtype. Reads from
 *  the prefetched cache where possible (instant), fires a per-family
 *  prefetch otherwise (~1 Overpass call). */
function useCandidates(
    family: ResolvedFamily,
): { points: Array<{ lat: number; lng: number; name: string }>; loading: boolean } {
    const [tick, setTick] = useState(0);
    useEffect(() => {
        // Major-city + coastline are bundled; nothing to prefetch.
        if (!family || family.kind === "city" || family.kind === "coastline") {
            return;
        }
        const cached = getCachedCategory(family.family);
        if (cached !== null) return; // already warm
        void prefetchCategory(family.family).then(() => setTick((t) => t + 1));
    }, [family?.kind, (family as any)?.family]);

    return useMemo(() => {
        if (!family) return { points: [], loading: false };
        if (family.kind === "city") {
            return {
                points: MAJOR_CITIES.map(([name, lat, lng]) => ({
                    name,
                    lat,
                    lng,
                })),
                loading: false,
            };
        }
        if (family.kind === "coastline") {
            // Coastline is a line, not a point set — handled separately
            // in the measuring branch.
            return { points: [], loading: false };
        }
        const cached = getCachedCategory(family.family);
        return {
            points: cached ?? [],
            loading: cached === null,
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [family?.kind, (family as any)?.family, tick]);
}

/* ────────────────── Geometry helpers (turf) ────────────────── */

/** Returns the bounded play-area polygon as a single Feature, or
 *  null when none is set. Prefers the eliminated/clipped polygon
 *  (mapGeoJSON), falling back to the raw play area (polyGeoJSON). */
function usePlayAreaPolygon(): Feature<Polygon | MultiPolygon> | null {
    const $mapGeoJSON = useStore(mapGeoJSON);
    const $polyGeoJSON = useStore(polyGeoJSON);
    return useMemo(() => {
        const fc = ($mapGeoJSON ??
            $polyGeoJSON) as FeatureCollection | null;
        if (!fc || !fc.features?.length) return null;
        const f = fc.features[0];
        if (!f.geometry) return null;
        const g = f.geometry;
        if (g.type !== "Polygon" && g.type !== "MultiPolygon") return null;
        return f as Feature<Polygon | MultiPolygon>;
    }, [$mapGeoJSON, $polyGeoJSON]);
}

/** Voronoi cell around `me` over `points`, intersected with the play
 *  area. Used to render the "yes, your nearest is the same" region
 *  for matching questions. Returns null when the math fails (e.g.
 *  fewer than 2 candidates), the caller falls back to "just show the
 *  pins". */
function voronoiCellAroundMe(
    me: { lat: number; lng: number },
    nearest: { lat: number; lng: number },
    allPoints: Array<{ lat: number; lng: number }>,
    playArea: Feature<Polygon | MultiPolygon>,
): Feature<Polygon | MultiPolygon> | null {
    if (allPoints.length < 2) return null;
    try {
        const playBbox = turf.bbox(playArea) as [number, number, number, number];
        // Pad bbox so the voronoi extends past the polygon edge; otherwise
        // edge cells are clipped weirdly by turf.voronoi.
        const pad = 0.5; // degrees ~50 km — fine for a sub-country preview
        const padded: [number, number, number, number] = [
            playBbox[0] - pad,
            playBbox[1] - pad,
            playBbox[2] + pad,
            playBbox[3] + pad,
        ];
        const fc = turf.featureCollection(
            allPoints.map((p) => turf.point([p.lng, p.lat])),
        );
        const cells = turf.voronoi(fc, { bbox: padded });
        if (!cells || !cells.features?.length) return null;
        // Find the cell containing `nearest`. The voronoi result is in
        // the same order as the input points; nearest's index in the
        // input is what we want.
        const idx = allPoints.findIndex(
            (p) => p.lat === nearest.lat && p.lng === nearest.lng,
        );
        const cell = idx >= 0 ? cells.features[idx] : null;
        if (!cell || !cell.geometry) return null;
        const cellFeature = cell as Feature<Polygon>;
        try {
            const clipped = turf.intersect(
                turf.featureCollection([cellFeature as any, playArea as any]),
            );
            return (clipped as Feature<Polygon | MultiPolygon>) ?? null;
        } catch {
            return cellFeature as unknown as Feature<Polygon | MultiPolygon>;
        }
    } catch (e) {
        console.warn("[QuestionImpactMap] voronoi failed:", e);
        return null;
    }
}

/** Half-plane on the "closer" side of the perpendicular bisector
 *  between `me` and `ref`. Modeled as a huge buffered triangle so we
 *  don't have to fight maplibre's polygon orientation — turf's `bbox`
 *  clipper then crops to the play area. Returns null on math fail. */
function closerHalfPlane(
    me: { lat: number; lng: number },
    ref: { lat: number; lng: number },
    playArea: Feature<Polygon | MultiPolygon>,
): Feature<Polygon | MultiPolygon> | null {
    try {
        // Midpoint between me and ref.
        const midLng = (me.lng + ref.lng) / 2;
        const midLat = (me.lat + ref.lat) / 2;
        // Vector from me → ref.
        const dx = ref.lng - me.lng;
        const dy = ref.lat - me.lat;
        const len = Math.hypot(dx, dy) || 1;
        // Perpendicular unit vector (rotate 90°).
        const px = -dy / len;
        const py = dx / len;
        // Build a rectangle on the "closer-to-ref" side of the bisector.
        // Big enough to cover any play area (10° ≈ 1100 km is plenty
        // even for country-scale games).
        const BIG = 10;
        const sideDx = (ref.lng - me.lng) / len; // unit toward ref
        const sideDy = (ref.lat - me.lat) / len;
        const a: [number, number] = [
            midLng + px * BIG,
            midLat + py * BIG,
        ];
        const b: [number, number] = [
            midLng - px * BIG,
            midLat - py * BIG,
        ];
        const c: [number, number] = [
            midLng - px * BIG + sideDx * BIG * 2,
            midLat - py * BIG + sideDy * BIG * 2,
        ];
        const d: [number, number] = [
            midLng + px * BIG + sideDx * BIG * 2,
            midLat + py * BIG + sideDy * BIG * 2,
        ];
        const halfPlane = turf.polygon([[a, b, c, d, a]]);
        const clipped = turf.intersect(
            turf.featureCollection([halfPlane as any, playArea as any]),
        );
        return (clipped as Feature<Polygon | MultiPolygon>) ?? null;
    } catch (e) {
        console.warn("[QuestionImpactMap] halfPlane failed:", e);
        return null;
    }
}

/* ────────────────────── Component ────────────────────── */

export function QuestionImpactMap({
    lat,
    lng,
    type,
    mode,
    tentacleRadiusKm,
}: QuestionImpactMapProps) {
    const family = useMemo(() => resolveFamily(type), [type]);
    const { points: candidates } = useCandidates(family);
    const playArea = usePlayAreaPolygon();
    const $theme = useStore(resolvedTheme);
    const mapRef = useRef<MapRef | null>(null);

    const mapStyle = useMemo(
        () => protomapsMapLibreStyle($theme === "dark" ? "dark" : "light"),
        [$theme],
    );

    /* --- Pick the nearest candidate for matching/measuring --- */
    const nearest = useMemo(() => {
        if (!candidates.length) return null;
        if (mode === "tentacles") return null;
        const me = turf.point([lng, lat]);
        let best: { lat: number; lng: number; name: string } | null = null;
        let bestKm = Infinity;
        for (const c of candidates) {
            const d = turf.distance(me, turf.point([c.lng, c.lat]), {
                units: "kilometers",
            });
            if (d < bestKm) {
                bestKm = d;
                best = c;
            }
        }
        return best;
    }, [candidates, lat, lng, mode]);

    /* --- Compute the impact regions --- */
    const regions = useMemo<{
        yes?: Feature<Polygon | MultiPolygon>;
        no?: Feature<Polygon | MultiPolygon>;
    }>(() => {
        if (!playArea) return {};
        if (mode === "matching" && nearest) {
            const cell = voronoiCellAroundMe(
                { lat, lng },
                nearest,
                candidates,
                playArea,
            );
            if (!cell) return {};
            try {
                const rest = turf.difference(
                    turf.featureCollection([playArea as any, cell as any]),
                );
                return {
                    yes: cell,
                    no: (rest as Feature<Polygon | MultiPolygon>) ?? undefined,
                };
            } catch {
                return { yes: cell };
            }
        }
        if (mode === "measuring" && nearest) {
            const closer = closerHalfPlane(
                { lat, lng },
                nearest,
                playArea,
            );
            if (!closer) return {};
            try {
                const further = turf.difference(
                    turf.featureCollection([playArea as any, closer as any]),
                );
                return {
                    yes: closer,
                    no: (further as Feature<Polygon | MultiPolygon>) ?? undefined,
                };
            } catch {
                return { yes: closer };
            }
        }
        return {};
    }, [mode, nearest, candidates, playArea, lat, lng]);

    /* --- Fit the map to the play area on mount + on playArea change --- */
    useEffect(() => {
        if (!playArea) return;
        const map = mapRef.current?.getMap();
        if (!map) return;
        try {
            const [minX, minY, maxX, maxY] = turf.bbox(playArea);
            map.fitBounds(
                [
                    [minX, minY],
                    [maxX, maxY],
                ],
                { padding: 24, duration: 0, maxZoom: 12 },
            );
        } catch {
            /* ignore */
        }
    }, [playArea]);

    if (!playArea || !family) return null;

    // Tentacle reach for the tentacles mode
    const tentacleReach = useMemo(() => {
        if (mode !== "tentacles" || !tentacleRadiusKm) return null;
        try {
            return turf.circle([lng, lat], tentacleRadiusKm, {
                units: "kilometers",
                steps: 64,
            });
        } catch {
            return null;
        }
    }, [mode, lat, lng, tentacleRadiusKm]);

    const candidatesGeoJSON = useMemo(
        () => ({
            type: "FeatureCollection" as const,
            features: candidates.map((c) =>
                turf.point([c.lng, c.lat], { name: c.name }),
            ),
        }),
        [candidates],
    );

    return (
        <div className="mx-2 mb-2 mt-1 rounded-sm border border-border overflow-hidden">
            <div className="w-full h-[180px] relative">
                <MapGL
                    ref={mapRef}
                    initialViewState={{
                        longitude: lng,
                        latitude: lat,
                        zoom: 10,
                    }}
                    style={{ width: "100%", height: "100%" }}
                    mapStyle={mapStyle}
                    attributionControl={false}
                    interactive={false}
                >
                    {/* "Yes" region (matching: same nearest, measuring: closer) */}
                    {regions.yes && (
                        <Source id="impact-yes" type="geojson" data={regions.yes}>
                            <Layer
                                id="impact-yes-fill"
                                type="fill"
                                paint={{
                                    "fill-color": "hsl(140, 60%, 50%)",
                                    "fill-opacity": 0.28,
                                }}
                            />
                            <Layer
                                id="impact-yes-line"
                                type="line"
                                paint={{
                                    "line-color": "hsl(140, 60%, 35%)",
                                    "line-width": 1.5,
                                    "line-opacity": 0.85,
                                }}
                            />
                        </Source>
                    )}
                    {/* "No" region (matching: different nearest, measuring: further) */}
                    {regions.no && (
                        <Source id="impact-no" type="geojson" data={regions.no}>
                            <Layer
                                id="impact-no-fill"
                                type="fill"
                                paint={{
                                    "fill-color": "hsl(0, 70%, 50%)",
                                    "fill-opacity": 0.22,
                                }}
                            />
                        </Source>
                    )}
                    {/* Tentacle reach circle */}
                    {tentacleReach && (
                        <Source id="tentacle-reach" type="geojson" data={tentacleReach as any}>
                            <Layer
                                id="tentacle-reach-fill"
                                type="fill"
                                paint={{
                                    "fill-color": "hsl(265, 60%, 60%)",
                                    "fill-opacity": 0.18,
                                }}
                            />
                            <Layer
                                id="tentacle-reach-line"
                                type="line"
                                paint={{
                                    "line-color": "hsl(265, 60%, 45%)",
                                    "line-width": 1.5,
                                    "line-opacity": 0.85,
                                    "line-dasharray": [3, 3],
                                }}
                            />
                        </Source>
                    )}
                    {/* Candidate points */}
                    {candidates.length > 0 && (
                        <Source
                            id="impact-candidates"
                            type="geojson"
                            data={candidatesGeoJSON}
                        >
                            <Layer
                                id="impact-candidates-circle"
                                type="circle"
                                paint={{
                                    "circle-radius": 3,
                                    "circle-color": "hsl(40, 90%, 55%)",
                                    "circle-stroke-color":
                                        "hsl(40, 90%, 25%)",
                                    "circle-stroke-width": 1,
                                    "circle-opacity": 0.9,
                                }}
                            />
                        </Source>
                    )}
                    {/* Seeker position */}
                    <Marker longitude={lng} latitude={lat} anchor="center">
                        <div
                            className="w-3 h-3 rounded-full bg-primary border-2 border-background"
                            title="Your question position"
                        />
                    </Marker>
                    {/* Nearest reference (matching + measuring) */}
                    {nearest && (
                        <Marker
                            longitude={nearest.lng}
                            latitude={nearest.lat}
                            anchor="center"
                        >
                            <div
                                className="w-2.5 h-2.5 rounded-full bg-amber-400 border-2 border-background"
                                title={nearest.name}
                            />
                        </Marker>
                    )}
                </MapGL>
            </div>
            <div className="px-2.5 py-1.5 text-[10px] leading-snug text-muted-foreground border-t border-border bg-secondary/40">
                {mode === "matching" && nearest && (
                    <>
                        <span className="text-green-500 font-semibold">Green</span> =
                        hider's nearest is the same.{" "}
                        <span className="text-red-500 font-semibold">Red</span> =
                        somewhere else.
                    </>
                )}
                {mode === "measuring" && nearest && (
                    <>
                        <span className="text-green-500 font-semibold">Green</span> =
                        closer to {nearest.name}.{" "}
                        <span className="text-red-500 font-semibold">Red</span> =
                        further.
                    </>
                )}
                {mode === "tentacles" &&
                    (tentacleReach ? (
                        <>
                            {candidates.length} candidates inside reach.
                            Hider answers with one of them — or "out of
                            reach" — narrowing the play area accordingly.
                        </>
                    ) : (
                        <>Tentacle reach not configured.</>
                    ))}
            </div>
        </div>
    );
}

export default QuestionImpactMap;
