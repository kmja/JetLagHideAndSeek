import { additionalMapGeoLocations, mapGeoLocation } from "@/lib/context";

/**
 * Every play-area OSM relation id — the PRIMARY plus each ADDED adjacent area
 * (`additionalMapGeoLocations` entries with `.added === true` that are OSM
 * relations). Subtracted areas (`.added === false`) are excluded; the combined
 * polygon already carves them out.
 *
 * This is the set every relation-id-keyed prewarm endpoint is fanned over so an
 * added adjacent area is served from R2 exactly like the primary (stations,
 * transit-routes, transit-overlay, water, coast, …). v1126: single source —
 * previously hand-copied in `overpass.ts` (`playAreaTransitRelationIds`),
 * `journey/stations.ts` (`playAreaRelationIdsAll`), and referenced by
 * `playAreaPrefetch.ts`. Duplicating it is exactly how a multi-region play area
 * silently diverges between one prewarm surface and another.
 */
export function playAreaRelationIdsAll(): number[] {
    const ids: number[] = [];
    const primary = mapGeoLocation.get()?.properties as
        | { osm_id?: number; osm_type?: string }
        | undefined;
    if (
        primary?.osm_type === "R" &&
        typeof primary.osm_id === "number" &&
        primary.osm_id > 0
    ) {
        ids.push(primary.osm_id);
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
