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

import osmtogeojson from "osmtogeojson";

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
 *
 * v295: deduplicates concurrent callers by relation id. PlayArea-
 * PreviewMap (wizard / lobby mini-preview) and the main seeker map's
 * `determineMapBoundaries` pipeline used to race each other for the
 * same boundary the moment the lobby opened after the wizard. Both
 * went to polygons.osm.fr, the second one tripped rate-limiting, the
 * cache-worker fallback was busy serving the first, and the main map
 * surfaced a "mirrors are busy" toast even though the lobby's preview
 * worked. Now any second caller during an in-flight fetch reuses the
 * same Promise; their `signal` only governs how long they wait for
 * the shared result, not whether the shared fetch keeps running.
 */
export async function fetchRawBoundaryPolygon(
    relationId: number,
    signal?: AbortSignal,
): Promise<GeoJSON.Polygon | GeoJSON.MultiPolygon | null> {
    let shared = inFlightBoundary.get(relationId);
    if (!shared) {
        shared = doFetchRawBoundaryPolygon(relationId).finally(() => {
            inFlightBoundary.delete(relationId);
        });
        inFlightBoundary.set(relationId, shared);
    }

    // No caller signal? Just await the shared fetch.
    if (!signal) return shared;
    // Aborted before we even waited.
    if (signal.aborted) return null;

    // Race the shared fetch against the caller's abort. We never
    // pass the caller signal down into the actual fetch — that would
    // let one caller's abort yank the result out from under another
    // — so the shared fetch always runs to completion, just this
    // caller stops listening.
    return new Promise((resolve) => {
        const onAbort = () => {
            signal.removeEventListener("abort", onAbort);
            resolve(null);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        shared!.then(
            (result) => {
                signal.removeEventListener("abort", onAbort);
                resolve(result);
            },
            () => {
                signal.removeEventListener("abort", onAbort);
                resolve(null);
            },
        );
    });
}

/** Module-level map of in-flight boundary fetches, keyed by relation
 *  id. An entry is created at the moment the shared Promise is
 *  scheduled and deleted in `.finally`, so it covers exactly the
 *  window during which a second caller would otherwise race the
 *  first to the same upstream. */
const inFlightBoundary = new Map<
    number,
    Promise<GeoJSON.Polygon | GeoJSON.MultiPolygon | null>
>();

/** The actual two-stage fetch (polygons.osm.fr → cache worker →
 *  build-trigger retry), with no caller-signal plumbing. The
 *  internal `fetchPolygonAttempt` / `fetchPolygonViaCacheWorker`
 *  helpers still enforce their per-request timeouts via their own
 *  AbortControllers, so a stuck upstream can't pin this forever. */
async function doFetchRawBoundaryPolygon(
    relationId: number,
): Promise<GeoJSON.Polygon | GeoJSON.MultiPolygon | null> {
    // v639: WORKER-FIRST. For a prewarmed (curated) city — and its
    // adjacent-area neighbours, now prewarmed too — the worker serves the
    // boundary from R2 in ~10 ms, so a self-hosted game never touches an
    // external service. This is the same `relation(N);out geom;` upstream
    // the main map already uses, so the wizard/lobby preview and the main
    // map can't disagree. (Previously this hit polygons.osm.fr FIRST, which
    // for a curated city made an avoidable external call on every preview,
    // and for its ~14 neighbours a throttle-prone burst — the residential-
    // IP rate-limiting reported in the wizard.)
    const workerGeom = await fetchPolygonViaCacheWorker(relationId);
    if (workerGeom) return workerGeom;

    // Worker miss (uncurated area the R2 cache doesn't hold, or a worker
    // hiccup). Fall back to polygons.osm.fr, then a build-trigger retry.
    const first = await fetchPolygonAttempt(relationId);
    if (first.geom) return first.geom;

    // Only retry polygons.osm.fr with a build trigger if that attempt was
    // specifically the "None" (not-yet-computed) sentinel — the trigger
    // does nothing for other failure modes, and the worker already
    // exhausted Overpass.
    if (!first.shouldBuildAndRetry) return null;

    triggerPolygonsOsmFrBuild(relationId);
    await waitWithSignal(BUILD_WAIT_MS);

    const second = await fetchPolygonAttempt(relationId);
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
): Promise<GeoJSON.Polygon | GeoJSON.MultiPolygon | null> {
    // Byte-identical to overpass-cache/src/index.ts's
    // singleRelationQuery — the R2 key is a hash of this string, so
    // any whitespace drift misses the cached entry.
    const query = `[out:json][timeout:120];relation(${relationId});out geom;`;
    const url = `${OVERPASS_API}?data=${encodeURIComponent(query)}`;
    const ctrl = new AbortController();
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

/** Convert a `relation(N);out geom;` Overpass response into a GeoJSON
 *  polygon/multipolygon. Delegates to `osmtogeojson`, which is the same
 *  library the main map's boundary loader uses — it does proper outer-
 *  ring stitching (segments → closed loops), handles inner rings (lakes
 *  / enclaves), and is the reason the lobby gets a clean outline.
 *
 *  v224 fix: the previous bespoke walker treated each member-way as its
 *  own closed ring, which produced "scattered fragments" for any admin
 *  boundary whose outer ring is split across multiple ways (most of
 *  them). Reusing osmtogeojson is roughly 30 lines instead of 50 and
 *  guarantees parity with the lobby's renderer. Returns null on any
 *  structural problem so the caller falls through. */
function polygonFromOverpassResponse(
    json: unknown,
    relationId: number,
): GeoJSON.Polygon | GeoJSON.MultiPolygon | null {
    if (!json || typeof json !== "object") return null;
    const elements = (json as { elements?: unknown }).elements;
    if (!Array.isArray(elements)) return null;
    // osmtogeojson keys its multipolygon assembly off the relation's
    // `type=boundary` / `boundary=administrative` tags and each member
    // way's `role=outer|inner`. The worker's batched-prewarm path
    // doesn't always preserve tags on the relation element, so make
    // sure they're present before handing off — without them
    // osmtogeojson falls back to emitting raw LineStrings, exactly the
    // pre-fix symptom.
    const annotated = {
        elements: (elements as any[]).map((el) => {
            if (el?.type === "relation" && el?.id === relationId) {
                return {
                    ...el,
                    tags: {
                        type: "boundary",
                        boundary: "administrative",
                        ...(el.tags ?? {}),
                    },
                };
            }
            return el;
        }),
    };
    let fc: GeoJSON.FeatureCollection;
    try {
        fc = osmtogeojson(annotated) as GeoJSON.FeatureCollection;
    } catch {
        return null;
    }
    for (const f of fc.features ?? []) {
        const g = f.geometry;
        if (g?.type === "Polygon" || g?.type === "MultiPolygon") {
            return g as GeoJSON.Polygon | GeoJSON.MultiPolygon;
        }
    }
    return null;
}

interface AttemptResult {
    geom: GeoJSON.Polygon | GeoJSON.MultiPolygon | null;
    /** True iff the failure was specifically the "None" / not-yet-
     *  computed sentinel and a build-trigger retry might help. */
    shouldBuildAndRetry: boolean;
}

async function fetchPolygonAttempt(
    relationId: number,
): Promise<AttemptResult> {
    const url = `${POLYGONS_OSM_FR_API}?id=${relationId}&params=0`;

    const ctrl = new AbortController();
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

/** Promise-based sleep used by the build-trigger retry path. v295
 *  removed the AbortSignal plumbing now that boundary fetches are
 *  deduplicated at the module level — the shared fetch always runs
 *  to completion regardless of which caller initiated it, so an
 *  abortable wait would be meaningless. */
function waitWithSignal(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
