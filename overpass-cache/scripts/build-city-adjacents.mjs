/**
 * OFFLINE GENERATOR — a FIXED transit-reach adjacent set per curated city.
 *
 * The wizard's live adjacency (`playAreaExtensions.ts`) picks neighbours by
 * ADMIN adjacency + a bbox transit flag. Topic 2 replaced that idea with
 * TRANSIT REACH: "everywhere the city's subway / light-rail / commuter-train /
 * tram / ferry / bus network actually runs" → the municipalities those stops
 * land in. That logic was prototyped + eyeballed city-by-city in the in-app
 * `/debug/adjacency` tool (`src/maps/api/transitReach.ts`).
 *
 * Rather than run that heavy selection at wizard time, we PRECOMPUTE it here,
 * ONCE, offline, and bake the result — a fixed `adjacentRelationIds: number[]`
 * — onto each city in `world-cities.json`. The worker then caches exactly those
 * relations and the wizard READS the stored set (no runtime Overpass, no
 * runtime selection). This script IS the generator; the debug tool stays the
 * review surface. It is a faithful node port of `findTransitReachCandidates` +
 * its helpers (kept in sync BY HAND — same coupling as `build-world-cities.mjs`
 * porting `rankPlayAreaResults`).
 *
 * Defaults mirror the settings validated in the debug tool (radius 40 km, all
 * six game transit modes, primary's own admin level, min 2 stops, area cap 10×
 * the primary, min density 0.2 stops/km², contiguous-only). All overridable.
 *
 * Usage (run on a machine that can reach Overpass — CI/sandbox egress blocks
 * it):
 *   node scripts/build-city-adjacents.mjs [--limit N] [--only <name|relId,…>]
 *        [--skip-existing] [--radius 40] [--level auto|6|7|8]
 *        [--kinds subway,light_rail,commuter,tram,ferry,bus]
 *        [--min-stops 2] [--max-area-ratio 10] [--min-density 0.2]
 *        [--no-contiguous] [--concurrency 4] [--delay-ms 1500]
 *        [--cooldown-ms 30000] [--max-cooldowns 4]
 *        [--out world-cities.json] [--email you@example.com]
 *
 *   --limit N          process the first N cities in the file (population
 *                      order). Omit = all.
 *   --only <list>      process ONLY these cities (comma list of names or
 *                      relation ids), e.g. --only Helsinki,913067.
 *   --skip-existing    skip cities that already carry an adjacentRelationIds
 *                      field — INCLUDING a canonical empty [] (a real "no
 *                      transit-reach neighbours" result, not a to-do). Only
 *                      cities with NO field (never generated / a prior run
 *                      failed) are retried. Resume a partial run without
 *                      recomputing finished cities.
 *   --priority-regions[=US,GB,…]  process cities by REGION tier first (then by
 *                      population), using each city's `country` tag — so the
 *                      audience's cities generate before the population-ordered
 *                      Chinese megacities (low-priority + sparse OSM transit).
 *                      Bare = the default English-speaking + W-Europe + Nordics.
 *   --max-adjacents N  coarsen to L6 (county) when a fine-level (>=7) primary's
 *                      auto result exceeds N adjacents — stops US metros (LA,
 *                      Chicago) returning dozens of suburbs (default 20; 0=off).
 *   --level auto|N     candidate admin_level. auto = the primary's own level
 *                      (default). A coarser N (6 county / 7 / 8 city) yields
 *                      fewer, larger adjacents.
 *   --kinds <list>     transit modes to follow. Default = all six.
 *   --min-stops N      drop candidates with < N reached stops (default 2).
 *   --max-area-ratio X drop candidates bigger than X× the primary — a
 *                      country-agnostic "not a whole province" cap (default 10).
 *   --min-density D    drop candidates below D stops/km² — a sparse region is a
 *                      poor hiding area (default 0.2).
 *   --no-contiguous    keep isolated reached districts (default: contiguous
 *                      blob touching the primary only).
 *   --concurrency N    parallel candidate-boundary fetches (default 4).
 *   --delay-ms N       pause (ms) between cities to be polite to Overpass, so
 *                      a heavy city doesn't rate-limit the next (default 1500).
 *   --cooldown-ms N    base wait (ms) after a "0 stops" result before retrying
 *                      the city — a real city returning 0 is almost always the
 *                      upstream throttled by a prior heavy city (default 30000).
 *   --max-cooldowns N  how many ESCALATING cooldown retries (N×base: 30/60/90…s)
 *                      before accepting a 0 (default 4).
 *   --out FILE         output file (default world-cities.json, in place).
 *
 * Writes each SUCCESSFULLY-processed entry's `adjacentRelationIds` (sorted,
 * deduped). Field semantics are three-state and load-bearing downstream:
 *   - ABSENT              → not generated (or the run failed): the worker
 *                           returns baked:false and the wizard falls back to
 *                           live admin-adjacency.
 *   - PRESENT, empty []   → generated, CANONICAL "no transit-reach neighbours":
 *                           the worker returns baked:true and the wizard shows
 *                           NO adjacents (it does NOT fall back to live).
 *   - PRESENT, non-empty  → generated: the wizard shows exactly this set.
 * A transient fetch failure (a "0 stops" note after cooldowns) leaves the field
 * ABSENT — it is never baked as an empty, so a rate-limited run can't poison a
 * real transit city. The file is otherwise preserved (merge, not replace).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
    area,
    booleanIntersects,
    booleanPointInPolygon,
    intersect,
} from "@turf/turf";
import osmtogeojson from "osmtogeojson";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..");

// ── args ──────────────────────────────────────────────────────────────
function arg(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    if (i === -1) return fallback;
    const next = process.argv[i + 1];
    if (!next || next.startsWith("--")) return true; // boolean flag
    return next;
}
const LIMIT = arg("limit", false) ? parseInt(arg("limit"), 10) : Infinity;
const ONLY = arg("only", false)
    ? String(arg("only"))
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean)
    : null;
const SKIP_EXISTING = !!arg("skip-existing", false);
const RADIUS_KM = parseFloat(arg("radius", "40")) || 40;
const LEVEL = String(arg("level", "auto"));
// All six transit modes — bus/tram/ferry included, because they're allowed
// hiding-zone modes in the game and some regions rely heavily on them (a
// bus-only suburb is still transit-reachable). The debug tool offers all six
// too. The combined query IS heavy with bus, but the browser tool runs it
// successfully (Sydney: 21k stops), so the worker can serve it. Override with
// `--kinds subway,light_rail,commuter` for a rail-only run.
const KINDS = String(
    arg("kinds", "subway,light_rail,commuter,tram,ferry,bus"),
)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const MIN_STOPS = parseInt(arg("min-stops", "2"), 10);
const MAX_AREA_RATIO = parseFloat(arg("max-area-ratio", "10")) || 10;
const MIN_DENSITY = parseFloat(arg("min-density", "0.2"));
const CONTIGUOUS = !arg("no-contiguous", false);
const CONCURRENCY = parseInt(arg("concurrency", "4"), 10) || 4;
const DELAY_MS = parseInt(arg("delay-ms", "1500"), 10);
// Cooldown after a "0 stops" result — almost always the worker's upstream
// Overpass rate-limited after a PREVIOUS heavy city (London-sized queries
// saturate it). We don't know how long the throttle lasts, so ESCALATE: wait
// COOLDOWN_MS, retry; if still 0, wait 2×, then 3×, … up to MAX_COOLDOWNS
// times. `--cooldown-ms` sets the base (default 30s), `--max-cooldowns` the
// number of escalating retries (default 4 → 30+60+90+120 = 5 min worst case).
const COOLDOWN_MS = parseInt(arg("cooldown-ms", "30000"), 10);
const MAX_COOLDOWNS = parseInt(arg("max-cooldowns", "4"), 10);
const VERBOSE = !!arg("verbose", false);
const PROBE = !!arg("probe", false);
// Priority-region ordering — process the cities players actually use FIRST.
// world-cities.json is population-ordered, which front-loads Chinese megacities
// (low-priority for the audience AND sparsely mapped in OSM). This orders the
// run by region TIER (list order), then population within each tier, using the
// `country` tag baked on each city. Bare `--priority-regions` uses the default
// list; `--priority-regions US,GB,…` customises it. Ported from
// laptop-prewarm.mjs — keep the default list roughly in sync.
const DEFAULT_PRIORITY_REGIONS = [
    "US", "CA", "GB", "IE", "AU", "NZ", // English-speaking core audience
    "DE", "FR", "ES", "IT", "NL", "BE", "AT", "CH", "PT", // Western Europe
    "SE", "NO", "DK", "FI", "IS", // Nordics
];
const PRIORITY_REGIONS = (() => {
    const v = arg("priority-regions", false);
    if (!v) return null;
    if (v === true) return DEFAULT_PRIORITY_REGIONS;
    return String(v)
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter((s) => /^[A-Z]{2}$/.test(s));
})();
// A fine-level (>=7) primary in a big metro can return dozens of tiny
// incorporated suburbs (LA at level 8 → 55 cities, Chicago → 137). When the
// auto result exceeds this, re-query candidates at level 6 (county) for a clean
// "few-large" set. Tunable via --max-adjacents; 0 disables the coarsening.
const MAX_ADJACENTS = parseInt(arg("max-adjacents", "20"), 10);
const OUT = resolve(PKG_ROOT, String(arg("out", "world-cities.json")));
const EMAIL = String(arg("email", "worldcities@example.com"));
const UA = `JetLagHideAndSeek-adjacents/1.0 (${EMAIL})`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Overpass ──────────────────────────────────────────────────────────
// PRIMARY endpoint is the app's OWN overpass-cache worker — the exact path the
// browser (and the validated /debug/adjacency tool) uses. It does mirror
// rotation, R2 caching, and abort-remark handling server-side, so the script
// gets identical results to the browser and doesn't get rate-limited hitting
// public mirrors directly (which returned empty/failed for every stops query).
// Public mirrors stay as a fallback if the worker is unreachable.
const WORKER_BASE =
    String(arg("worker", "")) ||
    "https://jlhs-overpass-cache.karl-mj-andersson.workers.dev";
const OVERPASS_ENDPOINTS = [
    `${WORKER_BASE}/api/interpreter`,
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    // overpass.osm.ch is DELIBERATELY excluded: a --probe showed it returns a
    // "successful" 200 with 0 elements and a nonsense timestamp ("115575") — a
    // broken/stale instance whose false-empty response was being trusted as an
    // authoritative "0 stops", baking wrong empties whenever the good endpoints
    // were momentarily busy. Re-add only if it's confirmed healthy again.
];
let endpointIdx = 0;

// ── Overpass slot gate (per-IP) ───────────────────────────────────────────
// Poll Overpass's /api/status — it reports THIS machine's per-IP slot budget
// (e.g. "Rate limit: 2 / 2 slots available now") — and wait until a slot is
// free before firing a DIRECT public-mirror query. The generator hits the
// WORKER first (server-side cache + its own rate handling), but when the
// worker's upstream is throttled it returns an empty 200; we then fall to the
// public mirrors straight from this IP, and those must be paced or they throttle
// too. This is the same gate laptop-prewarm.mjs uses — the generator delegated
// rate-limiting to the worker and never had its own, which is why heavy bulk
// runs stalled. Never blocks longer than maxWaitMs; a failed status check just
// proceeds (don't stall on a status hiccup).
const STATUS_URL = "https://overpass-api.de/api/status";
let lastSlotLog = 0;
async function waitForOverpassSlot(maxWaitMs = 180_000) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
        let text;
        try {
            const res = await fetch(STATUS_URL, { headers: { "User-Agent": UA } });
            text = await res.text();
        } catch {
            return; // status unreachable → proceed rather than stall
        }
        const avail = text.match(/(\d+)\s+slots?\s+available now/i);
        if (avail && parseInt(avail[1], 10) > 0) return; // a slot is free
        if (/Rate limit:\s*0\b/i.test(text)) return; // 0 = unlimited on this instance
        const waits = [...text.matchAll(/in (\d+) seconds/gi)].map((m) =>
            parseInt(m[1], 10),
        );
        const waitS = waits.length ? Math.min(...waits) : 4;
        if (Date.now() - lastSlotLog > 15_000) {
            console.log(`    ⏸ waiting ~${waitS + 1}s for a free Overpass slot…`);
            lastSlotLog = Date.now();
        }
        await sleep((waitS + 1) * 1000);
    }
}

async function overpass(query, tries = 7) {
    let lastErr;
    for (let attempt = 0; attempt < tries; attempt++) {
        const url = OVERPASS_ENDPOINTS[endpointIdx % OVERPASS_ENDPOINTS.length];
        const isWorker = url.startsWith(WORKER_BASE);
        // Pace DIRECT mirror queries to this IP's slot budget (the worker
        // manages its own upstream, so no gate for it). Never fire into a
        // throttle.
        if (!isWorker) await waitForOverpassSlot();
        // Per-attempt timeout so a hung connection can't stall a batch run.
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 180_000);
        try {
            const res = await fetch(url, {
                method: "POST",
                signal: ctrl.signal,
                headers: {
                    "User-Agent": UA,
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                body: "data=" + encodeURIComponent(query),
            });
            const text = await res.text();
            if (!res.ok) {
                // 429 (rate limit) / 5xx (overloaded mirror, incl. the
                // worker's own 502 "all mirrors unavailable") are TRANSIENT —
                // Overpass is just busy. Back off patiently (these recover in
                // seconds-to-minutes) rather than rotate fast and burn the
                // rate limit further. Honour Retry-After when present.
                const ra = parseInt(res.headers.get("Retry-After") ?? "", 10);
                const busy = res.status === 429 || res.status >= 500;
                lastErr = new Error(`Overpass ${res.status}`);
                endpointIdx++; // try a different mirror next
                const backoff = Number.isFinite(ra)
                    ? ra * 1000
                    : busy
                      ? Math.min(60_000, 5000 * 2 ** attempt)
                      : 2000;
                clearTimeout(timer);
                if (attempt < tries - 1) await sleep(backoff);
                continue;
            }
            // Soft-failure ("remark: runtime error … timed out") — retry on a
            // different mirror rather than treat the empty/truncated body as
            // real (same sniff as the client's overpassAbort.ts).
            if (/"remark":\s*"[^"]*(?:timed out|out of memory)/i.test(text)) {
                throw new Error("Overpass soft-timeout (remark)");
            }
            const json = JSON.parse(text);
            // An empty result from ANY endpoint is SUSPECT — not just the
            // worker (whose Cloudflare upstream can be throttled by its own
            // cron), but any mirror that momentarily soft-fails OR is quietly
            // broken (overpass.osm.ch was returning a fake 200/0). Rather than
            // trust a lone 0, rotate to the next endpoint and retry. On the
            // FINAL attempt we accept whatever we get, so a genuinely stopless
            // area still resolves to 0 after exhausting the endpoints.
            if ((json.elements ?? []).length === 0 && attempt < tries - 1) {
                endpointIdx++; // rotate to a different endpoint and re-query
                clearTimeout(timer);
                continue;
            }
            return json;
        } catch (e) {
            lastErr = e;
            endpointIdx++; // rotate mirror
            if (attempt < tries - 1) await sleep(Math.min(30_000, 2000 * 2 ** attempt));
        } finally {
            clearTimeout(timer);
        }
    }
    throw lastErr ?? new Error("Overpass failed");
}

// ── boundary polygon ────────────────────────────────────────────────────
// PRIMARY source is polygons.openstreetmap.fr — a dedicated, server-cached
// GeoJSON service (exactly what the app uses). It returns a clean
// Polygon/MultiPolygon directly and does NOT rate-limit like the Overpass
// interpreter, so hammering it for hundreds of candidate boundaries is safe.
// The Overpass `out geom` + osmtogeojson path is only the fallback.
const POLY_GEOJSON = "https://polygons.openstreetmap.fr/get_geojson.py";
const POLY_INDEX = "https://polygons.openstreetmap.fr/";

function normalizeToPolyGeometry(raw) {
    if (!raw || typeof raw !== "object") return null;
    if (raw.type === "Polygon" || raw.type === "MultiPolygon") return raw;
    if (raw.type === "Feature") {
        const g = raw.geometry;
        if (g && (g.type === "Polygon" || g.type === "MultiPolygon")) return g;
        return null;
    }
    if (raw.type === "FeatureCollection") {
        for (const f of raw.features ?? []) {
            const g = f?.geometry;
            if (g && (g.type === "Polygon" || g.type === "MultiPolygon"))
                return g;
        }
    }
    if (raw.type === "GeometryCollection") {
        for (const g of raw.geometries ?? []) {
            if (g && (g.type === "Polygon" || g.type === "MultiPolygon"))
                return g;
        }
    }
    return null;
}

async function fetchPolyOsmFr(relationId) {
    const url = `${POLY_GEOJSON}?id=${relationId}&params=0`;
    let text;
    try {
        const res = await fetch(url, {
            headers: { "User-Agent": UA, Accept: "application/json" },
        });
        if (!res.ok) return { geom: null, retry: false };
        text = (await res.text()).trim();
    } catch {
        return { geom: null, retry: false };
    }
    if (text === "None") return { geom: null, retry: true }; // not yet built
    if (!text || text.startsWith("<") || text.startsWith("!"))
        return { geom: null, retry: false };
    try {
        return { geom: normalizeToPolyGeometry(JSON.parse(text)), retry: false };
    } catch {
        return { geom: null, retry: false };
    }
}

async function triggerPolyBuild(relationId) {
    try {
        await fetch(`${POLY_INDEX}?id=${relationId}`, {
            headers: { "User-Agent": UA },
        });
    } catch {
        /* fire-and-forget */
    }
}

async function fetchBoundaryViaOverpass(relationId) {
    const q = `[out:json][timeout:120];relation(${relationId});out geom;`;
    let json;
    try {
        json = await overpass(q);
    } catch {
        return null;
    }
    const elements = json?.elements;
    if (!Array.isArray(elements)) return null;
    const annotated = {
        elements: elements.map((el) =>
            el?.type === "relation" && el?.id === relationId
                ? {
                      ...el,
                      tags: {
                          type: "boundary",
                          boundary: "administrative",
                          ...(el.tags ?? {}),
                      },
                  }
                : el,
        ),
    };
    let fc;
    try {
        fc = osmtogeojson(annotated);
    } catch {
        return null;
    }
    for (const f of fc.features ?? []) {
        const g = f.geometry;
        if (g?.type === "Polygon" || g?.type === "MultiPolygon") return g;
    }
    return null;
}

async function fetchBoundary(relationId) {
    let { geom, retry } = await fetchPolyOsmFr(relationId);
    if (geom) return geom;
    if (retry) {
        // polygons.osm.fr hasn't precomputed this one yet — kick a build and
        // retry once after a short wait (same as the app's first-time path).
        await triggerPolyBuild(relationId);
        await sleep(4000);
        ({ geom } = await fetchPolyOsmFr(relationId));
        if (geom) return geom;
    }
    return fetchBoundaryViaOverpass(relationId);
}

async function fetchAdminLevel(relationId) {
    const q = `[out:json][timeout:60];relation(${relationId});out tags;`;
    try {
        const json = await overpass(q);
        const rel = (json.elements ?? []).find((e) => e.type === "relation");
        return rel?.tags?.admin_level ?? null;
    } catch {
        return null;
    }
}

// ── transit-reach queries (ported from transitReach.ts) ─────────────────
/** One route-selector per kind. Kept separate so the stops fetch can query
 *  each mode on its OWN Overpass call — a huge metro's bus network alone can
 *  time out and, in a combined query, would zero out subway/rail too. */
function routeSelectorFor(kind, around) {
    switch (kind) {
        case "subway":
            return `relation["route"="subway"]${around};`;
        case "light_rail":
            return `relation["route"="light_rail"]${around};`;
        case "tram":
            return `relation["route"="tram"]${around};`;
        case "ferry":
            return `relation["route"="ferry"]${around};`;
        case "bus":
            return `relation["route"="bus"]${around};`;
        case "commuter":
            return `relation["route"="train"]["service"!~"^(long_distance|high_speed|night|car|car_shuttle)$"]${around};`;
        default:
            return "";
    }
}

function buildStopsQueryForKind(lat, lng, radiusKm, kind) {
    const r = Math.round(radiusKm * 1000);
    const sel = routeSelectorFor(kind, `(around:${r},${lat},${lng})`);
    return `
[out:json][timeout:180];
(
${sel}
)->.routes;
node(r.routes);
out;
`;
}

/** The ONE combined stops query — byte-identical to
 *  `buildRailNetworkStopsQuery` in src/maps/api/transitReach.ts (the validated
 *  /debug/adjacency path). ALL requested modes go in a single union, so this
 *  produces the exact same query string the browser tool sends — same worker
 *  cache entries, same live-fetch behaviour. The earlier per-mode split
 *  (`buildStopsQueryForKind` × 6, kept only for `--probe`) DIVERGED from the
 *  debug tool: novel query strings that cache-missed and came back empty. */
function buildRailNetworkStopsQuery(lat, lng, radiusKm, kinds) {
    const r = Math.round(radiusKm * 1000);
    const around = `(around:${r},${lat},${lng})`;
    // Emit selectors in transitReach.ts's FIXED order (not the kinds-array
    // order) so the query string is byte-identical to the debug tool's — same
    // worker cache key, so an already-warmed city serves instantly instead of
    // re-fetching live.
    const ORDER = ["subway", "light_rail", "tram", "ferry", "bus", "commuter"];
    const kindSet = new Set(kinds);
    const routeSelectors = ORDER.filter((k) => kindSet.has(k))
        .map((k) => routeSelectorFor(k, around))
        .filter(Boolean);
    return `
[out:json][timeout:90];
(
${routeSelectors.join("\n")}
)->.routes;
node(r.routes);
out;
`;
}

/** Tag a returned stop node by its OWN tags — identical to
 *  `inferStopKind` in transitReach.ts. With one combined query we can't tell
 *  which mode's selector matched a node, so we read the node's tags (the debug
 *  tool does the same); defaults to "commuter". */
function inferStopKind(tags) {
    if (!tags) return "commuter";
    if (tags.station === "subway" || tags.subway === "yes") return "subway";
    if (tags.light_rail === "yes" || tags.station === "light_rail")
        return "light_rail";
    if (tags.railway === "tram_stop" || tags.tram === "yes") return "tram";
    if (tags.amenity === "ferry_terminal" || tags.ferry === "yes")
        return "ferry";
    if (tags.highway === "bus_stop" || tags.bus === "yes") return "bus";
    return "commuter";
}

function buildAdjacentAdminQuery(adminLevel, lat, lng, radiusKm) {
    return `
[out:json][timeout:60];
relation["admin_level"="${adminLevel}"]["type"="boundary"](around:${radiusKm * 1000},${lat},${lng});
out tags bb;
`;
}

function buildLocalAdminBandQuery(lat, lng, radiusKm) {
    return `
[out:json][timeout:60];
relation["admin_level"~"^[678]$"]["type"="boundary"]["boundary"="administrative"](around:${radiusKm * 1000},${lat},${lng});
out tags bb;
`;
}

// Keep the INNER retry light (1 retry). During a rate-limit these just hammer
// a throttled upstream inside the too-short backoff window; the real recovery
// is the caller's 30 s city-level cooldown-and-retry. The inner retry only
// catches a genuinely transient single soft-fail.
const STOPS_TRIES = 2;

/** Run a stops query with retry-on-empty/error and a whitespace cache-buster on
 *  retries (Overpass ignores it; it changes the worker's query-hash key so a
 *  retry can't re-serve a just-cached soft-failure). Returns the element array
 *  (possibly []), or null if it threw on every attempt. */
async function fetchStopsElements(baseQuery) {
    for (let attempt = 1; attempt <= STOPS_TRIES; attempt++) {
        const q = attempt === 1 ? baseQuery : baseQuery + " ".repeat(attempt - 1);
        try {
            const json = await overpass(q);
            const els = json.elements ?? [];
            if (els.length > 0 || attempt === STOPS_TRIES) return els;
        } catch {
            if (attempt === STOPS_TRIES) return null;
        }
        await sleep(3000 * attempt);
    }
    return null;
}

function collectStops(elements, tagAs, out) {
    for (const el of elements) {
        if (el.type !== "node") continue;
        if (typeof el.lat !== "number" || typeof el.lon !== "number") continue;
        out.push({
            lat: el.lat,
            lon: el.lon,
            kind: tagAs === "infer" ? inferStopKind(el.tags) : tagAs,
            name: el.tags?.name,
        });
    }
}

async function fetchRailStops(lat, lng, radiusKm, kinds) {
    // ONE combined query, ALL modes — exactly the debug tool's process. It
    // completes even for a 36k-stop metro (London succeeded at 36,014 as the
    // FIRST city). Bus stays IN the query: it's a major reachability
    // contributor (London's 36k is mostly bus) and an allowed game mode, so
    // splitting it out and skipping it on failure wrongly collapsed London to 2
    // adjacents. The heavy-metro 0s were a RATE-LIMIT CASCADE (a prior heavy
    // city saturating the worker's upstream), not this query being too heavy —
    // that's handled by the caller's cooldown-and-retry, not by dropping bus.
    const els = await fetchStopsElements(
        buildRailNetworkStopsQuery(lat, lng, radiusKm, kinds),
    );
    if (els === null) return [];
    const stops = [];
    collectStops(els, "infer", stops);
    return stops;
}

async function fetchAdminCandidates(
    explicitLevel,
    detectedLevel,
    lat,
    lng,
    radiusKm,
) {
    // Choose the candidate admin level. An EXPLICIT --level is honored at any
    // level. For AUTO, query the primary's own level ONLY if it's a fine
    // municipality level (>=7) — a coarse megacity level (NYC = admin_level 5)
    // has no usable same-level peers (only whole states), so fall back to the
    // 6/7/8 municipality BAND, which yields the reachable cities/counties.
    // Mirrors transitReach.ts fetchAdminCandidates (the debug tool). This is
    // what makes NYC/London/Tokyo resolve at --level auto instead of 0.
    const chosen = explicitLevel ?? detectedLevel;
    const lvlNum =
        typeof chosen === "string" && /^\d+$/.test(chosen)
            ? parseInt(chosen, 10)
            : NaN;
    const useExact =
        explicitLevel != null
            ? Number.isFinite(lvlNum)
            : Number.isFinite(lvlNum) && lvlNum >= 7;
    // Coarse megacity (auto, numeric level <=6 like NYC=5): query LEVEL 6
    // (county) ONLY — a clean "few-large" set. The 6/7/8 BAND was wrong here:
    // it also pulled level-7/8 towns, and when a containing county fell below
    // the density filter (removed BEFORE dedup) its towns had no container to
    // collapse into and survived as dozens of orphans (NYC → 34 incl.
    // Ho-Ho-Kus/Dumont/etc. vs the debug tool's clean 5 counties). Only an
    // unknown (non-numeric) level falls to the band as a robust catch-all.
    const query = useExact
        ? buildAdjacentAdminQuery(String(lvlNum), lat, lng, radiusKm)
        : Number.isFinite(lvlNum)
          ? buildAdjacentAdminQuery("6", lat, lng, radiusKm)
          : buildLocalAdminBandQuery(lat, lng, radiusKm);
    let json;
    try {
        json = await overpass(query);
    } catch {
        return [];
    }
    const out = [];
    for (const el of json.elements ?? []) {
        if (el.type !== "relation" || typeof el.id !== "number") continue;
        if (!el.bounds) continue;
        const name =
            el.tags?.name ||
            el.tags?.["name:en"] ||
            el.tags?.official_name ||
            `r${el.id}`;
        const b = el.bounds;
        const ext = [b.maxlat, b.minlon, b.minlat, b.maxlon];
        out.push({
            id: el.id,
            name,
            adminLevel: el.tags?.admin_level ?? null,
            areaKm2: bboxAreaKm2(b),
            extent: ext,
            lat: (b.minlat + b.maxlat) / 2,
            lng: (b.minlon + b.maxlon) / 2,
        });
    }
    return out;
}

// ── geometry helpers (ported) ───────────────────────────────────────────
function bboxAreaKm2(b) {
    const midLat = (b.minlat + b.maxlat) / 2;
    const latKm = Math.abs(b.maxlat - b.minlat) * 111;
    const lngKm =
        Math.abs(b.maxlon - b.minlon) * 111 * Math.cos((midLat * Math.PI) / 180);
    return latKm * lngKm * 0.55;
}

function haversineKm(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLng = ((lng2 - lng1) * Math.PI) / 180;
    const la1 = (lat1 * Math.PI) / 180;
    const la2 = (lat2 * Math.PI) / 180;
    const x =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
}

function polygonExtent(geom) {
    let minLat = Infinity,
        maxLat = -Infinity,
        minLng = Infinity,
        maxLng = -Infinity;
    const rings = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
    for (const poly of rings) {
        for (const [lng, lat] of poly[0] ?? []) {
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
            if (lng < minLng) minLng = lng;
            if (lng > maxLng) maxLng = lng;
        }
    }
    return [maxLat, minLng, minLat, maxLng];
}

function extentAreaKm2(ext) {
    const [maxLat, minLng, minLat, maxLng] = ext;
    const midLat = (minLat + maxLat) / 2;
    const latKm = Math.abs(maxLat - minLat) * 111;
    const lngKm =
        Math.abs(maxLng - minLng) * 111 * Math.cos((midLat * Math.PI) / 180);
    return latKm * lngKm * 0.55;
}

function truePolyAreaKm2(poly) {
    try {
        const m2 = area({ type: "Polygon", coordinates: poly });
        if (Number.isFinite(m2) && m2 > 0) return m2 / 1e6;
    } catch {
        /* fall through */
    }
    return extentAreaKm2(polygonExtent({ type: "Polygon", coordinates: poly }));
}

function largestComponentCentre(geom) {
    const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
    const comps = polys.map((poly) => {
        const [maxLat, minLng, minLat, maxLng] = polygonExtent({
            type: "Polygon",
            coordinates: poly,
        });
        return {
            area: truePolyAreaKm2(poly),
            lat: (maxLat + minLat) / 2,
            lng: (minLng + maxLng) / 2,
        };
    });
    if (comps.length <= 1) {
        const c = comps[0];
        return c ? { lat: c.lat, lng: c.lng } : { lat: 0, lng: 0 };
    }
    // Greedy proximity CLUSTERING (largest-area first). A city split across many
    // polygons — a fragmented mainland, e.g. Tokyo whose mainland isn't one
    // clean polygon — collects into ONE cluster; a distant island group the
    // admin owns (Tokyo's Izu/Ogasawara islands ~1000 km south) forms a
    // SEPARATE cluster. We then pick the cluster with the largest TOTAL true
    // area (the mainland always out-weighs the islands) and return its
    // area-weighted centre. This fixes "pick the largest SINGLE component"
    // grabbing a tiny island when the mainland is fragmented into pieces each
    // smaller than that island. 150 km groups even a wide mainland while
    // keeping ocean islands separate; the area weighting keeps a near island
    // that does join from dragging the centre off the mainland.
    const CLUSTER_KM = 150;
    const clusters = [];
    for (const c of [...comps].sort((a, b) => b.area - a.area)) {
        let cl = clusters.find(
            (k) => haversineKm(k.lat, k.lng, c.lat, c.lng) <= CLUSTER_KM,
        );
        if (!cl) {
            cl = { area: 0, wLat: 0, wLng: 0, lat: c.lat, lng: c.lng };
            clusters.push(cl);
        }
        const w = Math.max(c.area, 1e-6);
        cl.area += w;
        cl.wLat += c.lat * w;
        cl.wLng += c.lng * w;
        cl.lat = cl.wLat / cl.area;
        cl.lng = cl.wLng / cl.area;
    }
    const best = clusters.reduce((a, b) => (b.area > a.area ? b : a));
    return { lat: best.lat, lng: best.lng };
}

function bboxesNear(a, b, gapDeg = 0.03) {
    const [aN, aW, aS, aE] = a;
    const [bN, bW, bS, bE] = b;
    const lngOk = !(bW > aE + gapDeg || aW > bE + gapDeg);
    const latOk = !(bS > aN + gapDeg || aS > bN + gapDeg);
    return lngOk && latOk;
}

function dropFarExclaves(geom) {
    if (geom.type !== "MultiPolygon" || geom.coordinates.length <= 1)
        return geom;
    const parts = geom.coordinates.map((poly) => {
        const ext = polygonExtent({ type: "Polygon", coordinates: poly });
        return { poly, ext, area: truePolyAreaKm2(poly) };
    });
    const largest = parts.reduce((a, b) => (b.area > a.area ? b : a));
    const MIN_FRACTION = 0.15;
    const kept = parts.filter(
        (p) =>
            p === largest ||
            p.area >= MIN_FRACTION * largest.area ||
            bboxesNear(p.ext, largest.ext, 0.05),
    );
    if (kept.length === geom.coordinates.length) return geom;
    return { type: "MultiPolygon", coordinates: kept.map((k) => k.poly) };
}

function fillHoles(poly) {
    if (poly.type === "Polygon")
        return { type: "Polygon", coordinates: [poly.coordinates[0]] };
    return {
        type: "MultiPolygon",
        coordinates: poly.coordinates.map((p) => [p[0]]),
    };
}

function centreInside(c, k) {
    const [maxLat, minLng, minLat, maxLng] = c.extent;
    const pt = [(minLng + maxLng) / 2, (minLat + maxLat) / 2];
    if (k.polygon) {
        try {
            return booleanPointInPolygon(pt, {
                type: "Feature",
                properties: {},
                geometry: fillHoles(k.polygon),
            });
        } catch {
            /* fall through */
        }
    }
    const [kMaxLat, kMinLng, kMinLat, kMaxLng] = k.extent;
    return (
        pt[0] >= kMinLng &&
        pt[0] <= kMaxLng &&
        pt[1] >= kMinLat &&
        pt[1] <= kMaxLat
    );
}

function bboxIoU(a, b) {
    const [aN, aW, aS, aE] = a;
    const [bN, bW, bS, bE] = b;
    const iS = Math.max(aS, bS);
    const iN = Math.min(aN, bN);
    const iW = Math.max(aW, bW);
    const iE = Math.min(aE, bE);
    if (iN <= iS || iE <= iW) return 0;
    const inter = (iN - iS) * (iE - iW);
    const areaA = (aN - aS) * (aE - aW);
    const areaB = (bN - bS) * (bE - bW);
    const union = areaA + areaB - inter;
    return union > 0 ? inter / union : 0;
}

const CANDIDATE_SUFFIX_RE =
    /\b(county|kommun|comune|gemeinde|municipality|parish|borough)\b/i;

function dedupeNested(candidates) {
    const bySizeDesc = [...candidates].sort((a, b) => b.areaKm2 - a.areaKm2);
    const suffixed = (n) => CANDIDATE_SUFFIX_RE.test(n);
    const kept = [];
    for (const c of bySizeDesc) {
        const container = kept.find(
            (k) => k.areaKm2 > c.areaKm2 * 1.25 && centreInside(c, k),
        );
        if (container) continue;
        const dupeIdx = kept.findIndex(
            (k) => bboxIoU(k.extent, c.extent) >= 0.75,
        );
        if (dupeIdx !== -1) {
            const incumbent = kept[dupeIdx];
            if (suffixed(incumbent.name) && !suffixed(c.name)) {
                kept[dupeIdx] = { ...c, stopCount: incumbent.stopCount };
            }
            continue;
        }
        kept.push(c);
    }
    kept.sort((a, b) => b.stopCount - a.stopCount || a.distanceKm - b.distanceKm);
    return kept;
}

function filterContiguous(cands, primaryFeature) {
    if (cands.length === 0) return cands;
    const n = cands.length;
    const seed = cands.map((c) => {
        if (!c.polygon) return false;
        try {
            return booleanIntersects(primaryFeature, {
                type: "Feature",
                properties: {},
                geometry: c.polygon,
            });
        } catch {
            return false;
        }
    });
    const adj = Array.from({ length: n }, () => []);
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            if (bboxesNear(cands[i].extent, cands[j].extent)) {
                adj[i].push(j);
                adj[j].push(i);
            }
        }
    }
    const seen = new Set();
    const queue = [];
    for (let i = 0; i < n; i++) {
        if (seed[i]) {
            seen.add(i);
            queue.push(i);
        }
    }
    if (seen.size === 0) return cands;
    while (queue.length) {
        const u = queue.shift();
        for (const v of adj[u]) {
            if (!seen.has(v)) {
                seen.add(v);
                queue.push(v);
            }
        }
    }
    return cands.filter((_, i) => seen.has(i));
}

// ── core: transit-reach for one city ────────────────────────────────────
async function findAdjacents(city) {
    const primaryOsmId = city.relationId;
    const rawPrimary = await fetchBoundary(primaryOsmId);
    if (!rawPrimary) {
        return { ids: [], names: [], note: "no primary boundary" };
    }
    const primaryPolygon = dropFarExclaves(rawPrimary);
    const { lat, lng } = largestComponentCentre(rawPrimary);
    if (VERBOSE)
        console.log(`    centroid=${lat.toFixed(4)},${lng.toFixed(4)}`);

    // Always detect the real admin_level (for the auto decision + the log);
    // an explicit --level overrides which level the candidate query uses.
    const detectedLevel = await fetchAdminLevel(primaryOsmId);
    const explicitLevel = LEVEL === "auto" ? null : LEVEL;

    const [stops, adminCandidates] = await Promise.all([
        fetchRailStops(lat, lng, RADIUS_KM, KINDS),
        fetchAdminCandidates(explicitLevel, detectedLevel, lat, lng, RADIUS_KM),
    ]);
    if (VERBOSE)
        console.log(
            `    stops=${stops.length} candidates=${adminCandidates.length} level=${explicitLevel ?? `auto(${detectedLevel})`}`,
        );
    if (stops.length === 0) {
        return { ids: [], names: [], note: "0 stops (check centroid/kinds)" };
    }

    const primaryFeature = {
        type: "Feature",
        properties: {},
        geometry: primaryPolygon,
    };
    const primaryAreaKm2 = extentAreaKm2(polygonExtent(primaryPolygon));

    const mostlyInsidePrimary = (candPoly) => {
        try {
            const cand = { type: "Feature", properties: {}, geometry: candPoly };
            const inter = intersect({
                type: "FeatureCollection",
                features: [primaryFeature, cand],
            });
            if (!inter) return false;
            const candArea = area(cand);
            if (candArea <= 0) return false;
            return area(inter) / candArea > 0.9;
        } catch {
            return false;
        }
    };

    // Build the final candidate set from a given admin-candidate list. Extracted
    // so we can run it TWICE — once at the auto/explicit level, and again at
    // level 6 to coarsen an over-granular metro (see below). Each call gets its
    // own `candidates`/`idx`, so it's safe to invoke repeatedly. `minDensity`
    // is a param because the density floor that suits small level-8 cities is
    // ~100× too strict for huge level-6 counties (a well-served county is still
    // very low stops/km²), so the coarse pass passes 0.
    const buildFinal = async (
        adminCands,
        minDensity = MIN_DENSITY,
        maxAreaRatio = MAX_AREA_RATIO,
    ) => {
        const candidates = [];
        let idx = 0;
        const runNext = async () => {
            while (idx < adminCands.length) {
                const cand = adminCands[idx++];
                if (cand.id === primaryOsmId) continue;
                const [maxLat, minLng, minLat, maxLng] = cand.extent;
                const bboxStops = stops.filter(
                    (s) =>
                        s.lat >= minLat &&
                        s.lat <= maxLat &&
                        s.lon >= minLng &&
                        s.lon <= maxLng,
                );
                if (bboxStops.length === 0) continue;
                let poly = await fetchBoundary(cand.id);
                if (poly) poly = dropFarExclaves(poly);
                if (poly && mostlyInsidePrimary(poly)) continue;
                let inside = bboxStops;
                if (poly) {
                    const feature = {
                        type: "Feature",
                        properties: {},
                        geometry: poly,
                    };
                    inside = bboxStops.filter((s) => {
                        try {
                            return booleanPointInPolygon([s.lon, s.lat], feature);
                        } catch {
                            return false;
                        }
                    });
                }
                if (inside.length === 0) continue;
                const kindSet = new Set();
                for (const s of inside) kindSet.add(s.kind);
                const cleanExt = poly ? polygonExtent(poly) : cand.extent;
                let realAreaKm2 = poly ? extentAreaKm2(cleanExt) : cand.areaKm2;
                if (poly) {
                    try {
                        const a =
                            area({
                                type: "Feature",
                                properties: {},
                                geometry: poly,
                            }) / 1e6;
                        if (a > 0) realAreaKm2 = a;
                    } catch {
                        /* keep bbox estimate */
                    }
                }
                candidates.push({
                    relationId: cand.id,
                    name: cand.name,
                    stopCount: inside.length,
                    distanceKm: haversineKm(lat, lng, cand.lat, cand.lng),
                    kinds: [...kindSet],
                    areaKm2: poly ? extentAreaKm2(cleanExt) : cand.areaKm2,
                    stopsPerKm2: realAreaKm2 > 0 ? inside.length / realAreaKm2 : 0,
                    adminLevel: cand.adminLevel,
                    extent: cleanExt,
                    polygon: poly,
                });
            }
        };
        await Promise.all(
            Array.from(
                { length: Math.min(CONCURRENCY, adminCands.length) },
                () => runNext(),
            ),
        );
        candidates.sort(
            (a, b) => b.stopCount - a.stopCount || a.distanceKm - b.distanceKm,
        );
        // Client-side filters (min-stops / density / area cap), then dedup +
        // contiguity — exactly the debug-tool pipeline at the validated defaults.
        let sized = candidates.filter(
            (c) => c.stopCount >= MIN_STOPS && c.stopsPerKm2 >= minDensity,
        );
        if (primaryAreaKm2 > 0 && maxAreaRatio > 0) {
            sized = sized.filter(
                (c) => c.areaKm2 <= maxAreaRatio * primaryAreaKm2,
            );
        }
        let out = dedupeNested(sized);
        if (CONTIGUOUS) out = filterContiguous(out, primaryFeature);
        return out;
    };

    let finalCandidates = await buildFinal(adminCandidates);

    // Coarsen an over-granular fine-level metro. A US city sits at admin_level 8,
    // so `auto` returns every incorporated suburb (LA → 55, Chicago → 137). When
    // a FINE-level (>=7) auto result blows past MAX_ADJACENTS, re-query at level
    // 6 (county) for a clean "few-large" set. Helsinki (L8 → 11) stays untouched
    // (under the cap), and an explicit --level is never overridden.
    // Coarsen when the auto result is over the cap AND the primary's level is
    // FINE (>=7) OR UNKNOWN. The unknown case is essential: under rate-limiting
    // the admin-level query intermittently fails → detectedLevel is null → the
    // city falls back to the 6/7/8 band (dozens of cities); those must still
    // coarsen (Long Beach → 66, Miami → 36 slipped through the old >=7-only
    // gate). A coarse-numeric level (4/5/6) already uses county candidates and
    // doesn't over-produce, so it's correctly left alone.
    const detLvlNum = parseInt(detectedLevel, 10);
    if (
        MAX_ADJACENTS > 0 &&
        explicitLevel === null &&
        finalCandidates.length > MAX_ADJACENTS &&
        (!Number.isFinite(detLvlNum) || detLvlNum >= 7)
    ) {
        if (VERBOSE)
            console.log(
                `    ${finalCandidates.length} adjacents at L${detectedLevel} > ${MAX_ADJACENTS} — coarsening to L6 (county)`,
            );
        try {
            const coarseAdmin = await fetchAdminCandidates(
                "6",
                detectedLevel,
                lat,
                lng,
                RADIUS_KM,
            );
            // Density floor AND area cap OFF for counties. Density: they're huge,
            // so a reachable one is still very low stops/km². Area cap: it's
            // relative to the PRIMARY, so a SMALL primary (Long Beach ~130 km²)
            // makes its own county (LA County ~1300+ km²) exceed 10× and drop —
            // which emptied the coarse set and kept the L8 66/36 bloat. min-stops
            // (>=2) + contiguity already exclude the grazed desert counties, so
            // the ratio cap is pure downside once we've decided to go county-level.
            const coarse = await buildFinal(coarseAdmin, 0, 0);
            // Adopt the coarser set only if it actually reduced the count without
            // collapsing to nothing (a country where L6 is absent/huge → skip).
            if (coarse.length >= 1 && coarse.length < finalCandidates.length) {
                finalCandidates = coarse;
            }
        } catch (e) {
            if (VERBOSE)
                console.log(`    (coarsen failed: ${e instanceof Error ? e.message : e})`);
        }
    }

    const ids = [...new Set(finalCandidates.map((c) => c.relationId))].sort(
        (a, b) => a - b,
    );
    return { ids, names: finalCandidates.map((c) => c.name), note: null };
}

// ── driver ──────────────────────────────────────────────────────────────
/** Order the city list by priority-region TIER (list index), then by population
 *  within each tier. A city whose `country` isn't in the list (or is unknown)
 *  sorts last, by population. Mirrors laptop-prewarm.mjs orderByPriorityRegions. */
function orderByPriorityRegions(cities, regions) {
    const rank = (c) => {
        const i = regions.indexOf((c.country ?? "").toUpperCase());
        return i === -1 ? regions.length : i;
    };
    return [...cities].sort(
        (a, b) => rank(a) - rank(b) || (b.population ?? 0) - (a.population ?? 0),
    );
}

function selectCities(all) {
    let list = all;
    if (ONLY) {
        list = all.filter(
            (c) =>
                ONLY.includes(String(c.relationId)) ||
                ONLY.includes((c.name ?? "").toLowerCase()),
        );
    }
    if (SKIP_EXISTING) {
        // A PRESENT array (even []) means "already generated" — a canonical
        // empty is a real result, not a to-do. Retry ONLY cities with no field
        // at all (never generated, or a prior run failed and left it absent).
        list = list.filter((c) => !Array.isArray(c.adjacentRelationIds));
    }
    // Reorder BEFORE the --limit slice so the limit takes the priority cities.
    if (PRIORITY_REGIONS && !ONLY) {
        list = orderByPriorityRegions(list, PRIORITY_REGIONS);
    }
    if (Number.isFinite(LIMIT)) list = list.slice(0, LIMIT);
    return list;
}

/** `--probe`: one boundary fetch + one subway stops query for Helsinki, with
 *  full HTTP diagnostics. Isolates "is Overpass reachable at all from this
 *  machine" from the selection logic — run this first if a real run returns
 *  0 stops everywhere. */
async function probe() {
    console.log(`[probe] worker=${WORKER_BASE}`);
    console.log(`[probe] fetching Helsinki (r34914) boundary…`);
    const geom = await fetchBoundary(34914);
    if (!geom) {
        console.log(`[probe] ✗ boundary fetch returned null`);
        return;
    }
    const { lat, lng } = largestComponentCentre(geom);
    console.log(
        `[probe] ✓ boundary ${geom.type}, centroid ${lat.toFixed(4)},${lng.toFixed(4)}`,
    );
    const q = buildStopsQueryForKind(lat, lng, RADIUS_KM, "subway");
    for (const url of OVERPASS_ENDPOINTS) {
        try {
            const res = await fetch(url, {
                method: "POST",
                headers: {
                    "User-Agent": UA,
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                body: "data=" + encodeURIComponent(q),
            });
            const text = await res.text();
            let count = "?";
            try {
                count = (JSON.parse(text).elements ?? []).length;
            } catch {
                /* not json */
            }
            console.log(
                `[probe] ${url}\n        status=${res.status} bytes=${text.length} nodes=${count} head=${JSON.stringify(text.slice(0, 160))}`,
            );
        } catch (e) {
            console.log(`[probe] ${url}\n        ERROR ${e}`);
        }
    }
}

async function main() {
    if (PROBE) {
        await probe();
        return;
    }
    const all = JSON.parse(readFileSync(OUT, "utf8"));
    const byRel = new Map(all.map((c) => [c.relationId, c]));
    const targets = selectCities(all);
    console.log(
        `[adjacents] ${targets.length}/${all.length} cities · radius=${RADIUS_KM}km level=${LEVEL} kinds=${KINDS.join("+")} minStops=${MIN_STOPS} maxAreaRatio=${MAX_AREA_RATIO} minDensity=${MIN_DENSITY} contiguous=${CONTIGUOUS}`,
    );

    let done = 0;
    let saved = 0;
    for (const city of targets) {
        done++;
        const label = `${done}/${targets.length} ${city.name} (r${city.relationId})`;
        try {
            let result = await findAdjacents(city);
            // A "0 stops" result for a real city almost always means the
            // worker's upstream Overpass got rate-limited by a PREVIOUS heavy
            // city (a London-sized 36k-stop query saturates it), not that the
            // city has no transit. The throttle clears with time, but we can't
            // see how long — so ESCALATE the wait (30s, 60s, 90s, …) and retry
            // until stops come back or MAX_COOLDOWNS is hit.
            for (
                let cd = 1;
                cd <= MAX_COOLDOWNS &&
                result.note &&
                result.note.includes("0 stops");
                cd++
            ) {
                const wait = COOLDOWN_MS * cd;
                console.log(
                    `    (0 stops — likely rate-limited by a prior heavy city; cooldown ${Math.round(wait / 1000)}s, retry ${cd}/${MAX_COOLDOWNS})`,
                );
                await sleep(wait);
                result = await findAdjacents(city);
            }
            const { ids, names, note } = result;
            const entry = byRel.get(city.relationId);
            // Bake ONLY a genuine result. A note ("0 stops", "no primary
            // boundary") is a transient FETCH failure — almost always upstream
            // rate-limiting, not a real "this city has no adjacents". Baking []
            // for it would permanently stamp a real transit city as canonically
            // adjacent-less, and — per the no-fallback contract (a baked city
            // never falls back to live admin-adjacency at wizard time) — it'd
            // never self-correct. So leave the field ABSENT on failure: the city
            // stays "not generated", retries on the next run, and falls back to
            // live meanwhile. A SUCCESSFUL run (note===null) is always baked,
            // INCLUDING a genuine empty set (ids===[]) — an empty array is the
            // canonical "no transit-reach neighbours" and is authoritative.
            if (!note) entry.adjacentRelationIds = ids;
            // Print the FULL adjacent list (not a truncated preview) so the
            // whole set is eyeball-checkable right in the terminal — the
            // truncated-at-8 form hid half of a big metro's neighbours.
            const list = names.length ? names.join(", ") : "(none)";
            if (note) {
                console.log(
                    `  ⚠ ${label}: ${ids.length} adjacents — ${note} [${list}]`,
                );
            } else {
                console.log(`  ✓ ${label}: ${ids.length} adjacents [${list}]`);
            }
            // Incremental save every 5 cities so a long run survives a crash.
            if (++saved % 5 === 0) writeFileSync(OUT, JSON.stringify(all, null, 2) + "\n");
        } catch (e) {
            console.warn(`  ✗ ${label}: ${e instanceof Error ? e.message : e}`);
        }
        await sleep(DELAY_MS);
    }

    writeFileSync(OUT, JSON.stringify(all, null, 2) + "\n");
    console.log(`[adjacents] wrote ${OUT} (${done} cities processed)`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
