/**
 * Country / region shards for the global reference-cache prewarm.
 *
 * Each entry maps to one R2 object under `country-refs/<iso>/all`
 * containing the cached combined-families Overpass response for
 * that shard's bounding box. Bbox lookups against a play-area
 * query pick the smallest-by-area shard fully containing the
 * requested bbox; queries whose bbox isn't fully inside any shard
 * fall through to the existing upstream path.
 *
 * Bbox order is `[minLng, minLat, maxLng, maxLat]` (i.e. west,
 * south, east, north) — matches GeoJSON / Turf convention. Note
 * that Overpass uses `(south, west, north, east)` in its own query
 * syntax; conversions live in `querySlicing.ts`.
 *
 * Bboxes here are deliberately a touch loose. We use them only for
 * containment tests; a few extra km of slop on a national boundary
 * just means the slicing path catches a few elements technically
 * outside the country, which the bbox filter then drops anyway.
 *
 * Big countries (US, CA) are split where a single combined-families
 * Overpass query would overrun the 180 s server-side budget.
 * Russia, Brazil, China would need the same treatment if we extend
 * coverage there.
 */

export interface CountryShard {
    /**
     * R2-key fragment for this shard. ISO 3166-1 alpha-2 code, or
     * `<ISO>-<region>` for sub-regions of big countries.
     */
    iso: string;
    /** Human-readable label for logs and the diagnose endpoint. */
    label: string;
    /** [minLng, minLat, maxLng, maxLat]. */
    bbox: [number, number, number, number];
    /**
     * Optional parent ISO. When set, this shard is one slice of a
     * larger country split because the country-wide query overruns
     * Overpass's server-side timeout. Documentation hint only —
     * the lookup code treats every shard uniformly.
     */
    parent?: string;
}

/**
 * Europe — EU + neighbours commonly picked as a play area.
 *
 * Bboxes cover the mainland of each country. Overseas territories
 * (French Polynesia, Greenland) are out of scope; a separate shard
 * can be added if anyone ever plays there.
 */
const EUROPE: CountryShard[] = [
    { iso: "AT", label: "Austria", bbox: [9.5, 46.4, 17.2, 49.0] },
    { iso: "BE", label: "Belgium", bbox: [2.5, 49.5, 6.4, 51.5] },
    { iso: "BG", label: "Bulgaria", bbox: [22.4, 41.2, 28.6, 44.2] },
    { iso: "CH", label: "Switzerland", bbox: [5.9, 45.8, 10.5, 47.8] },
    { iso: "CY", label: "Cyprus", bbox: [32.3, 34.6, 34.6, 35.7] },
    { iso: "CZ", label: "Czechia", bbox: [12.1, 48.5, 18.9, 51.1] },
    { iso: "DE", label: "Germany", bbox: [5.9, 47.3, 15.0, 55.1] },
    { iso: "DK", label: "Denmark", bbox: [8.1, 54.5, 15.2, 57.8] },
    { iso: "EE", label: "Estonia", bbox: [21.8, 57.5, 28.2, 59.7] },
    { iso: "ES", label: "Spain (mainland)", bbox: [-9.4, 35.9, 4.4, 43.8] },
    { iso: "FI", label: "Finland", bbox: [19.1, 59.4, 31.6, 70.1] },
    {
        iso: "FR",
        label: "France (metropolitan)",
        bbox: [-5.2, 41.3, 9.6, 51.1],
    },
    { iso: "GB", label: "United Kingdom", bbox: [-8.7, 49.9, 1.8, 60.9] },
    { iso: "GR", label: "Greece", bbox: [19.4, 34.8, 28.3, 41.8] },
    { iso: "HR", label: "Croatia", bbox: [13.5, 42.4, 19.4, 46.6] },
    { iso: "HU", label: "Hungary", bbox: [16.1, 45.7, 22.9, 48.6] },
    { iso: "IE", label: "Ireland", bbox: [-10.7, 51.4, -5.9, 55.4] },
    { iso: "IS", label: "Iceland", bbox: [-24.6, 63.3, -13.5, 66.6] },
    { iso: "IT", label: "Italy", bbox: [6.6, 35.5, 18.5, 47.1] },
    { iso: "LT", label: "Lithuania", bbox: [20.9, 53.9, 26.8, 56.5] },
    { iso: "LU", label: "Luxembourg", bbox: [5.7, 49.4, 6.6, 50.2] },
    { iso: "LV", label: "Latvia", bbox: [20.9, 55.7, 28.2, 58.1] },
    { iso: "MT", label: "Malta", bbox: [14.1, 35.7, 14.7, 36.1] },
    { iso: "NL", label: "Netherlands", bbox: [3.3, 50.7, 7.3, 53.6] },
    { iso: "NO", label: "Norway (mainland)", bbox: [4.5, 57.9, 31.1, 71.2] },
    { iso: "PL", label: "Poland", bbox: [14.1, 49.0, 24.2, 54.8] },
    { iso: "PT", label: "Portugal (mainland)", bbox: [-9.5, 36.9, -6.2, 42.2] },
    { iso: "RO", label: "Romania", bbox: [20.3, 43.6, 29.7, 48.3] },
    { iso: "SE", label: "Sweden", bbox: [11.0, 55.3, 24.2, 69.1] },
    { iso: "SI", label: "Slovenia", bbox: [13.4, 45.4, 16.6, 46.9] },
    { iso: "SK", label: "Slovakia", bbox: [16.8, 47.7, 22.6, 49.6] },
    // Non-EU European countries worth covering
    { iso: "BA", label: "Bosnia and Herzegovina", bbox: [15.7, 42.5, 19.7, 45.3] },
    { iso: "RS", label: "Serbia", bbox: [18.8, 42.2, 23.0, 46.2] },
    { iso: "AL", label: "Albania", bbox: [19.3, 39.6, 21.1, 42.7] },
    { iso: "MK", label: "North Macedonia", bbox: [20.4, 40.8, 23.0, 42.4] },
    { iso: "ME", label: "Montenegro", bbox: [18.4, 41.9, 20.4, 43.6] },
    { iso: "UA", label: "Ukraine", bbox: [22.1, 44.4, 40.2, 52.4] },
];

/**
 * North America. United States and Canada are split at -100° so
 * neither shard busts Overpass's server-side budget. Mexico fits
 * in one query.
 */
const NORTH_AMERICA: CountryShard[] = [
    {
        iso: "US-east",
        label: "United States (east of -100°)",
        bbox: [-100, 24.5, -66.9, 49.5],
        parent: "US",
    },
    {
        iso: "US-west",
        label: "United States (west of -100°)",
        bbox: [-125, 24.5, -100, 49.5],
        parent: "US",
    },
    {
        iso: "US-AK",
        label: "Alaska",
        bbox: [-180, 51, -129, 71.5],
        parent: "US",
    },
    {
        iso: "US-HI",
        label: "Hawaii",
        bbox: [-160.5, 18.9, -154.6, 22.3],
        parent: "US",
    },
    {
        iso: "CA-east",
        label: "Canada (east of -90°)",
        bbox: [-90, 41.7, -52.6, 70],
        parent: "CA",
    },
    {
        iso: "CA-west",
        label: "Canada (west of -90°)",
        bbox: [-141, 48.0, -90, 70],
        parent: "CA",
    },
    { iso: "MX", label: "Mexico", bbox: [-118.4, 14.5, -86.7, 32.7] },
];

/**
 * Frequently-played non-EU/NA regions. Add more as user demand
 * surfaces; the slicing path falls through cleanly to upstream for
 * any bbox not covered here.
 */
const ELSEWHERE: CountryShard[] = [
    { iso: "AU", label: "Australia (mainland + Tas)", bbox: [113, -44, 154, -10] },
    { iso: "NZ", label: "New Zealand", bbox: [165, -47.3, 178.6, -34.4] },
    { iso: "JP", label: "Japan", bbox: [122.9, 24, 145.8, 45.5] },
    { iso: "KR", label: "South Korea", bbox: [125.8, 33, 129.6, 38.6] },
    { iso: "TW", label: "Taiwan", bbox: [119.5, 21.8, 122.1, 25.3] },
    { iso: "SG", label: "Singapore", bbox: [103.6, 1.16, 104.05, 1.48] },
    { iso: "HK", label: "Hong Kong", bbox: [113.8, 22.15, 114.5, 22.6] },
];

export const COUNTRY_SHARDS: CountryShard[] = [
    ...EUROPE,
    ...NORTH_AMERICA,
    ...ELSEWHERE,
];
