/**
 * Bbox-extraction, template-matching, and response-slicing helpers
 * for the global reference-cache prewarm. See
 * `scripts/global-prewarm.md` for the architecture; this file holds
 * the geometric and parsing primitives.
 *
 * Standalone and pure: no I/O, no Worker globals. Imported by
 * `index.ts` once the runtime slicing path is wired in. No runtime
 * effect until then.
 */

import { COUNTRY_SHARDS, type CountryShard } from "./countryShards";

/** GeoJSON-order bbox: `[minLng, minLat, maxLng, maxLat]`. */
export type Bbox = [number, number, number, number];

/**
 * Match Overpass's global `[bbox:south,west,north,east]` setting —
 * the form the seeker app's reference-prefetch query uses (see
 * `buildPaddedBboxFilter` in src/maps/api/playAreaPrefetch.ts and
 * `buildBboxFilter` in index.ts). This is a single global setting,
 * not a per-statement filter, so there's exactly one per query.
 *
 * Numbers can be negative and may include decimals.
 */
const OVERPASS_BBOX_RE =
    /\[bbox:\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]/;

/**
 * Pull the bbox from a query carrying the `[bbox:s,w,n,e]` global
 * setting. Returns the bbox in GeoJSON order
 * `[minLng, minLat, maxLng, maxLat]`, or `null` when the query has
 * no such setting (e.g. a `relation(R)` boundary fetch or an
 * `around:` radius query — neither is eligible for slicing).
 *
 * Overpass's setting is `[bbox:south, west, north, east]`; we
 * re-order to GeoJSON `[west, south, east, north]` so consumers
 * don't have to remember the convention.
 */
export function extractBbox(query: string): Bbox | null {
    const m = OVERPASS_BBOX_RE.exec(query);
    if (!m) return null;
    const south = +m[1];
    const west = +m[2];
    const north = +m[3];
    const east = +m[4];
    if (
        !Number.isFinite(south) ||
        !Number.isFinite(west) ||
        !Number.isFinite(north) ||
        !Number.isFinite(east)
    ) {
        return null;
    }
    // Reject degenerate bboxes (south >= north, west >= east).
    if (south >= north || west >= east) return null;
    return [west, south, east, north];
}

/**
 * Strip the `[bbox:…]` setting from a query so the rest of it can be
 * hashed and compared against the known prewarm-template table.
 * Whitespace is collapsed at the same time to absorb formatting
 * drift between cron-side and client-side query construction.
 */
export function canonicalizeForTemplateMatch(query: string): string {
    return query
        .replace(OVERPASS_BBOX_RE, "[bbox:__BBOX__]")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * SHA-256 of the canonicalised template. Wraps the SubtleCrypto
 * primitive Workers already use elsewhere; exported so the cron can
 * precompute its template fingerprint at deploy time.
 */
export async function templateFingerprint(query: string): Promise<string> {
    const canonical = canonicalizeForTemplateMatch(query);
    const buf = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(canonical),
    );
    const bytes = new Uint8Array(buf);
    let hex = "";
    for (const byte of bytes) {
        hex += byte.toString(16).padStart(2, "0");
    }
    return hex;
}

/**
 * Pick the smallest-by-area shard whose bbox fully contains
 * `bbox`. Returns `null` if no shard contains it — falls through to
 * the existing per-query R2 cache + upstream Overpass path.
 *
 * "Fully contains" is strict: the play-area bbox sits entirely
 * inside the shard bbox. A bbox crossing two shards (Greater
 * Copenhagen — DK + SE) intentionally doesn't match here. We pick
 * the simpler "fall through to upstream" path over a multi-shard
 * merge for v1; multi-shard slicing is a v2 candidate if border
 * play areas show up in usage data.
 *
 * Smallest-by-area is what makes the US-east / US-west sub-shards
 * win over a hypothetical US-wide entry when both contain the same
 * Stockholm-sized bbox — the smaller cached response is faster to
 * parse and slice.
 */
export function findContainingShard(
    bbox: Bbox,
    shards: CountryShard[] = COUNTRY_SHARDS,
): CountryShard | null {
    const [w, s, e, n] = bbox;
    let best: CountryShard | null = null;
    let bestArea = Number.POSITIVE_INFINITY;
    for (const shard of shards) {
        const [sw, ss, se, sn] = shard.bbox;
        if (w >= sw && e <= se && s >= ss && n <= sn) {
            const area = (se - sw) * (sn - ss);
            if (area < bestArea) {
                best = shard;
                bestArea = area;
            }
        }
    }
    return best;
}

/**
 * Minimal subset of an Overpass JSON element we need to bbox-test.
 *
 *   - Nodes carry `lat` / `lon` directly.
 *   - Ways and relations using `out center` carry `center.lat /
 *     center.lon`. We treat that as the element's representative
 *     point, mirroring what the seeker app does downstream.
 *
 * Elements without any positional info (relations without `out
 * center`, etc.) are dropped from the sliced response — the seeker
 * app's matching/measuring questions need a point to compare
 * against anyway, so position-less elements were never going to
 * help that pipeline.
 */
export interface OverpassElement {
    type: string;
    id: number;
    lat?: number;
    lon?: number;
    center?: { lat: number; lon: number };
    tags?: Record<string, string>;
    // Unknown extra fields preserved on slice (e.g. `nodes`, `members`).
    [extra: string]: unknown;
}

export interface OverpassResponse {
    version?: number;
    generator?: string;
    osm3s?: unknown;
    elements?: OverpassElement[];
    [extra: string]: unknown;
}

/**
 * Filter an Overpass response to elements whose representative
 * point falls inside `bbox`. The returned object is a shallow copy
 * of the input with `elements` swapped for the filtered list —
 * top-level metadata (version, generator, osm3s) is preserved so
 * the response shape matches what the seeker app expects from a
 * direct Overpass call.
 *
 * Pure: input is not mutated.
 */
export function sliceResponseByBbox(
    response: OverpassResponse,
    bbox: Bbox,
): OverpassResponse {
    const [w, s, e, n] = bbox;
    const src = response.elements ?? [];
    const out: OverpassElement[] = [];
    for (let i = 0; i < src.length; i++) {
        const el = src[i];
        const lat =
            typeof el.lat === "number"
                ? el.lat
                : typeof el.center?.lat === "number"
                  ? el.center.lat
                  : null;
        const lng =
            typeof el.lon === "number"
                ? el.lon
                : typeof el.center?.lon === "number"
                  ? el.center.lon
                  : null;
        if (lat === null || lng === null) continue;
        if (lng >= w && lng <= e && lat >= s && lat <= n) {
            out.push(el);
        }
    }
    return { ...response, elements: out };
}

/**
 * R2 key generator for a shard's combined-references cache. Kept
 * in one place so the cron writer and the runtime reader stay in
 * lockstep.
 *
 * The `v1/` namespace lets us cache-bust the entire collection if
 * we ever change `STANDARD_REFERENCE_FAMILIES`. Old `v1` entries
 * become orphans; new entries land under `v2`. The cron can prune
 * old prefixes as a periodic janitorial pass.
 */
export function countryRefsKey(shardIso: string): string {
    return `country-refs/v1/${shardIso}/all`;
}
