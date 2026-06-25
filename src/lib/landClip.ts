import type { Feature, FeatureCollection, MultiPolygon, Polygon } from "geojson";

import {
    clipPolygonToLandWith,
    parseLakePolys,
    parseLandPolys,
    type LakePoly,
    type LandPoly,
} from "@/lib/geometry/clipCore";
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
 * surface. Lakeside admin areas legally include their slice of the
 * lake (Lausanne into Lac Léman, Chicago into Lake Michigan), so we
 * subtract major lakes too.
 *
 * This is the MAIN-THREAD path — kept as the fallback for the geometry
 * Web Worker (`@/lib/geometry/client.ts`). The actual clip algorithm
 * lives in `@/lib/geometry/clipCore.ts` (pure turf, no I/O) so the
 * worker and this module run identical logic; here we just own the data
 * loading (cacheFetch + PERMANENT_CACHE, memoized once per session).
 *
 * Data sources: `public/coastline50.geojson` (NE 1:50m coastline) and
 * `public/lakes50.geojson` (NE 1:50m lakes). See clipCore for the
 * parsing/orientation details.
 */

let landPolysPromise: Promise<LandPoly[]> | null = null;

async function loadLandPolys(): Promise<LandPoly[]> {
    if (landPolysPromise) return landPolysPromise;
    landPolysPromise = (async () => {
        const url = (import.meta.env.BASE_URL ?? "/") + "coastline50.geojson";
        const resp = await cacheFetch(
            url,
            undefined,
            CacheType.PERMANENT_CACHE,
        );
        const fc = (await resp.json()) as FeatureCollection;
        return parseLandPolys(fc);
    })();
    return landPolysPromise;
}

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
        return parseLakePolys(fc);
    })();
    return lakePolysPromise;
}

/**
 * Clip a play-area polygon (Polygon or MultiPolygon) to land only.
 * Returns the clipped geometry as a Feature, or `null` if the input
 * was malformed / the clip pipeline failed (caller should treat as
 * "leave the original polygon alone"). Best-effort and safe — never
 * throws.
 *
 * NOTE: this runs the turf work synchronously on the main thread. For
 * large areas prefer `@/lib/geometry/client.ts`'s `clipPolygonToLand`,
 * which delegates to the Web Worker and falls back here.
 */
export async function clipPolygonToLand(
    polygon: Feature<Polygon | MultiPolygon>,
): Promise<Feature<Polygon | MultiPolygon> | null> {
    try {
        const land = await loadLandPolys();
        // Lakes are best-effort — a clip without lake subtraction is
        // still correct, just keeps inland water.
        let lakes: LakePoly[] = [];
        try {
            lakes = await loadLakePolys();
        } catch (e) {
            console.warn("loadLakePolys failed; skipping lake subtraction", e);
        }
        return clipPolygonToLandWith(polygon, land, lakes);
    } catch (e) {
        console.warn("clipPolygonToLand failed:", e);
        return null;
    }
}
