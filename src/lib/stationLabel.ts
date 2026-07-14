/**
 * Station-name shortening for the hiding-zone map labels (v835).
 *
 * A dense metro's overlay (NYC, London) is a wall of long station names —
 * "145th Street", "Bedford Avenue", "Brooklyn Navy Yard Ferry Station".
 * Two steps calm it down:
 *   1. `abbreviateStationName` collapses the common street-type SUFFIXES to
 *      their postal abbreviations (Street → St, Avenue → Ave, …). Purely a
 *      word-level replace; the rest of the name is untouched.
 *   2. `shortenStationLabel` then hard-truncates to a max length (with an
 *      ellipsis), so even an un-abbreviatable long name stays compact. The
 *      max is a debug-adjustable atom (`stationLabelMaxChars`, default 12).
 *
 * Applied at MAP-RENDER time to the label feature's `shortName` property —
 * the full `name` is kept for taps / selection, so shortening is display-only.
 */

/** Whole-word street-type → abbreviation. Ordered longest-first isn't needed
 *  (word boundaries prevent overlaps). Case-insensitive; the abbreviation
 *  keeps title-case since these only appear as suffixes. */
const SUFFIX_ABBREVIATIONS: [RegExp, string][] = [
    [/\bStreet\b/gi, "St"],
    [/\bAvenue\b/gi, "Ave"],
    [/\bBoulevard\b/gi, "Blvd"],
    [/\bRoad\b/gi, "Rd"],
    [/\bSquare\b/gi, "Sq"],
    [/\bStation\b/gi, "Stn"],
    [/\bTerminal\b/gi, "Term"],
    [/\bCentre\b/gi, "Ctr"],
    [/\bCenter\b/gi, "Ctr"],
    [/\bPlace\b/gi, "Pl"],
    [/\bDrive\b/gi, "Dr"],
    [/\bLane\b/gi, "Ln"],
    [/\bCourt\b/gi, "Ct"],
    [/\bTerrace\b/gi, "Ter"],
    [/\bParkway\b/gi, "Pkwy"],
    [/\bHeights\b/gi, "Hts"],
    [/\bJunction\b/gi, "Jct"],
    [/\bGardens\b/gi, "Gdns"],
    [/\bCrescent\b/gi, "Cres"],
];

/** Collapse common street-type suffixes to their abbreviations. Idempotent
 *  and safe on any string; whitespace is normalised. */
export function abbreviateStationName(name: string): string {
    if (typeof name !== "string") return "";
    let out = name;
    for (const [re, rep] of SUFFIX_ABBREVIATIONS) out = out.replace(re, rep);
    return out.replace(/\s+/g, " ").trim();
}

/**
 * The display label for a station: abbreviated, then truncated to
 * `maxChars` with a trailing ellipsis. `maxChars <= 0` disables truncation
 * (abbreviation only). Trims a trailing space/hyphen before the ellipsis so
 * "116th St-…" doesn't read oddly.
 */
export function shortenStationLabel(name: string, maxChars: number): string {
    const abbr = abbreviateStationName(name);
    if (!Number.isFinite(maxChars) || maxChars <= 0) return abbr;
    if (abbr.length <= maxChars) return abbr;
    const cut = abbr.slice(0, Math.max(1, maxChars - 1)).replace(/[\s-]+$/, "");
    return `${cut}…`;
}
