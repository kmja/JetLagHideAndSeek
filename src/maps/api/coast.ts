/**
 * Prewarmed OSM `natural=coastline` geometry for the measuring
 * body-of-water elimination (v776).
 *
 * OSM tags the open sea + large bays + tidal reaches as `natural=coastline`
 * (a LINE), NOT `natural=water`, so a coastal metro's biggest body of water
 * is invisible to the water query. The elimination folds the SEA in as an
 * AREA built from these coastline lines (`seaFromCoastline`). The bundled
 * 1:50m Natural Earth coastline was too coarse for a metro like NYC — it
 * smeared the harbour/rivers into one blob and left much of the water marked
 * "further from water". This serves the DETAILED per-city OSM coastline from
 * R2, mirroring the named-water prewarm (`water.ts`) exactly.
 *
 * Reads the relation-id-keyed `/api/coast/<id>` endpoint, fanned over EVERY
 * play-area relation (primary + each added adjacent) and unioned. On any
 * cold area it background-warms the cold ids and declines (returns null), so
 * the caller falls back to the bundled 1:50m coastline. A warm coastal city
 * gets the detailed sea; an inland city's endpoint is a warmed-but-empty set
 * (no coastline in the bbox), which resolves to no sea contribution.
 */

import {
    additionalMapGeoLocations,
    mapGeoLocation,
} from "@/lib/context";
import { COAST_BY_RELATION_BASE } from "@/maps/api/constants";

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
