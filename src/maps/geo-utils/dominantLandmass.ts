/**
 * Clip an oversized play-area boundary to its DOMINANT LANDMASS before taking a
 * bounding box. Some OSM admin relations own far-flung islands — Tokyo Metropolis
 * (東京都) includes the Izu + Ogasawara chains reaching ~1000 km south into the
 * Pacific, so the whole-relation bbox is ~15°×18° of open ocean. Every extent
 * producer that feeds a reference/station/water/coast/admin bbox query (and the
 * tile pack) would then scan a mostly-empty ocean box → Overpass soft-timeout →
 * nothing caches → the city never warms/stars.
 *
 * The v721 fix (`transitReach.ts` `dropFarExclaves`/`largestComponentCentre`)
 * solved this ONLY for the client adjacency path, using turf on ASSEMBLED
 * polygons. This is the turf-free, geometry-agnostic sibling used by every OTHER
 * extent producer (worker + client). It works on raw coordinate GROUPS (one group
 * per OSM member way, or per GeoJSON polygon part), so it runs in the pure
 * Cloudflare Worker (no geometry libs) as well as on the client.
 *
 * Dominance is by VERTEX COUNT, not bbox area — a scatter of tiny far islands has
 * a huge bbox but few vertices, while a dense mainland city boundary has many; a
 * bbox-area metric would wrongly pick the scatter (the exact v721 pitfall). Groups
 * are clustered by bbox proximity (union-find); the dominant cluster + any cluster
 * near it or comparably detailed are kept; far sparse clusters (the ocean islands)
 * are dropped.
 *
 * CRITICALLY it is a NO-OP unless the raw extent is genuinely oversized (span over
 * ~a prefecture): a normal compact city returns the identical full bbox, so its R2
 * cache key is byte-for-byte unchanged and nothing re-warms. Only island-owning
 * primaries (which don't work today anyway) get a changed — now correct — extent.
 *
 * WORKER MIRROR: a byte-identical copy of `dominantExtentFromGroups` +
 * `collectCoordGroups` lives in `overpass-cache/src/index.ts`. Keep them in sync
 * (this file is the canonical, unit-tested source — `tests/dominantLandmass.test.ts`).
 */

/** Photon extent order used across the app: [maxLat, minLng, minLat, maxLng]. */
export type PhotonExtent = [number, number, number, number];

// Span (degrees) above which an extent is "not a city" and gets landmass-clipped.
// Matches the laptop prewarmer's `isOversizedExtent` thresholds.
const OVERSIZE_LAT_DEG = 3;
const OVERSIZE_LNG_DEG = 4.5;
// Two coordinate groups within this bbox gap (degrees) are the same landmass.
const CLUSTER_NEAR_DEG = 0.4;
// A non-dominant cluster this close to the dominant one is kept (a neighbouring
// borough/bay island that's genuinely part of the metro).
const KEEP_NEAR_DEG = 0.6;
// …or one with at least this fraction of the dominant cluster's vertex count.
const KEEP_VERTEX_FRAC = 0.5;

interface Box {
    minLng: number;
    minLat: number;
    maxLng: number;
    maxLat: number;
    n: number; // vertex count
}

function groupBox(g: [number, number][]): Box | null {
    let minLng = Infinity;
    let minLat = Infinity;
    let maxLng = -Infinity;
    let maxLat = -Infinity;
    let n = 0;
    for (const p of g) {
        const lng = p[0];
        const lat = p[1];
        if (typeof lng !== "number" || typeof lat !== "number") continue;
        if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
        if (lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;
        if (lng < minLng) minLng = lng;
        if (lat < minLat) minLat = lat;
        if (lng > maxLng) maxLng = lng;
        if (lat > maxLat) maxLat = lat;
        n++;
    }
    if (n === 0) return null;
    return { minLng, minLat, maxLng, maxLat, n };
}

/** Bbox gap in degrees (0 if the boxes overlap/touch), max over the two axes. */
function boxGap(a: Box, b: Box): number {
    const dx = Math.max(0, Math.max(a.minLng - b.maxLng, b.minLng - a.maxLng));
    const dy = Math.max(0, Math.max(a.minLat - b.maxLat, b.minLat - a.maxLat));
    return Math.max(dx, dy);
}

function mergeBox(a: Box, b: Box): Box {
    return {
        minLng: Math.min(a.minLng, b.minLng),
        minLat: Math.min(a.minLat, b.minLat),
        maxLng: Math.max(a.maxLng, b.maxLng),
        maxLat: Math.max(a.maxLat, b.maxLat),
        n: a.n + b.n,
    };
}

/**
 * Return a Photon extent [maxLat, minLng, minLat, maxLng] for the dominant
 * landmass of `groups` (one group per way/ring/part). A no-op (returns the full
 * bbox) unless the full extent is oversized. `null` if there are no usable coords.
 */
export function dominantExtentFromGroups(
    groups: [number, number][][],
): PhotonExtent | null {
    const boxes: Box[] = [];
    let full: Box | null = null;
    for (const g of groups) {
        const b = groupBox(g);
        if (!b) continue;
        boxes.push(b);
        full = full ? mergeBox(full, b) : b;
    }
    if (!full) return null;
    const asPhoton = (b: Box): PhotonExtent => [
        b.maxLat,
        b.minLng,
        b.minLat,
        b.maxLng,
    ];
    const latSpan = full.maxLat - full.minLat;
    const lngSpan = full.maxLng - full.minLng;
    // Not oversized → normal city → identical full bbox (no cache-key change).
    if (latSpan <= OVERSIZE_LAT_DEG && lngSpan <= OVERSIZE_LNG_DEG)
        return asPhoton(full);
    if (boxes.length < 2) return asPhoton(full);

    // Union-find cluster the group boxes by proximity.
    const parent = boxes.map((_, i) => i);
    const find = (a: number): number =>
        parent[a] === a ? a : (parent[a] = find(parent[a]));
    const uni = (a: number, b: number): void => {
        const ra = find(a);
        const rb = find(b);
        if (ra !== rb) parent[ra] = rb;
    };
    for (let i = 0; i < boxes.length; i++)
        for (let j = i + 1; j < boxes.length; j++)
            if (boxGap(boxes[i], boxes[j]) <= CLUSTER_NEAR_DEG) uni(i, j);

    const clusters = new Map<number, Box>();
    boxes.forEach((b, i) => {
        const r = find(i);
        const c = clusters.get(r);
        clusters.set(r, c ? mergeBox(c, b) : b);
    });
    const list = [...clusters.values()];
    if (list.length < 2) return asPhoton(full);

    // Dominant = most vertices (a dense mainland boundary, not a sparse scatter).
    let dominant = list[0];
    for (const c of list) if (c.n > dominant.n) dominant = c;

    // Keep the dominant + clusters near it or comparably detailed; drop far scatters.
    let kept: Box | null = null;
    for (const c of list) {
        const keep =
            c === dominant ||
            boxGap(c, dominant) <= KEEP_NEAR_DEG ||
            c.n >= dominant.n * KEEP_VERTEX_FRAC;
        if (keep) kept = kept ? mergeBox(kept, c) : c;
    }
    return asPhoton(kept ?? dominant);
}

/**
 * Collect coordinate GROUPS from a parsed boundary payload — one group per OSM
 * member way (`{geometry:[{lat,lon}]}`) or per nested GeoJSON coordinate ring/part.
 * Mirrors the recursive walk the raw extent functions used, but keeps each
 * leaf-path separate so `dominantExtentFromGroups` can cluster them. Handles both
 * Overpass `out geom` (`{elements:[{members:[{geometry}]}]}`) and polygons.osm.fr
 * GeoJSON (`{type:"MultiPolygon", coordinates:[...]}`).
 */
export function collectCoordGroups(parsed: unknown): [number, number][][] {
    const groups: [number, number][][] = [];
    const isCoordPair = (a: unknown): a is [number, number] =>
        Array.isArray(a) &&
        a.length >= 2 &&
        typeof a[0] === "number" &&
        typeof a[1] === "number";
    // A "path" is an array whose elements are coordinate pairs → one group.
    const visit = (node: any): void => {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) {
            if (node.length && isCoordPair(node[0])) {
                const g: [number, number][] = [];
                for (const p of node) if (isCoordPair(p)) g.push([p[0], p[1]]);
                if (g.length) groups.push(g);
                return;
            }
            for (const child of node) visit(child);
            return;
        }
        // Overpass way: geometry is [{lat,lon}, ...] → one group.
        if (Array.isArray(node.geometry) && node.geometry.length) {
            const first = node.geometry[0];
            if (first && typeof first.lat === "number") {
                const g: [number, number][] = [];
                for (const p of node.geometry)
                    if (typeof p.lat === "number" && typeof p.lon === "number")
                        g.push([p.lon, p.lat]);
                if (g.length) groups.push(g);
                return;
            }
            visit(node.geometry);
            return;
        }
        if (node.geometry) visit(node.geometry);
        if (node.coordinates) visit(node.coordinates);
        if (Array.isArray(node.members)) for (const m of node.members) visit(m);
        if (Array.isArray(node.elements)) for (const e of node.elements) visit(e);
        if (Array.isArray(node.features)) for (const f of node.features) visit(f);
    };
    visit(parsed);
    return groups;
}
