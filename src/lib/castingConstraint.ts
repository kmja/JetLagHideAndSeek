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
export const CURSE_HIDDEN_HANGMAN = "Curse of the Hidden Hangman";
export const CURSE_TRAVEL_AGENT = "Curse of the Mediocre Travel Agent";

/** Hidden Hangman: losses that end the curse (1 S / 2 M / 3 L, rulebook). */
export function hangmanMaxLosses(size: GameSize): number {
    return size === "small" ? 1 : size === "medium" ? 2 : 3;
}

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

/**
 * Mediocre Travel Agent: the destination radius around the seekers, km — the
 * "publicly-accessible place within 0.5 km (S) / 0.5 km (M) / 1 km (L) of the
 * seekers' current location" the effect allows.
 */
export function travelAgentRadiusKm(size: GameSize): number {
    return size === "large" ? 1 : 0.5;
}

export interface TravelAgentResult {
    status: ConstraintStatus;
    /** Which condition failed (only when `blocked`). */
    reason?: "too-far-from-seekers" | "too-close-to-hider";
    /** Picked destination → seekers, km. */
    destToSeekersKm?: number;
    /** Allowed radius around the seekers, km. */
    radiusKm?: number;
    /** Picked destination → hider, km. */
    destToHiderKm?: number;
    /** Seekers → hider, km. */
    seekerToHiderKm?: number;
}

/**
 * Mediocre Travel Agent — the two CHECKABLE geographic conditions:
 *   1. Effect: the destination must be within `travelAgentRadiusKm` of the
 *      seekers' current location.
 *   2. Casting cost: the destination must be FARTHER from the hider than the
 *      seekers currently are ("further from you than their current location").
 *
 * `seekerRef` = the freshest seeker location (the destination picker's centre).
 * Returns `unknown` (→ allow) when the destination or seeker reference is
 * missing/non-finite. The farther-from-hider check needs the hider's own fix;
 * when that's absent only the proximity condition is enforced (still `ok`
 * otherwise). Same fail-safe philosophy as the other constraints + the same
 * "Cast anyway" override on the fallible data.
 */
export function evaluateTravelAgent(
    size: GameSize,
    hiderPos: LatLng | null | undefined,
    seekerRef: LatLng | null | undefined,
    destPos: LatLng | null | undefined,
): TravelAgentResult {
    const finite = (p?: LatLng | null): p is LatLng =>
        !!p && Number.isFinite(p.lat) && Number.isFinite(p.lng);
    if (!finite(seekerRef) || !finite(destPos)) return { status: "unknown" };

    const radiusKm = travelAgentRadiusKm(size);
    const destToSeekersKm = haversineKm(destPos, seekerRef);
    if (destToSeekersKm > radiusKm) {
        return {
            status: "blocked",
            reason: "too-far-from-seekers",
            destToSeekersKm,
            radiusKm,
        };
    }
    if (finite(hiderPos)) {
        const destToHiderKm = haversineKm(destPos, hiderPos);
        const seekerToHiderKm = haversineKm(seekerRef, hiderPos);
        if (destToHiderKm <= seekerToHiderKm) {
            return {
                status: "blocked",
                reason: "too-close-to-hider",
                destToSeekersKm,
                radiusKm,
                destToHiderKm,
                seekerToHiderKm,
            };
        }
        return {
            status: "ok",
            destToSeekersKm,
            radiusKm,
            destToHiderKm,
            seekerToHiderKm,
        };
    }
    return { status: "ok", destToSeekersKm, radiusKm };
}
