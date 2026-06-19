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
/** v233: PMTiles vector basemap served by the same worker. The path
 *  after /tiles/ names a file in the TILES R2 bucket. The client
 *  (src/lib/protomapsStyle.ts) falls back to the Protomaps demo bucket
 *  (proxied through this worker to avoid browser CORS restrictions)
 *  while this URL still 404s.
 *
 *  v260: date-stamped key for the worldwide-z15 build. Tiles are served
 *  `immutable, max-age=1y`, so we version by FILENAME, never by mutating
 *  a key in place — that also sidesteps the v259 incident where a
 *  partial (extract-failed) upload poisoned `basemap.pmtiles`. Upload
 *  the file under this exact key BEFORE relying on it; until it lands
 *  the probe cleanly 404s → proxied demo fallback (a working map, just
 *  at demo detail). */
const DEFAULT_PMTILES_URL = `${JLHS_WORKER_BASE}/tiles/basemap-z15-20260614.pmtiles`;
const DEFAULT_OVERPASS_API_FALLBACK =
    "https://overpass-api.de/api/interpreter";
const DEFAULT_OVERPASS_API_TERTIARY =
    "https://overpass.private.coffee/api/interpreter";
const DEFAULT_OVERPASS_API_QUATERNARY =
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
export const PMTILES_URL = readOverride(
    "jlhs:pmtilesUrl",
    DEFAULT_PMTILES_URL,
);
/** Fallback PMTiles source — proxied through our own worker so the
 *  browser's CORS restrictions don't apply. Forwards to the Protomaps
 *  demo bucket server-side. Active only when our R2 file is missing. */
export const PMTILES_URL_FALLBACK =
    `${JLHS_WORKER_BASE}/tiles/protomaps-fallback`;
/** Base URL for city tile packs (v336). A pack for OSM relation N is
 *  at `${TILE_PACK_BASE}/N.pmtiles`, served by the worker's /tiles/
 *  route. The `v1/` namespace MUST match `tilePackKey` in
 *  overpass-cache/src/index.ts and the laptop uploader — bump together
 *  if the master basemap is re-rendered. */
export const TILE_PACK_BASE = `${JLHS_WORKER_BASE}/tiles/tile-packs/v1`;
/** Base URL for self-hosted elevation tiles (v342). A Terrarium-encoded
 *  PNG for tile z/x/y is at `${ELEVATION_TILE_BASE}/{z}/{x}/{y}.png`,
 *  proxied + R2-cached by the worker from the AWS Terrain Tiles dataset.
 *  Used by the sea-level measuring question to build an altitude
 *  contour. */
export const ELEVATION_TILE_BASE = `${JLHS_WORKER_BASE}/api/elevation`;
/** Base URL for self-hosted map glyphs + sprites (v349), proxied +
 *  R2-cached by the worker from protomaps.github.io/basemaps-assets.
 *  The MapLibre style's `glyphs` and `sprite` URLs point here so the
 *  basemap has no external dependency at game time. */
export const MAP_ASSET_BASE = `${JLHS_WORKER_BASE}/api/mapasset`;
export const OVERPASS_API_TERTIARY = readOverride(
    "jlhs:overpassApiTertiary",
    DEFAULT_OVERPASS_API_TERTIARY,
);
export const OVERPASS_API_QUATERNARY = readOverride(
    "jlhs:overpassApiQuaternary",
    DEFAULT_OVERPASS_API_QUATERNARY,
);
/** Photon forward-search endpoint, proxied through our worker so
 *  responses land in R2 (search-box submissions are the single most
 *  repeated upstream-touching call). Override via
 *  localStorage[`overpass-api-photon-forward`] for local dev when the
 *  worker isn't reachable. Mirrors the override pattern that
 *  OVERPASS_API uses. */
export const PHOTON_FORWARD_API = readOverride(
    "jlhs:photonForwardApi",
    `${JLHS_WORKER_BASE}/api/photon/forward`,
);
/** Photon reverse-geocode endpoint, same proxy + override pattern. */
export const PHOTON_REVERSE_API = readOverride(
    "jlhs:photonReverseApi",
    `${JLHS_WORKER_BASE}/api/photon/reverse`,
);
/** Legacy direct-to-Photon URL. Retained as a last-resort fallback
 *  for callers we haven't migrated; new code should use
 *  `PHOTON_FORWARD_API` / `PHOTON_REVERSE_API` instead. */
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
