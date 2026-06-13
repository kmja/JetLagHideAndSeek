/**
 * Curated list of major cities to pre-warm into the R2 cache.
 *
 * Two sources merge into `POPULAR_CITIES`:
 *
 *   1. The hand-curated list below in this file — small, reviewed.
 *      Edit here for cities you specifically want warmed.
 *   2. `bulk-cities.json` at the worker package root. This is the
 *      auto-discovered list (~170+ entries today) from the local
 *      discovery script. Edits there flow into the cron without
 *      any code change.
 *
 * Cron processes the merged list in random order, `PREWARM_BATCH_SIZE`
 * at a time, skipping anything that's still fresh (< CACHE_TTL_DAYS
 * old in R2). So adding a city is a one-line edit to either source.
 *
 * Entries are OSM relation IDs because that's the only thing the
 * seeker app actually fetches (no nodes, no ways — admin
 * boundaries are always relations). To add a city to the hand-list:
 * look it up on openstreetmap.org, copy the relation id from the URL
 * (e.g. `https://www.openstreetmap.org/relation/398021` -> 398021),
 * and add it here.
 *
 * Entries are best-effort — if any of these IDs are stale or
 * wrong, the worker just logs the prewarm failure and moves on;
 * the rest of the cache pipeline is unaffected.
 */

// Wrangler/esbuild bundles JSON imports as compiled-in modules
// automatically (no runtime fetch). Lives at the worker package root
// so it can be edited without touching code.
import BULK_CITIES from "../bulk-cities.json";
import BULK_CANDIDATE_NAMES from "../bulk-city-names.json";

import type { Env } from "./envTypes";

export interface CityEntry {
    name: string;
    /** OSM relation id (numeric, no prefix). */
    relationId: number;
    /** Photon's normalized bounding-box extent, lat-major:
     *  [maxLat, minLng, minLat, maxLng]. Optional because legacy
     *  entries from before v193 don't carry it; the cron lazily
     *  backfills these via a re-resolve. Used by the cron to
     *  prewarm the per-city reference caches (museums / hospitals /
     *  airports / …) with the SAME bbox the client derives from
     *  `mapGeoLocation.properties.extent`, so the R2 entries land
     *  on cache keys the client will actually hit. */
    extent?: [number, number, number, number];
}

const HAND_CURATED: CityEntry[] = [
    // North America
    { name: "New York City", relationId: 175905 },
    { name: "Los Angeles", relationId: 207359 },
    { name: "Chicago", relationId: 122604 },
    { name: "San Francisco", relationId: 111968 },
    { name: "Toronto", relationId: 324211 },
    { name: "Vancouver", relationId: 1852574 },
    { name: "Montreal", relationId: 8508732 },
    { name: "Mexico City", relationId: 1376330 },

    // Europe — Nordic
    { name: "Stockholm", relationId: 398021 },
    { name: "Copenhagen", relationId: 2192363 },
    { name: "Oslo", relationId: 406091 },
    { name: "Helsinki", relationId: 34914 },
    { name: "Gothenburg", relationId: 935611 },
    { name: "Malmö", relationId: 935619 },

    // Europe — UK + Ireland
    { name: "London", relationId: 65606 },
    { name: "Manchester", relationId: 88084 },
    { name: "Edinburgh", relationId: 1920901 },
    { name: "Dublin", relationId: 1109531 },

    // Europe — DACH + Benelux + France
    { name: "Berlin", relationId: 62422 },
    { name: "Hamburg", relationId: 62782 },
    { name: "Munich", relationId: 62428 },
    { name: "Frankfurt", relationId: 62400 },
    { name: "Vienna", relationId: 109166 },
    { name: "Zurich", relationId: 1682248 },
    { name: "Amsterdam", relationId: 47811 },
    { name: "Brussels", relationId: 54094 },
    { name: "Paris", relationId: 7444 },
    { name: "Lyon", relationId: 120965 },

    // Europe — South + East
    { name: "Madrid", relationId: 5326784 },
    { name: "Barcelona", relationId: 347950 },
    { name: "Rome", relationId: 41485 },
    { name: "Milan", relationId: 44915 },
    { name: "Lisbon", relationId: 5400890 },
    { name: "Warsaw", relationId: 336075 },
    { name: "Prague", relationId: 435514 },
    { name: "Budapest", relationId: 37244 },
    { name: "Athens", relationId: 8261138 },

    // Asia
    { name: "Tokyo", relationId: 1543125 },
    { name: "Osaka", relationId: 357794 },
    { name: "Seoul", relationId: 2297418 },
    { name: "Hong Kong", relationId: 913110 },
    { name: "Singapore", relationId: 536780 },
    { name: "Bangkok", relationId: 92277 },
    { name: "Taipei", relationId: 1293250 },

    // Middle East
    { name: "Istanbul", relationId: 223474 },
    { name: "Dubai", relationId: 4479752 },

    // Oceania
    { name: "Sydney", relationId: 5750005 },
    { name: "Melbourne", relationId: 4246124 },
    { name: "Auckland", relationId: 9220551 },

    // South America
    { name: "São Paulo", relationId: 298285 },
    { name: "Buenos Aires", relationId: 1224652 },
    { name: "Santiago", relationId: 3287969 },
];

/**
 * Dedupe + merge. Hand-curated entries take precedence (their `name`
 * is what we report in logs / R2 metadata), bulk entries fill in the
 * rest. Bulk file has the shape `{ name, relationId }` already, so no
 * shape conversion is needed.
 */
function mergeUnique(...lists: CityEntry[][]): CityEntry[] {
    const seen = new Set<number>();
    const out: CityEntry[] = [];
    for (const list of lists) {
        for (const entry of list) {
            if (!entry || typeof entry.relationId !== "number") continue;
            if (seen.has(entry.relationId)) continue;
            seen.add(entry.relationId);
            out.push(entry);
        }
    }
    return out;
}

/**
 * Bundled list as a synchronous baseline. The cron / trigger /
 * discover paths prefer `getPopularCities(env)` which folds in
 * R2-stored discovered relations too — but this constant stays for
 * any caller that doesn't have an Env handy.
 */
export const POPULAR_CITIES: CityEntry[] = mergeUnique(
    HAND_CURATED,
    BULK_CITIES as CityEntry[],
);

/** R2 key under which discovered (Photon-resolved) cities accumulate. */
export const DISCOVERED_R2_KEY = "_meta/discovered-cities.json";

/**
 * Same merge as `POPULAR_CITIES`, plus anything the
 * `/admin/discover` endpoint or the cron's discovery pass has
 * resolved and stored in R2. Cached at module scope so repeat calls
 * inside the same worker invocation don't re-hit R2.
 */
let _discoveredCache: CityEntry[] | null = null;
let _discoveredCacheLoadedFor: R2Bucket | null = null;

export async function loadDiscoveredCities(
    env: Env,
): Promise<CityEntry[]> {
    if (
        _discoveredCache !== null &&
        _discoveredCacheLoadedFor === env.CACHE
    ) {
        return _discoveredCache;
    }
    try {
        const obj = await env.CACHE.get(DISCOVERED_R2_KEY);
        if (!obj) {
            _discoveredCache = [];
        } else {
            const parsed = (await obj.json()) as unknown;
            _discoveredCache = Array.isArray(parsed)
                ? (parsed as CityEntry[]).filter(
                      (e) =>
                          e &&
                          typeof e.relationId === "number" &&
                          typeof e.name === "string",
                  )
                : [];
        }
    } catch (e) {
        console.warn("loadDiscoveredCities failed:", e);
        _discoveredCache = [];
    }
    _discoveredCacheLoadedFor = env.CACHE;
    return _discoveredCache;
}

export async function getPopularCities(
    env: Env,
): Promise<CityEntry[]> {
    const discovered = await loadDiscoveredCities(env);
    // `discovered` FIRST so a re-resolved entry (which carries the new
    // `extent` field, added in v193) overrides the bundled
    // HAND_CURATED / BULK_CITIES copy of the same relation. mergeUnique
    // is first-wins-by-relationId, so this is how the backfill upgrades
    // legacy extentless entries in place without anyone clearing R2.
    return mergeUnique(discovered, HAND_CURATED, BULK_CITIES as CityEntry[]);
}

/**
 * Append newly discovered entries to the R2-stored list. Idempotent
 * via `mergeUnique` semantics; the cache is invalidated so the next
 * `getPopularCities(env)` call sees the updates.
 */
export async function appendDiscoveredCities(
    env: Env,
    fresh: CityEntry[],
): Promise<void> {
    if (fresh.length === 0) return;
    const existing = await loadDiscoveredCities(env);
    const merged = mergeUnique(existing, fresh);
    await env.CACHE.put(
        DISCOVERED_R2_KEY,
        JSON.stringify(merged),
        { httpMetadata: { contentType: "application/json" } },
    );
    _discoveredCache = merged;
    _discoveredCacheLoadedFor = env.CACHE;
}

/**
 * Names of EVERY known city (bundled or discovered) that's missing
 * the `extent` field. The cron computes extents directly from the
 * known relationId via polygons.openstreetmap.fr — no Photon name
 * lookup, so it's immune to "Stockholm in Sweden vs Maine"
 * ambiguities. Returns at most `limit` entries with `{name, relationId}`.
 */
export async function missingExtentRelations(
    env: Env,
    limit: number,
): Promise<{ name: string; relationId: number }[]> {
    const all = await getPopularCities(env);
    const out: { name: string; relationId: number }[] = [];
    for (const c of all) {
        if (out.length >= limit) break;
        if (c.extent && c.extent.length === 4) continue;
        if (!Number.isFinite(c.relationId) || c.relationId <= 0) continue;
        out.push({ name: c.name, relationId: c.relationId });
    }
    return out;
}

/**
 * One-time-safe repair of the discovered-cities R2 doc: drop any
 * entry whose name (case-insensitive, comma-trimmed) collides with
 * the bundled HAND_CURATED or BULK_CITIES list but whose relationId
 * does NOT match the bundled canonical id. Those are the entries
 * left by an earlier bug where `resolveNameViaPhoton("Stockholm")`
 * resolved to Stockholm, Maine instead of Stockholm, Sweden.
 *
 * Returns the number of entries dropped. Idempotent — running it
 * again finds nothing to repair.
 */
export async function repairBogusDiscoveredEntries(
    env: Env,
): Promise<number> {
    const discovered = await loadDiscoveredCities(env);
    if (discovered.length === 0) return 0;
    const canonical = new Map<string, number>();
    const cityKey = (name: string) =>
        name.split(",")[0].trim().toLowerCase();
    for (const c of HAND_CURATED) {
        canonical.set(cityKey(c.name), c.relationId);
    }
    for (const c of BULK_CITIES as CityEntry[]) {
        if (!canonical.has(cityKey(c.name))) {
            canonical.set(cityKey(c.name), c.relationId);
        }
    }
    const next = discovered.filter((c) => {
        const want = canonical.get(cityKey(c.name));
        if (want === undefined) return true; // not a bundled name
        return c.relationId === want; // keep only correct matches
    });
    const removed = discovered.length - next.length;
    if (removed === 0) return 0;
    await env.CACHE.put(
        DISCOVERED_R2_KEY,
        JSON.stringify(next),
        { httpMetadata: { contentType: "application/json" } },
    );
    _discoveredCache = next;
    _discoveredCacheLoadedFor = env.CACHE;
    return removed;
}

/** Upsert a city into the discovered list by relationId: overwrite the
 *  existing entry (preferring the new fields) or append if absent.
 *  Used by the backfill to add `extent` to legacy entries. */
export async function upsertDiscoveredCity(
    env: Env,
    entry: CityEntry,
): Promise<void> {
    const existing = await loadDiscoveredCities(env);
    let found = false;
    const next = existing.map((c) => {
        if (c.relationId === entry.relationId) {
            found = true;
            return { ...c, ...entry };
        }
        return c;
    });
    if (!found) next.push(entry);
    await env.CACHE.put(
        DISCOVERED_R2_KEY,
        JSON.stringify(next),
        { httpMetadata: { contentType: "application/json" } },
    );
    _discoveredCache = next;
    _discoveredCacheLoadedFor = env.CACHE;
}

/**
 * Bundled candidate city-name list (~600 entries). Used by the
 * discover pipeline as the source of names to resolve.
 */
export const CANDIDATE_NAMES: string[] = (
    BULK_CANDIDATE_NAMES as string[]
).filter((n) => typeof n === "string" && n.length > 0);

/**
 * R2 key under which Photon-resolution attempt counts accumulate,
 * keyed by lowercase head-name. A candidate that Photon can't resolve
 * (returns no relation) would otherwise sit at the front of the
 * unresolved queue forever — `unresolvedCandidates` only drops names
 * once they're KNOWN, and a failed name never becomes known. Every
 * discover call would re-attempt the same dead front names and never
 * reach the ones behind them, which is why the discovered list stalls.
 *
 * Parking failed names after MAX_DISCOVER_ATTEMPTS tries (so a
 * transient Photon blip gets a few chances first) lets the queue
 * advance past genuinely-unresolvable names. Clearable by deleting
 * this R2 object if a name should be retried from scratch.
 */
export const DISCOVER_ATTEMPTS_R2_KEY = "_meta/discover-attempts.json";
const MAX_DISCOVER_ATTEMPTS = 3;

let _attemptsCache: Record<string, number> | null = null;
let _attemptsCacheLoadedFor: R2Bucket | null = null;

async function loadDiscoverAttempts(
    env: Env,
): Promise<Record<string, number>> {
    if (_attemptsCache !== null && _attemptsCacheLoadedFor === env.CACHE) {
        return _attemptsCache;
    }
    try {
        const obj = await env.CACHE.get(DISCOVER_ATTEMPTS_R2_KEY);
        const parsed = obj ? ((await obj.json()) as unknown) : {};
        _attemptsCache =
            parsed && typeof parsed === "object" && !Array.isArray(parsed)
                ? (parsed as Record<string, number>)
                : {};
    } catch (e) {
        console.warn("loadDiscoverAttempts failed:", e);
        _attemptsCache = {};
    }
    _attemptsCacheLoadedFor = env.CACHE;
    return _attemptsCache;
}

/**
 * Record a failed Photon resolution for each of `names` (by lowercase
 * head-name), incrementing its attempt count. Once a name's count
 * reaches MAX_DISCOVER_ATTEMPTS, `unresolvedCandidates` stops
 * returning it and the queue advances.
 */
export async function recordFailedResolves(
    env: Env,
    names: string[],
): Promise<void> {
    if (names.length === 0) return;
    const attempts = { ...(await loadDiscoverAttempts(env)) };
    for (const raw of names) {
        const head = raw.split(",")[0].trim().toLowerCase();
        if (!head) continue;
        attempts[head] = (attempts[head] ?? 0) + 1;
    }
    await env.CACHE.put(DISCOVER_ATTEMPTS_R2_KEY, JSON.stringify(attempts), {
        httpMetadata: { contentType: "application/json" },
    });
    _attemptsCache = attempts;
    _attemptsCacheLoadedFor = env.CACHE;
}

/**
 * Names that haven't been resolved into a relation ID yet. Drops
 * anything whose name (case-insensitive substring match, before the
 * first comma) appears in the merged HAND_CURATED + BULK_CITIES +
 * R2-stored set, AND anything parked after MAX_DISCOVER_ATTEMPTS
 * failed Photon resolutions (see DISCOVER_ATTEMPTS_R2_KEY).
 */
export async function unresolvedCandidates(
    env: Env,
): Promise<string[]> {
    const known = await getPopularCities(env);
    const knownLower = new Set(known.map((c) => c.name.toLowerCase()));
    const attempts = await loadDiscoverAttempts(env);
    return CANDIDATE_NAMES.filter((raw) => {
        const headLower = raw.split(",")[0].trim().toLowerCase();
        if (knownLower.has(headLower)) return false;
        if ((attempts[headLower] ?? 0) >= MAX_DISCOVER_ATTEMPTS) return false;
        return true;
    });
}
