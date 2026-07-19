import * as turf from "@turf/turf";
import type { Feature, MultiPolygon, Polygon } from "geojson";
import type { MapGeoJSONFeature, Map as MaplibreMap } from "maplibre-gl";
import { atom } from "nanostores";
import type { MapRef } from "react-map-gl/maplibre";

import { mapGeoLocation, polyGeoJSON } from "@/lib/context";
import { playAreaSignature } from "@/maps/geo-utils/playAreaIndex";

/**
 * v998: read LAND vs WATER from the basemap itself.
 *
 * The Protomaps basemap we already ship offline (the pmtiles / tile pack)
 * carries a `water` source-layer whose polygons are the OCEAN, seas, bays,
 * lakes and wide rivers — correctly assembled by Protomaps' pipeline (the same
 * OSM water-polygons a renderer uses), including the open sea as a real polygon.
 * That is the authoritative land/water map, and it's already downloaded.
 *
 * This module reads those polygons straight off a loaded MapLibre map (the same
 * `querySourceFeatures` pattern the hider POI overlay uses for the `pois`
 * layer) and caches them per play area, so the body-of-water measuring question
 * can buffer the REAL water — no fragile `natural=coastline` line assembly, no
 * flood-fill, no polygonize. `querySourceFeatures` returns geometry already in
 * lng/lat, clipped per rendered tile; a feature spanning tiles appears once per
 * tile and the pieces union back together when buffered, so we just accumulate
 * every polygon we see across map `idle`s.
 *
 * Consumers: `measuring.ts` body-of-water (the buffered water set) and, through
 * it, the shared configure-preview overlay (`questionImpact.ts`).
 */

const SOURCE_ID = "protomaps";
const WATER_LAYER = "water";

/** Bumped on every capture that adds new water polygons, so a consumer that
 *  computed before the basemap tiles loaded can recompute once they arrive. */
export const basemapWaterVersion = atom(0);

interface WaterEntry {
    polys: Feature<Polygon | MultiPolygon>[];
    keys: Set<string>;
}

// Small bounded cache keyed by play area (a couple of recent areas is plenty).
const cache = new Map<string, WaterEntry>();
const MAX_ENTRIES = 4;

/** The play-area identity — SAME expression the measuring memo key uses, so the
 *  capture side and the read side always agree on the cache key. */
function playAreaKey(): string {
    const poly = polyGeoJSON.get();
    if (poly) return `poly:${playAreaSignature(poly)}`;
    const osm = mapGeoLocation.get()?.properties?.osm_id;
    return osm != null ? `osm:${osm}` : "none";
}

/** A cheap dedupe key for a captured polygon: its first ring vertex + a coarse
 *  vertex count, so the same tile-piece re-seen on a later idle isn't stored
 *  twice (cross-tile pieces of one feature stay distinct — that's fine, they
 *  union when buffered). */
function geomKey(g: Polygon | MultiPolygon): string {
    let first: number[] | undefined;
    let count = 0;
    if (g.type === "Polygon") {
        first = g.coordinates[0]?.[0];
        for (const ring of g.coordinates) count += ring.length;
    } else {
        first = g.coordinates[0]?.[0]?.[0];
        for (const poly of g.coordinates)
            for (const ring of poly) count += ring.length;
    }
    const fx = first ? `${first[0].toFixed(5)},${first[1].toFixed(5)}` : "?";
    return `${g.type}:${fx}:${count}`;
}

/**
 * Read the basemap water polygons currently loaded on `map` and accumulate them
 * into the current play area's cache entry. Cheap + guarded — safe to call on
 * every map `idle`. Bumps `basemapWaterVersion` only when new polygons land.
 */
export function captureBasemapWater(map: MaplibreMap): void {
    try {
        if (!map.getSource(SOURCE_ID)) return;
        let raw: MapGeoJSONFeature[];
        try {
            raw = map.querySourceFeatures(SOURCE_ID, {
                sourceLayer: WATER_LAYER,
            }) as MapGeoJSONFeature[];
        } catch {
            return;
        }
        if (!raw || raw.length === 0) return;

        const key = playAreaKey();
        if (key === "none") return;
        let entry = cache.get(key);
        if (!entry) {
            entry = { polys: [], keys: new Set() };
            // Evict the oldest if we're over the small cap.
            if (cache.size >= MAX_ENTRIES) {
                const oldest = cache.keys().next().value;
                if (oldest !== undefined) cache.delete(oldest);
            }
            cache.set(key, entry);
        }

        let added = false;
        for (const f of raw) {
            const g = f.geometry;
            if (
                !g ||
                (g.type !== "Polygon" && g.type !== "MultiPolygon")
            )
                continue;
            const gk = geomKey(g as Polygon | MultiPolygon);
            if (entry.keys.has(gk)) continue;
            entry.keys.add(gk);
            // Keep the `name`/`kind` from the tile — Protomaps tags named lakes
            // / rivers, and `kind` distinguishes ocean/lake/river — so the
            // nearest-water LABEL can name the body (or say "Shoreline"/"Water").
            const props = (f.properties ?? {}) as Record<string, unknown>;
            entry.polys.push({
                type: "Feature",
                properties: {
                    name: typeof props.name === "string" ? props.name : undefined,
                    kind: typeof props.kind === "string" ? props.kind : undefined,
                },
                geometry: g as Polygon | MultiPolygon,
            });
            added = true;
        }
        if (added) basemapWaterVersion.set(basemapWaterVersion.get() + 1);
    } catch {
        /* never throw from a map idle handler */
    }
}

/**
 * The accumulated basemap water polygons for the current play area (optionally
 * only those intersecting `bbox`), or null if nothing has been captured yet
 * (no map has loaded the area). Returned features are plain water polygons; the
 * caller buffers them by the seeker's nearest-water distance.
 */
export function getBasemapWaterPolys(
    bbox?: [number, number, number, number],
): Feature<Polygon | MultiPolygon>[] | null {
    const entry = cache.get(playAreaKey());
    if (!entry || entry.polys.length === 0) return null;
    if (!bbox) return entry.polys;
    const frame = turf.bboxPolygon(bbox);
    const kept: Feature<Polygon | MultiPolygon>[] = [];
    for (const p of entry.polys) {
        try {
            if (turf.booleanIntersects(p, frame)) kept.push(p);
        } catch {
            kept.push(p); // keep on a predicate error rather than drop water
        }
    }
    return kept.length > 0 ? kept : null;
}

/**
 * Nearest basemap-water body to a point — the SAME source the body-of-water
 * elimination buffers, so the nearest-reference LABEL and the overlay agree by
 * construction. Returns the closest point on any water polygon (distance 0 if
 * the point is inside water), its name if the tile carries one (else
 * "Shoreline" for the sea / "Water"), and the distance in metres. `null` if no
 * basemap water is captured for the play area yet.
 */
export function nearestBasemapWater(
    lat: number,
    lng: number,
): { name: string; lat: number; lng: number; distanceMeters: number } | null {
    const entry = cache.get(playAreaKey());
    if (!entry || entry.polys.length === 0) return null;
    const pt = turf.point([lng, lat]);
    let best: {
        name: string;
        lat: number;
        lng: number;
        distanceMeters: number;
    } | null = null;
    for (const w of entry.polys) {
        try {
            const props = (w.properties ?? {}) as {
                name?: string;
                kind?: string;
            };
            const name =
                props.name ||
                (props.kind === "ocean" || props.kind === "sea"
                    ? "Shoreline"
                    : "Water");
            // Inside the water → distance 0, reference point is the seeker.
            if (turf.booleanPointInPolygon(pt, w)) {
                return { name, lat, lng, distanceMeters: 0 };
            }
            const line = turf.polygonToLine(w as never) as
                | GeoJSON.Feature<GeoJSON.LineString | GeoJSON.MultiLineString>
                | GeoJSON.FeatureCollection;
            const lines =
                line.type === "FeatureCollection" ? line.features : [line];
            for (const l of lines) {
                const nearest = turf.nearestPointOnLine(l as never, pt);
                const d = turf.distance(pt, nearest, { units: "meters" });
                if (!best || d < best.distanceMeters) {
                    const c = nearest.geometry.coordinates as [number, number];
                    best = {
                        name,
                        lat: c[1],
                        lng: c[0],
                        distanceMeters: d,
                    };
                }
            }
        } catch {
            /* skip a malformed water polygon */
        }
    }
    return best;
}

/** True once any basemap water has been captured for the current play area. */
export function hasBasemapWater(): boolean {
    const entry = cache.get(playAreaKey());
    return !!entry && entry.polys.length > 0;
}

/**
 * Attach a water-capture handler to a MapLibre map. Captures on the map's first
 * idle and on every subsequent idle (tiles load progressively; a pan/zoom loads
 * more). Returns a cleanup that detaches the handler. Intended to be called
 * from a map component's load effect.
 */
export function attachBasemapWaterCapture(map: MaplibreMap): () => void {
    const onIdle = () => captureBasemapWater(map);
    // The play area can change between games; a fresh capture just writes into
    // the new play area's cache entry (keyed by playAreaKey), so no reset here.
    map.on("idle", onIdle);
    // Capture immediately in case the map is already idle.
    captureBasemapWater(map);
    return () => {
        map.off("idle", onIdle);
    };
}

/** Convenience for callers that hold a react-map-gl MapRef. */
export function attachBasemapWaterCaptureRef(ref: MapRef | null): () => void {
    const map = ref?.getMap();
    if (!map) return () => {};
    return attachBasemapWaterCapture(map as unknown as MaplibreMap);
}
