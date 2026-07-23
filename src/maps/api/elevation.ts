import * as turf from "@turf/turf";
import type { Feature, MultiPolygon, Polygon } from "geojson";

import { getBasemapWaterPolys } from "@/maps/api/basemapWater";

import { ELEVATION_TILE_BASE } from "./constants";

/**
 * Digital-elevation-model access for the sea-level measuring question
 * (v342).
 *
 * Source: AWS "Terrain Tiles" (Terrarium PNG encoding), proxied + R2-
 * cached by our worker at `${ELEVATION_TILE_BASE}/{z}/{x}/{y}.png` so
 * it's self-hosted and prewarmable, never a direct external dependency
 * at game time.
 *
 * Terrarium decode: `elevation_m = (R*256 + G + B/256) - 32768`.
 *
 * The flow for sea-level:
 *   1. `buildElevationField(bbox)` fetches the Terrarium tiles covering
 *      the play-area bbox at ELEVATION_ZOOM, decodes them with a
 *      Canvas, and returns a sampler that maps (lng,lat) → metres.
 *   2. The caller samples the SEEKER's position to get their altitude
 *      (more reliable + self-consistent than GPS `coords.altitude`,
 *      which is frequently null or tens of metres off).
 *   3. `seaLevelRegion` builds a coarse point grid over the bbox,
 *      tags each with elevation, runs `turf.isobands` at the seeker's
 *      altitude, and returns the "closer to sea level" polygon (the
 *      sub-seeker-altitude band).
 *
 * Resolution: ELEVATION_ZOOM=11 is ~75 m/px at the equator. A city-
 * scale play area is a handful of tiles; a country-scale bbox would be
 * hundreds, so `buildElevationField` caps tile count and returns null
 * past the cap (the caller falls back to "no auto-elimination", same as
 * the bundled-dataset cases do for over-large areas).
 */

const ELEVATION_ZOOM = 11;
/** Max Terrarium tiles to fetch for one field. A 0.4°-ish city bbox is
 *  ~4 tiles at z11; 36 lets a generous metro through but stops a
 *  whole-country bbox from fetching hundreds. */
const MAX_ELEVATION_TILES = 36;
const TILE_PX = 256;
/** Sub-sample stride when reading a decoded tile into the grid. Every
 *  8th pixel → 32×32 samples per tile, plenty for a km-precision
 *  contour and cheap to grid + isoband. */
const SAMPLE_STRIDE = 8;

type Bbox = [number, number, number, number]; // [w, s, e, n]

function lngToTileX(lng: number, z: number): number {
    return Math.floor(((lng + 180) / 360) * 2 ** z);
}
function latToTileY(lat: number, z: number): number {
    const r = (lat * Math.PI) / 180;
    return Math.floor(
        ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z,
    );
}
function tileXToLng(x: number, z: number): number {
    return (x / 2 ** z) * 360 - 180;
}
function tileYToLat(y: number, z: number): number {
    const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/** Decode one Terrarium PNG to a Float32 elevation array (TILE_PX²) via
 *  an offscreen canvas. Returns null on any load/decode failure or for
 *  upstream 404s (tiles outside DEM coverage). */
async function decodeTile(
    z: number,
    x: number,
    y: number,
): Promise<Float32Array | null> {
    const url = `${ELEVATION_TILE_BASE}/${z}/${x}/${y}.png`;
    let blob: Blob;
    try {
        const resp = await fetch(url);
        if (!resp.ok) return null;
        blob = await resp.blob();
    } catch {
        return null;
    }
    try {
        const bitmap = await createImageBitmap(blob);
        const canvas = document.createElement("canvas");
        canvas.width = TILE_PX;
        canvas.height = TILE_PX;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) return null;
        ctx.drawImage(bitmap, 0, 0, TILE_PX, TILE_PX);
        bitmap.close?.();
        const { data } = ctx.getImageData(0, 0, TILE_PX, TILE_PX);
        const out = new Float32Array(TILE_PX * TILE_PX);
        for (let i = 0; i < TILE_PX * TILE_PX; i++) {
            const r = data[i * 4];
            const g = data[i * 4 + 1];
            const b = data[i * 4 + 2];
            out[i] = r * 256 + g + b / 256 - 32768;
        }
        return out;
    } catch {
        return null;
    }
}

export interface ElevationField {
    /** Sample elevation (metres) at a coordinate via nearest-grid
     *  lookup. Returns null when the point is outside the loaded
     *  tiles or fell on a no-data tile. */
    sample: (lng: number, lat: number) => number | null;
    /** The grid of sampled points, for building isobands. */
    points: Array<{ lng: number; lat: number; elevation: number }>;
}

/**
 * Fetch + decode the Terrarium tiles covering `bbox` and return an
 * ElevationField. Returns null when the bbox needs more than
 * MAX_ELEVATION_TILES (too large to be a play area) or when every tile
 * failed to load.
 */
export async function buildElevationField(
    bbox: Bbox,
): Promise<ElevationField | null> {
    const [w, s, e, n] = bbox;
    const z = ELEVATION_ZOOM;
    const x0 = lngToTileX(w, z);
    const x1 = lngToTileX(e, z);
    const y0 = latToTileY(n, z); // north → smaller y
    const y1 = latToTileY(s, z);
    const tileCount = (x1 - x0 + 1) * (y1 - y0 + 1);
    if (tileCount <= 0 || tileCount > MAX_ELEVATION_TILES) return null;

    const points: ElevationField["points"] = [];
    // Build a quick lookup grid keyed by integer (tileX, px, tileY, py)
    // isn't needed — for sampling we keep per-tile arrays + their tile
    // origin so we can locate a coordinate's nearest sample.
    const tiles: Array<{
        tx: number;
        ty: number;
        data: Float32Array;
    }> = [];

    const jobs: Promise<void>[] = [];
    for (let tx = x0; tx <= x1; tx++) {
        for (let ty = y0; ty <= y1; ty++) {
            jobs.push(
                decodeTile(z, tx, ty).then((data) => {
                    if (!data) return;
                    tiles.push({ tx, ty, data });
                    // Sample into the global point grid.
                    const lngLeft = tileXToLng(tx, z);
                    const lngRight = tileXToLng(tx + 1, z);
                    const latTop = tileYToLat(ty, z);
                    const latBottom = tileYToLat(ty + 1, z);
                    for (let py = 0; py < TILE_PX; py += SAMPLE_STRIDE) {
                        for (let px = 0; px < TILE_PX; px += SAMPLE_STRIDE) {
                            const elevation = data[py * TILE_PX + px];
                            const lng =
                                lngLeft +
                                ((px + 0.5) / TILE_PX) * (lngRight - lngLeft);
                            const lat =
                                latTop +
                                ((py + 0.5) / TILE_PX) * (latBottom - latTop);
                            points.push({ lng, lat, elevation });
                        }
                    }
                }),
            );
        }
    }
    await Promise.all(jobs);
    if (points.length === 0) return null;

    const sample = (lng: number, lat: number): number | null => {
        const tx = lngToTileX(lng, z);
        const ty = latToTileY(lat, z);
        const tile = tiles.find((t) => t.tx === tx && t.ty === ty);
        if (!tile) return null;
        const lngLeft = tileXToLng(tx, z);
        const lngRight = tileXToLng(tx + 1, z);
        const latTop = tileYToLat(ty, z);
        const latBottom = tileYToLat(ty + 1, z);
        const px = Math.min(
            TILE_PX - 1,
            Math.max(
                0,
                Math.round(((lng - lngLeft) / (lngRight - lngLeft)) * TILE_PX),
            ),
        );
        const py = Math.min(
            TILE_PX - 1,
            Math.max(
                0,
                Math.round(((lat - latTop) / (latBottom - latTop)) * TILE_PX),
            ),
        );
        return tile.data[py * TILE_PX + px];
    };

    return { sample, points };
}

/**
 * Build the "closer to sea level" elimination polygon for a sea-level
 * measuring question anchored at the seeker's (lat, lng).
 *
 * Returns:
 *   - a Polygon/MultiPolygon of the sub-seeker-altitude region (where
 *     the hider would be "closer to sea level"), OR
 *   - null when the elevation field couldn't be built (bbox too large,
 *     tiles unavailable) or the seeker's own altitude couldn't be
 *     sampled — the caller then skips auto-elimination.
 *
 * v969 (rulebook audit A5): "closer to sea level" is DISTANCE FROM sea
 * level — |elevation| — not signed elevation. The old `elevation <
 * seekerElevation` model mis-graded sub-sea-level terrain (a hider at
 * −50 m vs a seeker at +10 m is FARTHER from sea level, but −50 < 10
 * called them closer). Banding on |elevation| is identical to the old
 * behaviour wherever everything is above sea level (the overwhelming
 * majority of play areas) and correct in the Death-Valley/Dead-Sea case.
 */
export async function seaLevelRegion(
    bbox: Bbox,
    seekerLng: number,
    seekerLat: number,
): Promise<Feature<Polygon | MultiPolygon> | null> {
    const field = await buildElevationField(bbox);
    if (!field) return null;

    const seekerElevation = field.sample(seekerLng, seekerLat);
    if (seekerElevation === null || !Number.isFinite(seekerElevation)) {
        return null;
    }
    const seekerAbs = Math.abs(seekerElevation);

    // Assemble a turf point FeatureCollection with |elevation| props —
    // the metric the question actually compares.
    const fc = turf.featureCollection(
        field.points.map((p) =>
            turf.point([p.lng, p.lat], {
                absElevation: Math.abs(p.elevation),
            }),
        ),
    );

    // isobands needs a value range. Use the data's |min|/|max| bracketing
    // the seeker's |elevation|. If the seeker sits at an extreme of the
    // local range there's nothing to cut (everything is on one side),
    // so bail to null.
    let min = Infinity;
    let max = -Infinity;
    for (const p of field.points) {
        const abs = Math.abs(p.elevation);
        if (abs < min) min = abs;
        if (abs > max) max = abs;
    }
    if (
        seekerAbs <= min + 1 ||
        seekerAbs >= max - 1 ||
        !Number.isFinite(min) ||
        !Number.isFinite(max)
    ) {
        return null;
    }

    let bands;
    try {
        bands = turf.isobands(fc as any, [min - 1, seekerAbs, max + 1], {
            zProperty: "absElevation",
        });
    } catch {
        return null;
    }

    // isobands emits one MultiPolygon feature per band, tagged with the
    // band range string in `absElevation`. The lower band is the
    // "closer to sea level" region.
    const lowerKey = `${min - 1}-${seekerAbs}`;
    const lower =
        (bands.features.find(
            (f: any) => f.properties?.absElevation === lowerKey,
        ) as Feature<Polygon | MultiPolygon> | undefined) ??
        // Band labelling varies slightly by turf version — fall back to
        // taking the first feature, which is the lowest band.
        (bands.features[0] as Feature<Polygon | MultiPolygon> | undefined);
    if (!lower) return null;

    // v1131: a BODY OF WATER is at sea level (|elevation| = 0 = the closest
    // any point can be), so it MUST be inside the "closer to sea level"
    // region — never "further". The coarse DEM grid (~600 m samples) plus
    // isoband interpolation across a narrow channel (NYC's East River) can
    // otherwise carve part of the water out (the reported "water marked
    // further"). Fold the basemap water polygons (captured off the map, the
    // SAME source body-of-water uses) into the closer region so open water
    // always reads as closer to sea level. No capture yet → the DEM result
    // stands (best-effort, never worse).
    return unionWater(lower, bbox);
}

/** Union the "closer to sea level" region with any captured basemap water
 *  in the bbox — water is at sea level, so it's always closer. */
function unionWater(
    region: Feature<Polygon | MultiPolygon>,
    bbox: Bbox,
): Feature<Polygon | MultiPolygon> {
    const water = getBasemapWaterPolys(bbox);
    if (!water || water.length === 0) return region;
    let acc = region;
    for (const w of water) {
        try {
            const u = turf.union(turf.featureCollection([acc as any, w as any]));
            if (u) acc = u as Feature<Polygon | MultiPolygon>;
        } catch {
            /* skip a malformed water polygon */
        }
    }
    return acc;
}
