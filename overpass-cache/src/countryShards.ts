/**
 * Country / region shards for the global reference-cache prewarm.
 *
 * Each entry maps to one R2 object under
 * `country-refs/v1/<iso>/all` containing the cached
 * combined-families Overpass response for that shard's bounding
 * box. Bbox lookups against a play-area query pick the
 * smallest-by-area shard fully containing the requested bbox;
 * queries whose bbox isn't fully inside any shard fall through to
 * the existing upstream path.
 *
 * Bbox order is `[minLng, minLat, maxLng, maxLat]` (i.e. west,
 * south, east, north) — matches GeoJSON / Turf convention. Note
 * that Overpass uses `(south, west, north, east)` in its own query
 * syntax; conversions live in `querySlicing.ts`.
 *
 * Bboxes are deliberately a touch loose. We use them only for
 * containment tests; a few extra km of slop on a national boundary
 * just means the slicing path catches a few elements technically
 * outside the country, which the bbox filter then drops anyway.
 *
 * Big countries (Russia, China, USA, Canada, Brazil, Australia,
 * India) are split where a single combined-families Overpass query
 * would overrun the 180 s server-side budget OR would store an
 * impractically large R2 entry to parse per request.
 *
 * What's deliberately excluded:
 *   - Antarctica (no gameplay context).
 *   - Polar / uninhabited high-latitude regions (Svalbard, Bouvet,
 *     Heard Island, etc.) — far from any plausible play area, and
 *     adding them just slows the containment lookup.
 *   - The dateline-spanning eastern fringe of Russia past 180° —
 *     Wrangel Island, the Diomedes. The wrap-around adds parsing
 *     complexity for territory nobody will ever play in.
 *
 * Sources: bboxes built from each country's geographic extent
 * (sovereign land + immediately-adjacent territorial waters).
 * Approximate by design — within ~0.5° on the loose side.
 */

export interface CountryShard {
    /**
     * R2-key fragment for this shard. ISO 3166-1 alpha-2 code,
     * optionally suffixed with a region (e.g. "US-west") for
     * sub-country splits.
     */
    iso: string;
    /** Human-readable label for logs and the diagnose endpoint. */
    label: string;
    /** [minLng, minLat, maxLng, maxLat]. */
    bbox: [number, number, number, number];
    /**
     * Optional parent ISO. Set when this shard is one slice of a
     * larger country split because the country-wide query overruns
     * Overpass's server-side timeout. Documentation hint only —
     * the lookup code treats every shard uniformly.
     */
    parent?: string;
}

/* ────────────────────────── Europe ────────────────────────── */

const EUROPE: CountryShard[] = [
    // EU member states
    { iso: "AT", label: "Austria", bbox: [9.5, 46.4, 17.2, 49.0] },
    { iso: "BE", label: "Belgium", bbox: [2.5, 49.5, 6.4, 51.5] },
    { iso: "BG", label: "Bulgaria", bbox: [22.4, 41.2, 28.6, 44.2] },
    { iso: "CY", label: "Cyprus", bbox: [32.3, 34.6, 34.6, 35.7] },
    { iso: "CZ", label: "Czechia", bbox: [12.1, 48.5, 18.9, 51.1] },
    { iso: "DE", label: "Germany", bbox: [5.9, 47.3, 15.0, 55.1] },
    { iso: "DK", label: "Denmark", bbox: [8.1, 54.5, 15.2, 57.8] },
    { iso: "EE", label: "Estonia", bbox: [21.8, 57.5, 28.2, 59.7] },
    { iso: "ES", label: "Spain (mainland)", bbox: [-9.4, 35.9, 4.4, 43.8] },
    { iso: "ES-IC", label: "Canary Islands", bbox: [-18.2, 27.5, -13.4, 29.5], parent: "ES" },
    { iso: "FI", label: "Finland", bbox: [19.1, 59.4, 31.6, 70.1] },
    { iso: "FR", label: "France (metropolitan)", bbox: [-5.2, 41.3, 9.6, 51.1] },
    { iso: "FR-GF", label: "French Guiana", bbox: [-54.6, 2.1, -51.6, 5.8], parent: "FR" },
    { iso: "GR", label: "Greece", bbox: [19.4, 34.8, 28.3, 41.8] },
    { iso: "HR", label: "Croatia", bbox: [13.5, 42.4, 19.4, 46.6] },
    { iso: "HU", label: "Hungary", bbox: [16.1, 45.7, 22.9, 48.6] },
    { iso: "IE", label: "Ireland", bbox: [-10.7, 51.4, -5.9, 55.4] },
    { iso: "IT", label: "Italy", bbox: [6.6, 35.5, 18.5, 47.1] },
    { iso: "LT", label: "Lithuania", bbox: [20.9, 53.9, 26.8, 56.5] },
    { iso: "LU", label: "Luxembourg", bbox: [5.7, 49.4, 6.6, 50.2] },
    { iso: "LV", label: "Latvia", bbox: [20.9, 55.7, 28.2, 58.1] },
    { iso: "MT", label: "Malta", bbox: [14.1, 35.7, 14.7, 36.1] },
    { iso: "NL", label: "Netherlands", bbox: [3.3, 50.7, 7.3, 53.6] },
    { iso: "PL", label: "Poland", bbox: [14.1, 49.0, 24.2, 54.8] },
    { iso: "PT", label: "Portugal (mainland)", bbox: [-9.5, 36.9, -6.2, 42.2] },
    { iso: "PT-AZ", label: "Azores", bbox: [-31.3, 36.9, -25.0, 39.8], parent: "PT" },
    { iso: "PT-MA", label: "Madeira", bbox: [-17.3, 32.4, -16.2, 33.2], parent: "PT" },
    { iso: "RO", label: "Romania", bbox: [20.3, 43.6, 29.7, 48.3] },
    { iso: "SE", label: "Sweden", bbox: [11.0, 55.3, 24.2, 69.1] },
    { iso: "SI", label: "Slovenia", bbox: [13.4, 45.4, 16.6, 46.9] },
    { iso: "SK", label: "Slovakia", bbox: [16.8, 47.7, 22.6, 49.6] },
    // Non-EU European countries
    { iso: "AD", label: "Andorra", bbox: [1.4, 42.4, 1.8, 42.7] },
    { iso: "AL", label: "Albania", bbox: [19.3, 39.6, 21.1, 42.7] },
    { iso: "BA", label: "Bosnia and Herzegovina", bbox: [15.7, 42.5, 19.7, 45.3] },
    { iso: "BY", label: "Belarus", bbox: [23.2, 51.3, 32.8, 56.2] },
    { iso: "CH", label: "Switzerland", bbox: [5.9, 45.8, 10.5, 47.8] },
    { iso: "FO", label: "Faroe Islands", bbox: [-7.7, 61.4, -6.3, 62.4] },
    { iso: "GB", label: "United Kingdom", bbox: [-8.7, 49.9, 1.8, 60.9] },
    { iso: "IM", label: "Isle of Man", bbox: [-4.9, 54.0, -4.3, 54.5] },
    { iso: "IS", label: "Iceland", bbox: [-24.6, 63.3, -13.5, 66.6] },
    { iso: "LI", label: "Liechtenstein", bbox: [9.4, 47.0, 9.7, 47.3] },
    { iso: "MC", label: "Monaco", bbox: [7.4, 43.7, 7.5, 43.8] },
    { iso: "MD", label: "Moldova", bbox: [26.6, 45.4, 30.2, 48.5] },
    { iso: "ME", label: "Montenegro", bbox: [18.4, 41.9, 20.4, 43.6] },
    { iso: "MK", label: "North Macedonia", bbox: [20.4, 40.8, 23.0, 42.4] },
    { iso: "NO", label: "Norway (mainland)", bbox: [4.5, 57.9, 31.1, 71.2] },
    { iso: "RS", label: "Serbia", bbox: [18.8, 42.2, 23.0, 46.2] },
    { iso: "RU-west", label: "Russia (west, lng < 60°)", bbox: [19.6, 41.2, 60.0, 81.9], parent: "RU" },
    { iso: "RU-central", label: "Russia (central, 60° ≤ lng < 120°)", bbox: [60.0, 41.2, 120.0, 81.9], parent: "RU" },
    { iso: "RU-east", label: "Russia (east, lng ≥ 120°)", bbox: [120.0, 41.2, 180.0, 81.9], parent: "RU" },
    { iso: "SM", label: "San Marino", bbox: [12.4, 43.9, 12.5, 44.0] },
    { iso: "UA", label: "Ukraine", bbox: [22.1, 44.4, 40.2, 52.4] },
    { iso: "VA", label: "Vatican City", bbox: [12.44, 41.90, 12.46, 41.91] },
    { iso: "XK", label: "Kosovo", bbox: [20.0, 41.9, 21.8, 43.3] },
];

/* ─────────────────────── North America ─────────────────────── */

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
    { iso: "US-AK", label: "Alaska", bbox: [-180, 51, -129, 71.5], parent: "US" },
    { iso: "US-HI", label: "Hawaii", bbox: [-160.5, 18.9, -154.6, 22.3], parent: "US" },
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
    { iso: "GL", label: "Greenland", bbox: [-73.0, 59.5, -11.5, 83.7] },
    { iso: "BM", label: "Bermuda", bbox: [-64.9, 32.2, -64.6, 32.4] },
    // Central America
    { iso: "BZ", label: "Belize", bbox: [-89.3, 15.8, -87.7, 18.5] },
    { iso: "CR", label: "Costa Rica", bbox: [-86.0, 8.0, -82.5, 11.3] },
    { iso: "GT", label: "Guatemala", bbox: [-92.3, 13.7, -88.2, 17.9] },
    { iso: "HN", label: "Honduras", bbox: [-89.4, 12.9, -83.1, 16.5] },
    { iso: "NI", label: "Nicaragua", bbox: [-87.7, 10.7, -83.1, 15.0] },
    { iso: "PA", label: "Panama", bbox: [-83.1, 7.2, -77.1, 9.7] },
    { iso: "SV", label: "El Salvador", bbox: [-90.2, 13.1, -87.7, 14.5] },
    // Caribbean
    { iso: "AG", label: "Antigua and Barbuda", bbox: [-61.9, 16.9, -61.6, 17.7] },
    { iso: "BB", label: "Barbados", bbox: [-59.7, 13.0, -59.4, 13.4] },
    { iso: "BS", label: "Bahamas", bbox: [-79.0, 20.9, -72.7, 27.3] },
    { iso: "CU", label: "Cuba", bbox: [-85.0, 19.8, -74.1, 23.3] },
    { iso: "DM", label: "Dominica", bbox: [-61.5, 15.2, -61.2, 15.7] },
    { iso: "DO", label: "Dominican Republic", bbox: [-72.0, 17.5, -68.3, 19.9] },
    { iso: "GD", label: "Grenada", bbox: [-61.8, 11.9, -61.6, 12.2] },
    { iso: "HT", label: "Haiti", bbox: [-74.5, 18.0, -71.6, 20.1] },
    { iso: "JM", label: "Jamaica", bbox: [-78.4, 17.7, -76.2, 18.5] },
    { iso: "KN", label: "Saint Kitts and Nevis", bbox: [-62.9, 17.1, -62.5, 17.4] },
    { iso: "KY", label: "Cayman Islands", bbox: [-81.5, 19.2, -79.7, 19.8] },
    { iso: "LC", label: "Saint Lucia", bbox: [-61.1, 13.7, -60.9, 14.1] },
    { iso: "PR", label: "Puerto Rico", bbox: [-67.3, 17.9, -65.6, 18.6], parent: "US" },
    { iso: "TC", label: "Turks and Caicos", bbox: [-72.5, 21.4, -71.1, 21.9] },
    { iso: "TT", label: "Trinidad and Tobago", bbox: [-62.0, 10.0, -60.5, 11.4] },
    { iso: "VC", label: "Saint Vincent and the Grenadines", bbox: [-61.5, 12.5, -61.1, 13.4] },
    { iso: "VI", label: "US Virgin Islands", bbox: [-65.1, 17.6, -64.5, 18.4], parent: "US" },
];

/* ─────────────────────── South America ─────────────────────── */

const SOUTH_AMERICA: CountryShard[] = [
    { iso: "AR-north", label: "Argentina (north, lat > -40°)", bbox: [-73.6, -40, -53.6, -21.8], parent: "AR" },
    { iso: "AR-south", label: "Argentina (south, lat ≤ -40°)", bbox: [-73.6, -55.1, -65.0, -40], parent: "AR" },
    { iso: "BO", label: "Bolivia", bbox: [-69.7, -22.9, -57.5, -9.7] },
    { iso: "BR-north", label: "Brazil (north, lat > -16°)", bbox: [-74.0, -16, -34.8, 5.3], parent: "BR" },
    { iso: "BR-south", label: "Brazil (south, lat ≤ -16°)", bbox: [-58.2, -33.8, -34.8, -16], parent: "BR" },
    { iso: "CL", label: "Chile", bbox: [-75.6, -56.0, -66.4, -17.5] },
    { iso: "CO", label: "Colombia", bbox: [-79.0, -4.2, -66.9, 12.5] },
    { iso: "EC", label: "Ecuador", bbox: [-81.0, -5.0, -75.2, 1.4] },
    { iso: "GY", label: "Guyana", bbox: [-61.4, 1.2, -56.5, 8.6] },
    { iso: "PE", label: "Peru", bbox: [-81.4, -18.4, -68.7, -0.0] },
    { iso: "PY", label: "Paraguay", bbox: [-62.7, -27.6, -54.3, -19.3] },
    { iso: "SR", label: "Suriname", bbox: [-58.1, 1.8, -53.9, 6.0] },
    { iso: "UY", label: "Uruguay", bbox: [-58.4, -34.9, -53.1, -30.1] },
    { iso: "VE", label: "Venezuela", bbox: [-73.4, 0.6, -59.8, 12.2] },
];

/* ─────────────────────────── Asia ─────────────────────────── */

const ASIA: CountryShard[] = [
    // Middle East
    { iso: "AE", label: "United Arab Emirates", bbox: [51.5, 22.6, 56.4, 26.1] },
    { iso: "BH", label: "Bahrain", bbox: [50.4, 25.8, 50.7, 26.3] },
    { iso: "IL", label: "Israel", bbox: [34.3, 29.5, 35.9, 33.3] },
    { iso: "IQ", label: "Iraq", bbox: [38.8, 29.0, 48.8, 37.4] },
    { iso: "IR", label: "Iran", bbox: [44.0, 25.1, 63.3, 39.8] },
    { iso: "JO", label: "Jordan", bbox: [34.9, 29.2, 39.3, 33.4] },
    { iso: "KW", label: "Kuwait", bbox: [46.5, 28.5, 48.4, 30.1] },
    { iso: "LB", label: "Lebanon", bbox: [35.1, 33.0, 36.6, 34.7] },
    { iso: "OM", label: "Oman", bbox: [52.0, 16.6, 59.9, 26.4] },
    { iso: "PS", label: "Palestine", bbox: [34.2, 31.2, 35.6, 32.6] },
    { iso: "QA", label: "Qatar", bbox: [50.7, 24.5, 51.7, 26.2] },
    { iso: "SA", label: "Saudi Arabia", bbox: [34.5, 16.0, 55.7, 32.2] },
    { iso: "SY", label: "Syria", bbox: [35.7, 32.3, 42.4, 37.3] },
    { iso: "TR", label: "Turkey", bbox: [26.0, 35.8, 44.8, 42.1] },
    { iso: "YE", label: "Yemen", bbox: [42.5, 12.1, 53.1, 19.0] },
    // Central Asia
    { iso: "AF", label: "Afghanistan", bbox: [60.5, 29.4, 74.9, 38.5] },
    { iso: "KG", label: "Kyrgyzstan", bbox: [69.3, 39.2, 80.3, 43.3] },
    { iso: "KZ", label: "Kazakhstan", bbox: [46.5, 40.6, 87.3, 55.5] },
    { iso: "TJ", label: "Tajikistan", bbox: [67.4, 36.7, 75.2, 41.1] },
    { iso: "TM", label: "Turkmenistan", bbox: [52.4, 35.1, 66.7, 42.8] },
    { iso: "UZ", label: "Uzbekistan", bbox: [55.9, 37.2, 73.2, 45.6] },
    // South Asia
    { iso: "BD", label: "Bangladesh", bbox: [88.0, 20.6, 92.7, 26.6] },
    { iso: "BT", label: "Bhutan", bbox: [88.7, 26.7, 92.1, 28.3] },
    { iso: "IN-north", label: "India (north, lat > 22°)", bbox: [68.0, 22, 97.5, 35.7], parent: "IN" },
    { iso: "IN-south", label: "India (south, lat ≤ 22°)", bbox: [68.0, 6.7, 92.0, 22], parent: "IN" },
    { iso: "LK", label: "Sri Lanka", bbox: [79.6, 5.9, 81.9, 9.9] },
    { iso: "MV", label: "Maldives", bbox: [72.5, -0.7, 73.8, 7.1] },
    { iso: "NP", label: "Nepal", bbox: [80.0, 26.3, 88.2, 30.5] },
    { iso: "PK", label: "Pakistan", bbox: [60.8, 23.5, 77.0, 37.1] },
    // East Asia
    { iso: "CN-east", label: "China (east, lng > 105°)", bbox: [105, 18.0, 134.8, 53.6], parent: "CN" },
    { iso: "CN-west", label: "China (west, lng ≤ 105°)", bbox: [73.5, 18.0, 105, 50.0], parent: "CN" },
    { iso: "HK", label: "Hong Kong", bbox: [113.8, 22.15, 114.5, 22.6] },
    { iso: "JP", label: "Japan", bbox: [122.9, 24, 145.8, 45.5] },
    { iso: "KP", label: "North Korea", bbox: [124.2, 37.7, 130.7, 43.0] },
    { iso: "KR", label: "South Korea", bbox: [125.8, 33, 129.6, 38.6] },
    { iso: "MN", label: "Mongolia", bbox: [87.7, 41.6, 119.9, 52.2] },
    { iso: "MO", label: "Macau", bbox: [113.5, 22.1, 113.6, 22.2] },
    { iso: "TW", label: "Taiwan", bbox: [119.5, 21.8, 122.1, 25.3] },
    // Southeast Asia
    { iso: "BN", label: "Brunei", bbox: [114.1, 4.0, 115.4, 5.1] },
    { iso: "ID-west", label: "Indonesia (west, Sumatra/Java/Kalimantan)", bbox: [95.0, -11.0, 119.0, 6.1], parent: "ID" },
    { iso: "ID-east", label: "Indonesia (east, Sulawesi/Maluku/Papua)", bbox: [119.0, -11.0, 141.0, 5.9], parent: "ID" },
    { iso: "KH", label: "Cambodia", bbox: [102.3, 10.4, 107.6, 14.7] },
    { iso: "LA", label: "Laos", bbox: [100.1, 13.9, 107.7, 22.5] },
    { iso: "MM", label: "Myanmar", bbox: [92.2, 9.6, 101.2, 28.5] },
    { iso: "MY", label: "Malaysia", bbox: [99.6, 0.9, 119.3, 7.4] },
    { iso: "PH", label: "Philippines", bbox: [116.9, 4.6, 126.6, 19.6] },
    { iso: "SG", label: "Singapore", bbox: [103.6, 1.16, 104.05, 1.48] },
    { iso: "TH", label: "Thailand", bbox: [97.3, 5.6, 105.6, 20.5] },
    { iso: "TL", label: "East Timor", bbox: [124.0, -9.6, 127.4, -8.1] },
    { iso: "VN", label: "Vietnam", bbox: [102.1, 8.4, 109.5, 23.4] },
];

/* ────────────────────────── Africa ────────────────────────── */

const AFRICA: CountryShard[] = [
    // North Africa
    { iso: "DZ", label: "Algeria", bbox: [-8.7, 18.9, 12.0, 37.1] },
    { iso: "EG", label: "Egypt", bbox: [24.7, 21.7, 36.9, 31.7] },
    { iso: "EH", label: "Western Sahara", bbox: [-17.2, 20.8, -8.7, 27.7] },
    { iso: "LY", label: "Libya", bbox: [9.4, 19.5, 25.2, 33.2] },
    { iso: "MA", label: "Morocco", bbox: [-13.2, 27.7, -0.9, 35.9] },
    { iso: "SD", label: "Sudan", bbox: [21.8, 8.7, 38.6, 22.0] },
    { iso: "TN", label: "Tunisia", bbox: [7.5, 30.2, 11.6, 37.6] },
    // West Africa
    { iso: "BF", label: "Burkina Faso", bbox: [-5.5, 9.4, 2.4, 15.1] },
    { iso: "BJ", label: "Benin", bbox: [0.7, 6.2, 3.9, 12.4] },
    { iso: "CI", label: "Côte d'Ivoire", bbox: [-8.6, 4.4, -2.5, 10.7] },
    { iso: "CV", label: "Cape Verde", bbox: [-25.4, 14.8, -22.7, 17.2] },
    { iso: "GH", label: "Ghana", bbox: [-3.3, 4.7, 1.2, 11.2] },
    { iso: "GM", label: "The Gambia", bbox: [-16.8, 13.1, -13.8, 13.8] },
    { iso: "GN", label: "Guinea", bbox: [-15.1, 7.2, -7.6, 12.7] },
    { iso: "GW", label: "Guinea-Bissau", bbox: [-16.7, 10.9, -13.6, 12.7] },
    { iso: "LR", label: "Liberia", bbox: [-11.5, 4.3, -7.4, 8.6] },
    { iso: "ML", label: "Mali", bbox: [-12.2, 10.2, 4.3, 25.0] },
    { iso: "MR", label: "Mauritania", bbox: [-17.1, 14.7, -4.8, 27.3] },
    { iso: "NE", label: "Niger", bbox: [0.2, 11.7, 16.0, 23.5] },
    { iso: "NG", label: "Nigeria", bbox: [2.7, 4.3, 14.7, 13.9] },
    { iso: "SL", label: "Sierra Leone", bbox: [-13.3, 6.9, -10.3, 10.0] },
    { iso: "SN", label: "Senegal", bbox: [-17.5, 12.3, -11.4, 16.7] },
    { iso: "TG", label: "Togo", bbox: [-0.1, 6.1, 1.8, 11.1] },
    // Central Africa
    { iso: "AO", label: "Angola", bbox: [11.7, -18.0, 24.1, -4.4] },
    { iso: "CD", label: "DR Congo", bbox: [12.2, -13.5, 31.3, 5.4] },
    { iso: "CF", label: "Central African Republic", bbox: [14.4, 2.2, 27.5, 11.0] },
    { iso: "CG", label: "Republic of the Congo", bbox: [11.1, -5.0, 18.7, 3.7] },
    { iso: "CM", label: "Cameroon", bbox: [8.5, 1.7, 16.2, 13.1] },
    { iso: "GA", label: "Gabon", bbox: [8.7, -3.9, 14.5, 2.3] },
    { iso: "GQ", label: "Equatorial Guinea", bbox: [5.6, -1.5, 11.3, 3.8] },
    { iso: "ST", label: "São Tomé and Príncipe", bbox: [6.5, 0.0, 7.5, 1.7] },
    { iso: "TD", label: "Chad", bbox: [13.5, 7.4, 24.0, 23.5] },
    // East Africa
    { iso: "BI", label: "Burundi", bbox: [29.0, -4.5, 30.9, -2.3] },
    { iso: "DJ", label: "Djibouti", bbox: [41.7, 10.9, 43.4, 12.7] },
    { iso: "ER", label: "Eritrea", bbox: [36.5, 12.4, 43.1, 18.0] },
    { iso: "ET", label: "Ethiopia", bbox: [33.0, 3.4, 48.0, 14.9] },
    { iso: "KE", label: "Kenya", bbox: [33.9, -4.7, 41.9, 5.0] },
    { iso: "RW", label: "Rwanda", bbox: [28.9, -2.9, 30.9, -1.0] },
    { iso: "SO", label: "Somalia", bbox: [40.9, -1.7, 51.4, 11.9] },
    { iso: "SS", label: "South Sudan", bbox: [24.1, 3.5, 35.9, 12.3] },
    { iso: "TZ", label: "Tanzania", bbox: [29.3, -11.8, 40.5, -0.9] },
    { iso: "UG", label: "Uganda", bbox: [29.6, -1.5, 35.0, 4.2] },
    // Southern Africa
    { iso: "BW", label: "Botswana", bbox: [19.9, -26.9, 29.4, -17.8] },
    { iso: "LS", label: "Lesotho", bbox: [27.0, -30.7, 29.5, -28.6] },
    { iso: "MG", label: "Madagascar", bbox: [43.2, -25.7, 50.5, -11.9] },
    { iso: "MW", label: "Malawi", bbox: [32.7, -17.1, 35.9, -9.4] },
    { iso: "MZ", label: "Mozambique", bbox: [30.2, -26.9, 40.8, -10.5] },
    { iso: "NA", label: "Namibia", bbox: [11.7, -29.0, 25.3, -16.9] },
    { iso: "SZ", label: "Eswatini", bbox: [30.8, -27.4, 32.1, -25.7] },
    { iso: "ZA", label: "South Africa", bbox: [16.5, -34.9, 32.9, -22.1] },
    { iso: "ZM", label: "Zambia", bbox: [21.9, -18.1, 33.7, -8.2] },
    { iso: "ZW", label: "Zimbabwe", bbox: [25.2, -22.4, 33.1, -15.6] },
    // Indian Ocean islands
    { iso: "KM", label: "Comoros", bbox: [43.2, -12.5, 44.6, -11.3] },
    { iso: "MU", label: "Mauritius", bbox: [57.3, -20.6, 57.8, -19.9] },
    { iso: "SC", label: "Seychelles", bbox: [55.2, -4.8, 55.8, -4.2] },
];

/* ──────────────────────── Oceania ─────────────────────────── */

const OCEANIA: CountryShard[] = [
    { iso: "AU-east", label: "Australia (east, lng > 135°)", bbox: [135, -44, 154, -10], parent: "AU" },
    { iso: "AU-west", label: "Australia (west, lng ≤ 135°)", bbox: [113, -36, 135, -10], parent: "AU" },
    { iso: "NZ", label: "New Zealand", bbox: [165, -47.3, 178.6, -34.4] },
    { iso: "PG", label: "Papua New Guinea", bbox: [140.8, -11.7, 156.0, -0.9] },
    { iso: "FJ", label: "Fiji", bbox: [177.0, -19.2, 180.0, -16.2] },
    { iso: "SB", label: "Solomon Islands", bbox: [155.7, -11.7, 167.0, -6.6] },
    { iso: "VU", label: "Vanuatu", bbox: [166.5, -20.3, 169.9, -13.1] },
    { iso: "NC", label: "New Caledonia", bbox: [163.5, -22.7, 168.1, -19.5] },
    { iso: "WS", label: "Samoa", bbox: [-172.8, -14.1, -171.4, -13.4] },
    { iso: "TO", label: "Tonga", bbox: [-176.1, -22.4, -173.7, -15.5] },
    { iso: "PF", label: "French Polynesia", bbox: [-152.0, -27.7, -134.4, -8.1] },
    { iso: "GU", label: "Guam", bbox: [144.6, 13.2, 145.0, 13.7] },
];

export const COUNTRY_SHARDS: CountryShard[] = [
    ...EUROPE,
    ...NORTH_AMERICA,
    ...SOUTH_AMERICA,
    ...ASIA,
    ...AFRICA,
    ...OCEANIA,
];
