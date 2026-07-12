/**
 * useQuestionImpact — computes the geographic "what would this answer
 * tell us" overlay for matching / measuring / tentacles questions, as
 * plain GeoJSON. Rendered onto the EXISTING question-dialog map
 * (InlineLocationPicker), not a separate mini-map.
 *
 *   - Matching: Voronoi cell of the seeker's nearest X = the "yes,
 *     same nearest" region; the rest of the play area = "no". Plus
 *     every other instance of X so the seeker can read density.
 *   - Measuring: the real elimination geometry — a geodesic union of
 *     circles (radius = seeker's distance to nearest X) around every
 *     candidate, i.e. "everywhere whose nearest X is no further than
 *     mine" = the "closer" region; the rest of the play area = "further".
 *     A perpendicular-bisector half-plane is used only as an instant
 *     fallback while that async buffer resolves.
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

import {
    mapGeoJSON,
    polyGeoJSON,
    questionFinishedMapData,
} from "@/lib/context";
import { LOCATION_FIRST_TAG } from "@/maps/api";
import { measuringDraftBuffer } from "@/maps/questions/measuring";
import { arcBufferToPoint } from "@/maps/geo-utils";
import { pointInPlayArea } from "@/maps/geo-utils/playAreaIndex";
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
    | { kind: "water"; family: FamilyKey }
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
    // Named water bodies — a point family (centroids from the prewarm
    // cache) for the preview/impact. The real measuring elimination uses
    // full geometry (measuring.ts), so this is an approximation.
    if (stripped === "body-of-water")
        return { kind: "water", family: "body-of-water" };
    if (stripped in LOCATION_FIRST_TAG) {
        const loc = stripped as APILocations;
        return { kind: "api", family: `api:${loc}`, location: loc };
    }
    return null;
}

function usePlayAreaPolygon(): Feature<Polygon | MultiPolygon> | null {
    // Prefer the REMAINING area (play area minus everything already
    // eliminated by answered questions) so the closer/further (and
    // matching same/different) impact regions don't extend into parts of
    // the map that are already ruled out — the preview then matches the
    // big map. Falls back to the full play area before any elimination
    // has run / while it's still computing.
    const $maskData = useStore(questionFinishedMapData);
    const $mapGeoJSON = useStore(mapGeoJSON);
    const $polyGeoJSON = useStore(polyGeoJSON);
    return useMemo(() => {
        const src = ($maskData ?? $mapGeoJSON ?? $polyGeoJSON) as
            | Feature
            | FeatureCollection
            | null;
        return toSinglePolygon(src);
    }, [$maskData, $mapGeoJSON, $polyGeoJSON]);
}

/** Collapse a Feature / FeatureCollection to ONE polygon feature
 *  (unioning the parts of a multi-feature remaining area). */
function toSinglePolygon(
    src: Feature | FeatureCollection | null,
): Feature<Polygon | MultiPolygon> | null {
    if (!src) return null;
    if (src.type === "Feature") {
        const g = src.geometry;
        if (g && (g.type === "Polygon" || g.type === "MultiPolygon")) {
            return src as Feature<Polygon | MultiPolygon>;
        }
        return null;
    }
    if (src.type === "FeatureCollection") {
        const polys = src.features.filter(
            (f) =>
                f.geometry &&
                (f.geometry.type === "Polygon" ||
                    f.geometry.type === "MultiPolygon"),
        ) as Feature<Polygon | MultiPolygon>[];
        if (polys.length === 0) return null;
        if (polys.length === 1) return polys[0];
        try {
            return (
                (turf.union(
                    turf.featureCollection(polys as never),
                ) as Feature<Polygon | MultiPolygon>) ?? polys[0]
            );
        } catch {
            return polys[0];
        }
    }
    return null;
}

/** Voronoi cell of the "same nearest candidate as me" region, clipped to
 *  the play area. Null when math fails (caller falls back to dots only).
 *
 *  Selects the cell that CONTAINS the seeker's own point rather than the
 *  cell indexed by the geodesic-nearest candidate: `nearest` is picked by
 *  great-circle distance (`turf.distance`), but `turf.voronoi` partitions
 *  in PLANAR lng/lat space. Near a cell border — or at higher latitudes
 *  where a degree of longitude is much shorter than a degree of latitude —
 *  those disagree, so the geodesic-nearest's planar cell can EXCLUDE the
 *  seeker, painting the seeker's own position into the "not matching"
 *  region (impossible — your nearest X is trivially your nearest X). Using
 *  the containing cell makes the "same nearest" region always include the
 *  seeker. Falls back to the geodesic-nearest cell if no cell contains the
 *  seeker (degenerate Voronoi). */
function voronoiCellAroundMe(
    me: { lat: number; lng: number },
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
        const mePt = turf.point([me.lng, me.lat]);
        let cell: (typeof cells.features)[number] | null = null;
        for (const f of cells.features) {
            if (!f?.geometry) continue;
            try {
                if (turf.booleanPointInPolygon(mePt, f as any)) {
                    cell = f;
                    break;
                }
            } catch {
                /* skip malformed cell */
            }
        }
        // Fallback: no cell contained the seeker (degenerate tiling) — use
        // the geodesic-nearest candidate's cell so we still show something.
        if (!cell?.geometry) {
            const idx = allPoints.findIndex(
                (p) => p.lat === nearest.lat && p.lng === nearest.lng,
            );
            cell = idx >= 0 ? (cells.features[idx] ?? null) : null;
        }
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

    // Real measuring-elimination preview. The measuring cut is NOT a flat
    // perpendicular-bisector half-plane — that was only ever correct for a
    // single reference point. The actual elimination (adjustPerMeasuring →
    // bufferedDeterminer → arcBufferToPoint) buffers EVERY candidate by the
    // seeker's geodesic distance to the nearest one and unions the result:
    // "every place whose nearest X is no further than mine". We run the
    // exact same operator here so the green "closer" region the seeker sees
    // while configuring matches what the answer will actually carve out.
    //
    // Async (lazy @arcgis/core) so it lands a beat after the instant
    // half-plane fallback below. Point families only: `city` is a worldwide
    // set (a live geodesic union on every pin move would jank) and
    // `coastline` is a contour, not a point buffer — both keep the light
    // path. Only ever active while configuring a draft (impactMode is unset
    // on answered cards), so at most one of these runs at a time.
    const [measuring, setMeasuring] = useState<{
        family: string;
        lat: number;
        lng: number;
        yes: Feature<Polygon | MultiPolygon> | null;
        no: Feature<Polygon | MultiPolygon> | null;
    } | null>(null);
    useEffect(() => {
        if (mode !== "measuring") return;
        if (!family || family.kind === "city" || family.kind === "coastline") {
            return;
        }
        if (!playArea) return;
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
        let cancelled = false;
        // v688: body-of-water is NOT a point family — its references are
        // lake/reservoir shores AND river/canal lines. Buffering the
        // `natural=water` CENTROID cache (as the point path below does)
        // ignored rivers and measured lakes from their middle, so the
        // overlay marked areas far from any shore as "closer" and
        // disagreed with the real cut. For water we compute the SAME buffer
        // the elimination uses (full `out geom` geometry); every other
        // measuring family is a genuine point set, so the centroid buffer
        // is exact there.
        const bufferPromise =
            family.kind === "water"
                ? measuringDraftBuffer("body-of-water", lat, lng)
                : (() => {
                      const cached = getCachedCategory(family.family);
                      if (!cached || cached.length === 0) return null;
                      const pts = turf.featureCollection(
                          cached.map((f) => turf.point([f.lng, f.lat])),
                      );
                      return arcBufferToPoint(pts, lat, lng);
                  })();
        if (!bufferPromise) return;
        Promise.resolve(bufferPromise)
            .then((buffer) => {
                if (cancelled || !buffer) return;
                let yes: Feature<Polygon | MultiPolygon> | null = null;
                let no: Feature<Polygon | MultiPolygon> | null = null;
                try {
                    yes = turf.intersect(
                        turf.featureCollection([
                            buffer as any,
                            playArea as any,
                        ]),
                    ) as Feature<Polygon | MultiPolygon> | null;
                } catch {
                    /* keep null — caller falls back to half-plane */
                }
                try {
                    no = turf.difference(
                        turf.featureCollection([
                            playArea as any,
                            buffer as any,
                        ]),
                    ) as Feature<Polygon | MultiPolygon> | null;
                } catch {
                    /* keep null */
                }
                setMeasuring({ family: family.family, lat, lng, yes, no });
            })
            .catch(() => {
                /* leave the half-plane fallback in place */
            });
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mode, family?.kind, (family as any)?.family, playArea, lat, lng, tick]);

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
                      pointInPlayArea(playArea, c.lng, c.lat),
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
            const cell = voronoiCellAroundMe(
                { lat, lng },
                nearest,
                candidates,
                playArea,
            );
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
        } else if (mode === "measuring") {
            // Prefer the real geodesic region computed by the effect above
            // (matches the actual elimination). It's only valid for the
            // current family + seeker position; while it's still resolving
            // (or unavailable) we draw the cheap perpendicular-bisector
            // half-plane so the seeker always has immediate feedback. The
            // half-plane needs a nearest POINT, so it only applies to point
            // families with a resolved `nearest`; water renders solely from
            // the real full-geometry buffer (its "nearest" is a line/shore,
            // not a centroid — v688).
            const real =
                measuring &&
                family.kind !== "city" &&
                measuring.family === (family as { family?: string }).family &&
                measuring.lat === lat &&
                measuring.lng === lng &&
                (measuring.yes || measuring.no)
                    ? measuring
                    : null;
            if (real) {
                out.yes = real.yes ?? undefined;
                out.no = real.no ?? undefined;
            } else if (nearest) {
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
                            out.no =
                                further as Feature<Polygon | MultiPolygon>;
                    } catch {
                        /* keep yes only */
                    }
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
        measuring,
    ]);
}
