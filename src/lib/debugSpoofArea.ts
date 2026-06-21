import * as turf from "@turf/turf";

import { mapGeoLocation, polyGeoJSON } from "@/lib/context";
import { spoofedPosition } from "@/lib/debugGpsSpoof";

/**
 * Set the spoof to a random point INSIDE the current play area. Prefers
 * the land-clipped `polyGeoJSON` polygon (so the point lands on land, not
 * out in the bay) via rejection sampling; falls back to the play area's
 * Photon bbox extent when no polygon is set. Returns false when there's
 * no play area to spoof into.
 *
 * v401-perf: split out of `debugGpsSpoof.ts` so that file (which is
 * imported EAGERLY at app load for `installGpsSpoof`) no longer pulls in
 * `@turf/turf` (+ its transitive d3). This function is only reached from
 * the lazy `DebugPhaseControls`, so turf now loads with the game route
 * instead of on first paint — removing ~456KB (turf+d3) from the eager
 * bundle. `installGpsSpoof` itself never used turf; only this did.
 */
export function spoofRandomInPlayArea(): boolean {
    const poly = polyGeoJSON.get();
    if (poly && poly.features.length > 0) {
        const merged =
            poly.features.length === 1
                ? poly.features[0]
                : (turf.combine(poly).features[0] as GeoJSON.Feature);
        const b = turf.bbox(poly);
        const [w, s, e, n] = [b[0], b[1], b[2], b[3]];
        for (let i = 0; i < 300; i++) {
            const lng = w + Math.random() * (e - w);
            const lat = s + Math.random() * (n - s);
            if (
                turf.booleanPointInPolygon(
                    turf.point([lng, lat]),
                    merged as any,
                )
            ) {
                spoofedPosition.set({ lat, lng });
                return true;
            }
        }
        // Degenerate / very thin polygon — fall back to its centroid.
        const c = turf.centroid(merged as any).geometry.coordinates;
        spoofedPosition.set({ lat: c[1], lng: c[0] });
        return true;
    }

    // No polygon yet — use the Photon extent bbox
    // ([maxLat, minLng, minLat, maxLng]).
    const extent = (mapGeoLocation.get()?.properties as { extent?: number[] })
        ?.extent;
    if (extent && extent.length === 4) {
        const [maxLat, minLng, minLat, maxLng] = extent;
        const lat = minLat + Math.random() * (maxLat - minLat);
        const lng = minLng + Math.random() * (maxLng - minLng);
        spoofedPosition.set({ lat, lng });
        return true;
    }
    return false;
}
