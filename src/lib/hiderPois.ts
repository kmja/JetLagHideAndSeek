import { persistentAtom } from "@nanostores/persistent";

/**
 * Hider "points of interest" overlay — sourced ENTIRELY from the basemap
 * pmtiles (the `pois` source-layer, which we drop from the rendered style
 * in `protomapsStyle.ts` but is still present in the tile data and
 * queryable via `map.querySourceFeatures("protomaps", {sourceLayer:
 * "pois"})`). So the hider can light up cafes / shops / toilets / parks
 * near their hiding zone with ZERO Overpass — it reads whatever tiles are
 * already loaded (for a starred city that's the offline tile pack).
 *
 * The catalog below is the exact set of POI `kind` values the Protomaps
 * basemap encodes (see `@protomaps/basemaps` `base_layers.ts` pois
 * filter), grouped + coloured the way the flavour groups them.
 *
 * Behaviour (v894): the POI FIELD renders via the basemap's NATIVE Protomaps
 * `pois` layer (icons + names), toggled by `hiderPoiShow` (default on). The
 * map drawer's searchable type list lets the hider toggle any number of kinds
 * to HIGHLIGHT — those are drawn as bold group-coloured DOTS by
 * `HiderPoiOverlay` (`hiderPoiHighlightKinds`), so "where are all the X"
 * stands out over the native field.
 */

export type HiderPoiGroup =
    | "food"
    | "retail"
    | "civic"
    | "culture"
    | "nature"
    | "transit";

export interface HiderPoiGroupMeta {
    label: string;
    /** Dot colour on the map (also the chip accent). */
    color: string;
}

/** Group → label + map colour. Distinct hues so groups read apart. */
export const HIDER_POI_GROUPS: Record<HiderPoiGroup, HiderPoiGroupMeta> = {
    food: { label: "Food & drink", color: "#e8803a" },
    retail: { label: "Shops", color: "#d4a017" },
    civic: { label: "Civic", color: "#64748b" },
    culture: { label: "Culture", color: "#c2508f" },
    nature: { label: "Nature", color: "#4b9e5f" },
    transit: { label: "Transit", color: "#2f6fb0" },
};

export interface HiderPoiDef {
    /** The `kind` value as it appears in the pmtiles `pois` layer. */
    kind: string;
    /** Friendly label for chips + the on-map legend. */
    label: string;
    group: HiderPoiGroup;
}

/**
 * The full searchable catalog — every kind the Protomaps basemap renders
 * in its `pois` layer. `building` is deliberately omitted (far too generic
 * / noisy to be a useful scouting overlay).
 */
export const HIDER_POI_CATALOG: HiderPoiDef[] = [
    // Food & drink
    { kind: "restaurant", label: "Restaurant", group: "food" },
    { kind: "cafe", label: "Cafe", group: "food" },
    { kind: "fast_food", label: "Fast food", group: "food" },
    { kind: "bar", label: "Bar", group: "food" },
    // Shops
    { kind: "supermarket", label: "Supermarket", group: "retail" },
    { kind: "convenience", label: "Convenience store", group: "retail" },
    { kind: "books", label: "Bookshop", group: "retail" },
    { kind: "clothes", label: "Clothing", group: "retail" },
    { kind: "electronics", label: "Electronics", group: "retail" },
    { kind: "beauty", label: "Beauty", group: "retail" },
    // Civic / institutional
    { kind: "toilets", label: "Toilets", group: "civic" },
    { kind: "drinking_water", label: "Drinking water", group: "civic" },
    { kind: "library", label: "Library", group: "civic" },
    { kind: "post_office", label: "Post office", group: "civic" },
    { kind: "townhall", label: "Town hall", group: "civic" },
    { kind: "school", label: "School", group: "civic" },
    { kind: "university", label: "University", group: "civic" },
    { kind: "stadium", label: "Stadium", group: "civic" },
    // Culture
    { kind: "museum", label: "Museum", group: "culture" },
    { kind: "theatre", label: "Theatre", group: "culture" },
    { kind: "attraction", label: "Attraction", group: "culture" },
    { kind: "artwork", label: "Artwork", group: "culture" },
    // Nature
    { kind: "park", label: "Park", group: "nature" },
    { kind: "garden", label: "Garden", group: "nature" },
    { kind: "bench", label: "Bench", group: "nature" },
    { kind: "beach", label: "Beach", group: "nature" },
    { kind: "forest", label: "Forest", group: "nature" },
    { kind: "marina", label: "Marina", group: "nature" },
    { kind: "peak", label: "Peak", group: "nature" },
    { kind: "zoo", label: "Zoo", group: "nature" },
    { kind: "animal", label: "Animal", group: "nature" },
    // Transit (already covered by the Hiding-zones overlay, so kept OUT of
    // the defaults but searchable).
    { kind: "aerodrome", label: "Airport", group: "transit" },
    { kind: "station", label: "Train station", group: "transit" },
    { kind: "bus_stop", label: "Bus stop", group: "transit" },
    { kind: "ferry_terminal", label: "Ferry terminal", group: "transit" },
];

/** kind → def, for O(1) lookup by the overlay + drawer. */
export const HIDER_POI_BY_KIND: Record<string, HiderPoiDef> =
    Object.fromEntries(HIDER_POI_CATALOG.map((d) => [d.kind, d]));

/** Colour a kind's dot by its group (falls back to a neutral grey). */
export function hiderPoiColor(kind: string): string {
    const def = HIDER_POI_BY_KIND[kind];
    return def ? HIDER_POI_GROUPS[def.group].color : "#94a3b8";
}

/**
 * Master toggle for the in-zone POI FIELD — the basemap's NATIVE Protomaps
 * `pois` layer (icons + names), shown/hidden on the hider map. Default OFF
 * (v1020 — it read as an always-on overlay of orange restaurant dots the
 * hider never enabled; POIs now appear only when turned on in Map options).
 * Persisted.
 */
export const hiderPoiShow = persistentAtom<boolean>("hiderPoiShow", false, {
    encode: (v) => JSON.stringify(v),
    decode: (v) => v === "true",
});

/**
 * The POI kinds the hider has toggled ON to HIGHLIGHT — drawn as bold
 * group-coloured DOTS by `HiderPoiOverlay` (v894: multi-select, was a single
 * string). Chosen from the map drawer's searchable type list. Persisted.
 */
export const hiderPoiHighlightKinds = persistentAtom<string[]>(
    "hiderPoiHighlightKinds",
    [],
    { encode: JSON.stringify, decode: safeParseKinds },
);

function safeParseKinds(v: string): string[] {
    try {
        const parsed = JSON.parse(v);
        return Array.isArray(parsed)
            ? parsed.filter((k) => typeof k === "string")
            : [];
    } catch {
        return [];
    }
}
