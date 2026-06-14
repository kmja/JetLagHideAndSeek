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

import { OVERPASS_API } from "./constants";

const POLYGONS_OSM_FR_API =
    "https://polygons.openstreetmap.fr/get_geojson.py";
/** "Index" endpoint that triggers an on-demand build for relations
 *  the service hasn't pre-computed yet. A GET with `?id=N` queues
 *  the build and returns an HTML page; subsequent `get_geojson.py`
 *  calls then return the built polygon (typically within 1-5 s for
 *  small relations, up to ~30 s for country-sized ones). */
const POLYGONS_OSM_FR_INDEX = "https://polygons.openstreetmap.fr/";

const REQUEST_TIMEOUT_MS = 8_000;
/** How long to wait between kicking off a build and the retry
 *  fetch. Short enough to keep the perceived latency tolerable,
 *  long enough for the service to finish building a typical
 *  city/region polygon. */
const BUILD_WAIT_MS = 2500;
/** Trigger requests are fire-and-forget but we still need a
 *  timeout so a stuck connection doesn't keep an AbortController
 *  pinned forever. */
const BUILD_TRIGGER_TIMEOUT_MS = 5_000;

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
 *
 * When the service replies "None" — meaning it hasn't pre-computed
 * this relation yet — we kick off an on-demand build via
 * `triggerPolygonsOsmFrBuild` and retry the GET once after a short
 * wait. This is what makes first-time-ever play areas (never picked
 * by any seeker before) reliably resolve through the fast path
 * instead of falling through to the public Overpass mirrors and their
 * per-IP rate limits.
 */
export async function fetchRawBoundaryPolygon(
    relationId: number,
    signal?: AbortSignal,
): Promise<GeoJSON.Polygon | GeoJSON.MultiPolygon | null> {
    const first = await fetchPolygonAttempt(relationId, signal);
    if (first.geom) return first.geom;

    // polygons.osm.fr fast path didn't help — either it 5xx'd, CORS-
    // hiccuped (residential IPs get throttled hard), or returned the
    // "not yet computed" sentinel. Fall through to the cache worker
    // before giving up: it serves boundaries from R2 in ~10 ms for
    // any prewarmed area (every city in the curated list — which the
    // wizard mostly picks from) and otherwise races Overpass. This
    // is the same upstream the main map uses post-wizard, so the
    // wizard preview and the lobby preview can't disagree anymore.
    const workerGeom = await fetchPolygonViaCacheWorker(relationId, signal);
    if (workerGeom) return workerGeom;

    // Both paths failed. Only retry polygons.osm.fr with a build
    // trigger if the FIRST attempt was specifically the "None"
    // sentinel (the trigger does nothing for other failure modes,
    // and the worker fallback already exhausted Overpass).
    if (!first.shouldBuildAndRetry) return null;
    if (signal?.aborted) return null;

    triggerPolygonsOsmFrBuild(relationId);
    await waitWithSignal(BUILD_WAIT_MS, signal);
    if (signal?.aborted) return null;

    const second = await fetchPolygonAttempt(relationId, signal);
    return second.geom;
}

/** Fetch the boundary through the cache worker's /api/interpreter
 *  endpoint, then assemble the resulting Overpass relation members
 *  back into a single GeoJSON polygon. Used as a fallback when
 *  polygons.openstreetmap.fr is throttling the user's IP — the
 *  worker's R2 cache is the same one the main map hits, so a
 *  prewarmed city gets the wizard polygon for free. Returns null on
 *  any failure so the caller treats it the same as the primary
 *  fast path missing. */
async function fetchPolygonViaCacheWorker(
    relationId: number,
    signal?: AbortSignal,
): Promise<GeoJSON.Polygon | GeoJSON.MultiPolygon | null> {
    // Byte-identical to overpass-cache/src/index.ts's
    // singleRelationQuery — the R2 key is a hash of this string, so
    // any whitespace drift misses the cached entry.
    const query = `[out:json][timeout:120];relation(${relationId});out geom;`;
    const url = `${OVERPASS_API}?data=${encodeURIComponent(query)}`;
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

    let json: unknown;
    try {
        json = await resp.json();
    } catch {
        return null;
    }
    return polygonFromOverpassResponse(json, relationId);
}

/** Walk a `relation(N);out geom;` Overpass response and assemble its
 *  outer/inner member-way geometries into a GeoJSON polygon. Doesn't
 *  attempt full ring-stitching — most admin relations have member ways
 *  already arranged as closed rings; we just gather them and group by
 *  role. Inner rings become MultiPolygon holes; outer rings each
 *  become a Polygon (combined as MultiPolygon if more than one). On
 *  any structural problem returns null so the caller falls through. */
function polygonFromOverpassResponse(
    json: unknown,
    relationId: number,
): GeoJSON.Polygon | GeoJSON.MultiPolygon | null {
    if (!json || typeof json !== "object") return null;
    const elements = (json as { elements?: unknown }).elements;
    if (!Array.isArray(elements)) return null;
    const relation = elements.find(
        (e: any) => e?.type === "relation" && e?.id === relationId,
    ) as { members?: any[] } | undefined;
    if (!relation || !Array.isArray(relation.members)) return null;
    const outers: Array<Array<[number, number]>> = [];
    const inners: Array<Array<[number, number]>> = [];
    for (const m of relation.members) {
        if (m?.type !== "way" || !Array.isArray(m.geometry)) continue;
        const ring: Array<[number, number]> = [];
        for (const p of m.geometry) {
            if (typeof p?.lat === "number" && typeof p?.lon === "number") {
                ring.push([p.lon, p.lat]);
            }
        }
        if (ring.length < 3) continue;
        // Close the ring if Overpass left it open.
        const first = ring[0];
        const last = ring[ring.length - 1];
        if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first);
        if (m.role === "inner") inners.push(ring);
        else outers.push(ring);
    }
    if (outers.length === 0) return null;
    // Each outer ring becomes a polygon; inner rings attach to whichever
    // outer ring they sit inside. We don't do point-in-polygon
    // assignment here because the wizard preview only needs an
    // approximate outline — drop inner rings onto the first outer is a
    // worst-case visual nit, not a correctness bug.
    if (outers.length === 1) {
        return {
            type: "Polygon",
            coordinates: [outers[0], ...inners],
        };
    }
    return {
        type: "MultiPolygon",
        coordinates: outers.map((o, i) => (i === 0 ? [o, ...inners] : [o])),
    };
}

interface AttemptResult {
    geom: GeoJSON.Polygon | GeoJSON.MultiPolygon | null;
    /** True iff the failure was specifically the "None" / not-yet-
     *  computed sentinel and a build-trigger retry might help. */
    shouldBuildAndRetry: boolean;
}

async function fetchPolygonAttempt(
    relationId: number,
    signal?: AbortSignal,
): Promise<AttemptResult> {
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
        return { geom: null, shouldBuildAndRetry: false };
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
    }
    if (!resp.ok) return { geom: null, shouldBuildAndRetry: false };

    let text: string;
    try {
        text = await resp.text();
    } catch {
        return { geom: null, shouldBuildAndRetry: false };
    }
    const trimmed = text.trim();
    if (trimmed === "None") {
        return { geom: null, shouldBuildAndRetry: true };
    }
    if (
        !trimmed ||
        trimmed.startsWith("<") ||
        trimmed.startsWith("!")
    ) {
        return { geom: null, shouldBuildAndRetry: false };
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        return { geom: null, shouldBuildAndRetry: false };
    }
    return { geom: normalizeToPolyGeometry(parsed), shouldBuildAndRetry: false };
}

/**
 * Queue an on-demand polygon build at polygons.openstreetmap.fr for
 * the given relation ID. Fire-and-forget: the response is an HTML
 * page that we don't need to read; we just need the GET to land so
 * the service starts computing. The polygon is cached server-side
 * once built, so calling this on play-area selection means every
 * later boundary fetch (this seeker AND every co-player + every
 * future game on the same area) is a fast-path hit.
 *
 * Safe to call repeatedly for the same id — the service deduplicates
 * concurrent build requests internally, and we de-dupe at the
 * module level too to avoid waste.
 */
const triggeredBuilds = new Set<number>();
export function triggerPolygonsOsmFrBuild(relationId: number): void {
    if (!Number.isFinite(relationId) || relationId <= 0) return;
    if (triggeredBuilds.has(relationId)) return;
    triggeredBuilds.add(relationId);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), BUILD_TRIGGER_TIMEOUT_MS);
    fetch(`${POLYGONS_OSM_FR_INDEX}?id=${relationId}`, {
        method: "GET",
        signal: ctrl.signal,
        mode: "no-cors",
    })
        .catch(() => {
            /* fire-and-forget — failure here is fine, the next
               on-demand fetch will retry the build trigger inline */
        })
        .finally(() => clearTimeout(timer));
}

/** Promise-based sleep that aborts cleanly when the caller's signal
 *  fires. Used by the build-trigger retry path so a cancelled
 *  boundary fetch doesn't keep its retry pending in the background. */
function waitWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        if (signal?.aborted) return resolve();
        const t = setTimeout(resolve, ms);
        const onAbort = () => {
            clearTimeout(t);
            signal?.removeEventListener("abort", onAbort);
            resolve();
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
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
