/**
 * Fast-path boundary fetcher backed by polygons.openstreetmap.fr.
 *
 * The seeker app's heaviest network step is the play-area boundary
 * fetch: an Overpass query like `relation(65606);out geom;` returns
 * the raw member ways which osmtogeojson then assembles into a
 * MultiPolygon. Cold-cache that's 2–15 s of Overpass server time
 * for big relations (London, LA, Tokyo) — even on our own R2
 * cache the FIRST seeker to request a city eats the upstream cost.
 *
 * polygons.openstreetmap.fr is a free public service that maintains
 * pre-computed GeoJSON polygons for every OSM admin relation. A
 * `get_geojson.py?id=ID&params=0` request returns the GeoJSON
 * geometry directly in milliseconds when the polygon is already
 * computed, or triggers a server-side compute (~1–5 s) the first
 * time a relation is asked for. Either way it's faster than the
 * Overpass round-trip plus osmtogeojson assembly we do today.
 *
 * Used by `determineGeoJSON` as the first attempt for relation-
 * type fetches. Returns null on any failure (404, timeout, empty
 * body, unparseable response, polygon-not-yet-computed) so the
 * caller can fall back to the existing Overpass path without a
 * user-visible blip.
 */

/** Per-attempt timeout. Polygons.openstreetmap.fr is typically
 *  sub-second once a polygon is cached; first-of-its-kind requests
 *  take longer because the server computes on demand. 12 s keeps
 *  headroom for that compute without blocking failover. */
const POLYGONS_OSM_FR_TIMEOUT_MS = 12_000;

const DEFAULT_POLYGONS_OSM_FR_API =
    "https://polygons.openstreetmap.fr/get_geojson.py";

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

/** Overridable via `localStorage.setItem("jlhs:polygonsOsmFrApi", url)`. */
export const POLYGONS_OSM_FR_API = readOverride(
    "jlhs:polygonsOsmFrApi",
    DEFAULT_POLYGONS_OSM_FR_API,
);

/** Fetch the boundary polygon for an OSM relation from
 *  polygons.openstreetmap.fr. Returns a FeatureCollection shaped
 *  the same as `osmtogeojson`'s output (non-Point features only)
 *  on success, or null on any failure so the caller can fall back.
 *
 *  Always-resolving (never throws) so the caller doesn't need a
 *  try/catch — null IS the failure signal. */
export async function fetchBoundaryFromPolygonsOsmFr(
    osmId: string,
    /** Optional progress callback. Called with (loadedBytes,
     *  totalBytes|null) as the response streams in. Used by
     *  determineGeoJSON to feed the loading overlay's progress
     *  meter. */
    onProgress?: (loaded: number, total: number | null) => void,
): Promise<GeoJSON.FeatureCollection | null> {
    const url = `${POLYGONS_OSM_FR_API}?id=${encodeURIComponent(osmId)}&params=0`;
    const controller = new AbortController();
    const timer = setTimeout(
        () => controller.abort(),
        POLYGONS_OSM_FR_TIMEOUT_MS,
    );
    let resp: Response;
    try {
        resp = await fetch(url, {
            method: "GET",
            signal: controller.signal,
            // CORS is permissive on polygons.openstreetmap.fr.
            mode: "cors",
            headers: { Accept: "application/json" },
        });
    } catch {
        clearTimeout(timer);
        return null;
    }
    clearTimeout(timer);
    if (!resp.ok) return null;

    // Stream the body so we can feed a progress callback. The
    // server doesn't always send Content-Length (chunked transfer
    // for the largest boundaries), so total may be null mid-flight.
    let text: string;
    if (resp.body && onProgress) {
        const total = parseInt(resp.headers.get("Content-Length") ?? "", 10);
        const reader = resp.body.getReader();
        const chunks: Uint8Array[] = [];
        let loaded = 0;
        try {
            // eslint-disable-next-line no-constant-condition
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                loaded += value.byteLength;
                onProgress(loaded, Number.isFinite(total) ? total : null);
            }
        } catch {
            return null;
        }
        const combined = new Uint8Array(loaded);
        let offset = 0;
        for (const c of chunks) {
            combined.set(c, offset);
            offset += c.byteLength;
        }
        text = new TextDecoder().decode(combined);
    } else {
        try {
            text = await resp.text();
        } catch {
            return null;
        }
    }

    // The service returns the literal string `None` (Python's
    // null) when the polygon isn't computed yet, or an HTML page
    // on internal error. Defensive guards before JSON.parse.
    const trimmed = text.trim();
    if (
        !trimmed ||
        trimmed === "None" ||
        trimmed.startsWith("<") ||
        trimmed.startsWith("!")
    ) {
        return null;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        return null;
    }

    // The response can be either a bare Geometry, a Feature, or a
    // FeatureCollection. Normalize to FeatureCollection so the
    // downstream pipeline (which expects osmtogeojson's output
    // shape) doesn't need to special-case.
    const fc = normalizeToFeatureCollection(parsed);
    if (!fc || fc.features.length === 0) return null;
    return fc;
}

function normalizeToFeatureCollection(
    raw: unknown,
): GeoJSON.FeatureCollection | null {
    if (!raw || typeof raw !== "object") return null;
    const obj = raw as Record<string, unknown>;
    if (obj.type === "FeatureCollection") {
        const features = obj.features;
        if (!Array.isArray(features)) return null;
        return {
            type: "FeatureCollection",
            features: features.filter(
                (f) =>
                    f &&
                    typeof f === "object" &&
                    (f as { geometry?: GeoJSON.Geometry }).geometry &&
                    (f as { geometry: GeoJSON.Geometry }).geometry.type !==
                        "Point",
            ) as GeoJSON.Feature[],
        };
    }
    if (obj.type === "Feature") {
        const geometry = (obj as { geometry?: GeoJSON.Geometry }).geometry;
        if (!geometry || geometry.type === "Point") return null;
        return {
            type: "FeatureCollection",
            features: [obj as unknown as GeoJSON.Feature],
        };
    }
    // Bare Geometry (Polygon / MultiPolygon).
    if (
        obj.type === "Polygon" ||
        obj.type === "MultiPolygon" ||
        obj.type === "LineString" ||
        obj.type === "MultiLineString"
    ) {
        return {
            type: "FeatureCollection",
            features: [
                {
                    type: "Feature",
                    geometry: obj as unknown as GeoJSON.Geometry,
                    properties: {},
                },
            ],
        };
    }
    return null;
}
