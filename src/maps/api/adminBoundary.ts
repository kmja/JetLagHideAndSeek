/**
 * Prewarmed admin-boundary geometry for the matching zone / letter-zone /
 * admin-division question (v830).
 *
 * `findAdminBoundary` (overpass.ts) needs the administrative boundary at a
 * given OSM `admin_level` that CONTAINS a point (the seeker's reference or
 * the hider's live GPS). v826 made that an area-keyed poly query (cacheable
 * per game), but a warm city STILL ran it live once per game per level —
 * the reported "1st admin border" Overpass error even in a prewarmed NYC.
 *
 * This module mirrors water.ts / coast.ts exactly: it reads the
 * relation-id-keyed `/api/admin/<id>/<level>` endpoint (the worker derives
 * the bbox from the boundary it already has and serves the `out geom` admin
 * set from R2), fanned over EVERY play-area relation (primary + each added
 * adjacent area) and unioned. On any cold area it background-warms the cold
 * ids and declines (null), so the caller falls back to its live poly query.
 * A warm city never touches Overpass for the admin question.
 */

import {
    additionalMapGeoLocations,
    mapGeoLocation,
} from "@/lib/context";
import { ADMIN_BY_RELATION_BASE } from "@/maps/api/constants";

/** Raw Overpass element (relation with `out geom` geometry). */
interface OverpassElement {
    type?: string;
    id?: number;
    [k: string]: unknown;
}

/** Every play-area OSM relation id — the primary PLUS each ADDED adjacent
 *  area. Mirrors `playAreaRelationIdsAll` in water.ts / stations.ts. */
function playAreaRelationIdsAll(): number[] {
    const ids: number[] = [];
    const primaryProps = mapGeoLocation.get()?.properties as
        | { osm_id?: number; osm_type?: string }
        | undefined;
    if (
        primaryProps?.osm_type === "R" &&
        typeof primaryProps.osm_id === "number" &&
        primaryProps.osm_id > 0
    ) {
        ids.push(primaryProps.osm_id);
    }
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

/** Fetch one relation's prewarmed admin geometry at a level. Returns null
 *  on a MISS (the endpoint's `cache` marker — not warmed yet — or !ok) so
 *  callers distinguish "cold" from a warmed-but-empty area (`[]`). */
async function fetchPrewarmedAdmin(
    relationId: number,
    level: number,
): Promise<OverpassElement[] | null> {
    try {
        const resp = await fetch(
            `${ADMIN_BY_RELATION_BASE}/${relationId}/${level}`,
        );
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

/** Relation/level pairs already asked to warm this session. */
const adminWarmRequested = new Set<string>();

/** Fire a background warm of a relation's admin set at a level.
 *  Fire-and-forget; deduped per session. */
function requestAdminWarm(relationId: number, level: number): void {
    const key = `${relationId}/${level}`;
    if (adminWarmRequested.has(key)) return;
    adminWarmRequested.add(key);
    void fetch(
        `${ADMIN_BY_RELATION_BASE}/${relationId}/${level}?warm=1`,
    ).catch(() => {
        adminWarmRequested.delete(key);
    });
}

/**
 * Fan the prewarmed admin endpoint over EVERY play-area relation at one
 * level and return the unioned elements — but ONLY when every area is warm.
 * If ANY area is cold, returns null: the caller background-warms the cold
 * ids (done here) and uses the live poly query. Elements deduped by
 * `type/id` so a boundary shared across two bbox supersets isn't doubled.
 */
export async function fetchPrewarmedAreaAdmin(
    level: number,
): Promise<{ elements: OverpassElement[] } | null> {
    const ids = playAreaRelationIdsAll();
    if (ids.length === 0) return null;
    const results = await Promise.all(
        ids.map((id) => fetchPrewarmedAdmin(id, level)),
    );
    if (results.some((r) => r === null)) {
        ids.forEach((id, i) => {
            if (results[i] === null) requestAdminWarm(id, level);
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
