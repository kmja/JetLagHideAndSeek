/**
 * Global app-wide preference for unit system: metric or imperial.
 *
 * Used (initially) by the rulebook viewer to render distances in the
 * player's preferred system, but designed to be the single source of
 * truth for any future place we display human-readable distances.
 *
 * Default is "metric". A previous version tried to auto-detect from
 * `navigator.language`, but English-as-a-second-language users in
 * metric countries (`en-AU`, `en-IN`, plain `en` on a German phone)
 * would have been routed to imperial — overshooting by an order of
 * magnitude. A plain default + visible toggle is simpler and right.
 */
import { persistentAtom } from "@nanostores/persistent";
import { computed } from "nanostores";

export type UnitSystem = "metric" | "imperial";
/** Kept as a separate type so future surfaces can re-introduce an
 *  "auto" or per-region default without breaking the existing
 *  persisted-store contract. */
export type UnitPreference = UnitSystem;

export const unitPreference = persistentAtom<UnitPreference>(
    "unit-preference",
    "metric",
    {
        encode: (v) => v,
        // Migrate legacy "auto" (v216 default) — without this, the
        // existing localStorage value would pass through and every
        // distance-conversion check (`=== "metric"`) would silently
        // fall through to the imperial branch. Reading anything other
        // than the two valid systems collapses to "metric".
        decode: (v) => (v === "imperial" ? "imperial" : "metric"),
    },
);

/** Resolved unit system. Currently a 1:1 of the preference, but kept
 *  as a `computed` so callers don't have to change if we ever
 *  re-introduce a derived layer (per-game override, etc.). */
export const resolvedUnits = computed(unitPreference, (pref) => pref);

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
