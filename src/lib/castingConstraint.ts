import type { GameSize } from "@/lib/gameSetup";

/**
 * Location-based CASTING-COST constraints the app can actually verify from the
 * positions it already holds (the hider's GPS + the seekers' last-shared
 * locations). The rulebook states these as conditions the hider must satisfy
 * BEFORE casting; rather than leave them to self-attestation (the dialog only
 * DISPLAYED the constraint text), these are ENFORCED — the "Cast curse" button
 * is blocked with an explanation until the condition holds.
 *
 * Only enforced when the data needed is present (multiplayer, with a fresh
 * seeker location + the hider's own fix). When it isn't — solo/offline, no
 * seeker has shared yet, a geo lookup fails — the result is `unknown` and the
 * cast is ALLOWED (never false-block a legitimate cast on missing data).
 *
 * Two constraints are covered:
 *   • Curse of the Bridge Troll — the seekers must be at least 2 km (S) /
 *     10 km (M) / 50 km (L) from the hider. Purely positional → evaluated
 *     synchronously here.
 *   • Curse of Water Weight — the seekers must be within 300 m of a body of
 *     water. Needs a water lookup at the seeker's location → evaluated
 *     asynchronously by the caller (this module only supplies the threshold +
 *     the name match).
 *
 * The genuinely un-checkable ones ("Seekers must be outside", U-Turn's "heading
 * the wrong way", Distant Cuisine's "at the restaurant") stay self-attested.
 */

export const CURSE_BRIDGE_TROLL = "Curse of the Bridge Troll";
export const CURSE_WATER_WEIGHT = "Curse of Water Weight";

/** Bridge Troll: minimum seeker→hider distance, in kilometres, by game size.
 *  Metric-canonical rulebook values (the card DISPLAY converts to the unit
 *  preference; the geographic threshold itself is fixed). */
export function bridgeTrollMinKm(size: GameSize): number {
    return size === "small" ? 2 : size === "medium" ? 10 : 50;
}

/** Water Weight: the seekers must be within this many metres of water. */
export const WATER_WEIGHT_WITHIN_M = 300;

export interface LatLng {
    lat: number;
    lng: number;
}

/** Cheap great-circle distance in kilometres. */
export function haversineKm(a: LatLng, b: LatLng): number {
    const R = 6371;
    const dLat = ((b.lat - a.lat) * Math.PI) / 180;
    const dLng = ((b.lng - a.lng) * Math.PI) / 180;
    const la1 = (a.lat * Math.PI) / 180;
    const la2 = (b.lat * Math.PI) / 180;
    const h =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export type ConstraintStatus = "ok" | "blocked" | "unknown";

export interface DistanceConstraintResult {
    status: ConstraintStatus;
    /** Nearest seeker's distance to the hider, km (present when evaluable). */
    nearestKm?: number;
    /** Required minimum, km. */
    minKm?: number;
}

/**
 * Bridge Troll — the NEAREST seeker must be at least `bridgeTrollMinKm` away.
 * `unknown` (→ allow) when the hider has no fix or no seeker has shared a
 * location yet.
 */
export function evaluateBridgeTroll(
    size: GameSize,
    hiderPos: LatLng | null | undefined,
    seekerPositions: LatLng[],
): DistanceConstraintResult {
    if (!hiderPos || seekerPositions.length === 0) return { status: "unknown" };
    const minKm = bridgeTrollMinKm(size);
    let nearestKm = Infinity;
    for (const s of seekerPositions) {
        if (!Number.isFinite(s.lat) || !Number.isFinite(s.lng)) continue;
        nearestKm = Math.min(nearestKm, haversineKm(hiderPos, s));
    }
    if (!Number.isFinite(nearestKm)) return { status: "unknown" };
    return {
        status: nearestKm < minKm ? "blocked" : "ok",
        nearestKm,
        minKm,
    };
}
