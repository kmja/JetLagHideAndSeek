/**
 * Prewarmed named-water-body geometry for the measuring body-of-water
 * elimination (v687).
 *
 * The body-of-water measuring question cuts the map by seeker-distance to
 * the nearest named lake / river / canal shore. Computing that needs the
 * full `out geom` water geometry — the single heaviest reference family in
 * a dense metro (the reason it's isolated from the combined refs query,
 * v632). On a cold play area the client ran it live against Overpass, where
 * it routinely soft-timed-out (Paris) — the same class of failure the
 * hiding-zone station prewarm (v668) fixed for the station field.
 *
 * This module mirrors the station prewarm exactly: it reads the
 * relation-id-keyed `/api/water/<id>` endpoint (the worker derives the bbox
 * from the boundary it already has and serves the `out geom` water set from
 * R2), fanned over EVERY play-area relation (primary + each added adjacent
 * area) and unioned. On any cold area it background-warms the cold ids and
 * declines, so the caller (`measuring.ts`) falls back to its live poly
 * query — which covers the whole union. A warm city never touches Overpass.
 */

import {
    additionalMapGeoLocations,
    mapGeoLocation,
} from "@/lib/context";
import { WATER_BY_RELATION_BASE } from "@/maps/api/constants";

/** Raw Overpass element (node/way/relation with `out geom` geometry). */
interface OverpassElement {
    type?: string;
    id?: number;
    [k: string]: unknown;
}

/** The primary play-area OSM relation id, or null for a custom-drawn /
 *  non-relation play area (which has no prewarm entry to hit). Mirrors
 *  `primaryRelationId` in stations.ts. */
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
 *  area. Mirrors `playAreaRelationIdsAll` in stations.ts so water is fanned
 *  over the same set as the station field. */
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

/** Fetch one relation's prewarmed water geometry. Returns null on a MISS
 *  (the endpoint's `cache` marker — not warmed yet — or an error/!ok) so
 *  callers can distinguish "cold" from a warmed-but-empty area (`[]`, no
 *  marker). Read-only — the worker never goes upstream on this path. */
async function fetchPrewarmedWater(
    relationId: number,
): Promise<OverpassElement[] | null> {
    try {
        const resp = await fetch(`${WATER_BY_RELATION_BASE}/${relationId}`);
        if (!resp.ok) return null;
        const data = (await resp.json()) as {
            elements?: OverpassElement[];
            cache?: string;
        };
        if (data?.cache) return null;
        return data?.elements ?? [];
    } catch {
        return null;
    }
}

/** Relation ids we've asked the worker to warm this session, so a warm
 *  fires once per relation, not on every fetch. */
const waterWarmRequested = new Set<number>();

/** Fire a background warm of a relation's water set on the worker.
 *  Fire-and-forget; deduped per session. */
function requestWaterWarm(relationId: number): void {
    if (waterWarmRequested.has(relationId)) return;
    waterWarmRequested.add(relationId);
    void fetch(`${WATER_BY_RELATION_BASE}/${relationId}?warm=1`).catch(() => {
        waterWarmRequested.delete(relationId);
    });
}

/**
 * Fan the prewarmed water endpoint over EVERY play-area relation (primary +
 * each added adjacent area) and return the unioned elements — but ONLY when
 * every area is warm. If ANY area is cold, returns null: the caller
 * background-warms the cold ids (done here) and uses the live poly query,
 * which covers the whole union. Elements are deduped by `type/id` so a
 * river shared across two bbox supersets isn't double-buffered.
 *
 * The returned set is a small BBOX SUPERSET of the play area (a 2 km pad,
 * matching the worker query) — deliberately NOT culled to the polygon: a
 * shore just outside the boundary is still the nearest body of water
 * (rulebook p17), and the elimination buffers geometry anyway.
 */
export async function fetchPrewarmedAreaWater(): Promise<{
    elements: OverpassElement[];
} | null> {
    const ids = playAreaRelationIdsAll();
    if (ids.length === 0) return null;
    const results = await Promise.all(
        ids.map((id) => fetchPrewarmedWater(id)),
    );
    if (results.some((r) => r === null)) {
        ids.forEach((id, i) => {
            if (results[i] === null) requestWaterWarm(id);
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

/** Warm the water set for EVERY play-area relation (primary + added
 *  adjacent areas). Called after a live poly fetch so the next
 *  body-of-water question is served from R2. Deduped per session. */
export function requestWaterWarmAll(): void {
    for (const id of playAreaRelationIdsAll()) requestWaterWarm(id);
}
