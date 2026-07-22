/**
 * Per-city OSM `natural=coastline` geometry for the coast-dependent
 * question types (v776 prewarm; v778 full migration).
 *
 * OSM tags the open sea + large bays + tidal reaches as `natural=coastline`
 * (a LINE), NOT `natural=water`, so a coastal metro's real coast is invisible
 * to the `natural=water` query. Per the rulebook, only references WITHIN the
 * play area exist, so the coast that matters is exactly the coast inside the
 * play area — which is precisely what per-city OSM coastline gives us, and at
 * full OSM detail (the bundled Natural Earth 1:50m coastline is far too coarse
 * for a metro like NYC: it smears the harbour/tidal rivers into one blob).
 *
 * Fetch chain (v778): prewarmed `/api/coast/<id>` from R2 (warm cities, zero
 * live Overpass) → a live `way["natural"="coastline"]` Overpass query over the
 * play-area polygon (cold cities) → the bundled 1:50m `coastline50.geojson`
 * (kept as a last-resort fallback in each CONSUMER, so nothing breaks when
 * per-city coast is unavailable or degenerate).
 *
 * `fetchAreaCoastlineLines()` returns the raw coastline LINES; consumers that
 * need land/sea AREAS (`same-landmass`, the `coastline` subtype, body-of-water)
 * close them against the play-area frame via `seaFromCoastline` /
 * `fetchAreaLandPolygons`.
 */

import * as turf from "@turf/turf";
import type {
    Feature,
    LineString,
    MultiLineString,
    MultiPolygon,
    Polygon,
} from "geojson";
import osmtogeojson from "osmtogeojson";

import {
    additionalMapGeoLocations,
    mapGeoJSON,
    mapGeoLocation,
} from "@/lib/context";
import { landFromCoast as landFromCoastViaWorker } from "@/lib/geometry/client";
import { safeJsonFromCachedResponse } from "@/maps/api/cache";
import { COAST_BY_RELATION_BASE } from "@/maps/api/constants";
import { getOverpassData } from "@/maps/api/overpass";
import { seaFromCoastline } from "@/maps/questions/seaFromCoastline";

/** Raw Overpass element (way with `out geom` geometry). */
interface OverpassElement {
    type?: string;
    id?: number;
    [k: string]: unknown;
}

function primaryRelationId(): number | null {
    const p = mapGeoLocation.get()?.properties as
        | { osm_id?: number; osm_type?: string }
        | undefined;
    if (p?.osm_type === "R" && typeof p.osm_id === "number" && p.osm_id > 0) {
        return p.osm_id;
    }
    return null;
}

function playAreaRelationIdsAll(): number[] {
    const ids: number[] = [];
    const primary = primaryRelationId();
    if (primary !== null) ids.push(primary);
    for (const e of additionalMapGeoLocations.get()) {
        if (!e.added) continue;
        const p = e.location?.properties as
            | { osm_id?: number; osm_type?: string }
            | undefined;
        if (
            p?.osm_type === "R" &&
            typeof p.osm_id === "number" &&
            p.osm_id > 0 &&
            !ids.includes(p.osm_id)
        ) {
            ids.push(p.osm_id);
        }
    }
    return ids;
}

/** Fetch one relation's prewarmed coastline geometry. Returns null on a
 *  MISS (the `cache` marker — not warmed yet — or an error/!ok) so callers
 *  can distinguish "cold" from a warmed-but-empty (inland) area. */
async function fetchPrewarmedCoast(
    relationId: number,
): Promise<OverpassElement[] | null> {
    try {
        const resp = await fetch(`${COAST_BY_RELATION_BASE}/${relationId}`);
        if (!resp.ok) return null;
        const data = (await safeJsonFromCachedResponse(resp)) as {
            elements?: OverpassElement[];
            cache?: string;
        };
        if (data?.cache) return null;
        return data?.elements ?? [];
    } catch {
        return null;
    }
}

const coastWarmRequested = new Set<number>();

function requestCoastWarm(relationId: number): void {
    if (coastWarmRequested.has(relationId)) return;
    coastWarmRequested.add(relationId);
    void fetch(`${COAST_BY_RELATION_BASE}/${relationId}?warm=1`).catch(() => {
        coastWarmRequested.delete(relationId);
    });
}

/**
 * Fan the prewarmed coastline endpoint over EVERY play-area relation and
 * return the unioned elements — but ONLY when every area is warm. If ANY
 * area is cold, returns null: the caller background-warms the cold ids
 * (done here) and falls back to the bundled 1:50m coastline. Elements are
 * deduped by `type/id`.
 */
export async function fetchPrewarmedAreaCoast(): Promise<{
    elements: OverpassElement[];
} | null> {
    const ids = playAreaRelationIdsAll();
    if (ids.length === 0) return null;
    const results = await Promise.all(
        ids.map((id) => fetchPrewarmedCoast(id)),
    );
    if (results.some((r) => r === null)) {
        ids.forEach((id, i) => {
            if (results[i] === null) requestCoastWarm(id);
        });
        return null;
    }
    const seen = new Set<string>();
    const merged: OverpassElement[] = [];
    for (const el of results.flatMap((r) => r as OverpassElement[])) {
        const key = `${el.type ?? "?"}/${el.id ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(el);
    }
    return { elements: merged };
}

/** Warm the coastline set for EVERY play-area relation. Called after a
 *  body-of-water question falls back to the 1:50m sea, so the NEXT one gets
 *  the detailed sea. Deduped per session. */
export function requestCoastWarmAll(): void {
    for (const id of playAreaRelationIdsAll()) requestCoastWarm(id);
}

/* ── v778: full migration — per-city coastline lines + land polygons ─── */

/** osmtogeojson the raw elements and keep only the (Multi)LineString coast. */
function linesFromElements(
    elements: OverpassElement[],
): Feature<LineString | MultiLineString>[] {
    if (!elements || elements.length === 0) return [];
    const geo = osmtogeojson({ elements } as never);
    return geo.features.filter(
        (f) =>
            f.geometry?.type === "LineString" ||
            f.geometry?.type === "MultiLineString",
    ) as Feature<LineString | MultiLineString>[];
}

let _coastLinesCache: {
    key: string;
    promise: Promise<Feature<LineString | MultiLineString>[] | null>;
} | null = null;

async function computeAreaCoastlineLines(): Promise<
    Feature<LineString | MultiLineString>[] | null
> {
    // 1. Prewarmed per-city coast from R2 (warm cities). A non-null result —
    //    INCLUDING an empty array (warm inland city, genuinely no coast) — is
    //    authoritative; only a cold/error result (null) falls through.
    const prewarmed = await fetchPrewarmedAreaCoast();
    if (prewarmed) return linesFromElements(prewarmed.elements);

    // 2. Live Overpass over the play-area BBOX (cold cities). v876: MUST be a
    //    bbox query, NOT the land-clipped `poly:` query — the play-area polygon
    //    is clipped to land + simplified INWARD, and OSM `natural=coastline`
    //    ways trace that exact waterline, so a `poly:` filter EXCLUDES the
    //    tidal-river/harbour coastline (NYC's East River etc.) that sits on/just
    //    outside the boundary → the sea was invisible to body-of-water +
    //    coastline, which then degraded to the coarse 1:50m bundle. A bbox
    //    (2 km-padded, matching the `/api/coast/<id>` prewarm builder) catches
    //    it. `fetchPrewarmedAreaCoast` already fired `?warm=1` for the cold ids,
    //    so the NEXT game is served from R2.
    const $map = mapGeoJSON.get();
    if (!$map) return [];
    let bb: [number, number, number, number];
    try {
        bb = turf.bbox($map).slice(0, 4) as [number, number, number, number];
    } catch {
        return null;
    }
    const PAD = 0.02; // ~2 km
    const query =
        `[out:json][timeout:90];` +
        `way["natural"="coastline"](${bb[1] - PAD},${bb[0] - PAD},${bb[3] + PAD},${bb[2] + PAD});` +
        `out geom;`;
    try {
        const data = await getOverpassData(query, undefined);
        return linesFromElements(
            (data as { elements?: OverpassElement[] })?.elements ?? [],
        );
    } catch (e) {
        console.warn("[coast] live coastline fetch failed:", e);
        return null; // → consumer falls back to the bundled 1:50m coastline
    }
}

/**
 * Per-city OSM coastline LINES for the current play area (primary + added
 * adjacents), preferring the prewarmed R2 endpoint and falling back to a live
 * play-area Overpass query. Returns `null` ONLY when per-city coast can't be
 * obtained at all (Overpass failure) — the caller then falls back to the
 * bundled 1:50m coastline. A warm-but-inland area resolves to `[]` (no coast),
 * NOT null, so an inland city doesn't pointlessly retry live.
 *
 * The successful result is cached per (relation-id set) for the session so the
 * network fetch runs once; a `null` failure is evicted so a retry re-fetches.
 */
export async function fetchAreaCoastlineLines(): Promise<
    Feature<LineString | MultiLineString>[] | null
> {
    const ids = playAreaRelationIdsAll();
    const key = ids.slice().sort((a, b) => a - b).join(",") || "none";
    if (_coastLinesCache && _coastLinesCache.key === key) {
        return _coastLinesCache.promise;
    }
    const promise = computeAreaCoastlineLines();
    _coastLinesCache = { key, promise };
    // Don't cache a transient failure — evict so the next call re-fetches.
    void promise
        .then((r) => {
            if (r === null && _coastLinesCache?.promise === promise) {
                _coastLinesCache = null;
            }
        })
        .catch(() => {
            if (_coastLinesCache?.promise === promise) _coastLinesCache = null;
        });
    return promise;
}

/**
 * Per-city LAND polygons for the current play area — the play-area frame MINUS
 * the sea that `seaFromCoastline` builds from the OSM coastline. Each separate
 * part of the returned (Multi)Polygon is a distinct landmass within the frame,
 * which is exactly what `same-landmass` needs, and its boundary is the coast,
 * which is what the `coastline` subtype measures distance to.
 *
 * Returns `null` when per-city coast is unavailable OR the sea build is
 * degenerate/guard-rejected (inland frame, inverted winding, seeker-in-sea) —
 * the caller then falls back to closing the bundled 1:50m coastline into land,
 * so behaviour is unchanged where per-city coast can't be trusted.
 */
export async function fetchAreaLandPolygons(seeker: {
    lat: number;
    lng: number;
}): Promise<Feature<Polygon | MultiPolygon> | null> {
    const $map = mapGeoJSON.get();
    if (!$map) return null;
    let bbox: [number, number, number, number];
    try {
        bbox = turf.bbox($map).slice(0, 4) as [
            number,
            number,
            number,
            number,
        ];
    } catch {
        return null;
    }

    const lines = await fetchAreaCoastlineLines();
    if (!lines || lines.length === 0) return null;

    // v875: run the heavy seaFromCoastline + world-frame difference OFF the
    // main thread so a dense coastal metro (NYC harbour + tidal rivers) can't
    // freeze the UI here. The worker REJECTS when unavailable → the identical
    // main-thread computation below is the fallback (correctness never depends
    // on the worker existing).
    try {
        return await landFromCoastViaWorker(lines, bbox, {
            lat: seeker.lat,
            lng: seeker.lng,
        });
    } catch {
        /* worker unavailable / errored — main-thread fallback below */
    }

    const sea = seaFromCoastline(lines, bbox, {
        lng: seeker.lng,
        lat: seeker.lat,
    });
    if (!sea) return null;

    try {
        const frame = turf.bboxPolygon(bbox);
        const land = turf.difference(
            turf.featureCollection([frame, sea] as never),
        ) as Feature<Polygon | MultiPolygon> | null;
        if (!land || !land.geometry) return null;
        if (turf.area(land) <= 0) return null;
        return land;
    } catch {
        return null;
    }
}
