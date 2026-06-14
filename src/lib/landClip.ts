import * as turf from "@turf/turf";
import type {
    Feature,
    FeatureCollection,
    MultiPolygon,
    Polygon,
} from "geojson";

import { cacheFetch } from "@/maps/api/cache";
import { CacheType } from "@/maps/api/types";

/**
 * Trim a play-area polygon to the land portion only, using the bundled
 * Natural Earth 1:50m coastline as the world's land mask.
 *
 * Why this exists: OSM admin boundaries (the source of the play-area
 * polygons) follow legal jurisdictions, not coastlines — so something
 * like Nagasaki Prefecture sweeps tens of kilometres into the ocean
 * because the prefecture's legal extent includes territorial waters.
 * Drawing that on the map makes ~50 % of the play area look like
 * playable space when in fact it's empty sea. This module clips the
 * polygon against actual land so what the seeker sees IS the playable
 * surface.
 *
 * Data source: `public/coastline50.geojson` (Natural Earth 1:50m
 * coastline). 1405 of its 1429 features are already closed loops
 * (islands + continent outlines, stored as LineStrings) — we treat
 * those as land polygons. The 24 open lines are continental fragments
 * around the antimeridian; skipped here. The dataset's ~5 km
 * resolution is plenty for "snap the polygon to the coast" — anything
 * finer wouldn't change the visible silhouette at lobby zoom.
 *
 * Performance notes:
 *   - The land FC is loaded once per session (cacheFetch +
 *     PERMANENT_CACHE), then memoized at module scope.
 *   - For each clip call, we bbox-filter the global FC (1429
 *     features) down to overlapping ones (typically 1-20) before any
 *     turf.intersect — those are the only ones that matter for the
 *     play area's region.
 *   - Each intersect is sub-second on a county-sized polygon.
 *   - Resulting clipped polygons are unioned into a single feature so
 *     downstream code (the elimination mask, the lobby preview) gets
 *     the same shape it would from a raw OSM boundary.
 */

/** Memoized land polygons. Each entry carries a precomputed bbox so
 *  the per-clip overlap filter is O(n) instead of O(n*m). */
type LandPoly = {
    feature: Feature<Polygon>;
    bbox: [number, number, number, number];
};
let landPolysPromise: Promise<LandPoly[]> | null = null;

async function loadLandPolys(): Promise<LandPoly[]> {
    if (landPolysPromise) return landPolysPromise;
    landPolysPromise = (async () => {
        const url =
            (import.meta.env.BASE_URL ?? "/") + "coastline50.geojson";
        const resp = await cacheFetch(
            url,
            undefined,
            CacheType.PERMANENT_CACHE,
        );
        const fc = (await resp.json()) as FeatureCollection;
        const out: LandPoly[] = [];
        for (const f of fc.features) {
            const g = f.geometry;
            if (!g) continue;
            if (g.type === "LineString") {
                const coords = g.coordinates;
                if (coords.length < 4) continue;
                const first = coords[0];
                const last = coords[coords.length - 1];
                if (first[0] !== last[0] || first[1] !== last[1]) {
                    // Open line — continent fragment around the
                    // antimeridian. Closing it would produce a
                    // bogus polygon, so skip.
                    continue;
                }
                // Natural Earth coastlines wind CW around land
                // (continents/islands), which is the opposite of
                // GeoJSON's outer-ring convention (CCW). Without
                // rewinding, treating the line as an outer ring
                // makes the resulting "polygon" represent the
                // OCEAN instead of the land — and Sweden ∩ ocean
                // gives back just the coastal-water bits, which
                // was the visible bug in v149. `turf.rewind` flips
                // each ring to GeoJSON convention.
                let poly: Feature<Polygon> = {
                    type: "Feature",
                    properties: {},
                    geometry: { type: "Polygon", coordinates: [coords] },
                };
                try {
                    poly = turf.rewind(poly, {
                        reverse: false,
                    }) as Feature<Polygon>;
                } catch {
                    /* malformed ring — fall through with raw orientation */
                }
                out.push({
                    feature: poly,
                    bbox: turf.bbox(poly) as [
                        number,
                        number,
                        number,
                        number,
                    ],
                });
            }
            // Natural Earth's coastline file is pure LineString;
            // no Polygon / MultiLineString cases to handle.
        }
        return out;
    })();
    return landPolysPromise;
}

function bboxesOverlap(
    a: [number, number, number, number],
    b: [number, number, number, number],
): boolean {
    return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
}

/* ───────────────────────── Inland lakes ─────────────────────────
 *
 * The coastline mask above is Natural Earth's OCEAN coastline — it
 * knows nothing about inland lakes. But OSM admin boundaries for
 * lakeside places legally include their slice of the lake (Lausanne's
 * commune extends into Lac Léman; Chicago into Lake Michigan; Geneva,
 * Zürich, Como, Constance, …), so a coastline-only clip leaves a big
 * water bite in the play area — exactly the "ocean part not trimmed"
 * the user reported for Lausanne.
 *
 * Fix: subtract major lakes too. `public/lakes50.geojson` is Natural
 * Earth 1:50m lakes, stripped to {name} + geometry and simplified to
 * ~200 m (423 KB, fetched on demand + permanently cached, same as the
 * coastline). After intersecting the boundary with land we difference
 * out any lake whose bbox overlaps it. */
type LakePoly = {
    feature: Feature<Polygon | MultiPolygon>;
    bbox: [number, number, number, number];
};
let lakePolysPromise: Promise<LakePoly[]> | null = null;

async function loadLakePolys(): Promise<LakePoly[]> {
    if (lakePolysPromise) return lakePolysPromise;
    lakePolysPromise = (async () => {
        const url = (import.meta.env.BASE_URL ?? "/") + "lakes50.geojson";
        const resp = await cacheFetch(
            url,
            undefined,
            CacheType.PERMANENT_CACHE,
        );
        const fc = (await resp.json()) as FeatureCollection;
        const out: LakePoly[] = [];
        for (const f of fc.features) {
            const g = f.geometry;
            if (
                !g ||
                (g.type !== "Polygon" && g.type !== "MultiPolygon")
            ) {
                continue;
            }
            const feature = f as Feature<Polygon | MultiPolygon>;
            try {
                out.push({
                    feature,
                    bbox: turf.bbox(feature) as [
                        number,
                        number,
                        number,
                        number,
                    ],
                });
            } catch {
                /* skip malformed lake */
            }
        }
        return out;
    })();
    return lakePolysPromise;
}

/** Subtract every overlapping lake from a (already land-clipped)
 *  feature. Best-effort: any failed difference is skipped so a single
 *  bad lake polygon can't break the clip. Returns the input unchanged
 *  when no lakes overlap or the lakes file can't be loaded. */
async function subtractLakes(
    feature: Feature<Polygon | MultiPolygon>,
): Promise<Feature<Polygon | MultiPolygon>> {
    let lakes: LakePoly[];
    try {
        lakes = await loadLakePolys();
    } catch (e) {
        console.warn("loadLakePolys failed; skipping lake subtraction", e);
        return feature;
    }
    const fBbox = turf.bbox(feature) as [number, number, number, number];
    const overlapping = lakes.filter((l) => bboxesOverlap(fBbox, l.bbox));
    if (overlapping.length === 0) return feature;
    let acc = feature;
    for (const lake of overlapping) {
        try {
            const diff = turf.difference(
                turf.featureCollection([acc, lake.feature]),
            ) as Feature<Polygon | MultiPolygon> | null;
            // `difference` returns null when the lake fully covers the
            // feature — that'd mean the whole play area is water, which
            // is never right, so keep the previous accumulator.
            if (diff && diff.geometry) acc = diff;
        } catch {
            /* skip any lake that fails the topology check */
        }
    }
    return acc;
}

/**
 * Clip a play-area polygon (Polygon or MultiPolygon) to land only.
 * Returns the clipped geometry as a Feature, or `null` if the input
 * was malformed / the clip pipeline failed (caller should treat as
 * "leave the original polygon alone"). Best-effort and safe — never
 * throws.
 */
export async function clipPolygonToLand(
    polygon: Feature<Polygon | MultiPolygon>,
): Promise<Feature<Polygon | MultiPolygon> | null> {
    try {
        const polys = await loadLandPolys();
        const playBbox = turf.bbox(polygon) as [
            number,
            number,
            number,
            number,
        ];
        const relevant = polys.filter((p) => bboxesOverlap(playBbox, p.bbox));
        if (relevant.length === 0) return null;

        const pieces: Feature<Polygon | MultiPolygon>[] = [];
        for (const land of relevant) {
            try {
                const inter = turf.intersect(
                    turf.featureCollection([polygon, land.feature]),
                ) as Feature<Polygon | MultiPolygon> | null;
                if (inter && inter.geometry) {
                    pieces.push(inter);
                }
            } catch {
                /* skip any pair that fails the topology check */
            }
        }
        if (pieces.length === 0) return null;
        let acc: Feature<Polygon | MultiPolygon>;
        if (pieces.length === 1) {
            acc = pieces[0];
        } else {
            // Drop tiny, distant fragments before unioning. An OSM
            // admin boundary like "Tokyo Metropolis" legally includes
            // the Izu and Ogasawara island chains hundreds of km
            // south of the actual city — playable in the legal sense,
            // ridiculous in the hide-and-seek sense. We keep the
            // largest piece by area and any other piece that's either
            // (a) reasonably large vs the largest (>= 10 %), or
            // (b) close to the largest (centroid within 60 km).
            // Both heuristics together preserve cases like the UK +
            // Northern Ireland (large + far is kept by area) and
            // Stockholm + adjacent suburbs (small + close is kept by
            // distance), while dropping legal exclaves no one will
            // travel to mid-game.
            const filtered = filterMeaningfulPieces(pieces);
            acc = filtered[0];
            for (let i = 1; i < filtered.length; i++) {
                try {
                    const u = turf.union(
                        turf.featureCollection([acc, filtered[i]]),
                    ) as Feature<Polygon | MultiPolygon> | null;
                    if (u) acc = u;
                } catch {
                    /* skip any pair that fails the topology check */
                }
            }
        }

        // Subtract inland lakes from the land-clipped shape. Done
        // after the land intersect + piece-union so we difference
        // against the final single feature once, and before the area
        // sanity check below so a lake bite counts toward the
        // kept-area ratio (a play area that's mostly lake SHOULD trip
        // the guard and fall back to raw, same as a mostly-ocean one).
        acc = await subtractLakes(acc);

        // Sanity check — if the clip removed more than (1-MIN_KEEP)
        // of the input area, treat it as a bug and bail. Two known
        // failure modes this catches:
        //   1. Coastline orientation was wrong (the v149 Sweden
        //      bug — the land mask was actually an ocean mask, so
        //      we got back just the coastal-water bits).
        //   2. NE 1:50m generalises away small features. A play
        //      area that's mostly small islands could lose most of
        //      itself to the simplified outline. Better to render
        //      the un-clipped OSM polygon than a glitchy fragment.
        // The threshold below is permissive — even a heavily
        // coastal area like Nagasaki only loses ~50% to the trim,
        // so 0.4 (keep at least 40%) doesn't reject legitimate
        // trims but does reject the "we lost 99% of it" disasters.
        const MIN_KEEP = 0.4;
        try {
            const inArea = turf.area(polygon);
            const outArea = turf.area(acc);
            if (inArea > 0 && outArea / inArea < MIN_KEEP) {
                console.warn(
                    `clipPolygonToLand kept only ${(
                        (outArea / inArea) *
                        100
                    ).toFixed(
                        1,
                    )}% of input area — likely a bad clip; falling back to raw polygon.`,
                );
                return null;
            }
        } catch {
            /* area comparison failed — proceed with the clip */
        }
        return acc;
    } catch (e) {
        console.warn("clipPolygonToLand failed:", e);
        return null;
    }
}

/** Min size of a piece relative to the largest piece, for the keep
 *  decision below. Tokyo's Izu islands sit at 1-15 % of mainland;
 *  this cutoff (10 %) drops the small ones while keeping comparably-
 *  sized siblings (UK + N. Ireland, large dual-island countries). */
const MIN_RELATIVE_AREA = 0.1;
/** Max centroid distance from the largest piece, in km, for a piece
 *  to be kept under the "small but close" branch. 60 km comfortably
 *  covers suburbs/satellite islands of any reasonable city but
 *  excludes far-flung legal exclaves. */
const MAX_PIECE_DISTANCE_KM = 60;

/**
 * Keep only the meaningful pieces of a freshly-land-clipped
 * play-area: the largest piece, plus any other piece that's
 * substantial on its own merits OR close enough to the main piece
 * that a seeker could plausibly reach it.
 *
 * Returns the input unchanged when it's already a single piece, when
 * the area heuristic fails (e.g. degenerate geometry), or when every
 * piece happens to qualify — so this can never make things worse,
 * only drop true outliers like Tokyo Metropolis's Pacific island
 * chain.
 */
function filterMeaningfulPieces(
    pieces: Feature<Polygon | MultiPolygon>[],
): Feature<Polygon | MultiPolygon>[] {
    if (pieces.length <= 1) return pieces;
    let withMeta: { piece: Feature<Polygon | MultiPolygon>; area: number; center: Feature<{ type: "Point"; coordinates: [number, number] }> | null }[];
    try {
        withMeta = pieces.map((p) => {
            const a = turf.area(p);
            let c: any = null;
            try {
                c = turf.centroid(p);
            } catch {
                c = null;
            }
            return { piece: p, area: a, center: c };
        });
    } catch {
        return pieces;
    }
    withMeta.sort((a, b) => b.area - a.area);
    const largest = withMeta[0];
    if (!largest.center || largest.area <= 0) return pieces;

    const largestCenter = largest.center;
    const kept = withMeta.filter((it, idx) => {
        if (idx === 0) return true;
        if (it.area / largest.area >= MIN_RELATIVE_AREA) return true;
        if (!it.center) return false;
        try {
            const km = turf.distance(largestCenter, it.center, {
                units: "kilometers",
            });
            return km <= MAX_PIECE_DISTANCE_KM;
        } catch {
            return false;
        }
    });
    if (kept.length === withMeta.length) return pieces;
    return kept.map((it) => it.piece);
}
