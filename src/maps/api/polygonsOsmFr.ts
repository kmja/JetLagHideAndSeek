/**
 * Fast-path relation-boundary fetcher backed by
 * polygons.openstreetmap.fr.
 *
 * For 'give me the polygon for OSM relation X' queries — which
 * are the heavy ones in this app (a play area's admin boundary)
 * — polygons.openstreetmap.fr has pre-computed GeoJSON for
 * essentially every relevant relation. Cold response is usually
 * sub-second; for huge relations (Shanghai, Tokyo, Greater
 * London) it's typically 1-5 s, vs Overpass server-compute
 * times that can blow past 30 s and trigger rate limits.
 *
 * v79 originally added this as a SERIAL pre-check before
 * Overpass with a 12 s timeout. That made every request wait
 * up to 12 s when polygons.osm.fr couldn't help (404 / hadn't-
 * computed-yet / CORS hiccup), so v86 removed it. v90 brings
 * it back, but now it joins the mirror race in
 * getOverpassData — first responder wins, polygons.osm.fr
 * silently doesn't compete for queries it can't help with.
 *
 * Returns Overpass-API-shaped JSON ({ elements: [...] }) so it
 * slots straight into the existing pipeline (osmtogeojson +
 * downstream) with no changes upstream of cacheFetch.
 */

const POLYGONS_OSM_FR_API =
    "https://polygons.openstreetmap.fr/get_geojson.py";

const REQUEST_TIMEOUT_MS = 8_000;

/** Pull the relation id out of the canonical
 *  `[out:json][timeout:NNN];relation(ID);out geom;` boundary
 *  query shape that determineGeoJSON emits. Returns null when
 *  the query is anything more elaborate (multi-relation,
 *  area-based POI fetches, transit-route queries) — those go
 *  through Overpass only. */
export function extractBoundaryRelationId(query: string): number | null {
    // Permissive whitespace; tolerate slight variations in the
    // timeout / output config the caller passes.
    const m =
        /^\s*\[out:json\][^;]*;\s*relation\((\d+)\)\s*;\s*out\s+geom\s*;\s*$/i.exec(
            query,
        );
    if (!m) return null;
    const n = parseInt(m[1], 10);
    return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Hit polygons.openstreetmap.fr for an OSM relation and return the raw
 * GeoJSON polygon geometry (or null on any failure). The preview map
 * in the wizard uses this for "show me the actual shape" without going
 * through the osmtogeojson stitching path that
 * `fetchBoundaryAsOverpassShape` is for.
 */
export async function fetchRawBoundaryPolygon(
    relationId: number,
    signal?: AbortSignal,
): Promise<GeoJSON.Polygon | GeoJSON.MultiPolygon | null> {
    const url = `${POLYGONS_OSM_FR_API}?id=${relationId}&params=0`;

    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);

    let resp: Response;
    try {
        resp = await fetch(url, {
            method: "GET",
            signal: ctrl.signal,
            mode: "cors",
            headers: { Accept: "application/json" },
        });
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
    }
    if (!resp.ok) return null;

    let text: string;
    try {
        text = await resp.text();
    } catch {
        return null;
    }
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
    return normalizeToPolyGeometry(parsed);
}

/**
 * Hit polygons.openstreetmap.fr for an OSM relation. Returns
 * an Overpass-shaped { elements: [...] } response on success,
 * or null on any failure (HTTP error, polygon-not-yet-computed
 * 'None' sentinel, parse error, timeout). Never throws.
 *
 * The synthetic Overpass element wraps the GeoJSON polygon in
 * a `members.geometry` shape that osmtogeojson recognises, so
 * the downstream pipeline doesn't need a separate code path.
 */
export async function fetchBoundaryAsOverpassShape(
    relationId: number,
    signal?: AbortSignal,
): Promise<{ elements: unknown[] } | null> {
    const geom = await fetchRawBoundaryPolygon(relationId, signal);
    if (!geom) return null;

    // Wrap as a minimal Overpass relation so osmtogeojson treats
    // it as a multipolygon boundary. The members[0].geometry
    // field is what osmtogeojson reads when assembling the
    // outer ring; supplying ready-made coordinates skips its
    // member-stitching pass entirely.
    return {
        elements: [
            {
                type: "relation",
                id: relationId,
                tags: {
                    type: "boundary",
                    boundary: "administrative",
                },
                members: synthesisMembersFromGeometry(geom, relationId),
            },
        ],
    };
}

function normalizeToPolyGeometry(
    raw: unknown,
): GeoJSON.Polygon | GeoJSON.MultiPolygon | null {
    if (!raw || typeof raw !== "object") return null;
    const obj = raw as Record<string, unknown>;
    if (obj.type === "Polygon" || obj.type === "MultiPolygon") {
        return obj as unknown as GeoJSON.Polygon | GeoJSON.MultiPolygon;
    }
    if (obj.type === "Feature") {
        const g = (obj as { geometry?: unknown }).geometry;
        if (
            g &&
            typeof g === "object" &&
            ((g as { type?: string }).type === "Polygon" ||
                (g as { type?: string }).type === "MultiPolygon")
        ) {
            return g as GeoJSON.Polygon | GeoJSON.MultiPolygon;
        }
        return null;
    }
    if (obj.type === "FeatureCollection") {
        const feats = (obj as { features?: unknown[] }).features ?? [];
        for (const f of feats) {
            const g = (f as { geometry?: unknown })?.geometry;
            if (
                g &&
                typeof g === "object" &&
                ((g as { type?: string }).type === "Polygon" ||
                    (g as { type?: string }).type === "MultiPolygon")
            ) {
                return g as GeoJSON.Polygon | GeoJSON.MultiPolygon;
            }
        }
    }
    return null;
}

/** Build the synthetic `members` array osmtogeojson expects for
 *  a multipolygon relation. Each member is one ring; outer rings
 *  go first, then inner (hole) rings. polygons.osm.fr already
 *  returns rings with the GeoJSON winding order, so we don't
 *  need to do any orientation work. */
function synthesisMembersFromGeometry(
    geom: GeoJSON.Polygon | GeoJSON.MultiPolygon,
    relationId: number,
): Array<{
    type: "way";
    ref: number;
    role: "outer" | "inner";
    geometry: Array<{ lat: number; lon: number }>;
}> {
    const out: Array<{
        type: "way";
        ref: number;
        role: "outer" | "inner";
        geometry: Array<{ lat: number; lon: number }>;
    }> = [];
    const polygons =
        geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
    let synthRef = relationId * 100; // unique-ish synthetic way ids
    for (const poly of polygons) {
        poly.forEach((ring, idx) => {
            out.push({
                type: "way",
                ref: synthRef++,
                role: idx === 0 ? "outer" : "inner",
                geometry: ring.map(([lon, lat]) => ({ lat, lon })),
            });
        });
    }
    return out;
}
