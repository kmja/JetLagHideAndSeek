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
 * Each can be overridden at runtime via localStorage — useful
 * for quick debugging if our cache worker is misbehaving:
 *
 *     localStorage.setItem('jlhs:overpassApi',
 *       'https://overpass-api.de/api/interpreter');
 *     location.reload();
 *
 * Clear the override with `localStorage.removeItem('jlhs:overpassApi')`.
 */
const JLHS_WORKER_BASE =
    "https://jlhs-overpass-cache.karl-mj-andersson.workers.dev";
const DEFAULT_OVERPASS_API = `${JLHS_WORKER_BASE}/api/interpreter`;
/** Journey-time arrival proxy. Server holds the Trafiklab key as
 *  a secret so the seeker app doesn't need to ask each player to
 *  sign up. See overpass-cache/src/journey.ts for the impl. */
const DEFAULT_JOURNEY_API = `${JLHS_WORKER_BASE}/api/journey/arrivals`;
const DEFAULT_OVERPASS_API_FALLBACK =
    "https://overpass.private.coffee/api/interpreter";
const DEFAULT_OVERPASS_API_TERTIARY =
    "https://overpass.kumi.systems/api/interpreter";

function readOverride(key: string, fallback: string): string {
    if (typeof window === "undefined") return fallback;
    try {
        const v = window.localStorage.getItem(key);
        if (v && typeof v === "string" && v.length > 0) return v;
    } catch {
        /* localStorage blocked — use default */
    }
    return fallback;
}

export const OVERPASS_API = readOverride(
    "jlhs:overpassApi",
    DEFAULT_OVERPASS_API,
);
export const OVERPASS_API_FALLBACK = readOverride(
    "jlhs:overpassApiFallback",
    DEFAULT_OVERPASS_API_FALLBACK,
);
export const JOURNEY_API = readOverride(
    "jlhs:journeyApi",
    DEFAULT_JOURNEY_API,
);
export const OVERPASS_API_TERTIARY = readOverride(
    "jlhs:overpassApiTertiary",
    DEFAULT_OVERPASS_API_TERTIARY,
);
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
