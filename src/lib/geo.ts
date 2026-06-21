/**
 * Tiny geo helpers shared across the transit/trip-planning UI.
 *
 * These intentionally avoid pulling in `@turf/turf` (which is a large
 * dependency) for what is a couple lines of trig — the trip-planning
 * components call this on every GPS tick / station-list render, so the
 * lightweight inline version keeps those hot paths cheap. For heavier
 * geometry (buffers, voronoi, point-in-polygon) use the turf-based
 * operators in `src/maps/geo-utils/` instead.
 */

/** Great-circle distance between two lat/lng points, in metres. */
export function haversineMeters(
    lat1: number,
    lng1: number,
    lat2: number,
    lng2: number,
): number {
    const R = 6_371_000; // mean Earth radius, metres
    const phi1 = (lat1 * Math.PI) / 180;
    const phi2 = (lat2 * Math.PI) / 180;
    const dPhi = ((lat2 - lat1) * Math.PI) / 180;
    const dLambda = ((lng2 - lng1) * Math.PI) / 180;
    const a =
        Math.sin(dPhi / 2) ** 2 +
        Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
