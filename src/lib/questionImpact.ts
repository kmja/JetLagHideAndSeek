/**
 * useQuestionImpact — computes the geographic "what would this answer
 * tell us" overlay for matching / measuring / tentacles questions, as
 * plain GeoJSON. Rendered onto the EXISTING question-dialog map
 * (InlineLocationPicker), not a separate mini-map.
 *
 *   - Matching: Voronoi cell of the seeker's nearest X = the "yes,
 *     same nearest" region; the rest of the play area = "no". Plus
 *     every other instance of X so the seeker can read density.
 *   - Measuring: perpendicular bisector between the seeker and their
 *     nearest X. "closer" half vs "further" half.
 *   - Tentacles: the reach circle + every candidate inside it.
 *
 * Pure geometry on the prefetched feature cache (playAreaPrefetch) —
 * no extra Overpass round-trips beyond the nearest-reference text
 * preview that's already on screen.
 */

import { useStore } from "@nanostores/react";
import * as turf from "@turf/turf";
import type {
    Feature,
    FeatureCollection,
    MultiPolygon,
    Polygon,
} from "geojson";
import { useEffect, useMemo, useState } from "react";

import { mapGeoJSON, polyGeoJSON } from "@/lib/context";
import { LOCATION_FIRST_TAG } from "@/maps/api";
import {
    type FamilyKey,
    getCachedCategory,
    prefetchCategory,
} from "@/maps/api/playAreaPrefetch";
import { MAJOR_CITIES } from "@/maps/data/majorCities";
import type { APILocations } from "@/maps/schema";

export type ImpactMode = "matching" | "measuring" | "tentacles";

export interface QuestionImpact {
    /** "yes" region — matching: same nearest; measuring: closer. */
    yes?: Feature<Polygon | MultiPolygon>;
    /** "no" region — matching: different nearest; measuring: further. */
    no?: Feature<Polygon | MultiPolygon>;
    /** All candidate instances of the subtype, as plotted dots. */
    candidates: Array<{ lat: number; lng: number; name: string }>;
    /** Tentacle reach circle (tentacles mode only). */
    reachCircle?: Feature<Polygon>;
    /** Seeker's nearest candidate (matching/measuring). */
    nearest: { lat: number; lng: number; name: string } | null;
    /** True while the candidate set is still being fetched. */
    loading: boolean;
}

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
    if (stripped in LOCATION_FIRST_TAG) {
        const loc = stripped as APILocations;
        return { kind: "api", family: `api:${loc}`, location: loc };
    }
    return null;
}

function usePlayAreaPolygon(): Feature<Polygon | MultiPolygon> | null {
    const $mapGeoJSON = useStore(mapGeoJSON);
    const $polyGeoJSON = useStore(polyGeoJSON);
    return useMemo(() => {
        const fc = ($mapGeoJSON ?? $polyGeoJSON) as FeatureCollection | null;
        if (!fc || !fc.features?.length) return null;
        const f = fc.features[0];
        const g = f?.geometry;
        if (!g || (g.type !== "Polygon" && g.type !== "MultiPolygon")) {
            return null;
        }
        return f as Feature<Polygon | MultiPolygon>;
    }, [$mapGeoJSON, $polyGeoJSON]);
}

/** Voronoi cell around the seeker's nearest candidate, clipped to the
 *  play area. Null when math fails (caller falls back to dots only). */
function voronoiCellAroundMe(
    nearest: { lat: number; lng: number },
    allPoints: Array<{ lat: number; lng: number }>,
    playArea: Feature<Polygon | MultiPolygon>,
): Feature<Polygon | MultiPolygon> | null {
    if (allPoints.length < 2) return null;
    try {
        const playBbox = turf.bbox(playArea) as [
            number,
            number,
            number,
            number,
        ];
        const pad = 0.5;
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
        if (!cells?.features?.length) return null;
        const idx = allPoints.findIndex(
            (p) => p.lat === nearest.lat && p.lng === nearest.lng,
        );
        const cell = idx >= 0 ? cells.features[idx] : null;
        if (!cell?.geometry) return null;
        try {
            const clipped = turf.intersect(
                turf.featureCollection([cell as any, playArea as any]),
            );
            return (clipped as Feature<Polygon | MultiPolygon>) ?? null;
        } catch {
            return cell as unknown as Feature<Polygon | MultiPolygon>;
        }
    } catch (e) {
        console.warn("[questionImpact] voronoi failed:", e);
        return null;
    }
}

/** Half-plane on the "closer to ref" side of the perpendicular
 *  bisector between me and ref, clipped to the play area. */
function closerHalfPlane(
    me: { lat: number; lng: number },
    ref: { lat: number; lng: number },
    playArea: Feature<Polygon | MultiPolygon>,
): Feature<Polygon | MultiPolygon> | null {
    try {
        const midLng = (me.lng + ref.lng) / 2;
        const midLat = (me.lat + ref.lat) / 2;
        const dx = ref.lng - me.lng;
        const dy = ref.lat - me.lat;
        const len = Math.hypot(dx, dy) || 1;
        const px = -dy / len;
        const py = dx / len;
        const sideDx = dx / len;
        const sideDy = dy / len;
        const BIG = 10;
        const a: [number, number] = [midLng + px * BIG, midLat + py * BIG];
        const b: [number, number] = [midLng - px * BIG, midLat - py * BIG];
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
        console.warn("[questionImpact] halfPlane failed:", e);
        return null;
    }
}

export function useQuestionImpact(
    lat: number,
    lng: number,
    type: string,
    mode: ImpactMode,
    tentacleRadiusKm?: number,
): QuestionImpact | null {
    const family = useMemo(() => resolveFamily(type), [type]);
    const playArea = usePlayAreaPolygon();
    const [tick, setTick] = useState(0);

    // Warm the family cache if it isn't already (point families only;
    // city + coastline are bundled / line-shaped).
    useEffect(() => {
        if (!family || family.kind === "city" || family.kind === "coastline") {
            return;
        }
        if (getCachedCategory(family.family) !== null) return;
        void prefetchCategory(family.family).then(() => setTick((t) => t + 1));
    }, [family?.kind, (family as any)?.family]);

    return useMemo(() => {
        if (!family || !playArea) return null;
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        // Coastline / line-shaped references aren't a point set — the
        // impact regions need a different (contour) approach we haven't
        // built yet, so bail and let the text preview carry it.
        if (family.kind === "coastline") return null;

        const rawCandidates: Array<{ lat: number; lng: number; name: string }> =
            family.kind === "city"
                ? MAJOR_CITIES.map(([name, la, ln]) => ({
                      name,
                      lat: la,
                      lng: ln,
                  }))
                : (getCachedCategory(family.family) ?? []).map((f) => ({
                      lat: f.lat,
                      lng: f.lng,
                      name: f.name,
                  }));
        // v371: rulebook p17 — restrict candidates to features inside
        // the play-area polygon. The reference cache is keyed on a
        // 50 km PADDED bbox so feature warming is reusable across edits;
        // the picker's candidate dots were inheriting that pad and
        // showing dozens of out-of-bounds museums/parks/etc. polyGeoJSON
        // is the union of primary + every adjacent area (assembled by
        // determineMapBoundaries), so this single filter handles both
        // single-area and multi-area play areas. Falls through to the
        // unfiltered list while the polygon is still loading (matches
        // the v369 graceful-degrade in nearestFromCache).
        const candidates =
            playArea && family.kind !== "city"
                ? rawCandidates.filter((c) =>
                      turf.booleanPointInPolygon(
                          turf.point([c.lng, c.lat]),
                          playArea as never,
                      ),
                  )
                : rawCandidates;
        const loading =
            family.kind !== "city" &&
            getCachedCategory(family.family) === null;

        // Nearest candidate (matching / measuring).
        let nearest: { lat: number; lng: number; name: string } | null = null;
        if (mode !== "tentacles" && candidates.length) {
            const me = turf.point([lng, lat]);
            let bestKm = Infinity;
            for (const c of candidates) {
                const d = turf.distance(me, turf.point([c.lng, c.lat]), {
                    units: "kilometers",
                });
                if (d < bestKm) {
                    bestKm = d;
                    nearest = c;
                }
            }
        }

        const out: QuestionImpact = { candidates, nearest, loading };

        if (mode === "matching" && nearest) {
            const cell = voronoiCellAroundMe(nearest, candidates, playArea);
            if (cell) {
                out.yes = cell;
                try {
                    const rest = turf.difference(
                        turf.featureCollection([playArea as any, cell as any]),
                    );
                    if (rest)
                        out.no = rest as Feature<Polygon | MultiPolygon>;
                } catch {
                    /* keep yes only */
                }
            }
        } else if (mode === "measuring" && nearest) {
            const closer = closerHalfPlane({ lat, lng }, nearest, playArea);
            if (closer) {
                out.yes = closer;
                try {
                    const further = turf.difference(
                        turf.featureCollection([
                            playArea as any,
                            closer as any,
                        ]),
                    );
                    if (further)
                        out.no = further as Feature<Polygon | MultiPolygon>;
                } catch {
                    /* keep yes only */
                }
            }
        } else if (mode === "tentacles" && tentacleRadiusKm) {
            try {
                out.reachCircle = turf.circle([lng, lat], tentacleRadiusKm, {
                    units: "kilometers",
                    steps: 64,
                }) as Feature<Polygon>;
            } catch {
                /* no circle */
            }
        }

        return out;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        family?.kind,
        (family as any)?.family,
        playArea,
        lat,
        lng,
        mode,
        tentacleRadiusKm,
        tick,
    ]);
}
