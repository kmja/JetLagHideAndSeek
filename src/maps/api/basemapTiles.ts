import { VectorTile } from "@mapbox/vector-tile";
import type { Feature, MultiPolygon, Polygon } from "geojson";
import Protobuf from "pbf";
import { PMTiles } from "pmtiles";

/**
 * v1002: read a basemap vector-tile LAYER directly from the pmtiles archive,
 * HEADLESS, at a fixed zoom — independent of any MapLibre map.
 *
 * The `querySourceFeatures` capture (`basemapWater.ts`) only sees tiles a
 * DISPLAY map has actually loaded, which ties the water geometry to the map's
 * viewport + zoom and to an `idle` race (the "overlay reveals before it's
 * ready / sometimes never loads" fragility). This reads the SAME pmtiles we
 * already ship — the archive the map renders from — straight off R2 via range
 * requests, decodes the MVT with `@mapbox/vector-tile`, and returns the layer's
 * polygons in lng/lat. Deterministic: given a play-area bbox it always returns
 * the same water/roads/… regardless of what any map is doing.
 *
 * Purely additive + gated — every failure path returns null so the caller falls
 * back to the `querySourceFeatures` capture, exactly as before.
 */

// One PMTiles instance per archive URL (it caches the directory internally).
let pmCache: { url: string; pm: PMTiles } | null = null;
function getPM(url: string): PMTiles {
    if (pmCache && pmCache.url === url) return pmCache.pm;
    const pm = new PMTiles(url);
    pmCache = { url, pm };
    return pm;
}

const tileXOf = (lng: number, z: number): number =>
    Math.floor(((lng + 180) / 360) * Math.pow(2, z));
const tileYOf = (lat: number, z: number): number => {
    const r = (lat * Math.PI) / 180;
    return Math.floor(
        ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) *
            Math.pow(2, z),
    );
};

async function readTileLayer(
    pm: PMTiles,
    z: number,
    x: number,
    y: number,
    sourceLayer: string,
): Promise<Feature<Polygon | MultiPolygon>[]> {
    try {
        const resp = await pm.getZxy(z, x, y);
        if (!resp || !resp.data) return [];
        const vt = new VectorTile(new Protobuf(new Uint8Array(resp.data)));
        const layer = vt.layers[sourceLayer];
        if (!layer) return [];
        const out: Feature<Polygon | MultiPolygon>[] = [];
        for (let i = 0; i < layer.length; i++) {
            let gj: Feature;
            try {
                gj = layer.feature(i).toGeoJSON(x, y, z) as Feature;
            } catch {
                continue;
            }
            const g = gj.geometry;
            if (g && (g.type === "Polygon" || g.type === "MultiPolygon")) {
                out.push(gj as Feature<Polygon | MultiPolygon>);
            }
        }
        return out;
    } catch {
        return [];
    }
}

/**
 * Fetch the polygons of a basemap source-layer covering `bbox`, decoded from the
 * pmtiles at `url`. Picks the highest zoom in [`minZoom`, `targetZoom`] whose
 * tile count over the bbox is ≤ `maxTiles` (bounded fan-out of range requests),
 * clamped to the archive's max zoom. Returns null on any failure / empty result.
 */
export async function fetchBasemapLayerPolys(
    url: string,
    bbox: [number, number, number, number],
    sourceLayer: string,
    opts?: { targetZoom?: number; minZoom?: number; maxTiles?: number },
): Promise<Feature<Polygon | MultiPolygon>[] | null> {
    try {
        if (!url) return null;
        const pm = getPM(url);
        const header = await pm.getHeader();
        const archiveMax = Number.isFinite(header?.maxZoom)
            ? (header.maxZoom as number)
            : 15;
        const [minLng, minLat, maxLng, maxLat] = bbox;
        const targetZoom = Math.min(opts?.targetZoom ?? 12, archiveMax);
        const minZoom = opts?.minZoom ?? 8;
        const maxTiles = opts?.maxTiles ?? 24;

        // Pick the highest zoom whose tile count fits the fan-out budget.
        let z = targetZoom;
        for (; z > minZoom; z--) {
            const xa = tileXOf(minLng, z);
            const xb = tileXOf(maxLng, z);
            const ya = tileYOf(maxLat, z); // note: lat inverts the Y axis
            const yb = tileYOf(minLat, z);
            const count = (xb - xa + 1) * (yb - ya + 1);
            if (count <= maxTiles) break;
        }

        const xa = tileXOf(minLng, z);
        const xb = tileXOf(maxLng, z);
        const ya = tileYOf(maxLat, z);
        const yb = tileYOf(minLat, z);
        const jobs: Promise<Feature<Polygon | MultiPolygon>[]>[] = [];
        for (let x = xa; x <= xb; x++) {
            for (let y = ya; y <= yb; y++) {
                jobs.push(readTileLayer(pm, z, x, y, sourceLayer));
            }
        }
        const results = await Promise.all(jobs);
        const feats = results.flat();
        return feats.length > 0 ? feats : null;
    } catch {
        return null;
    }
}
