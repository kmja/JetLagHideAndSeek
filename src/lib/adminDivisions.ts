/**
 * Country-specific names for the OSM `admin_level` tiers used by the
 * rulebook's matching "Same X" admin-division questions.
 *
 * Background. OSM `admin_level` is a coarse, country-agnostic tag —
 * level 4 means "1st-order subdivision below the country" in DE
 * (Bundesland), US (State), JP (Prefecture), CH (Canton), and so on,
 * but the *word* varies by country and the player wants the *word*.
 * Without it, the UI just says "OSM Zone 4" — technically correct,
 * useless to a German seeker who wants to ask "Same Bundesland".
 *
 * Source of truth. Lookups are drawn from OSM's
 * https://wiki.openstreetmap.org/wiki/Tag:boundary%3Dadministrative
 * country-by-country grid (which itself tracks Wikipedia's
 * "Administrative divisions of <country>"). Only common tiers (4-10)
 * are mapped — country (2) and supranational (3 in some countries) are
 * never the answer to "same X" questions in practice.
 *
 * Behaviour. `adminDivisionName(iso, level)` returns the localised
 * label when a row exists, falling back to the generic Nth-order
 * description. The fallback is what the seeker sees when the play
 * area is in a country we haven't tabled yet — still useful, just
 * less specific.
 *
 * v355: introduced to feed the matching-card admin-level dropdown,
 * the subtype picker tiles, and the question-list "Same Bundesland"
 * label.
 */

type AdminLevel = 4 | 5 | 6 | 7 | 8 | 9 | 10;

const TABLE: Record<string, Partial<Record<AdminLevel, string>>> = {
    AT: { 4: "State (Bundesland)", 6: "District (Bezirk)", 8: "Municipality (Gemeinde)" },
    AU: { 4: "State", 6: "Local Government Area" },
    BE: { 4: "Region", 6: "Province", 7: "Arrondissement", 8: "Municipality" },
    BR: { 4: "State (Estado)", 6: "Microregion", 8: "Municipality (Município)" },
    CA: { 4: "Province / Territory", 6: "Census Division", 8: "Municipality" },
    CH: { 4: "Canton", 6: "District (Bezirk)", 8: "Municipality (Gemeinde)" },
    CN: { 4: "Province (省)", 5: "Prefecture (地区)", 6: "County (县)", 7: "Township (镇)" },
    CZ: { 4: "Region (Kraj)", 6: "District (Okres)", 7: "Microregion", 8: "Municipality (Obec)" },
    DE: { 4: "State (Bundesland)", 5: "Government Region", 6: "District (Kreis)", 7: "Amt / Verbandsgemeinde", 8: "Municipality (Gemeinde)", 9: "City District (Stadtteil)" },
    DK: { 4: "Region", 7: "Municipality (Kommune)" },
    ES: { 4: "Autonomous Community", 6: "Province", 8: "Municipality" },
    FI: { 4: "Region (Maakunta)", 6: "Sub-region", 8: "Municipality (Kunta)" },
    FR: { 4: "Region (Région)", 6: "Department (Département)", 7: "Arrondissement", 8: "Commune", 9: "Borough (Arrondissement municipal)" },
    GB: { 4: "Country / Region", 5: "Combined Authority", 6: "County / Council Area", 7: "District", 8: "Civil Parish", 10: "Ward" },
    HU: { 4: "County (Megye)", 6: "District (Járás)", 8: "Town / City (Város)" },
    IE: { 4: "Province", 5: "Region", 6: "County", 7: "Municipal District" },
    IN: { 4: "State", 5: "Division", 6: "District", 8: "Sub-district" },
    IT: { 4: "Region (Regione)", 6: "Province (Provincia)", 7: "Metropolitan City", 8: "Comune", 9: "Sub-comune" },
    JP: { 4: "Prefecture (都道府県)", 6: "Subprefecture", 7: "City / Special Ward", 8: "Town / Village", 9: "Ward (区)" },
    KR: { 4: "Province (도)", 6: "City / County (시 / 군)", 8: "Sub-municipality (읍 / 면 / 동)" },
    MX: { 4: "State (Estado)", 6: "Municipality (Municipio)" },
    NL: { 4: "Province (Provincie)", 8: "Municipality (Gemeente)", 10: "Neighbourhood (Buurt)" },
    NO: { 4: "County (Fylke)", 7: "Municipality (Kommune)" },
    NZ: { 4: "Region", 6: "District / City" },
    PL: { 4: "Voivodeship (Województwo)", 6: "County (Powiat)", 7: "Gmina", 8: "Gmina seat" },
    PT: { 4: "District (Distrito)", 6: "Municipality (Município)", 8: "Civil Parish (Freguesia)" },
    RU: { 4: "Federal Subject", 5: "Federal District", 6: "Raion", 8: "Settlement" },
    SE: { 4: "County (Län)", 7: "Municipality (Kommun)" },
    TR: { 4: "Province (İl)", 6: "District (İlçe)", 8: "Village / Quarter (Mahalle)" },
    TW: { 4: "Province / Special Municipality", 5: "County / City (縣 / 市)", 7: "Township / District (鄉 / 區)" },
    UA: { 4: "Oblast", 6: "Raion", 8: "Hromada" },
    US: { 4: "State", 5: "Combined Statistical Area", 6: "County", 7: "Borough / Township", 8: "City / Town", 9: "Ward", 10: "Neighbourhood" },
    ZA: { 4: "Province", 6: "District Municipality", 8: "Local Municipality" },
};

/** Generic Nth-order fallback when we don't have a country-specific
 *  label. Stops at the depth the rulebook actually uses. */
const GENERIC: Record<AdminLevel, string> = {
    4: "1st admin division",
    5: "Sub-state region",
    6: "2nd admin division",
    7: "Sub-county region",
    8: "3rd admin division",
    9: "Sub-municipal district",
    10: "4th admin division",
};

/**
 * The human label for an OSM admin_level in a given ISO-2 country
 * code (case-insensitive). Falls back to the generic Nth-order
 * description if the row is missing.
 *
 * Pass the level as a number (matches the schema's `cat.adminLevel`).
 * `iso` may be undefined (no play area set yet) — returns the
 * generic label.
 */
export function adminDivisionName(
    iso: string | undefined | null,
    level: number,
): string {
    if (level < 4 || level > 10) return `OSM Zone ${level}`;
    const tier = level as AdminLevel;
    const row = iso ? TABLE[iso.toUpperCase()] : undefined;
    return row?.[tier] ?? GENERIC[tier];
}

/**
 * Best-default OSM admin_level for the rulebook's admin tiers
 * (1st-4th admin division) in a given country. Most countries follow
 * the 4/6/8/9 pattern, but a few don't — Japan's "city / special
 * ward" is level 7, the UK's parish system sits oddly, etc. Used by
 * the subtype-picker shortcuts so a German player tapping "1st admin
 * division" gets level 4 (Bundesland) but a Japanese player gets the
 * Prefecture mapping too — both already correct in the default table.
 */
const TIER_OVERRIDES: Record<string, [number, number, number, number]> = {
    // [tier1, tier2, tier3, tier4]
    JP: [4, 7, 8, 9],
    GB: [4, 6, 7, 10],
    NO: [4, 7, 7, 7],
    SE: [4, 7, 7, 7],
    DK: [4, 7, 7, 7],
    // v970 (rulebook audit B): the rulebook's own 4th-division example is
    // "NYC has boroughs" — and NYC boroughs are OSM admin_level 7 (Queens
    // borough L7 sits beside coterminous Queens County L6; NYC has NO L8/L9
    // inside it), so the generic tier4→9 default found nothing there. Tiers
    // 1-3 keep the standard state/county/municipality 4/6/8.
    US: [4, 6, 8, 7],
};

export function adminTierToOsmLevel(
    iso: string | undefined | null,
    tier: 1 | 2 | 3 | 4,
): number {
    const code = iso?.toUpperCase();
    const row = code ? TIER_OVERRIDES[code] : undefined;
    if (row) return row[tier - 1];
    const defaults = [4, 6, 8, 9] as const;
    return defaults[tier - 1];
}
