/**
 * Tiny map-fitting helper. Used by the radar question flows (add +
 * configure) to keep the seeker's chosen radius fully visible — the
 * old default of "tap radar → keep the current zoom" surprised
 * players when the 10 km circle extended off-screen.
 *
 * Lives in its own file (rather than @/lib/context) so it doesn't
 * drag any nanostores into modules that just want to do a map-fit
 * — and because the leaflet import is dynamic, this stays safe to
 * import from SSR-reachable trees.
 */

const METERS_PER_UNIT: Record<string, number> = {
    meters: 1,
    kilometers: 1000,
    miles: 1609.344,
};

/**
 * Pan/zoom a map so a circle of `radius` (in the given units) centred
 * on `(lat, lng)` is fully visible with a sensible margin.
 *
 * Map type is loose on purpose. The function is called from both the
 * Leaflet path (where `map` is a real `L.Map`) and the MapLibre path
 * (where it's a `maplibregl.Map`). Both expose a `fitBounds` that
 * accepts a south-west / north-east coordinate pair, just with slightly
 * different tuple conventions (Leaflet wants [lat,lng], MapLibre wants
 * [lng,lat]) — we hand off whichever the caller built and rely on the
 * caller to pass the right shape for the runtime in use.
 */
 
export function fitMapToRadius(
    map: any,
    lat: number,
    lng: number,
    radius: number,
    unit: "meters" | "kilometers" | "miles",
): void {
    if (!map || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
    if (!Number.isFinite(radius) || radius <= 0) return;

    const meters = radius * (METERS_PER_UNIT[unit] ?? 1);

    // Coarse but accurate-enough conversion: 1° lat ≈ 111 320 m;
    // 1° lng scales with cos(lat). We over-pad by 15% so the circle
    // doesn't kiss the viewport edge and to give Leaflet room for
    // its zoom-snap quantisation.
    const latDelta = (meters / 111_320) * 1.15;
    const lngDelta =
        (meters / (111_320 * Math.cos((lat * Math.PI) / 180))) * 1.15;

    const bounds: [[number, number], [number, number]] = [
        [lat - latDelta, lng - lngDelta],
        [lat + latDelta, lng + lngDelta],
    ];

    try {
        map.fitBounds(bounds, { animate: true, duration: 0.4 });
    } catch {
        /* ignore — degenerate bounds, map unmounted, etc. */
    }
}
