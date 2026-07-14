/**
 * Google "encoded polyline" decoder — the format MOTIS/OTP `legGeometry`
 * uses for a leg's real shape (the actual street/track path, not the
 * straight from→to segment). We decode it server-side and pass the
 * points through on `JourneyLeg.geometry` so the client can draw the true
 * walking/riding geometry instead of a schematic straight line.
 *
 * Returns GeoJSON-order `[lng, lat]` pairs (ready for a LineString), or an
 * empty array on any malformed input. `precision` is the coordinate
 * precision the encoder used — OTP-classic is 5, MOTIS v2 reports its own
 * (usually 7) in the `precision` field, so callers pass what upstream
 * gives and default to 5.
 */
export function decodePolyline(
    encoded: string,
    precision = 5,
): [number, number][] {
    if (typeof encoded !== "string" || encoded.length === 0) return [];
    const factor = Math.pow(10, precision);
    const coords: [number, number][] = [];
    let index = 0;
    let lat = 0;
    let lng = 0;
    const len = encoded.length;

    try {
        while (index < len) {
            let result = 0;
            let shift = 0;
            let b: number;
            do {
                b = encoded.charCodeAt(index++) - 63;
                result |= (b & 0x1f) << shift;
                shift += 5;
            } while (b >= 0x20 && index < len);
            const dlat = result & 1 ? ~(result >> 1) : result >> 1;
            lat += dlat;

            result = 0;
            shift = 0;
            do {
                b = encoded.charCodeAt(index++) - 63;
                result |= (b & 0x1f) << shift;
                shift += 5;
            } while (b >= 0x20 && index < len);
            const dlng = result & 1 ? ~(result >> 1) : result >> 1;
            lng += dlng;

            const plat = lat / factor;
            const plng = lng / factor;
            if (Number.isFinite(plat) && Number.isFinite(plng)) {
                coords.push([plng, plat]);
            }
        }
    } catch {
        return coords;
    }
    return coords;
}

/**
 * Pull a decoded `[lng, lat][]` shape out of an OTP/MOTIS `legGeometry`
 * object (`{ points, precision?, length? }`), or return undefined when
 * there's no usable geometry. Kept tiny + defensive so a shape-drifted
 * upstream never throws — a missing geometry just falls back to the
 * straight leg segment on the client.
 */
export function legGeometryPoints(
    legGeometry: unknown,
): [number, number][] | undefined {
    const g = legGeometry as { points?: unknown; precision?: unknown };
    if (!g || typeof g.points !== "string") return undefined;
    const precision =
        typeof g.precision === "number" && g.precision > 0 ? g.precision : 5;
    const pts = decodePolyline(g.points, precision);
    return pts.length >= 2 ? pts : undefined;
}
