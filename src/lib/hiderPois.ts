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
 * Behaviour (v888): once the hider commits a zone, the POI field is shown
 * AUTOMATICALLY within that zone (`hiderPoiShow`, default on). The map
 * drawer's search lets the hider HIGHLIGHT one kind (e.g. "supermarket")
 * — matching POIs pop while the rest dim (`hiderPoiHighlightKind`).
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
 * Groups whose POIs are drawn ALWAYS (once the hider commits a zone). The
 * `transit` group is excluded from the always-on field — those stops are
 * already the Hiding-zones overlay — but they stay HIGHLIGHTABLE via
 * search (a highlighted transit kind is drawn even though the base field
 * skips it).
 */
export const HIDER_POI_ALWAYS_GROUPS: HiderPoiGroup[] = [
    "food",
    "retail",
    "civic",
    "culture",
    "nature",
];

/** Whether a kind is part of the always-on in-zone field. */
export function hiderPoiAlwaysShown(kind: string): boolean {
    const def = HIDER_POI_BY_KIND[kind];
    return !!def && HIDER_POI_ALWAYS_GROUPS.includes(def.group);
}

/**
 * Master toggle for the in-zone POI field. Default ON — once the hider
 * commits a zone, the places inside it show automatically. Persisted.
 */
export const hiderPoiShow = persistentAtom<boolean>("hiderPoiShow", true, {
    encode: (v) => JSON.stringify(v),
    decode: (v) => v === "true",
});

/**
 * The single POI kind the hider is HIGHLIGHTING via search (e.g.
 * "supermarket") — matching POIs in the zone pop while the rest dim.
 * Empty string = no highlight. Persisted.
 */
export const hiderPoiHighlightKind = persistentAtom<string>(
    "hiderPoiHighlightKind",
    "",
);
