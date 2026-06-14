/**
 * Global app-wide preference for unit system: metric, imperial, or auto.
 *
 * Used (initially) by the rulebook viewer to render distances in the
 * player's preferred system, but designed to be the single source of
 * truth for any future place we display human-readable distances.
 *
 * "auto" resolves to imperial for US/UK/Liberia/Myanmar locales and
 * metric everywhere else, using the browser's `navigator.language`
 * region tag. Falls back to metric on SSR or when the region tag is
 * unparseable — matches the rulebook's own default (the printed book
 * we transcribed is the metric edition).
 */
import { persistentAtom } from "@nanostores/persistent";
import { computed } from "nanostores";

export type UnitSystem = "metric" | "imperial";
export type UnitPreference = UnitSystem | "auto";

/**
 * Persistent user preference. "auto" is the default so first-time
 * visitors see the right system for their region without configuring
 * anything; explicit picks ("metric" / "imperial") stick across
 * sessions.
 */
export const unitPreference = persistentAtom<UnitPreference>(
    "unit-preference",
    "auto",
    { encode: (v) => v, decode: (v) => v as UnitPreference },
);

/** Regions whose primary unit system is imperial. Anywhere not in
 *  this list resolves to metric. Kept small and explicit — the long
 *  tail of mixed-system regions (Canada, etc.) sees metric by
 *  default, which matches typical map app behaviour. */
const IMPERIAL_REGIONS = new Set(["US", "LR", "MM"]);
const IMPERIAL_ROAD_REGIONS = new Set(["US", "LR", "MM", "GB"]);

/** Detect from the browser's locale. Distances on UK road signage
 *  and trail markers are still in miles/yards, so GB is treated as
 *  imperial for distance display even though the country is
 *  otherwise metric. */
function detectFromLocale(): UnitSystem {
    if (typeof navigator === "undefined") return "metric";
    const tags = [navigator.language, ...(navigator.languages ?? [])];
    for (const tag of tags) {
        if (!tag) continue;
        // Locale tags look like "en-US", "en_GB", or just "en". The
        // region is the uppercase part after the first separator.
        const m = tag.match(/[-_]([A-Za-z]{2,3})/);
        if (!m) continue;
        const region = m[1].toUpperCase();
        if (IMPERIAL_ROAD_REGIONS.has(region)) return "imperial";
        if (IMPERIAL_REGIONS.has(region)) return "imperial";
        return "metric";
    }
    return "metric";
}

/** Resolved unit system — "auto" expanded to a concrete metric or
 *  imperial. Reactive: re-derives whenever the preference changes. */
export const resolvedUnits = computed(unitPreference, (pref) =>
    pref === "auto" ? detectFromLocale() : pref,
);

/** Format meters in the chosen system. Picks the most readable
 *  imperial unit (ft for <1000 ft, mi otherwise). Metric stays as
 *  meters for <1000 and switches to km above that. */
export function formatMeters(meters: number, system: UnitSystem): string {
    if (system === "metric") {
        if (meters < 1000) return `${trimNumber(meters)} m`;
        return `${trimNumber(meters / 1000)} km`;
    }
    const ft = meters * 3.28084;
    if (ft < 1000) return `${trimNumber(ft, 0)} ft`;
    return `${trimNumber(ft / 5280, 2)} mi`;
}

/** Format kilometers in the chosen system. Metric stays km;
 *  imperial converts to miles. */
export function formatKm(km: number, system: UnitSystem): string {
    if (system === "metric") return `${trimNumber(km)} km`;
    const mi = km * 0.621371;
    // Tighter precision under 10 mi so "1 km" doesn't render as
    // "1 mi" (it's 0.6 mi). Above 10 mi, integer miles read better.
    return `${trimNumber(mi, mi < 10 ? 1 : 0)} mi`;
}

/** Format km/h (speed). Imperial → mph. */
export function formatKmh(kmh: number, system: UnitSystem): string {
    if (system === "metric") return `${trimNumber(kmh)} km/h`;
    return `${trimNumber(kmh * 0.621371, 0)} mph`;
}

/** Drop trailing .0 from numbers that round cleanly. `decimals`
 *  bounds how many digits to keep after the point; .0 always trims. */
function trimNumber(n: number, decimals = 1): string {
    const rounded = Number(n.toFixed(decimals));
    return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

/** Substitute distance templates in arbitrary text. Recognised:
 *  - `{{m:NNN}}`   — meters (e.g. {{m:500}})
 *  - `{{km:NN.N}}` — kilometers (e.g. {{km:1.5}})
 *  - `{{kmh:NNN}}` — kilometers/hour (e.g. {{kmh:250}})
 *
 *  Used by the rulebook renderer so the same markdown source serves
 *  both metric and imperial readers, and so authoring stays
 *  unit-agnostic (write the metric value the rulebook actually uses;
 *  the renderer handles the imperial conversion). */
export function applyUnitTemplates(text: string, system: UnitSystem): string {
    return text
        .replace(/\{\{m:(\d+(?:\.\d+)?)\}\}/g, (_, v) =>
            formatMeters(parseFloat(v), system),
        )
        .replace(/\{\{km:(\d+(?:\.\d+)?)\}\}/g, (_, v) =>
            formatKm(parseFloat(v), system),
        )
        .replace(/\{\{kmh:(\d+(?:\.\d+)?)\}\}/g, (_, v) =>
            formatKmh(parseFloat(v), system),
        );
}
