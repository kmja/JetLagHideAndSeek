import type { APILocations } from "@/maps/schema";

/**
 * Overpass boundary endpoints, in failover order:
 *
 *   1. OVERPASS_API — our own R2-backed cache worker. Cached
 *      requests return in single-digit ms; cache misses fall
 *      through to the same three public mirrors below, store
 *      the result in R2, and return. A weekly cron also
 *      pre-warms a curated list of major cities so first-time
 *      regional loads hit warm cache.
 *   2. OVERPASS_API_FALLBACK — direct hit on the second public
 *      mirror. Used only if our worker is itself unreachable.
 *   3. OVERPASS_API_TERTIARY — third public mirror, same role.
 *
 * If you're running locally without the cache worker deployed,
 * swap OVERPASS_API back to `https://overpass-api.de/api/interpreter`.
 */
export const OVERPASS_API =
    "https://jlhs-overpass-cache.karl-mj-andersson.workers.dev/api/interpreter";
export const OVERPASS_API_FALLBACK =
    "https://overpass.private.coffee/api/interpreter";
export const OVERPASS_API_TERTIARY =
    "https://overpass.kumi.systems/api/interpreter";
export const GEOCODER_API = "https://photon.komoot.io/api/";
export const PASTEBIN_API_POST_URL =
    "https://cors-anywhere.com/https://pastebin.com/api/api_post.php";
export const PASTEBIN_API_RAW_URL = "https://pastebin.com/raw/";
export const PASTEBIN_API_RAW_URL_PROXIED =
    "https://cors-anywhere.com/https://pastebin.com/raw/";

export const ICON_COLORS = {
    black: "#3D3D3D",
    blue: "#2A81CB",
    gold: "#FFD326",
    green: "#2AAD27",
    grey: "#7B7B7B",
    orange: "#CB8427",
    red: "#CB2B3E",
    violet: "#9C2BCB",
};

export const LOCATION_FIRST_TAG: {
    [key in APILocations]:
        | "amenity"
        | "tourism"
        | "leisure"
        | "diplomatic"
        | "natural";
} = {
    aquarium: "tourism",
    hospital: "amenity",
    peak: "natural",
    museum: "tourism",
    theme_park: "tourism",
    zoo: "tourism",
    cinema: "amenity",
    library: "amenity",
    golf_course: "leisure",
    consulate: "diplomatic",
    park: "leisure",
};

export const BLANK_GEOJSON = {
    type: "FeatureCollection",
    features: [
        {
            type: "Feature",
            properties: {},
            geometry: {
                type: "Polygon",
                coordinates: [
                    [
                        [-180, -90],
                        [180, -90],
                        [180, 90],
                        [-180, 90],
                        [-180, -90],
                    ],
                ],
            },
        },
    ],
};
