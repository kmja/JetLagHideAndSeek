import * as turf from "@turf/turf";

/**
 * v376: bbox-prefiltered point-in-play-area tests.
 *
 * Three hot filters added in v369-v372 (nearestFromCache,
 * findCachedPlaces, useQuestionImpact's candidate clip) call
 * `turf.booleanPointInPolygon` per candidate against the play-area
 * FeatureCollection. For Ottawa's 1103 parks against Frankfurt's dense
 * multipolygon, each pass cost ~50 ms — small, but it runs on every
 * configure-dialog state change (drag, type switch, GPS update), so it
 * shows up as a continuous jank.
 *
 * The optimisation is just a bbox prefilter:
 *   - Compute and cache the play area's outer bbox per FeatureCollection
 *     reference (WeakMap keyed on the object itself — invalidates
 *     automatically when polyGeoJSON.set(...) writes a new reference).
 *   - Outer bbox reject is one comparison, ~5 ns. Catches every
 *     candidate clearly outside.
 *   - Only points inside the outer bbox fall through to the full
 *     booleanPointInPolygon loop.
 *
 * Multi-feature play areas (primary + adjacent areas) also cache a
 * per-feature bbox list so the inner loop can skip features whose bbox
 * doesn't contain the point. For single-area play areas the inner cost
 * is identical to v369-v372 (one bbox check, one full test).
 *
 * Total pass on 1103 candidates × 4-piece multipolygon: ~3 ms.
 */

type FC = GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon>;
type Feat = GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>;

interface IndexedPolygon {
    outer: [number, number, number, number]; // [minLng, minLat, maxLng, maxLat]
    parts: Array<{ bbox: [number, number, number, number]; feat: Feat }>;
}

const fcIndex = new WeakMap<object, IndexedPolygon>();
const featIndex = new WeakMap<object, IndexedPolygon>();

function bbox4(geom: GeoJSON.Feature): [number, number, number, number] {
    const b = turf.bbox(geom);
    return [b[0], b[1], b[2], b[3]];
}

function unionBbox(
    bs: Array<[number, number, number, number]>,
): [number, number, number, number] {
    let minLng = Infinity,
        minLat = Infinity,
        maxLng = -Infinity,
        maxLat = -Infinity;
    for (const [a, b, c, d] of bs) {
        if (a < minLng) minLng = a;
        if (b < minLat) minLat = b;
        if (c > maxLng) maxLng = c;
        if (d > maxLat) maxLat = d;
    }
    return [minLng, minLat, maxLng, maxLat];
}

function indexFC(poly: FC): IndexedPolygon {
    const cached = fcIndex.get(poly);
    if (cached) return cached;
    const parts = poly.features.map((feat) => ({
        bbox: bbox4(feat),
        feat,
    }));
    const idx: IndexedPolygon = {
        outer: unionBbox(parts.map((p) => p.bbox)),
        parts,
    };
    fcIndex.set(poly, idx);
    return idx;
}

function indexFeat(feat: Feat): IndexedPolygon {
    const cached = featIndex.get(feat);
    if (cached) return cached;
    const b = bbox4(feat);
    const idx: IndexedPolygon = {
        outer: b,
        parts: [{ bbox: b, feat }],
    };
    featIndex.set(feat, idx);
    return idx;
}

function bboxContains(
    box: [number, number, number, number],
    lng: number,
    lat: number,
): boolean {
    return lng >= box[0] && lng <= box[2] && lat >= box[1] && lat <= box[3];
}

/**
 * Whether `(lng, lat)` falls inside the play-area polygon set. Accepts
 * either a FeatureCollection (the standard polyGeoJSON shape) or a
 * single Feature (usePlayAreaPolygon's shape). Returns false on null.
 */
export function pointInPlayArea(
    poly: FC | Feat | null,
    lng: number,
    lat: number,
): boolean {
    if (!poly) return false;
    const idx =
        (poly as FC).type === "FeatureCollection"
            ? indexFC(poly as FC)
            : indexFeat(poly as Feat);
    if (!bboxContains(idx.outer, lng, lat)) return false;
    const pt = turf.point([lng, lat]);
    for (const { bbox, feat } of idx.parts) {
        if (!bboxContains(bbox, lng, lat)) continue;
        if (turf.booleanPointInPolygon(pt, feat as never)) return true;
    }
    return false;
}

/**
 * v376: stable polygon identity for memoize keys. Three matching/measuring
 * determiners used `JSON.stringify({entirety: polyGeoJSON.get(), ...})`
 * which materialised hundreds of KB on every memo lookup just to test
 * equality. We don't need the polygon contents in the key — we just need
 * "different polygon = different key". A signature built from each
 * feature's properties + a coarse vertex count is unique enough in
 * practice (two distinct play areas don't collide) and cheap to compute.
 *
 * Cached on the same WeakMap basis as pointInPlayArea so the signature
 * is one lookup once polyGeoJSON.set(...) writes a new reference.
 */
const sigCache = new WeakMap<object, string>();

export function playAreaSignature(
    poly: FC | Feat | null | undefined,
): string {
    if (!poly) return "";
    const cached = sigCache.get(poly);
    if (cached) return cached;
    let sig: string;
    if ((poly as FC).type === "FeatureCollection") {
        const fc = poly as FC;
        const parts = fc.features.map((f) => {
            const props = (f.properties ?? {}) as Record<string, unknown>;
            const id = props.osm_id ?? (f as { id?: unknown }).id ?? "";
            return `${id}:${vertexCount(f)}`;
        });
        sig = `fc[${parts.join("|")}]`;
    } else {
        sig = `f:${vertexCount(poly as Feat)}`;
    }
    sigCache.set(poly, sig);
    return sig;
}

function vertexCount(feat: GeoJSON.Feature): number {
    const g = feat.geometry as
        | GeoJSON.Polygon
        | GeoJSON.MultiPolygon
        | undefined;
    if (!g) return 0;
    if (g.type === "Polygon") {
        let n = 0;
        for (const ring of g.coordinates) n += ring.length;
        return n;
    }
    if (g.type === "MultiPolygon") {
        let n = 0;
        for (const poly of g.coordinates)
            for (const ring of poly) n += ring.length;
        return n;
    }
    return 0;
}
