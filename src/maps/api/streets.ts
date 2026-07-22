/**
 * Prewarmed NAMED-highway geometry for the matching same-street question
 * (v992).
 *
 * The same-street question keys on the geometry of every OSM way sharing the
 * seeker's nearest-street NAME. The old design found that nearest street with
 * a position-keyed `way["highway"](around:500,lat,lng)` query — the exact
 * coords make a unique query string, so it could NEVER cache and hit live
 * Overpass on EVERY same-street question (the rate-limit-and-fail risk).
 *
 * This module mirrors the water/coast prewarm exactly: it reads the
 * relation-id-keyed `/api/streets/<id>` endpoint (the worker derives the bbox
 * from the boundary it already has and serves the named-highway `out geom` set
 * from R2), fanned over EVERY play-area relation (primary + each added
 * adjacent area) and unioned. On any cold area it background-warms the cold
 * ids and declines, so the caller (`matching.ts`) falls back to its live
 * cacheable poly query. A warm city never touches Overpass.
 */

import {
    additionalMapGeoLocations,
    mapGeoLocation,
} from "@/lib/context";
import { safeJsonFromCachedResponse } from "@/maps/api/cache";
import { STREETS_BY_RELATION_BASE } from "@/maps/api/constants";

/** Raw Overpass element (a highway `way` with `out geom` geometry + node ids
 *  + tags). */
export interface OverpassStreetElement {
    type?: string;
    id?: number;
    geometry?: Array<{ lat: number; lon: number }>;
    nodes?: number[];
    tags?: Record<string, string>;
    [k: string]: unknown;
}

/** The primary play-area OSM relation id, or null for a custom-drawn /
 *  non-relation play area. Mirrors `primaryRelationId` in water.ts. */
function primaryRelationId(): number | null {
    const p = mapGeoLocation.get()?.properties as
        | { osm_id?: number; osm_type?: string }
        | undefined;
    if (p?.osm_type === "R" && typeof p.osm_id === "number" && p.osm_id > 0) {
        return p.osm_id;
    }
    return null;
}

/** Every play-area OSM relation id — the primary PLUS each ADDED adjacent
 *  area. Mirrors `playAreaRelationIdsAll` in water.ts. */
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

/** Fetch one relation's prewarmed named-highway geometry. Returns null on a
 *  MISS (the endpoint's `cache` marker — not warmed yet — or an error/!ok) so
 *  callers distinguish "cold" from a warmed-but-empty area. Read-only. */
async function fetchPrewarmedStreets(
    relationId: number,
): Promise<OverpassStreetElement[] | null> {
    try {
        const resp = await fetch(`${STREETS_BY_RELATION_BASE}/${relationId}`);
        if (!resp.ok) return null;
        const data = (await safeJsonFromCachedResponse(resp)) as {
            elements?: OverpassStreetElement[];
            cache?: string;
        };
        if (data?.cache) return null;
        return data?.elements ?? [];
    } catch {
        return null;
    }
}

/** Relation ids we've asked the worker to warm this session, so a warm fires
 *  once per relation, not on every fetch. */
const streetsWarmRequested = new Set<number>();

function requestStreetsWarm(relationId: number): void {
    if (streetsWarmRequested.has(relationId)) return;
    streetsWarmRequested.add(relationId);
    void fetch(`${STREETS_BY_RELATION_BASE}/${relationId}?warm=1`).catch(() => {
        streetsWarmRequested.delete(relationId);
    });
}

/**
 * Fan the prewarmed streets endpoint over EVERY play-area relation (primary +
 * each added adjacent area) and return the unioned raw elements — but ONLY
 * when every area is warm. If ANY area is cold, returns null: the caller
 * background-warms the cold ids (done here) and uses the live poly query.
 * Elements are deduped by `type/id`.
 */
export async function fetchPrewarmedAreaStreets(): Promise<
    OverpassStreetElement[] | null
> {
    const ids = playAreaRelationIdsAll();
    if (ids.length === 0) return null;
    const results = await Promise.all(
        ids.map((id) => fetchPrewarmedStreets(id)),
    );
    if (results.some((r) => r === null)) {
        ids.forEach((id, i) => {
            if (results[i] === null) requestStreetsWarm(id);
        });
        return null;
    }
    const seen = new Set<string>();
    const merged: OverpassStreetElement[] = [];
    for (const el of results.flatMap((r) => r as OverpassStreetElement[])) {
        const key = `${el.type ?? "?"}/${el.id ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(el);
    }
    return merged;
}

/** Warm the streets set for EVERY play-area relation. Called after a live
 *  poly fetch so the next same-street question is served from R2. */
export function requestStreetsWarmAll(): void {
    for (const id of playAreaRelationIdsAll()) requestStreetsWarm(id);
}
