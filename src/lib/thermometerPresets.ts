import type { GameSize } from "@/lib/gameSetup";
import { formatMeters, gameDistanceKm, type UnitSystem } from "@/lib/units";

/**
 * Canonical thermometer target-distance tiers, ONE source of truth for the
 * three surfaces that render them (the configure dialog, the on-map
 * tracker overlay, and the question card). v972.
 *
 * `sig` is the stable, unit-independent id stored on the question's
 * `distance` / `targetSig` fields (so it must never change). `meters` is
 * the rulebook metric distance; the LABEL and the tracker THRESHOLD (km)
 * are both derived from `meters` + the selected unit system, so an
 * imperial player sees "0.5 mi / 3 mi / 10 mi / 45 mi" and the live
 * tracker triggers at those nice values.
 *
 * `validSizes` follows rulebook p30: 1 km + 5 km all sizes; 15 km M+L;
 * 75 km L only. The legacy house presets (500 m / 2 km / 10 km) are kept
 * with EMPTY `validSizes` (v969 A6) so a legacy saved game's sig still
 * resolves a label, but they're never selectable.
 */
export interface ThermometerTier {
    sig: string;
    meters: number;
    validSizes: GameSize[];
}

const ALL_SIZES: GameSize[] = ["small", "medium", "large"];

export const THERMOMETER_TIERS: ThermometerTier[] = [
    { sig: "500m", meters: 500, validSizes: [] },
    { sig: "1km", meters: 1000, validSizes: ALL_SIZES },
    { sig: "2km", meters: 2000, validSizes: [] },
    { sig: "5km", meters: 5000, validSizes: ALL_SIZES },
    { sig: "10km", meters: 10000, validSizes: [] },
    { sig: "15km", meters: 15000, validSizes: ["medium", "large"] },
    { sig: "75km", meters: 75000, validSizes: ["large"] },
];

export interface ThermometerPreset {
    sig: string;
    /** Display label in the selected system (e.g. "0.5 mi" / "1 km"). */
    label: string;
    /** Tracker threshold in KILOMETRES (imperial uses the nice miles). */
    km: number;
    validSizes: GameSize[];
}

/** Build the thermometer presets for a unit system. */
export function thermometerPresets(system: UnitSystem): ThermometerPreset[] {
    return THERMOMETER_TIERS.map((t) => ({
        sig: t.sig,
        label: formatMeters(t.meters, system),
        km: gameDistanceKm(t.meters, system),
        validSizes: t.validSizes,
    }));
}

/** Unit-aware display label for a stored thermometer sig (e.g. the
 *  question's `distance` field). Falls back to the raw sig for an
 *  unknown value. v972. */
export function thermometerSigLabel(
    sig: string | undefined,
    system: UnitSystem,
): string {
    if (!sig) return "";
    const tier = THERMOMETER_TIERS.find((t) => t.sig === sig);
    return tier ? formatMeters(tier.meters, system) : sig;
}

/** The presets a game size may pick from (selectable tiers only). */
export function thermometerPresetsForSize(
    size: GameSize,
    system: UnitSystem,
): ThermometerPreset[] {
    return thermometerPresets(system).filter((p) =>
        p.validSizes.includes(size),
    );
}
