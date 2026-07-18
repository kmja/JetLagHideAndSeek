/**
 * Single source of truth for the app's unit system (metric vs imperial)
 * and every human-readable distance/speed it renders.
 *
 * v972: unified. There used to be TWO independent unit toggles — the
 * Settings "Miles / Kilometers" picker (`defaultUnit`, which also sets a
 * question's stored radius unit) and a separate Metric/Imperial toggle in
 * the rulebook viewer (`unitPreference`). They could disagree. Now the
 * ONE visible control is `defaultUnit`; `resolvedUnits` derives the
 * metric/imperial system from it, so the rulebook, card text, tile
 * descriptions, question presets, and the hiding zone all follow the same
 * selection.
 *
 * Conversion is CURATED, not raw. The Jet Lag creators round to clean
 * numbers (160 km = 100 mi, 80 km = 50 mi, 2 km ≈ 1 mi, 250 km/h =
 * 150 mph, …), not `× 0.621371` — so the canonical game distances map
 * through `GAME_DISTANCE_TABLE` to their nicely-rounded imperial forms.
 * Anything not in the table falls back to a sensible rounded conversion.
 */
import { computed } from "nanostores";

import { defaultUnit } from "@/lib/context";

export type UnitSystem = "metric" | "imperial";
/** Kept as a separate type so future surfaces can re-introduce an
 *  "auto" or per-region default without breaking callers. */
export type UnitPreference = UnitSystem;

/**
 * Resolved unit system, derived from the Settings units toggle
 * (`defaultUnit`). "miles" → imperial; "kilometers"/"meters" → metric.
 * A `computed` so every consumer re-renders when the toggle changes.
 */
export const resolvedUnits = computed(defaultUnit, (u): UnitSystem =>
    u === "miles" ? "imperial" : "metric",
);

/**
 * Curated metric→imperial map for the distances the game actually uses.
 * Keyed by METERS. The imperial value is the creators' clean rounding,
 * NOT a raw conversion. Small distances render in feet, larger ones in
 * miles. Keep this the ONE place these numbers live — radar/thermometer/
 * tentacle presets, the hiding zone, and every description read from it.
 */
export const GAME_DISTANCE_TABLE: Record<
    number,
    { imperialValue: number; imperialUnit: "ft" | "mi" }
> = {
    3: { imperialValue: 10, imperialUnit: "ft" },
    30: { imperialValue: 100, imperialUnit: "ft" },
    150: { imperialValue: 500, imperialUnit: "ft" },
    300: { imperialValue: 1000, imperialUnit: "ft" },
    500: { imperialValue: 0.25, imperialUnit: "mi" },
    1000: { imperialValue: 0.5, imperialUnit: "mi" },
    2000: { imperialValue: 1, imperialUnit: "mi" },
    5000: { imperialValue: 3, imperialUnit: "mi" },
    10000: { imperialValue: 6, imperialUnit: "mi" },
    15000: { imperialValue: 10, imperialUnit: "mi" },
    25000: { imperialValue: 15, imperialUnit: "mi" },
    40000: { imperialValue: 25, imperialUnit: "mi" },
    50000: { imperialValue: 30, imperialUnit: "mi" },
    75000: { imperialValue: 45, imperialUnit: "mi" },
    80000: { imperialValue: 50, imperialUnit: "mi" },
    160000: { imperialValue: 100, imperialUnit: "mi" },
};

/** Curated km/h → mph map (clean rounding). */
const SPEED_TABLE: Record<number, number> = {
    200: 125,
    250: 150,
};

/**
 * The nicely-rounded imperial radius (in MILES) for a metric distance
 * given in meters — used by the question presets when imperial is
 * selected. Every game radius is ≥ 0.25 mi, so this always returns miles.
 * Falls back to a rounded raw conversion for a non-canonical value.
 */
export function imperialMilesForMeters(meters: number): number {
    const hit = GAME_DISTANCE_TABLE[meters];
    if (hit) {
        return hit.imperialUnit === "mi"
            ? hit.imperialValue
            : hit.imperialValue / 5280;
    }
    const mi = meters * 0.000621371;
    // Round to a tidy step: 0.05 mi under 1 mi, whole miles above 10,
    // else 0.5 mi.
    if (mi < 1) return Math.round(mi * 20) / 20;
    if (mi > 10) return Math.round(mi);
    return Math.round(mi * 2) / 2;
}

/**
 * A question radius (value + unit) for the given metric distance in the
 * SELECTED system, using the curated table. Metric keeps km (or m under
 * 1 km); imperial converts to the creators' nice miles. Used by the
 * radar / thermometer / tentacle presets so an imperial player picks
 * imperial sizes and a metric player picks metric ones — the value is
 * stored on the question, so it displays consistently for every viewer
 * regardless of their own preference.
 */
export function gameRadius(
    meters: number,
    system: UnitSystem,
): { radius: number; unit: "meters" | "kilometers" | "miles" } {
    if (system === "imperial") {
        return { radius: imperialMilesForMeters(meters), unit: "miles" };
    }
    if (meters < 1000) return { radius: meters, unit: "meters" };
    return { radius: meters / 1000, unit: "kilometers" };
}

/**
 * The tracker THRESHOLD in kilometres for a metric distance in the
 * selected system — the thermometer measures displacement in km and
 * compares against this. Imperial uses the curated nice miles (0.5 mi =
 * 0.804 km), so the live tracker matches the imperial label the player
 * sees. Metric returns the plain km value.
 */
export function gameDistanceKm(meters: number, system: UnitSystem): number {
    const { radius, unit } = gameRadius(meters, system);
    if (unit === "miles") return radius * 1.609344;
    if (unit === "kilometers") return radius;
    return radius / 1000;
}

/** Format meters in the chosen system, using the curated table. */
export function formatMeters(meters: number, system: UnitSystem): string {
    if (system === "metric") {
        if (meters < 1000) return `${trimNumber(meters)} m`;
        return `${trimNumber(meters / 1000)} km`;
    }
    const hit = GAME_DISTANCE_TABLE[meters];
    if (hit) return `${trimNumber(hit.imperialValue)} ${hit.imperialUnit}`;
    // Non-canonical: pick the readable unit + a sensible round.
    const ft = meters * 3.28084;
    if (ft < 1000) return `${trimNumber(ft, 0)} ft`;
    return `${trimNumber(imperialMilesForMeters(meters), 2)} mi`;
}

/** Format kilometers in the chosen system, via the meters table. */
export function formatKm(km: number, system: UnitSystem): string {
    if (system === "metric") return `${trimNumber(km)} km`;
    return formatMeters(Math.round(km * 1000), system);
}

/** Format km/h (speed) in the chosen system, using the curated map. */
export function formatKmh(kmh: number, system: UnitSystem): string {
    if (system === "metric") return `${trimNumber(kmh)} km/h`;
    const mph = SPEED_TABLE[kmh] ?? Math.round(kmh * 0.621371);
    return `${trimNumber(mph, 0)} mph`;
}

/** Drop trailing .0 from numbers that round cleanly. `decimals`
 *  bounds how many digits to keep after the point; .0 always trims. */
function trimNumber(n: number, decimals = 2): string {
    const rounded = Number(n.toFixed(decimals));
    return String(rounded);
}

/** Substitute distance templates in arbitrary text. Recognised:
 *  - `{{m:NNN}}`   — meters (e.g. {{m:500}})
 *  - `{{km:NN.N}}` — kilometers (e.g. {{km:1.5}})
 *  - `{{kmh:NNN}}` — kilometers/hour (e.g. {{kmh:250}})
 *
 *  Used by the rulebook renderer AND the card/tile description renderers
 *  so a single metric-authored source serves both systems, and the
 *  curated table keeps the imperial numbers clean. */
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
