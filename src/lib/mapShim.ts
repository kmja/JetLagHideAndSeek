/**
 * Map shim — adapts a maplibregl.Map to the subset of Leaflet's
 * Map API that the rest of the codebase still calls (getCenter,
 * getZoom, fitBounds, flyTo, plus no-op stubs for eachLayer /
 * removeLayer which only the deleted Leaflet path needed).
 *
 * Why this exists: the seeker app started life as a Leaflet
 * codebase. `mapContext` was the source of truth for
 * "the map is mounted; here it is." Many call sites — question
 * cards, AddQuestionDialog, OptionDrawers, the radius preset
 * picker — read it to pull a map.getCenter() or schedule a
 * map.flyTo() / map.fitBounds() animation.
 *
 * When we switched the renderer to MapLibre GL in v74-v77, those
 * call sites still expected the Leaflet method signatures
 * (in particular: flyTo([lat,lng], zoom) — MapLibre wants
 * flyTo({center: [lng,lat], zoom}); fitBounds([[lat,lng],
 * [lat,lng]]) — MapLibre wants fitBounds([[lng,lat],[lng,lat]])).
 * Rather than touch every one of those call sites, we publish a
 * shim that translates the Leaflet-shaped calls into MapLibre-
 * shaped ones on the way through, and have MapV2 set
 * `mapContext` to that shim instead of a real Leaflet Map.
 *
 * eachLayer / removeLayer become no-ops: those existed for the
 * Leaflet path to imperatively add/remove rendered question
 * markers, which MapLibre does declaratively through Source /
 * Layer atoms. The few sites that still call them (clearing
 * planning-mode layers) don't need to do anything on MapLibre.
 */

import type maplibregl from "maplibre-gl";

/** Leaflet-shaped map facade. Only the methods the rest of the
 *  codebase actually calls. Keep this surface tight — every method
 *  here is one we have to keep shimming forever. */
export interface MapShim {
    getCenter(): { lat: number; lng: number };
    getZoom(): number;
    fitBounds(
        bounds: [[number, number], [number, number]],
        opts?: {
            padding?: number | [number, number];
            animate?: boolean;
            duration?: number;
            maxZoom?: number;
        },
    ): void;
    flyTo(
        latlng: [number, number],
        zoom?: number,
        opts?: { duration?: number; animate?: boolean },
    ): void;
    /** No-op on MapLibre — layers are managed declaratively via
     *  Source/Layer atoms. */
    eachLayer(cb: (layer: unknown) => void): void;
    /** No-op on MapLibre — same reason. */
    removeLayer(layer: unknown): void;
}

/** Wrap a maplibregl.Map so it presents the Leaflet-flavoured
 *  surface defined above. The wrapper is cheap (one object alloc
 *  per Map mount) and the methods just translate coordinates /
 *  signatures on the way through. */
export function createMapShim(map: maplibregl.Map): MapShim {
    return {
        getCenter() {
            // maplibregl.LngLat already exposes .lat / .lng — no
            // translation needed.
            const c = map.getCenter();
            return { lat: c.lat, lng: c.lng };
        },
        getZoom() {
            return map.getZoom();
        },
        fitBounds(bounds, opts) {
            // Leaflet uses [[lat, lng], [lat, lng]], MapLibre
            // uses [[lng, lat], [lng, lat]]. Swap.
            const [[lat1, lng1], [lat2, lng2]] = bounds;
            map.fitBounds(
                [
                    [lng1, lat1],
                    [lng2, lat2],
                ],
                {
                    // Leaflet's `padding` accepts [x, y] or a
                    // single number — both flatten well to
                    // MapLibre's number-or-PaddingOptions arg.
                    padding: Array.isArray(opts?.padding)
                        ? opts?.padding[0]
                        : (opts?.padding ?? 40),
                    maxZoom: opts?.maxZoom,
                    // Leaflet's `duration` is in seconds (0.4 =
                    // 400ms); MapLibre wants milliseconds.
                    duration:
                        opts?.duration != null
                            ? opts.duration * 1000
                            : undefined,
                    animate: opts?.animate ?? true,
                },
            );
        },
        flyTo([lat, lng], zoom, opts) {
            map.flyTo({
                center: [lng, lat],
                zoom,
                duration:
                    opts?.duration != null ? opts.duration * 1000 : 600,
                animate: opts?.animate ?? true,
            });
        },
        eachLayer() {
            /* no-op — see header */
        },
        removeLayer() {
            /* no-op — see header */
        },
    };
}
