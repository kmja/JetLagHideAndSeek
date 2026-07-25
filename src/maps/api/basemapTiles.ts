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

export interface NamedPoint {
    name: string;
    kind: string;
    lng: number;
    lat: number;
}

/** Read the NAMED point features of a source-layer from one tile (e.g. the
 *  `physical_point` label layer — lake/reservoir/bay names). */
async function readTileNamedPoints(
    pm: PMTiles,
    z: number,
    x: number,
    y: number,
    sourceLayer: string,
): Promise<NamedPoint[]> {
    try {
        const resp = await pm.getZxy(z, x, y);
        if (!resp || !resp.data) return [];
        const vt = new VectorTile(new Protobuf(new Uint8Array(resp.data)));
        const layer = vt.layers[sourceLayer];
        if (!layer) return [];
        const out: NamedPoint[] = [];
        for (let i = 0; i < layer.length; i++) {
            try {
                const gj = layer.feature(i).toGeoJSON(x, y, z) as Feature;
                const g = gj.geometry;
                if (!g || g.type !== "Point") continue;
                const props = (gj.properties ?? {}) as {
                    name?: string;
                    kind?: string;
                };
                const name =
                    typeof props.name === "string" ? props.name.trim() : "";
                if (!name) continue;
                const c = g.coordinates as [number, number];
                out.push({
                    name,
                    kind: (props.kind ?? "").trim(),
                    lng: c[0],
                    lat: c[1],
                });
            } catch {
                continue;
            }
        }
        return out;
    } catch {
        return [];
    }
}

/** Fetch NAMED point features (name + kind + lng/lat) of a source-layer over a
 *  bbox — used to read the Protomaps `physical_point` water-body labels, which
 *  is where water NAMES live (the `water` polygon layer carries none). */
export async function fetchLayerNamedPointsFromPM(
    pm: PMTiles,
    bbox: [number, number, number, number],
    sourceLayer: string,
    opts?: { targetZoom?: number; minZoom?: number; maxTiles?: number },
): Promise<NamedPoint[] | null> {
    try {
        const header = await pm.getHeader();
        const archiveMax = Number.isFinite(header?.maxZoom)
            ? (header.maxZoom as number)
            : 15;
        const [minLng, minLat, maxLng, maxLat] = bbox;
        const targetZoom = Math.min(opts?.targetZoom ?? 14, archiveMax);
        const minZoom = opts?.minZoom ?? 10;
        const maxTiles = opts?.maxTiles ?? 400;
        let z = targetZoom;
        for (; z > minZoom; z--) {
            const xa = tileXOf(minLng, z);
            const xb = tileXOf(maxLng, z);
            const ya = tileYOf(maxLat, z);
            const yb = tileYOf(minLat, z);
            if ((xb - xa + 1) * (yb - ya + 1) <= maxTiles) break;
        }
        const xa = tileXOf(minLng, z);
        const xb = tileXOf(maxLng, z);
        const ya = tileYOf(maxLat, z);
        const yb = tileYOf(minLat, z);
        const jobs: Promise<NamedPoint[]>[] = [];
        for (let x = xa; x <= xb; x++)
            for (let y = ya; y <= yb; y++)
                jobs.push(readTileNamedPoints(pm, z, x, y, sourceLayer));
        const feats = (await Promise.all(jobs)).flat();
        return feats;
    } catch {
        return null;
    }
}

/**
 * v1160 DIAGNOSTIC: compare the NAME SETS of a source-layer across zooms over the
 * SAME geography, to answer "are the names at a higher zoom a subset of a lower
 * zoom's?" (the v1157 count probe couldn't — its fixed 2×2 tile sample covered a
 * different-sized area per zoom, so the counts weren't comparable). Reads a
 * common CENTRAL sub-bbox (~1/3 of the play-area span) at each zoom — every zoom
 * covers the identical geography, just at different tile counts — collects the
 * set of names, and reports per zoom: the set size, how many of its names are IN
 * the lowest zoom's set (`∈zLO`), and how many are NEW (not in the lowest set).
 * A `new:0` at a higher zoom ⇒ the lowest zoom is a superset (safe to source
 * names there). A `new:>0` ⇒ the lowest zoom MISSES those bodies (generalized
 * away), so it's NOT a complete source. Also reports `zLO-only` — names the
 * lowest zoom has that the highest lost (fragmented). Returns
 * "set z10=A z11=B(∈z10:x,new:y) z12=C(…) | z10-only-vs-z12=z".
 */
export async function probeLayerNamesAcrossZooms(
    pm: PMTiles,
    bbox: [number, number, number, number],
    sourceLayer: string,
    zooms: number[],
): Promise<string> {
    const [minLng, minLat, maxLng, maxLat] = bbox;
    const cLng = (minLng + maxLng) / 2;
    const cLat = (minLat + maxLat) / 2;
    // A central sub-bbox = 1/3 of the play-area span in each dimension, so the
    // highest zoom stays a manageable tile count and every zoom covers the SAME
    // ground (fair set comparison).
    const hw = (maxLng - minLng) / 6;
    const hh = (maxLat - minLat) / 6;
    const sub: [number, number, number, number] = [
        cLng - hw,
        cLat - hh,
        cLng + hw,
        cLat + hh,
    ];
    const sets: Array<{ z: number; names: Set<string> }> = [];
    for (const z of zooms) {
        const xa = tileXOf(sub[0], z);
        const xb = tileXOf(sub[2], z);
        const ya = tileYOf(sub[3], z);
        const yb = tileYOf(sub[1], z);
        const tiles: Array<[number, number]> = [];
        for (let x = xa; x <= xb; x++)
            for (let y = ya; y <= yb; y++) tiles.push([x, y]);
        const names = new Set<string>();
        await Promise.all(
            tiles.slice(0, 40).map(async ([x, y]) => {
                try {
                    const resp = await pm.getZxy(z, x, y);
                    if (!resp || !resp.data) return;
                    const vt = new VectorTile(
                        new Protobuf(new Uint8Array(resp.data)),
                    );
                    const layer = vt.layers[sourceLayer];
                    if (!layer) return;
                    for (let i = 0; i < layer.length; i++) {
                        try {
                            const nm = (
                                layer.feature(i).properties as { name?: string }
                            ).name;
                            if (typeof nm === "string" && nm.trim())
                                names.add(nm.trim());
                        } catch {
                            /* skip */
                        }
                    }
                } catch {
                    /* skip tile */
                }
            }),
        );
        sets.push({ z, names });
    }
    if (sets.length === 0) return "set no-data";
    const base = sets[0];
    const parts = sets.map((s) => {
        if (s.z === base.z) return `z${s.z}=${s.names.size}`;
        let inBase = 0;
        let novel = 0;
        for (const n of s.names) {
            if (base.names.has(n)) inBase++;
            else novel++;
        }
        return `z${s.z}=${s.names.size}(∈z${base.z}:${inBase},new:${novel})`;
    });
    const top = sets[sets.length - 1];
    let baseOnly = 0;
    for (const n of base.names) if (!top.names.has(n)) baseOnly++;
    return `set ${parts.join(" ")} | z${base.z}-only-vs-z${top.z}=${baseOnly}`;
}

/** URL variant of {@link probeLayerNamesAcrossZooms} — reads from the master
 *  archive over the network when no in-memory pack is loaded. */
export async function probeLayerNamesAcrossZoomsUrl(
    url: string,
    bbox: [number, number, number, number],
    sourceLayer: string,
    zooms: number[],
): Promise<string> {
    if (!url) return "no-url";
    return probeLayerNamesAcrossZooms(getPM(url), bbox, sourceLayer, zooms);
}

/**
 * v1156 DIAGNOSTIC: enumerate EVERY layer in the tiles over `bbox` and report,
 * per layer, how many features it has and how many carry a NAME (+ samples). The
 * `physical_point` guess was empty, but the map clearly labels water bodies, so
 * the names are in SOME layer — this finds which one. Returns a compact string.
 */
export async function fetchBasemapInventoryFromPM(
    pm: PMTiles,
    bbox: [number, number, number, number],
    opts?: { targetZoom?: number; maxTiles?: number },
): Promise<string | null> {
    try {
        const header = await pm.getHeader();
        const archiveMax = Number.isFinite(header?.maxZoom)
            ? (header.maxZoom as number)
            : 15;
        const [minLng, minLat, maxLng, maxLat] = bbox;
        const targetZoom = Math.min(opts?.targetZoom ?? 14, archiveMax);
        const maxTiles = opts?.maxTiles ?? 12;
        let z = targetZoom;
        for (; z > 8; z--) {
            const xa = tileXOf(minLng, z);
            const xb = tileXOf(maxLng, z);
            const ya = tileYOf(maxLat, z);
            const yb = tileYOf(minLat, z);
            if ((xb - xa + 1) * (yb - ya + 1) <= maxTiles) break;
        }
        const xa = tileXOf(minLng, z);
        const xb = tileXOf(maxLng, z);
        const ya = tileYOf(maxLat, z);
        const yb = tileYOf(minLat, z);
        const inv = new Map<
            string,
            { count: number; named: number; samples: string[] }
        >();
        const tiles: Array<[number, number]> = [];
        for (let x = xa; x <= xb && tiles.length < maxTiles; x++)
            for (let y = ya; y <= yb && tiles.length < maxTiles; y++)
                tiles.push([x, y]);
        await Promise.all(
            tiles.map(async ([x, y]) => {
                const resp = await pm.getZxy(z, x, y);
                if (!resp || !resp.data) return;
                const vt = new VectorTile(
                    new Protobuf(new Uint8Array(resp.data)),
                );
                for (const layerName of Object.keys(vt.layers)) {
                    const layer = vt.layers[layerName];
                    let rec = inv.get(layerName);
                    if (!rec) {
                        rec = { count: 0, named: 0, samples: [] };
                        inv.set(layerName, rec);
                    }
                    for (let i = 0; i < layer.length; i++) {
                        rec.count++;
                        try {
                            const f = layer.feature(i);
                            const props = f.properties as {
                                name?: string;
                            };
                            const nm =
                                typeof props.name === "string"
                                    ? props.name.trim()
                                    : "";
                            if (nm) {
                                rec.named++;
                                if (rec.samples.length < 2)
                                    rec.samples.push(nm);
                            }
                        } catch {
                            /* skip */
                        }
                    }
                }
            }),
        );
        const parts = [...inv.entries()]
            .sort((a, b) => b[1].named - a[1].named)
            .map(
                ([name, r]) =>
                    `${name}:${r.count}/n${r.named}${r.samples.length ? `(${r.samples.join("|")})` : ""}`,
            );
        return `z${z} ${parts.join(" ")}`;
    } catch (e) {
        return `inv-err ${String(e).slice(0, 40)}`;
    }
}

/** URL variant. */
export async function fetchBasemapInventory(
    url: string,
    bbox: [number, number, number, number],
    opts?: { targetZoom?: number; maxTiles?: number },
): Promise<string | null> {
    if (!url) return null;
    return fetchBasemapInventoryFromPM(getPM(url), bbox, opts);
}

/** URL variant of {@link fetchLayerNamedPointsFromPM} — reads from the master
 *  archive over the network when no in-memory pack is loaded. */
export async function fetchBasemapLayerNamedPoints(
    url: string,
    bbox: [number, number, number, number],
    sourceLayer: string,
    opts?: { targetZoom?: number; minZoom?: number; maxTiles?: number },
): Promise<NamedPoint[] | null> {
    if (!url) return null;
    return fetchLayerNamedPointsFromPM(getPM(url), bbox, sourceLayer, opts);
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
    if (!url) return null;
    return fetchLayerPolysFromPM(getPM(url), bbox, sourceLayer, opts);
}

/**
 * Same as {@link fetchBasemapLayerPolys} but reads from a PROVIDED PMTiles
 * handle — used to read straight from the in-memory PRELOADED city pack
 * (offline, instant) instead of the master archive over the network (v1074).
 */
export async function fetchLayerPolysFromPM(
    pm: PMTiles,
    bbox: [number, number, number, number],
    sourceLayer: string,
    opts?: { targetZoom?: number; minZoom?: number; maxTiles?: number },
): Promise<Feature<Polygon | MultiPolygon>[] | null> {
    try {
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
