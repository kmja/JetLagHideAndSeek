#!/usr/bin/env node
/**
 * laptop-prewarm.mjs
 *
 * Runs the cache worker's prewarm queries from THIS machine's IP
 * (residential / VPS / wherever) instead of from the worker's
 * shared Cloudflare-edge IP, and uploads the results to R2 via
 * `POST /admin/store-prewarmed`. Bypasses the per-IP rate-limit
 * ceiling that's been throttling the in-worker cron.
 *
 * Usage:
 *   node scripts/laptop-prewarm.mjs \
 *     --worker https://jlhs-overpass-cache.<sub>.workers.dev \
 *     --secret <ADMIN_SECRET> \
 *     [--max 200] \
 *     [--only-city <relationId|name>] \
 *     [--cold-only] \
 *     [--skip-discover] [--skip-boundaries] [--skip-references] \
 *     [--skip-transit] [--skip-hsr] [--skip-photon] [--skip-adjacent] \
 *     [--skip-one-ring] [--one-ring-top N] [--one-ring-max-per-city N] \
 *     [--tile-packs] [--master-pmtiles URL] [--pmtiles-bin path] \
 *     [--delay-ms 2000]
 *
 * What it does:
 *   0. Discovery (once, first) — drains the bundled candidate
 *      city-NAME backlog into relation ids via /admin/discover, so
 *      the city loop below sees the full ~1300-city list instead of
 *      just the ~170 already resolved. --skip-discover to bypass.
 *   Per city (from /admin/list-cities):
 *     1. Boundary — `relation(N);out geom;` against overpass-api.de,
 *                   upload to R2 if 200 + non-empty.
 *     2. Refs     — per-city unioned `nwr<filter>(bbox)` query the
 *                   worker would issue. Requires the city's `extent`
 *                   (derived locally from the boundary geometry when
 *                   the list doesn't carry one).
 *     3. Transit  — per-city BUS / TRAIN / TRAM colored route
 *                   overlays. Subway + ferry moved to the cron's
 *                   per-country-shard prewarm (v329); bus / train /
 *                   tram stay per-city because their networks are
 *                   too dense to shard reliably under the worker's
 *                   20 MB reduce cap (NYC bus alone is ~91 MB raw;
 *                   German DB train, Tokyo tram networks similar
 *                   scale). The laptop is the PRIMARY warmer for
 *                   these — Node on a workstation has the RAM to
 *                   reduce a 100 MB body the worker rejects.
 *                   Keys off the city's `extent` (bbox query), so
 *                   toggling any of these in that city is an instant
 *                   R2 hit instead of a 5-15 s Overpass round-trip.
 *     4. Photon   — forward search for the city's name + reverse
 *                   geocode at the city's centroid, both hitting our
 *                   /api/photon/{forward,reverse} proxy (v333). One
 *                   call each warms the worker's R2 cache so that
 *                   "search for Stockholm" and "reverse-lookup a
 *                   point near Stockholm centre" are instant for
 *                   every future user. Skipped if the search-box
 *                   query for that exact city is already cached.
 *     4b. Adjacent — the wizard's "extend play area" picker queries
 *                   (topological adjacency, admin-level, adjacent band,
 *                   transit stations, megacity sub-units). Mirrors the
 *                   worker cron; --skip-adjacent to drop (v440).
 *     5. Tile pack — (OPT-IN, --tile-packs) `pmtiles extract` the
 *                   master basemap over the city bbox into a small
 *                   self-contained .pmtiles, upload to
 *                   /admin/store-tile-pack. The client downloads it
 *                   whole and serves city tiles from memory instead
 *                   of thousands of per-tile range requests. Requires
 *                   the pmtiles Go CLI (github.com/protomaps/
 *                   go-pmtiles); skipped with guidance if absent.
 *                   County-scale extents (deepest fitting zoom < 12)
 *                   are skipped — too big for a one-shot pack.
 *   Once, after the city loop:
 *     5. HSR      — one `area["ISO3166-1"=XX]; way[...highspeed=yes]`
 *                   query per country in HSR_COUNTRIES. HSR is an
 *                   inter-city network, so it's keyed by country, not
 *                   city (v214).
 *     6. One-ring — (default on, --skip-one-ring to drop) the adjacent
 *                   admin areas of the top N cities, each processed as a
 *                   FULL play area (same boundary/refs/transit/metro/
 *                   elevation/photon/adjacent-search as a curated city),
 *                   so areas folded in via "Extend play area" are warm.
 *
 * Idempotent + skippable: every query asks the worker
 * (/admin/check-fresh) whether R2 already holds a non-stale entry for
 * that exact query string, and skips the upstream fetch if so. To
 * force a refetch, delete the entry in the R2 dashboard.
 *
 * Pace: defaults to 2 s between Overpass queries; overpass-api.de's
 * usage policy says ≤1 req/s sustained from a single IP, so 2 s is
 * conservative. The script logs every step so you can watch progress.
 *
 * Run continuously: a $5 VPS or a home PC can run this on a loop
 * (cron, systemd timer, `while true; do node …; sleep 1h; done`) to
 * keep R2 warm indefinitely. The script naturally re-checks the
 * city list each run so newly-discovered cities get picked up.
 */

import { execFileSync } from "node:child_process";
import dns from "node:dns";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { gzipSync } from "node:zlib";

// Force IPv4-first DNS resolution. Node 17+ defaults to "verbatim"
// order, which on dual-stack hosts often hands undici the AAAA (IPv6)
// addresses first. If the local network's IPv6 path to Cloudflare is
// broken/blackholed, every `fetch` hangs and dies with
// `AggregateError [ETIMEDOUT]` (4 sub-errors = the 4 IPv6 addrs it
// tried) instead of falling back to IPv4 — even though the IPv4 path
// (and .NET's Invoke-RestMethod) works fine. ipv4first makes undici
// try the A records first, which is what we want for a CDN-fronted
// worker. Safe on IPv4-only and dual-stack-healthy hosts too.
dns.setDefaultResultOrder("ipv4first");

const args = parseArgs(process.argv.slice(2));
if (!args.worker || !args.secret) {
    console.error("usage: --worker URL --secret SECRET [--max N] [--delay-ms 2000]");
    process.exit(1);
}

const WORKER = args.worker.replace(/\/+$/, "");
const SECRET = args.secret;
const MAX_CITIES = args.max ? parseInt(args.max, 10) : Infinity;
// v473: build/warm a SINGLE city on demand instead of the whole list.
// Accepts an OSM relation id (numeric) or a case-insensitive name
// substring. When a numeric id matches no bundled city, we synthesise a
// bare {relationId,name} — processCity fetches its boundary to derive
// the extent, so a one-off tile-pack build needs nothing else. Combine
// with --tile-packs + the --skip-* flags to build just one city's pack.
const ONLY_CITY = args["only-city"] ? String(args["only-city"]) : null;
// v641: `--cold-only` skips cities that are ALREADY warmed (per
// /admin/prewarmed-cities: they have a boundary + an adjacency entry) so a
// full run goes STRAIGHT to un-warmed cities instead of spending most of
// its time re-`check-fresh`ing the popular front of the list (which the
// cron keeps warm). Ignored with --only-city.
const COLD_ONLY = !!args["cold-only"];
// v684: process the world-cities SEED (biggest cities) FIRST, in population
// order, instead of the default shuffle — so the cities you're most likely
// to play (and NA/EU majors) warm before the long auto-discovered tail.
const SEED_FIRST = !!args["seed-first"];
// v693: warm the PLAYER-relevant regions first. The seed is a pure
// population ranking (44% Asia, 20% China), but a US YouTube show's audience
// plays in the US + English-speaking world + Western Europe — so warming
// biggest-population-first stars Chongqing before Manchester. This orders
// the whole city list by region TIER (the list order below = the tiers),
// then by population within each tier, so the stars players actually use
// light up first. Non-listed / unknown-country cities warm last (by
// population). Bare `--priority-regions` uses the default list; pass
// `--priority-regions US,GB,CA,…` to customise the tiers/order.
const DEFAULT_PRIORITY_REGIONS = [
    "US", "CA", "GB", "IE", "AU", "NZ", // English-speaking (the core audience)
    "DE", "FR", "ES", "IT", "NL", "BE", "AT", "CH", "PT", // Western Europe
    "SE", "NO", "DK", "FI", "IS", // Nordics
];
const PRIORITY_REGIONS = (() => {
    const v = args["priority-regions"];
    if (!v) return null;
    if (v === true) return DEFAULT_PRIORITY_REGIONS;
    return String(v)
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter((s) => /^[A-Z]{2}$/.test(s));
})();
// v684: after warming, call POST /admin/verify-city per city so the star
// (`fullyCuratedAt`) is stamped IMMEDIATELY instead of waiting for the cron
// to happen to pick that city. On by default; --skip-verify to drop.
// `--verify-only` skips all warming and just runs the verify pass (useful
// right after a completed warm run to light up the stars).
const DO_VERIFY = !args["skip-verify"];
const VERIFY_ONLY = !!args["verify-only"];
const DELAY_MS = args["delay-ms"] ? parseInt(args["delay-ms"], 10) : 2000;
const DO_BOUNDARIES = !args["skip-boundaries"];
const DO_REFS = !args["skip-references"];
const DO_HSR = !args["skip-hsr"];
const DO_DISCOVER = !args["skip-discover"];
const DO_TRANSIT = !args["skip-transit"];
// v687: warm the named-water GEOMETRY for the measuring body-of-water
// elimination (served by /api/water/<id>). Keyed off the same
// boundary-geometry extent as refs; on by default whenever refs run.
// --skip-water to drop (the client falls back to its live poly query).
const DO_WATER = !args["skip-water"];
const DO_PHOTON = !args["skip-photon"];
// v440: warm the wizard's "extend play area" adjacent-search queries
// per city (topological adjacency, admin-level, adjacent band, transit
// stations, megacity sub-units). Mirrors the worker cron's
// prewarmAdjacentSearchForCity. On by default; --skip-adjacent to drop.
const DO_ADJACENT = !args["skip-adjacent"];
// v360 / v442: one-ring neighbour warming. After the main city loop,
// discover the adjacent admin areas of the top N cities and process each
// as a FULL play area (boundary, refs, transit, metro, elevation, photon,
// adjacent-search) — so an area a seeker folds in via "Extend play area"
// behaves exactly like the primary. v442 made it DEFAULT-ON (it's the
// point of warming adjacent areas) — pass --skip-one-ring to drop it.
// `--one-ring-top=N` bounds the city count (default 100); the city list
// leads with HAND_CURATED majors, so "first N" is a reasonable most-
// played proxy (there's no population field to rank by).
const DO_ONE_RING = !args["skip-one-ring"];
// v696: warm each city COMPLETELY before moving to the next — primary, then
// its adjacent areas (as full play areas), then verify + stamp its star —
// instead of warming ALL primaries first and doing the one-ring pass at the
// end. So NYC + adjacents are fully cached and STARRED before LA starts,
// which is what you want with --priority-regions (player cities light up
// whole, in order). The tail-end one-ring + batch-verify passes are skipped
// (they're now inline per city). Pairs naturally with --priority-regions.
const CITY_COMPLETE = !!args["city-complete"];
const ONE_RING_TOP = args["one-ring-top"]
    ? parseInt(args["one-ring-top"], 10)
    : 100;
// Cap on neighbors warmed per city, so one pathological metro with dozens
// of tiny adjacent municipalities can't dominate the pass.
const ONE_RING_MAX_PER_CITY = args["one-ring-max-per-city"]
    ? parseInt(args["one-ring-max-per-city"], 10)
    : 12;
// Tile packs are OPT-IN (--tile-packs): they require the external
// `pmtiles` Go binary (github.com/protomaps/go-pmtiles), which most
// hosts won't have. The other phases need only Node.
const DO_TILE_PACKS = !!args["tile-packs"];
// Flipped off at startup if the pmtiles binary check fails, so the
// per-city loop skips pack extraction cleanly instead of throwing.
let tilePacksEnabled = DO_TILE_PACKS;
const PMTILES_BIN = args["pmtiles-bin"] || "pmtiles";
// Master archive to extract city packs FROM. Defaults to the current
// self-hosted basemap; override with --master-pmtiles when the
// basemap filename changes (it carries a build date).
const MASTER_PMTILES_URL =
    args["master-pmtiles"] ||
    `${WORKER}/tiles/basemap-z15-20260614.pmtiles`;
// Pack sizing. We extract z0..maxzoom where maxzoom is the deepest
// level whose single-zoom tile count stays under this cap — so tight
// city bboxes get full z15 detail while county-scale Photon extents
// fall back to a coarser (but still one-download) z13/z12 pack.
const TILE_PACK_MAX_TILES = 12000;
const TILE_PACK_MAX_ZOOM = 15;
const TILE_PACK_MIN_ZOOM = 0;
// Matches MAX_STORE_BYTES on the worker — packs over this are rejected
// server-side, so don't bother uploading them.
// v345: raised from 60 MB. Full-z15 major-metro packs (NYC / Tokyo /
// London) run well past 60 MB and loading speed for those cities is
// the priority. Packs over TILE_PACK_SINGLE_SHOT use R2 multipart
// upload (chunked through the worker), so the only ceiling is this.
const TILE_PACK_MAX_BYTES = 150 * 1024 * 1024; // 150 MB
// Packs at/under this upload in one POST; larger go multipart. Kept
// under Cloudflare's ~100 MB inbound request-body limit with headroom,
// and matches the worker's TILE_PACK_SINGLE_SHOT_MAX.
const TILE_PACK_SINGLE_SHOT = 90 * 1024 * 1024; // 90 MB
// R2 multipart parts must be >= 5 MiB (except the last). 25 MB keeps
// the part count low for a 150 MB pack (6 parts) while staying well
// under the single-request limit.
const TILE_PACK_PART_BYTES = 25 * 1024 * 1024; // 25 MB

const UA =
    "jlhs-laptop-prewarm/1.0 (https://github.com/kmja/jetlaghideandseek)";
const OVERPASS = "https://overpass-api.de/api/interpreter";
const OVERPASS_STATUS = "https://overpass-api.de/api/status";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------- Overpass slot coordination ------------------- *
 *
 * The overpass-api.de docs (https://wiki.openstreetmap.org/wiki/
 * Overpass_API/Overpass_QL) describe a SLOT system: each IP gets a
 * small number of concurrent execution slots, and when they're all
 * busy your queries return 429. The /api/status endpoint reports
 * how many slots are currently free AND, when none are, exactly how
 * long until the next one will be.
 *
 * Using it = the difference between "submit, get 429, retry blindly,
 * compound the problem" and "wait the precise interval the server is
 * telling us, never get rate-limited at all." That's the bursts of
 * 429s we were seeing on Vancouver / LA / Chicago — heavy queries
 * (NYC's refs took 62 s) hogged all the slots and the script kept
 * firing while the server was still chewing.
 *
 * Output format (plain text):
 *
 *   Connected as: 1234567890
 *   Current time: 2026-06-13T14:50:00Z
 *   Rate limit: 6
 *   2 slots available now.
 *   Slot available after: 2026-06-13T14:50:10Z, in 10 seconds.
 *   Slot available after: 2026-06-13T14:50:25Z, in 25 seconds.
 *   Currently running queries: ...
 */

async function fetchOverpassStatus() {
    try {
        const resp = await fetch(OVERPASS_STATUS, {
            headers: { "User-Agent": UA },
        });
        if (!resp.ok) return null;
        return await resp.text();
    } catch {
        return null;
    }
}

/** Block until overpass-api.de says we have at least one free slot.
 *  When no slot is free, the status response tells us when the next
 *  one will free; we sleep that long + a 1 s safety pad, then re-check. */
async function waitForSlot(label) {
    let attempts = 0;
    while (true) {
        attempts++;
        const status = await fetchOverpassStatus();
        if (!status) {
            // /api/status itself unreachable — sleep modestly and try
            // the query anyway. Either the server's down (we'll fail
            // gracefully) or this is a transient blip.
            console.log(`  ⏸ ${label} — /api/status unreachable, waiting 10 s`);
            await sleep(10_000);
            return;
        }
        const m = status.match(/(\d+)\s+slots available now/i);
        const available = m ? parseInt(m[1], 10) : 0;
        if (available > 0) {
            if (attempts > 1) {
                console.log(`  ▶ ${label} slot free, going`);
            }
            return;
        }
        // No slot. Find the smallest "in N seconds" wait the server
        // reports across all queued slots — that's when the next one
        // will free. Default to 10 s if parsing fails.
        const waits = [
            ...status.matchAll(/in\s+(\d+)\s+seconds?/gi),
        ].map((m) => parseInt(m[1], 10));
        const nextFreeSec = waits.length > 0 ? Math.min(...waits) : 10;
        console.log(
            `  ⏸ ${label} — 0 slots free, waiting ${nextFreeSec + 1} s`,
        );
        await sleep((nextFreeSec + 1) * 1000);
    }
}

/* ------------------------- Query builders ------------------------- *
 * MUST stay byte-identical to the worker's equivalents (see
 * `singleRelationQuery`, `buildReferenceBboxQuery`, `buildHsrCountryQuery`
 * in overpass-cache/src/index.ts) — the R2 cache key is a hash of
 * the query string. Any whitespace drift and the upload won't match
 * the client's lookup. */

const PAD_KM_REF = 50; // mirrors PAD_KM in worker

// HSR is prewarmed per-COUNTRY (v214), not per-city. EXACT mirror of
// HSR_COUNTRIES in overpass-cache/src/index.ts and
// src/maps/api/playAreaPrefetch.ts — same set, same uppercase
// alpha-2 codes — or the country query the client issues won't hit
// what we upload here.
const HSR_COUNTRIES = [
    "JP",
    "CN",
    "FR",
    "DE",
    "ES",
    "IT",
    "GB",
    "BE",
    "NL",
    "CH",
    "AT",
    "KR",
    "TW",
    "TR",
    "SA",
    "MA",
    "SE",
    // US omitted — the country-wide area query times out at 180 s
    // every run (see HSR_COUNTRIES in overpass-cache/src/index.ts).
    "RU",
    "PL",
    "DK",
    "PT",
    "UZ",
    "NO",
    "FI",
];

// EXACT byte-for-byte mirror of REFERENCE_FAMILY_FILTERS in
// overpass-cache/src/index.ts. Order matters because the R2 cache
// key is a hash of the query string — any reorder produces a key
// the client won't ever hit, so the upload would be wasted.
const REFERENCE_FAMILY_FILTERS = [
    { filter: '["aeroway"="aerodrome"]["iata"]' },
    { filter: '["tourism"="aquarium"]' },
    { filter: '["amenity"="cinema"]' },
    { filter: '["diplomatic"="consulate"]' },
    { filter: '["leisure"="golf_course"]' },
    { filter: '["amenity"="hospital"]' },
    { filter: '["amenity"="library"]' },
    { filter: '["tourism"="museum"]' },
    { filter: '["leisure"="park"]' },
    { filter: '["natural"="peak"]' },
    { filter: '["tourism"="theme_park"]' },
    { filter: '["tourism"="zoo"]' },
    { filter: '["brand:wikidata"="Q259340"]' },
    { filter: '["brand:wikidata"="Q38076"]' },
    { filter: '["railway"="station"]' },
];

function boundaryQuery(relationId) {
    return `[out:json][timeout:120];relation(${relationId});out geom;`;
}

// Per-city transit modes the laptop warms. v334: extended to include
// train + tram, both colored overlays the client toggles (and which the
// cron DOES per-shard prewarm, but DE/JP/CN-scale rail networks blow the
// 20 MB reduce cap there; this script is the reliable fallback). v584:
// the cron also per-shard prewarms BUS now — sparse/medium countries
// warm cleanly at country scope, so this per-city bus pass is the dense-
// country (US/DE/JP) fallback for the same oversize reason. Subway +
// ferry are tiny everywhere and don't need laptop help.
//
// Why per-city for bus/train/tram: every one of these is dense enough
// that a whole-country `out skel geom` overruns the worker's reduce
// buffer. Per-city queries are much smaller (single metro's network)
// and this Node script has GBs of RAM to handle the reduce step the
// worker can't. The route value matches the `route=` selector the
// client passes through; the cache key is the byte-identical bbox
// query so the client's runtime lookup hits R2 directly.
const TRANSIT_ROUTE_TYPES = ["bus", "train", "tram"];

/**
 * Shrink a raw transit Overpass response before storing it, keeping
 * the SAME Overpass JSON shape so the client parser (which already
 * dedupes ways by ref + decimates geometry) reads it unchanged.
 *
 * The raw `out skel geom` response for a dense bus network is huge
 * (NYC ≈ 91 MB) and bloated three ways the overlay doesn't need:
 *   1. Every street way is repeated in each route relation that uses
 *      it. The client only draws each unique way once (dedupe by ref),
 *      so we keep the first occurrence and drop the rest.
 *   2. Full-resolution geometry, when the client decimates to
 *      MAX_VERTICES points per way anyway. We decimate with the same
 *      stride algorithm so prewarmed + on-demand renders are identical.
 *   3. 7-decimal coordinates (~1 cm). 5 decimals (~1 m) is far more
 *      than an overlay line needs.
 *
 * Output: one synthetic relation whose members are the unique
 * decimated ways. The client discards route grouping anyway (it draws
 * each way as a bare LineString with empty properties), so collapsing
 * to a single relation is lossless for the overlay.
 */
const MAX_VERTICES = 50;

function round5(n) {
    return Math.round(n * 1e5) / 1e5;
}

function decimateGeom(geom) {
    const n = geom.length;
    let pts;
    if (n <= MAX_VERTICES) {
        pts = geom;
    } else {
        const stride = Math.ceil(n / MAX_VERTICES);
        pts = [];
        for (let i = 0; i < n; i += stride) pts.push(geom[i]);
        const last = geom[n - 1];
        const tail = pts[pts.length - 1];
        if (tail.lat !== last.lat || tail.lon !== last.lon) pts.push(last);
    }
    return pts.map((p) => ({ lat: round5(p.lat), lon: round5(p.lon) }));
}

function reduceTransitResponse(text) {
    const parsed = JSON.parse(text);
    const seen = new Set();
    const members = [];
    for (const el of parsed.elements || []) {
        if (el.type !== "relation") continue;
        for (const m of el.members || []) {
            if (m.type !== "way") continue;
            if (!Array.isArray(m.geometry) || m.geometry.length < 2) continue;
            if (m.ref !== undefined) {
                if (seen.has(m.ref)) continue;
                seen.add(m.ref);
            }
            members.push({
                type: "way",
                ref: m.ref,
                geometry: decimateGeom(m.geometry),
            });
        }
    }
    const reduced = {
        version: parsed.version,
        generator: parsed.generator,
        osm3s: parsed.osm3s,
        elements: [{ type: "relation", id: 0, tags: {}, members }],
    };
    return { text: JSON.stringify(reduced), wayCount: members.length };
}

/**
 * Byte-for-byte mirror of the single-area branch of
 * `fetchTransitRelations` in src/maps/api/transitRoutes.ts. The R2
 * cache key is a SHA-256 of this exact string, so any whitespace drift
 * and the client's toggle would miss what we store here.
 *
 * v249: switched from `map_to_area` (a single relation -> area, which
 * Overpass silently resolves to an EMPTY area for some city boundary
 * relations — Cleveland's buses returned 0 despite RTA obviously
 * existing) to a bbox query off the city's Photon extent — the same
 * `[bbox]`-style 3-decimal contract the reference families use. The
 * client builds the identical string from `mapGeoLocation.properties
 * .extent`, so this finally warms what the client actually reads (the
 * old map_to_area form keyed a string the client never issued, since
 * the client takes the poly:/bbox path, not map_to_area).
 *
 *   tuple = transitBboxTuple(extent)  // "s,w,n,e", 3-decimal, +5km pad
 *   query = `\n[out:json][timeout:180][bbox:${tuple}];\nrelation["route"="<type>"];\nout skel geom;\n`
 *
 * v329: bbox lives in the `[bbox:...]` global setting (it used to be
 * a per-statement `(${tuple})` filter on the route relation). The new
 * form lets the worker's query canonicaliser strip the bbox and match
 * a stable template fingerprint, which is how every TRANSIT_SHARD_MODES
 * query (subway/ferry/train/tram, and bus since v584) dispatches into
 * the per-shard slicing path on the worker side. A bus query in a dense
 * country whose shard oversize-skipped still resolves via the byte-
 * identical exact-key path this script warms.
 *
 * KEEP IN LOCKSTEP with buildTransitBboxTuple + fetchTransitRelations
 * in src/maps/api/transitRoutes.ts AND transitRouteQuery in
 * overpass-cache/src/index.ts (same pad, same toFixed(3), same
 * whitespace, same setting order).
 */
const TRANSIT_BBOX_PAD_KM = 5;

function transitBboxTuple(extent) {
    // extent is [maxLat, minLng, minLat, maxLng].
    const [maxLat, minLng, minLat, maxLng] = extent;
    const south = minLat;
    const west = minLng;
    const north = maxLat;
    const east = maxLng;
    const latPad = TRANSIT_BBOX_PAD_KM / 111;
    const midLat = (south + north) / 2;
    const lngPad =
        TRANSIT_BBOX_PAD_KM / (111 * Math.cos((midLat * Math.PI) / 180));
    const s = (south - latPad).toFixed(3);
    const w = (west - lngPad).toFixed(3);
    const n = (north + latPad).toFixed(3);
    const e = (east + lngPad).toFixed(3);
    return `${s},${w},${n},${e}`;
}

function transitRouteQuery(extent, routeType) {
    const tuple = transitBboxTuple(extent);
    // v329: bbox in `[bbox:...]` global-setting form (mirrors
    // src/maps/api/transitRoutes.ts + overpass-cache transitRouteQuery)
    // so the worker's query canonicaliser strips it and the per-shard
    // slicing path (subway/ferry) recognises the template fingerprint.
    return `\n[out:json][timeout:180][bbox:${tuple}];\nrelation["route"="${routeType}"];\nout skel geom;\n`;
}

function bboxFilter(extent, padKm) {
    const [maxLat, minLng, minLat, maxLng] = extent;
    const south = minLat;
    const west = minLng;
    const north = maxLat;
    const east = maxLng;
    const latPad = padKm / 111;
    const midLat = (south + north) / 2;
    const lngPad = padKm / (111 * Math.cos((midLat * Math.PI) / 180));
    const s = (south - latPad).toFixed(3);
    const w = (west - lngPad).toFixed(3);
    const n = (north + latPad).toFixed(3);
    const e = (east + lngPad).toFixed(3);
    return `[bbox:${s},${w},${n},${e}]`;
}

function referenceQuery(extent) {
    const bb = bboxFilter(extent, PAD_KM_REF);
    const body = REFERENCE_FAMILY_FILTERS.map(
        ({ filter }) => `nwr${filter};`,
    ).join("\n");
    return `\n[out:json][timeout:120]${bb};\n(\n${body}\n);\nout center;\n`;
}

// v668: hiding-zone STATION field. EXACT byte-for-byte mirror of
// AREA_STATION_FILTERS + buildAreaStationsBboxQuery in
// overpass-cache/src/index.ts (all-mode stop selectors, 2 km pad,
// timeout:180). The R2 key hashes this exact string, and the worker's
// /api/area-stations/<id> read endpoint rebuilds it from the boundary
// extent — so this must match the worker builder, not the client.
const AREA_STATION_FILTERS = [
    "[railway=station][subway=yes]",
    "[station=subway]",
    "[railway=station][subway!=yes]",
    "[railway=halt]",
    "[railway=tram_stop]",
    "[railway=halt][light_rail=yes]",
    "[highway=bus_stop]",
    "[amenity=ferry_terminal]",
    "[public_transport=platform][platform=ferry]",
];
const PAD_KM_STATIONS = 2;
function areaStationsQuery(extent) {
    const bb = bboxFilter(extent, PAD_KM_STATIONS);
    const body = AREA_STATION_FILTERS.map((f) => `nwr${f};`).join("\n");
    return `\n[out:json][timeout:180]${bb};\n(\n${body}\n);\nout center;\n`;
}

// v687: named-water GEOMETRY for the measuring body-of-water elimination.
// EXACT byte-for-byte mirror of WATER_FILTERS + buildWaterBboxQuery in
// overpass-cache/src/index.ts (major named bodies + river/canal
// centrelines, 2 km pad, timeout:180, `out geom`). The R2 key hashes this
// exact string, and the worker's /api/water/<id> read endpoint rebuilds it
// from the boundary extent — so this must match the worker builder.
const WATER_FILTERS = [
    '["natural"="water"]["name"]["water"!~"pond|basin|pool|fountain|wastewater|moat|tank|ditch"]',
    // v690: NO `["name"]` on the line filter (unnamed river/canal segments
    // are still bodies of water). Byte-identical to the worker builder.
    '["waterway"~"^(river|canal)$"]',
];
const PAD_KM_WATER = 2;
function waterQuery(extent) {
    const bb = bboxFilter(extent, PAD_KM_WATER);
    const body = WATER_FILTERS.map((f) => `nwr${f};`).join("\n");
    return `\n[out:json][timeout:180]${bb};\n(\n${body}\n);\nout geom;\n`;
}

// Byte-identical to buildHsrCountryQuery in overpass-cache/src/index.ts
// and src/maps/api/playAreaPrefetch.ts. The R2 key hashes this exact
// string.
function hsrCountryQuery(iso) {
    return `\n[out:json][timeout:180];\narea["ISO3166-1"="${iso}"]["admin_level"="2"]->.hsrArea;\nway["railway"="rail"]["highspeed"="yes"](area.hsrArea);\nout geom;\n`;
}

/* --------------- Adjacent-search queries (v440) -------------------- *
 *
 * The wizard's "extend play area" picker
 * (src/maps/api/playAreaExtensions.ts) fires up to five Overpass
 * queries. Each builder below is BYTE-IDENTICAL to its client
 * counterpart AND to the worker mirror in overpass-cache/src/index.ts —
 * the R2 key is a SHA-256 of the exact string, so any whitespace drift
 * misses the cache. Centroid is the bbox centre (same as the worker
 * cron), keeping laptop + cron writing to identical keys.
 */
const ADJACENT_SEARCH_RADIUS_KM = 25; // == ADJACENT_SEARCH_DEFAULT_RADIUS_KM

function adjacentAdminLevelQuery(osmId) {
    return `\n[out:json][timeout:25];\nrelation(${osmId});\nout tags;\n`;
}
function adjacentTopologicalQuery(osmId) {
    return `\n[out:json][timeout:120];\nrelation(${osmId});\nway(r);\nrel(bw);\nout tags bb;\n`;
}
function adjacentAdminBandQuery(adminLevel, lat, lng, radiusKm) {
    return `\n[out:json][timeout:60];\nrelation["admin_level"="${adminLevel}"]["type"="boundary"](around:${radiusKm * 1000},${lat},${lng});\nout tags bb;\n`;
}
function adjacentStationsQuery(lat, lng, radiusKm) {
    const r = radiusKm * 1000;
    return `\n[out:json][timeout:45];\n(\n  node["station"="subway"](around:${r},${lat},${lng});\n  node["railway"="station"](around:${r},${lat},${lng});\n  node["railway"="halt"](around:${r},${lat},${lng});\n  node["railway"="tram_stop"](around:${r},${lat},${lng});\n  node["amenity"="ferry_terminal"](around:${r},${lat},${lng});\n);\nout;\n`;
}
function adjacentSubUnitsQuery(osmId, level) {
    const areaId = 3600000000 + osmId;
    const levelRegex = `^[${level + 1}${level + 2}]$`;
    return `\n[out:json][timeout:60];\narea(id:${areaId});\nrelation["admin_level"~"${levelRegex}"]["type"="boundary"]["boundary"="administrative"](area);\nout tags bb;\n`;
}

/* ------------------------- Network helpers ------------------------ */

/** True when an Overpass JSON body carries a runtime-error `remark`
 *  (soft timeout / OOM). The remark sits at the END of the body, so the
 *  tail pre-check keeps clean bodies cheap. Mirrors isAbortedOverpassText
 *  in overpass-cache/src/index.ts. */
function isAbortedOverpassText(text) {
    const tail = text.length > 4096 ? text.slice(-4096) : text;
    if (!tail.includes('"remark"')) return false;
    try {
        const parsed = JSON.parse(text);
        return (
            typeof parsed?.remark === "string" &&
            /runtime error|timed out|out of memory/i.test(parsed.remark)
        );
    } catch {
        return false;
    }
}

const FETCH_MAX_ATTEMPTS = 4;

async function fetchOverpass(query, label) {
    // Up to FETCH_MAX_ATTEMPTS attempts. Between attempts we re-check
    // /api/status so a 429 from a transient burst doesn't make us give up
    // immediately — but we don't loop forever either, since a persistent
    // 429/5xx means the server genuinely wants us to back off and the cron
    // / next run will catch this city later.
    for (let attempt = 1; attempt <= FETCH_MAX_ATTEMPTS; attempt++) {
        await waitForSlot(label);
        const t0 = Date.now();
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 180_000);
        try {
            const resp = await fetch(OVERPASS, {
                method: "POST",
                signal: ctrl.signal,
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    "User-Agent": UA,
                },
                body: `data=${encodeURIComponent(query)}`,
            });
            const dur = Date.now() - t0;
            if (resp.status === 429) {
                // Read Retry-After if present, otherwise fall back to
                // waiting for the next free slot via /api/status on
                // the next attempt.
                const ra = parseInt(resp.headers.get("Retry-After") ?? "", 10);
                const waitSec = Number.isFinite(ra) ? ra : 10;
                console.warn(
                    `  ⚠ ${label} 429, retry ${attempt}/${FETCH_MAX_ATTEMPTS} after ${waitSec} s`,
                );
                await sleep(waitSec * 1000);
                continue;
            }
            if (!resp.ok) {
                // 5xx (502/503/504) + Cloudflare 5xx are TRANSIENT gateway/
                // overload responses on a busy mirror — a fast 504 (a few
                // seconds) is the front-end shedding load, NOT a genuine
                // 120 s query timeout. Retry with escalating backoff (the
                // loop re-waits for a slot first). Heavy metros usually
                // succeed on a later attempt when load drops. 4xx other
                // than 429 are permanent (malformed query) → give up.
                if (resp.status >= 500 && attempt < FETCH_MAX_ATTEMPTS) {
                    const waitSec = Math.min(10 * attempt, 40);
                    console.warn(
                        `  ⚠ ${label} overpass ${resp.status} ${resp.statusText} (${dur} ms), retry ${attempt}/${FETCH_MAX_ATTEMPTS} after ${waitSec} s`,
                    );
                    await sleep(waitSec * 1000);
                    continue;
                }
                console.warn(
                    `  ✗ ${label} overpass ${resp.status} ${resp.statusText} (${dur} ms)`,
                );
                return null;
            }
            const text = await resp.text();
            // v668: Overpass soft-fails with HTTP 200 + a runtime-error
            // `remark` + empty/truncated elements when it hits its
            // server-side time/memory limit. Never upload that — it would
            // poison R2 (the exact Chicago hiding-zones failure). Treat it
            // like a failed fetch so the next run retries.
            if (isAbortedOverpassText(text)) {
                console.warn(
                    `  ✗ ${label} overpass soft-timeout (abort remark) — discarding (${dur} ms)`,
                );
                return null;
            }
            return { text, ms: dur };
        } catch (e) {
            const dur = Date.now() - t0;
            console.warn(
                `  ✗ ${label} overpass threw: ${e?.message ?? e} (${dur} ms)`,
            );
            return null;
        } finally {
            clearTimeout(timer);
        }
    }
    console.warn(`  ✗ ${label} gave up after ${FETCH_MAX_ATTEMPTS} attempts`);
    return null;
}

/** Skip uploading any single response larger than this AFTER
 *  reduction. Generous because the streaming worker handles big
 *  bodies fine; this is just a backstop against a pathological case
 *  the reduction couldn't tame. Mirrors the worker's MAX_STORE_BYTES. */
const MAX_UPLOAD_BYTES = 60 * 1024 * 1024; // 60 MB

/**
 * Store a prewarmed Overpass response via the worker's STREAMING
 * protocol (v249-fix): the query + metadata ride in the URL query
 * string and the raw response text is the POST body, streamed straight
 * to R2. The old path JSON-wrapped the body, which made the worker
 * parse + re-stringify tens of MB in heap and blow Cloudflare's 128 MB
 * limit (error 1102) on big transit payloads. `bodyText` is the raw
 * Overpass response string (NOT a parsed object).
 */
async function uploadToWorker({
    query,
    bodyText,
    kind,
    sourceName,
    sourceRelationId,
}) {
    const params = new URLSearchParams();
    params.set("query", query);
    if (kind) params.set("kind", kind);
    if (sourceName) params.set("sourceName", sourceName);
    if (sourceRelationId) params.set("sourceRelationId", String(sourceRelationId));
    // Gzip the body before upload. Three wins:
    //   - 5-10x smaller upload (transit + boundary + HSR all compress
    //     beautifully — they're repetitive JSON),
    //   - 5-10x smaller R2 storage (worker stores the bytes as-is,
    //     tagged encoding=gzip),
    //   - the client's read path serves it with Content-Encoding: gzip
    //     and the browser decompresses, so the worker never has to
    //     touch the body again.
    const rawBytes = Buffer.byteLength(bodyText, "utf8");
    const gz = gzipSync(Buffer.from(bodyText, "utf8"));
    const resp = await fetchRetry(
        `${WORKER}/admin/store-prewarmed?${params.toString()}`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Encoding": "gzip",
                Authorization: `Bearer ${SECRET}`,
            },
            body: gz,
        },
        "store-prewarmed",
    );
    if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(
            `store-prewarmed failed: ${resp.status} ${text.slice(0, 200)}`,
        );
    }
    const j = await resp.json();
    return { ...j, rawBytes, gzipBytes: gz.byteLength };
}

/** Ask the worker to evict a discovered city whose boundary came back
 *  empty (Photon resolved its name to a non-boundary relation). The
 *  name then re-enters the discovery queue for a corrected re-resolve.
 *  Best-effort: a failure here just means the entry sticks around to
 *  be retried next run. */
async function evictDiscovered(city) {
    try {
        const resp = await fetch(`${WORKER}/admin/evict-discovered`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${SECRET}`,
            },
            body: JSON.stringify({ relationId: Number(city.relationId) }),
        });
        if (!resp.ok) return;
        const data = await resp.json().catch(() => null);
        if (data?.removed) {
            console.log(`  ⌫ evicted discovered entry r${city.relationId}`);
        }
    } catch {
        /* best-effort */
    }
}

/** Drop a specific cached Overpass query from R2 so the next fetch goes
 *  back to upstream. Used when the cached response turns out to be
 *  unusable (e.g. a boundary that came back with no derivable geometry,
 *  so refs/transit have nothing to key off). Returns true on a clean
 *  eviction so the caller can decide whether to re-fetch this run. */
async function evictCachedQuery(query, label) {
    try {
        const resp = await fetch(`${WORKER}/admin/evict-query`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${SECRET}`,
            },
            body: JSON.stringify({ query }),
        });
        if (!resp.ok) {
            console.warn(`  ✗ evict-query (${label}) HTTP ${resp.status}`);
            return false;
        }
        return true;
    } catch (e) {
        console.warn(`  ✗ evict-query (${label}) ${e?.message ?? e}`);
        return false;
    }
}

/** Fetch an already-cached Overpass response through the worker's
 *  public endpoint. Used only after `isFresh` returns true, so this
 *  always hits R2 (no upstream traffic). Returns parsed JSON or null
 *  on any error. We need the parsed body to derive a fallback extent
 *  from the boundary geometry for cities that ship without one. */
async function fetchCached(query) {
    try {
        const resp = await fetch(`${WORKER}/api/interpreter`, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "User-Agent": UA,
            },
            body: `data=${encodeURIComponent(query)}`,
        });
        if (!resp.ok) return null;
        return await resp.json();
    } catch {
        return null;
    }
}

/** Ask the worker whether a given Overpass query is already cached
 *  and within TTL. Returns true if we should SKIP the upstream fetch.
 *  Treats network errors as "not fresh" so a worker hiccup never
 *  silently turns the run into a no-op.
 *
 *  Logs every check so a run where the endpoint isn't deployed (404)
 *  or where R2 unexpectedly returns nothing is visible at a glance —
 *  otherwise the script would just silently re-fetch everything. */
async function isFresh(query, label) {
    let resp;
    try {
        resp = await fetch(`${WORKER}/admin/check-fresh`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${SECRET}`,
            },
            body: JSON.stringify({ query }),
        });
    } catch (e) {
        console.log(`  · check-fresh ${label} threw: ${e?.message ?? e}`);
        return false;
    }
    if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        console.log(
            `  · check-fresh ${label} HTTP ${resp.status} ${resp.statusText}${text ? ` — ${text.slice(0, 120)}` : ""}`,
        );
        return false;
    }
    let data;
    try {
        data = await resp.json();
    } catch {
        console.log(`  · check-fresh ${label} returned non-JSON`);
        return false;
    }
    if (!data?.fresh) {
        const ageH =
            typeof data?.ageMs === "number"
                ? Math.round(data.ageMs / 3_600_000)
                : null;
        console.log(
            `  · check-fresh ${label}: exists=${data?.exists ?? false}${ageH != null ? ` ageH=${ageH}` : ""}`,
        );
    }
    return Boolean(data?.fresh);
}

/**
 * v365: GET-with-skip-sleep warmer for the photon endpoints. Photon
 * entries live in their own edge-cache/R2 namespace (no canonical
 * Overpass-style "is fresh" route), so `isFresh` doesn't cover them.
 *
 * v364 tried a HEAD probe, but `handlePhoton` rejects non-GET (returns
 * 405), so the probe never reported a hit and we fell through to GET +
 * the 2 s DELAY_MS sleep anyway — the loop still "stopped" on every
 * fully-warmed city. The actual waste was the politeness SLEEP, not the
 * GET (a cache hit returns in ~1 ms, KB-sized). So: always GET, read the
 * X-Cache header, and SKIP the sleep when it's a hit — nothing went
 * upstream, so there's nothing to be polite about. A real MISS (upstream
 * Photon fetch) still pays the sleep.
 */
async function warmPhoton(url, label) {
    try {
        const r = await fetchRetry(url, { method: "GET" }, label);
        if (r.ok) {
            const xc = r.headers.get("X-Cache") ?? "?";
            if (/HIT/i.test(xc)) {
                console.log(`  ⤼ ${label} already cached (${xc}) — skipping`);
                return; // no upstream fetch → no politeness sleep
            }
            console.log(`  ✓ ${label} (${xc})`);
        } else {
            console.warn(`  ✗ ${label} status ${r.status}`);
        }
    } catch (e) {
        console.warn(`  ✗ ${label}: ${e.message}`);
    }
    await sleep(DELAY_MS);
}

/** fetch() with retry on transient network failures (ETIMEDOUT, DNS,
 *  connection resets). The worker control-plane calls (list-cities,
 *  discover) used to throw straight to a "fatal:" and kill the whole
 *  pass on a single blip — a momentary IPv6 hiccup or Cloudflare edge
 *  reset shouldn't cost an hour's wait for the next loop iteration.
 *  Retries up to `attempts` times with exponential backoff. Only
 *  catches THROWN errors (network layer); a non-ok HTTP response is
 *  returned as-is for the caller to handle. */
async function fetchRetry(url, init, label, attempts = 4) {
    let lastErr;
    for (let i = 1; i <= attempts; i++) {
        try {
            return await fetch(url, init);
        } catch (e) {
            lastErr = e;
            const backoff = Math.min(2000 * 2 ** (i - 1), 16000);
            console.warn(
                `  ⚠ ${label} network error (${e?.cause?.code ?? e?.message ?? e}); retry ${i}/${attempts} in ${backoff} ms`,
            );
            if (i < attempts) await sleep(backoff);
        }
    }
    throw lastErr;
}

async function listCities() {
    const resp = await fetchRetry(
        `${WORKER}/admin/list-cities`,
        { headers: { Authorization: `Bearer ${SECRET}` } },
        "list-cities",
    );
    if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`list-cities failed: ${resp.status} ${text}`);
    }
    const data = await resp.json();
    return data.cities ?? [];
}

/** v684: the ordered seed relation ids (biggest cities, population-desc)
 *  from the public /api/seed-cities. Used by --seed-first to warm the
 *  cities you actually play before the auto-discovered tail. Empty on
 *  failure (→ seed-first degrades to the default order). */
async function fetchSeedIds() {
    try {
        const resp = await fetchRetry(
            `${WORKER}/api/seed-cities`,
            {},
            "seed-cities",
        );
        if (!resp.ok) return [];
        const data = await resp.json();
        return Array.isArray(data.ids) ? data.ids : [];
    } catch {
        return [];
    }
}

/** Reorder the city list so seed cities come FIRST, in seed (population)
 *  order, then everything else in its existing order. */
function orderSeedFirst(cities, seedIds) {
    if (seedIds.length === 0) return cities;
    const byId = new Map(cities.map((c) => [c.relationId, c]));
    const seen = new Set();
    const out = [];
    for (const id of seedIds) {
        const c = byId.get(id);
        if (c) {
            out.push(c);
            seen.add(id);
        }
    }
    for (const c of cities) {
        if (!seen.has(c.relationId)) out.push(c);
    }
    return out;
}

/** v693: order the city list by PRIORITY-REGION tier (list index), then by
 *  population within each tier. A city whose `country` isn't in the list (or
 *  is unknown) sorts last, by population. So `US,GB,…` warms every US city
 *  (biggest first), then every UK city, …, then the rest. Requires the seed
 *  to carry `country` (baked by the generator / backfilled). */
function orderByPriorityRegions(cities, regions) {
    const rank = new Map(regions.map((c, i) => [c, i]));
    const rankOf = (c) =>
        c.country && rank.has(c.country) ? rank.get(c.country) : Infinity;
    return [...cities].sort(
        (a, b) =>
            rankOf(a) - rankOf(b) ||
            (b.population ?? -1) - (a.population ?? -1),
    );
}

/** v684: ask the worker to verify + stamp one city's star
 *  (fullyCuratedAt) NOW. Read-only R2 HEADs server-side (no Overpass), so
 *  it's cheap and safe to call right after warming. Returns the result or
 *  null on failure. */
async function verifyCity(relationId) {
    try {
        const resp = await fetchRetry(
            `${WORKER}/admin/verify-city`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${SECRET}`,
                },
                body: JSON.stringify({ relationId }),
            },
            "verify-city",
        );
        if (!resp.ok) return null;
        return await resp.json();
    } catch {
        return null;
    }
}

/** Run the verify pass over a list of cities: stamp the star for every one
 *  that's fully cached (primary + adjacents). No Overpass, so it's fast. */
async function verifyStars(cities) {
    console.log(`=== verifying stars for ${cities.length} cities ===`);
    let starred = 0;
    for (let i = 0; i < cities.length; i++) {
        const c = cities[i];
        const v = await verifyCity(c.relationId);
        if (v?.fullyCurated) {
            starred++;
            if (v.stamped) {
                console.log(`  ★ ${c.name} — fully cached (stamped)`);
            }
        }
        if ((i + 1) % 50 === 0) {
            console.log(
                `  … verified ${i + 1}/${cities.length} (${starred} starred so far)`,
            );
        }
        await sleep(80); // gentle on the worker; these are R2-only ops
    }
    console.log(`=== verify done — ${starred}/${cities.length} fully cached ===`);
}

/**
 * v641: the set of relation ids the worker considers ALREADY WARMED — a
 * city with both a `boundary` entry and at least one `adjacent-*` entry in
 * R2 (per /admin/prewarmed-cities). Used by --cold-only to skip these and
 * process only un-warmed cities. Returns an empty set on any failure (so
 * cold-only degrades to "process everything"). Note the endpoint is bounded
 * + may report `truncated:true` on a huge cache — then some warm cities
 * won't be in the set and get re-checked, which is harmless.
 */
async function fetchWarmedRelationIds() {
    try {
        const resp = await fetchRetry(
            `${WORKER}/admin/prewarmed-cities`,
            { headers: { Authorization: `Bearer ${SECRET}` } },
            "prewarmed-cities",
        );
        if (!resp.ok) return new Set();
        const data = await resp.json();
        if (data.truncated) {
            console.warn(
                `  ! prewarmed-cities truncated (scanned ${data.scanned}); some warm cities may be re-checked`,
            );
        }
        const warm = new Set();
        for (const c of data.cities ?? []) {
            const kinds = c.kinds ?? [];
            const hasBoundary = kinds.includes("boundary");
            const hasAdjacency = kinds.some(
                (k) => typeof k === "string" && k.startsWith("adjacent-"),
            );
            if (hasBoundary && hasAdjacency) warm.add(String(c.relationId));
        }
        return warm;
    } catch (e) {
        console.warn(`  ! prewarmed-cities lookup failed: ${e?.message ?? e}`);
        return new Set();
    }
}

/**
 * v640: backfill a city's canonical `extent` via the worker when it's
 * missing. The worker derives it with `bboxFromRelation` (polygons.osm.fr,
 * the same source the cron uses) and stores it in the discovered-cities
 * doc, so this becomes the ONE value the cron + client `/api/relation-extent`
 * read for the adjacency `around:` keys. Mutates `city.extent` on success.
 * Best-effort: logs + returns on any failure (the caller's boundary-derived
 * fallback still covers references).
 */
async function ensureCityExtent(city) {
    if (city.extent || !city.relationId) return;
    try {
        const resp = await fetch(`${WORKER}/admin/store-city-extent`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${SECRET}`,
            },
            body: JSON.stringify({
                name: city.name,
                relationId: city.relationId,
            }),
        });
        if (!resp.ok) {
            const text = await resp.text().catch(() => "");
            console.warn(
                `  ✗ extent backfill r${city.relationId}: ${resp.status} ${text}`,
            );
            return;
        }
        const data = await resp.json().catch(() => null);
        if (
            Array.isArray(data?.extent) &&
            data.extent.length === 4 &&
            data.extent.every((n) => typeof n === "number" && isFinite(n))
        ) {
            city.extent = data.extent;
            console.log(
                `  ✓ extent backfilled + stored: [${data.extent
                    .map((n) => n.toFixed(3))
                    .join(", ")}]`,
            );
        }
    } catch (e) {
        console.warn(
            `  ✗ extent backfill r${city.relationId} threw: ${e?.message ?? e}`,
        );
    }
}

/* ----------------------------- Main ------------------------------ */

async function processCity(city) {
    console.log(`[${city.name}] r${city.relationId}`);

    // v640: if this city has no canonical `extent` yet, backfill it NOW via
    // the worker (POST /admin/store-city-extent → bboxFromRelation → stored)
    // instead of waiting on the cron's ~5-per-tick pass. This is the ONE
    // canonical `city.extent` the cron + client `/api/relation-extent` read
    // for the adjacent-area `around:` keys, so filling it here lets this
    // same run warm adjacency under keys the client will actually hit.
    // Mutates `city.extent` on success; no-op if already present or on
    // failure (the boundary-derived fallback below still covers refs).
    await ensureCityExtent(city);

    // Most bundled HAND_CURATED / BULK_CITIES entries ship without an
    // extent — only cities the worker's cron has already backfilled
    // carry one. But we don't need to wait for the backfill: the
    // boundary query we're about to run returns the full polygon
    // geometry, and the bbox of that geometry IS the extent. So we
    // fetch the boundary first, then derive a fallback extent locally
    // from its members[].geometry coords, then use that for the
    // reference query below. End result: every city the laptop script
    // touches gets boundary + refs primed, not just the ~10 % that
    // happen to have a server-side extent already. (HSR is no longer
    // per-city — see processHsrCountries.)
    let effectiveExtent = city.extent ?? null;
    // v356: the REFERENCE query must key off the boundary-geometry
    // min/max — NOT the server-side / Photon `city.extent` — because
    // that's the canonical extent the client now uses too
    // (`referenceExtent` in src/maps/api/playAreaPrefetch.ts). Photon's
    // extent and the polygon's true min/max differ in the 3rd decimal,
    // so a refs entry warmed under `city.extent` would miss the client's
    // boundary-extent lookup (the Frankfurt cascade). We always derive
    // `boundaryExtent` from the boundary geometry below and use it for
    // refs, falling back to `effectiveExtent` only if derivation fails.
    // Transit/elevation still ride `effectiveExtent` for now — they have
    // the same latent mismatch, tracked separately.
    let boundaryExtent = null;

    if (DO_BOUNDARIES) {
        const q = boundaryQuery(city.relationId);
        let needFreshFetch = !(await isFresh(q, "boundary"));
        if (!needFreshFetch) {
            console.log(`  ⤼ boundary already cached — checking geometry`);
            // Pull the extent from the cached boundary so refs (and,
            // as a fallback, transit) can run. We don't download it from
            // upstream — we have it in R2 — but the laptop script doesn't
            // have a direct R2 read path. Easiest: hit the public
            // /api/interpreter, which serves from R2 in <10 ms on a hit,
            // and parse the geometry locally. No upstream traffic, no
            // rate-limit cost.
            const cached = await fetchCached(q);
            if (!cached) {
                console.warn(
                    `  ⚠ /api/interpreter returned no body for cached boundary — re-fetching`,
                );
                needFreshFetch = true;
            } else {
                const derived = extentFromBoundaryResponse(cached);
                if (derived) {
                    boundaryExtent = derived;
                    if (!effectiveExtent) effectiveExtent = derived;
                    console.log(
                        `  ⌐ extent derived from cached boundary geom`,
                    );
                } else {
                    // The cached body has no usable geometry — most
                    // likely Overpass once returned a relation header
                    // with no member ways, and we stored it. Drop the
                    // bad entry and re-fetch this run so refs/transit
                    // get a working extent instead of silently being
                    // skipped every time.
                    console.warn(
                        `  ⚠ cached boundary has no derivable geometry — evicting and re-fetching`,
                    );
                    await evictCachedQuery(q, "boundary");
                    needFreshFetch = true;
                }
            }
        }
        if (needFreshFetch) {
            const res = await fetchOverpass(q, "boundary");
            if (res) {
                const parsed = safeJSON(res.text);
                const hasElements =
                    parsed &&
                    Array.isArray(parsed.elements) &&
                    parsed.elements.length > 0;
                const derived = hasElements
                    ? extentFromBoundaryResponse(parsed)
                    : null;
                if (hasElements && derived) {
                    try {
                        const r = await uploadToWorker({
                            query: q,
                            bodyText: res.text,
                            kind: "boundary",
                            sourceName: city.name,
                            sourceRelationId: String(city.relationId),
                        });
                        console.log(
                            `  ✓ boundary stored (${r.rawBytes} B raw → ${r.gzipBytes} B gz in ${res.ms} ms)`,
                        );
                    } catch (e) {
                        console.warn(`  ✗ boundary upload: ${e.message}`);
                    }
                    boundaryExtent = derived;
                    if (!effectiveExtent) effectiveExtent = derived;
                    console.log(
                        `  ⌐ extent derived from boundary geom: [${derived.map((n) => n.toFixed(3)).join(", ")}]`,
                    );
                } else if (hasElements && !derived) {
                    // Upstream returned the relation but no member
                    // geometry came along — usually a city whose OSM
                    // relation has no `way` members (just a centre
                    // node, or only sub-relations). Caching this would
                    // poison future runs (we'd hit the "no geometry"
                    // branch above every time), so DROP it on the floor
                    // and warn — the operator can revisit the city's
                    // relation id by hand.
                    console.warn(
                        `  ⚠ boundary response has no derivable geometry — NOT caching, refs/transit will skip`,
                    );
                } else {
                    console.warn(`  ⚠ boundary response empty / unparseable`);
                    // An empty boundary from a non-bundled (discovered)
                    // city means Photon resolved its name to a
                    // non-boundary relation. Evict it so the name returns
                    // to the discovery queue and gets re-resolved
                    // correctly. Bundled cities (HAND_CURATED / BULK)
                    // aren't in the discovered doc, so evicting them is a
                    // harmless no-op (removed:false).
                    await evictDiscovered(city);
                }
                await sleep(DELAY_MS);
            }
        }
    }

    // v356: refs key off the boundary-geometry extent (canonical), with
    // effectiveExtent as a last-resort fallback if boundary derivation
    // failed entirely.
    const refExtent = boundaryExtent ?? effectiveExtent;
    if (!refExtent && DO_REFS) {
        console.log(`  ⤼ no extent available — skipping refs`);
    }

    if (refExtent && DO_REFS) {
        const q = referenceQuery(refExtent);
        if (await isFresh(q, "refs")) {
            console.log(`  ⤼ refs already cached — skipping`);
        } else {
        const res = await fetchOverpass(q, "references");
        if (res) {
            const parsed = safeJSON(res.text);
            if (parsed) {
                try {
                    const r = await uploadToWorker({
                        query: q,
                        bodyText: res.text,
                        kind: "references",
                        sourceName: city.name,
                        sourceRelationId: String(city.relationId),
                    });
                    console.log(
                        `  ✓ refs stored (${r.rawBytes} B raw → ${r.gzipBytes} B gz in ${res.ms} ms, ${parsed.elements?.length ?? 0} elements)`,
                    );
                } catch (e) {
                    console.warn(`  ✗ refs upload: ${e.message}`);
                }
            }
            await sleep(DELAY_MS);
        }
        }
    }

    // v668: hiding-zone STATION field — the hider's "Hiding zones"
    // overlay + zone-containment lookups read /api/area-stations/<id>,
    // which keys off the SAME boundary-geometry extent as refs. Warming
    // it here means a starred city's stations paint from R2 with zero
    // live Overpass (the Chicago "loaded-but-empty" fix). On by default
    // whenever refs run; the bus-heavy body shares the 180 s timeout +
    // pacing, and a failure just leaves it to the on-tap client fetch.
    if (refExtent && DO_REFS) {
        const q = areaStationsQuery(refExtent);
        if (await isFresh(q, "stations")) {
            console.log(`  ⤼ stations already cached — skipping`);
        } else {
            const res = await fetchOverpass(q, "stations");
            if (res) {
                const parsed = safeJSON(res.text);
                if (parsed) {
                    try {
                        const r = await uploadToWorker({
                            query: q,
                            bodyText: res.text,
                            kind: "area-stations",
                            sourceName: city.name,
                            sourceRelationId: String(city.relationId),
                        });
                        console.log(
                            `  ✓ stations stored (${r.rawBytes} B raw → ${r.gzipBytes} B gz in ${res.ms} ms, ${parsed.elements?.length ?? 0} elements)`,
                        );
                    } catch (e) {
                        console.warn(`  ✗ stations upload: ${e.message}`);
                    }
                }
                await sleep(DELAY_MS);
            }
        }
    }

    // v687: named-water GEOMETRY — the measuring body-of-water elimination
    // reads /api/water/<id>, keyed off the SAME boundary-geometry extent as
    // refs/stations. Warming it here means a starred city's water question
    // cuts from R2 with zero live Overpass — the heavy `out geom`
    // water scan was the last per-question-type live hole (it soft-timed-out
    // on dense metros like Paris). On by default whenever refs run; a
    // failure just leaves it to the on-tap client fetch.
    if (refExtent && DO_REFS && DO_WATER) {
        const q = waterQuery(refExtent);
        if (await isFresh(q, "water")) {
            console.log(`  ⤼ water already cached — skipping`);
        } else {
            const res = await fetchOverpass(q, "water");
            if (res) {
                const parsed = safeJSON(res.text);
                if (parsed) {
                    try {
                        const r = await uploadToWorker({
                            query: q,
                            bodyText: res.text,
                            kind: "water",
                            sourceName: city.name,
                            sourceRelationId: String(city.relationId),
                        });
                        console.log(
                            `  ✓ water stored (${r.rawBytes} B raw → ${r.gzipBytes} B gz in ${res.ms} ms, ${parsed.elements?.length ?? 0} elements)`,
                        );
                    } catch (e) {
                        console.warn(`  ✗ water upload: ${e.message}`);
                    }
                }
                await sleep(DELAY_MS);
            }
        }
    }

    // Per-city BUS overlay (v329: subway + ferry are the cron's
    // per-shard job now — see TRANSIT_ROUTE_TYPES). v249: keyed off the
    // city's bbox via the `[bbox:...]` form (NOT map_to_area, which
    // silently returned an empty area for some boundary relations —
    // Cleveland's buses came back 0). v357: prefer the boundary-geometry
    // extent (canonical, what the client now uses too) — Photon's extent
    // and the polygon's true min/max differ in the 3rd decimal, so a
    // Photon-keyed transit cache missed the client's lookup by one
    // digit. Big metros' bus networks are heavy (out skel geom over
    // thousands of routes), exactly why this lives on the laptop and
    // not the Worker — so they share the same waitForSlot + 180 s
    // timeout + DELAY_MS pacing as everything else. A failure
    // (timeout / empty) just leaves it for the on-tap client fetch.
    const transitExtent = boundaryExtent ?? effectiveExtent;
    if (DO_TRANSIT && !transitExtent) {
        console.log(`  ⤼ no extent available — skipping transit`);
    }
    if (DO_TRANSIT && transitExtent) {
        for (const routeType of TRANSIT_ROUTE_TYPES) {
            const q = transitRouteQuery(transitExtent, routeType);
            if (await isFresh(q, `transit ${routeType}`)) {
                console.log(`  ⤼ transit ${routeType} already cached — skipping`);
                continue;
            }
            const res = await fetchOverpass(q, `transit ${routeType}`);
            if (!res) continue;
            // Reduce (dedupe ways + decimate + round coords) before
            // storing so a dense network (NYC bus ≈ 91 MB raw) shrinks
            // to something the worker stores and the client can parse.
            const rawBytes = Buffer.byteLength(res.text, "utf8");
            let reduced;
            try {
                reduced = reduceTransitResponse(res.text);
            } catch (e) {
                console.warn(
                    `  ✗ transit ${routeType} reduce failed: ${e.message}`,
                );
                await sleep(DELAY_MS);
                continue;
            }
            const redBytes = Buffer.byteLength(reduced.text, "utf8");
            if (redBytes > MAX_UPLOAD_BYTES) {
                console.log(
                    `  ⤼ transit ${routeType} still ${redBytes} B after reduce (raw ${rawBytes}) — skipping`,
                );
                await sleep(DELAY_MS);
                continue;
            }
            try {
                const r = await uploadToWorker({
                    query: q,
                    bodyText: reduced.text,
                    kind: "transit",
                    sourceName: `${city.name} (${routeType})`,
                    sourceRelationId: String(city.relationId),
                });
                const reducePct =
                    rawBytes > 0
                        ? Math.round((100 * redBytes) / rawBytes)
                        : 100;
                console.log(
                    `  ✓ transit ${routeType} stored (raw ${rawBytes} B → reduced ${redBytes} B (${reducePct}%) → gz ${r.gzipBytes} B, ${reduced.wayCount} ways, ${res.ms} ms)`,
                );
            } catch (e) {
                console.warn(`  ✗ transit ${routeType} upload: ${e.message}`);
            }
            await sleep(DELAY_MS);
        }
    }

    // v334: per-city Photon warm-up. One forward search for the
    // city's name + one reverse geocode at its centroid. Both hit
    // OUR worker's /api/photon/{forward,reverse} proxy (NOT
    // photon.komoot.io directly), so the response lands in R2 and
    // every subsequent identical request is an instant cache hit.
    // Cheap — Photon responses are kilobytes — and unblocks the
    // single most-clicked play-area picker flows. Pacing is the same
    // DELAY_MS as everything else so this can't trip Photon's own
    // rate limit either.
    if (DO_PHOTON) {
        const lat = effectiveExtent
            ? (effectiveExtent[0] + effectiveExtent[2]) / 2
            : null;
        const lng = effectiveExtent
            ? (effectiveExtent[1] + effectiveExtent[3]) / 2
            : null;
        // v364: do a HEAD first and short-circuit on a cache hit. Without
        // this, every fully-warmed city still paid GET round trip + the
        // DELAY_MS pacing sleep (≈ 4 s/city wasted on the photon pass).
        // The HEAD itself is cheap and goes through the same edge/R2 path,
        // so a HIT here returns in ~1 ms; only an upstream-bound GET pays
        // the politeness sleep.
        await warmPhoton(
            `${WORKER}/api/photon/forward?lang=en&q=${encodeURIComponent(city.name)}`,
            `photon-forward "${city.name}"`,
        );
        if (lat !== null && lng !== null) {
            const lat4 = lat.toFixed(4);
            const lng4 = lng.toFixed(4);
            await warmPhoton(
                `${WORKER}/api/photon/reverse?lat=${lat4}&lon=${lng4}&lang=en`,
                `photon-reverse ${lat4},${lng4}`,
            );
        }
    }

    // v336: per-city tile pack. Heavy + needs the external pmtiles
    // binary, so it's opt-in (--tile-packs) and runs last per city.
    // Uses the resolved effectiveExtent (derived from boundary geometry
    // when the city list didn't carry one), same as refs/transit.
    if (tilePacksEnabled) {
        await processTilePack(city, effectiveExtent);
    }

    // v342: per-city elevation tiles (for sea-level questions). Just a
    // few GET requests through the worker's /api/elevation proxy — the
    // first request stores the Terrarium tile in R2, so this primes the
    // play area's DEM coverage. Cheap (no decode here, the worker just
    // moves bytes), so it's on by default whenever references run.
    if (DO_REFS) {
        await processElevation(effectiveExtent);
    }

    // v343: metro-line tentacle routes (Large games per rulebook p38).
    // Single bbox-scoped query for relation[route=subway][name] over the
    // play area; result is the candidate set for every metro tentacle
    // question asked in this city. Goes through the standard
    // /admin/store-prewarmed pipeline alongside refs / transit / HSR.
    if (DO_TRANSIT) {
        // v357: boundary-geometry extent (matches client's
        // `referenceExtent` in src/maps/api/playAreaPrefetch.ts).
        await processMetroRoutes(city, boundaryExtent ?? effectiveExtent);
    }

    // v440: warm the wizard's "extend play area" adjacent-search queries
    // (topological adjacency, admin-level, band, stations, sub-units).
    // v640: adjacency keys off the canonical `city.extent` (bboxFromRelation)
    // — the SAME value the cron and the client's `/api/relation-extent` use,
    // NOT the boundary-geometry extent references key off. `ensureCityExtent`
    // above has filled it when possible; fall back to the boundary extent
    // only if the backfill couldn't produce one (a live miss either way).
    if (DO_ADJACENT) {
        await processAdjacentSearch(
            city,
            city.extent ?? boundaryExtent ?? effectiveExtent,
        );
    }

    // HSR is no longer per-city — see processHsrCountries(), run once
    // after the whole city loop.
}

/* ──────────────── Adjacent-search prewarm (v440) ─────────────────── *
 *
 * Warms the up-to-five Overpass queries the wizard's "extend play area"
 * picker fires, so that step is instant for any city this loop covers.
 * Mirrors prewarmAdjacentSearchForCity in overpass-cache/src/index.ts;
 * the relation-keyed queries (topological, admin-level, sub-units) are
 * the most valuable since their cache key is stable regardless of
 * centroid rounding.
 */
async function processAdjacentSearch(city, extent) {
    if (!extent) {
        console.log(`  ⤼ no extent available — skipping adjacent-search`);
        return;
    }
    // Photon extent shape: [maxLat, minLng, minLat, maxLng]. Bbox centre
    // matches the worker cron so both write identical centroid-keyed keys.
    const [maxLat, minLng, minLat, maxLng] = extent;
    const lat = (maxLat + minLat) / 2;
    const lng = (minLng + maxLng) / 2;
    const radius = ADJACENT_SEARCH_RADIUS_KM;

    // Warm one query: skip if R2 already fresh, else fetch + upload.
    const warm = async (q, label, kind) => {
        if (await isFresh(q, label)) {
            console.log(`  ⤼ ${label} already cached — skipping`);
            return;
        }
        const res = await fetchOverpass(q, label);
        if (!res) return;
        try {
            await uploadToWorker({
                query: q,
                bodyText: res.text,
                kind,
                sourceName: city.name,
                sourceRelationId: String(city.relationId),
            });
            console.log(`  ✓ ${label} stored (${res.ms} ms)`);
        } catch (e) {
            console.warn(`  ✗ ${label} upload: ${e.message}`);
        }
        await sleep(DELAY_MS);
    };

    // 0. Topological adjacency — the primary pass; relation-keyed.
    await warm(
        adjacentTopologicalQuery(city.relationId),
        "adjacent topological",
        "adjacent-topological",
    );

    // 1. Admin-level lookup — yields the level for queries 2 and 4.
    let adminLevel = null;
    const alq = adjacentAdminLevelQuery(city.relationId);
    if (await isFresh(alq, "adjacent admin-level")) {
        console.log(`  ⤼ adjacent admin-level already cached — skipping`);
        const cached = await fetchCached(alq);
        adminLevel = cached?.elements?.[0]?.tags?.admin_level ?? null;
    } else {
        const res = await fetchOverpass(alq, "adjacent admin-level");
        if (res) {
            adminLevel =
                safeJSON(res.text)?.elements?.[0]?.tags?.admin_level ?? null;
            try {
                await uploadToWorker({
                    query: alq,
                    bodyText: res.text,
                    kind: "adjacent-admin-level",
                    sourceName: city.name,
                    sourceRelationId: String(city.relationId),
                });
                console.log(
                    `  ✓ adjacent admin-level stored (level ${adminLevel ?? "?"}, ${res.ms} ms)`,
                );
            } catch (e) {
                console.warn(`  ✗ adjacent admin-level upload: ${e.message}`);
            }
            await sleep(DELAY_MS);
        }
    }

    // 2. Adjacent admin band — same-level peers within radius.
    if (adminLevel) {
        await warm(
            adjacentAdminBandQuery(adminLevel, lat, lng, radius),
            "adjacent band",
            "adjacent-admin",
        );
    }

    // 3. Adjacent transit stations (all modes, 25 km).
    await warm(
        adjacentStationsQuery(lat, lng, radius),
        "adjacent stations",
        "adjacent-stations",
    );

    // 4. Megacity sub-units (boroughs) — admin_level ≤ 5 only, matching
    //    the client gate in findExtensionCandidates.
    if (adminLevel) {
        const lvl = parseInt(adminLevel, 10);
        if (Number.isFinite(lvl) && lvl <= 5) {
            await warm(
                adjacentSubUnitsQuery(city.relationId, lvl),
                "adjacent sub-units",
                "adjacent-subunits",
            );
        }
    }
}

/* ───────────────────── Elevation prewarm (v342) ─────────────────────── *
 *
 * The sea-level measuring question decodes Terrarium elevation tiles
 * over the play-area bbox at z11. Warming = GET each covering tile
 * through the worker proxy once, which stores it in R2. Mirrors the
 * client's ELEVATION_ZOOM / coverage math in src/maps/api/elevation.ts.
 */
const ELEVATION_ZOOM = 11;
const ELEVATION_MAX_TILES = 36;

async function processElevation(extent) {
    if (!extent) return;
    // Photon extent shape: [maxLat, minLng, minLat, maxLng].
    const [maxLat, minLng, minLat, maxLng] = extent;
    const z = ELEVATION_ZOOM;
    const x0 = lonToTileX(minLng, z);
    const x1 = lonToTileX(maxLng, z);
    const y0 = latToTileY(maxLat, z);
    const y1 = latToTileY(minLat, z);
    const count = (x1 - x0 + 1) * (y1 - y0 + 1);
    if (count <= 0 || count > ELEVATION_MAX_TILES) return;

    // v364: cheap "all-corners cached?" probe to short-circuit a fully-
    // warmed city. Elevation tiles have no isFresh route, so without
    // this every fully-warmed metro paid count × ~20 ms (50-200 GETs)
    // even though every tile was already in R2. We HEAD the four bbox
    // corners (or the single tile when count == 1) — if ALL are HITs,
    // assume the interior is warm too and skip the body. A miss on any
    // corner falls through to the full warming pass.
    const corners = [
        [x0, y0],
        [x1, y0],
        [x0, y1],
        [x1, y1],
    ].filter(
        ([tx, ty], i, arr) =>
            arr.findIndex(([a, b]) => a === tx && b === ty) === i,
    );
    let cornerHits = 0;
    for (const [tx, ty] of corners) {
        try {
            const r = await fetch(
                `${WORKER}/api/elevation/${z}/${tx}/${ty}.png`,
                { method: "HEAD" },
            );
            if (r.ok && /HIT/i.test(r.headers.get("X-Cache") ?? "")) {
                cornerHits++;
            }
        } catch {
            /* probe failed — fall through */
        }
    }
    if (cornerHits === corners.length) {
        console.log(
            `  ⤼ elevation already cached (${count} tiles z${z}) — skipping`,
        );
        return;
    }

    let warmed = 0;
    for (let tx = x0; tx <= x1; tx++) {
        for (let ty = y0; ty <= y1; ty++) {
            const url = `${WORKER}/api/elevation/${z}/${tx}/${ty}.png`;
            try {
                const r = await fetch(url, { method: "GET" });
                if (r.ok) warmed++;
            } catch {
                /* skip — best effort */
            }
        }
    }
    if (warmed > 0) {
        console.log(`  ✓ elevation: warmed ${warmed}/${count} tiles (z${z})`);
    }
}

/* ───────────────────── Metro tentacle routes (v343) ─────────────────── *
 *
 * Single play-area-bbox query for `relation[route=subway][name]` per
 * city. Used by the metro-line tentacle question (rulebook p38, Large
 * games) to enumerate candidate metro lines. Stored at the standard
 * /admin/store-prewarmed endpoint; the client issues the byte-identical
 * query at game time so it lands on the cached entry.
 *
 * MUST match `metroRoutesQuery` in src/maps/questions/tentacles.ts AND
 * `playAreaBboxTuple` (5 km pad, 3-decimal). Drift = cache miss.
 */
function metroRoutesQuery(extent) {
    const tuple = transitBboxTuple(extent); // same pad/precision as the client
    return `\n[out:json][timeout:180][bbox:${tuple}];\nrelation["route"="subway"]["name"];\nout tags geom;\n`;
}

async function processMetroRoutes(city, extent) {
    if (!extent) return;
    const q = metroRoutesQuery(extent);
    if (await isFresh(q, "metro-routes")) {
        console.log(`  ⤼ metro routes already cached — skipping`);
        return;
    }
    const res = await fetchOverpass(q, "metro routes");
    if (!res) return;
    const sizeBytes = Buffer.byteLength(res.text, "utf8");
    if (sizeBytes > MAX_UPLOAD_BYTES) {
        console.log(
            `  ⤼ metro routes ${sizeBytes} B over cap — skipping`,
        );
        return;
    }
    try {
        const r = await uploadToWorker({
            query: q,
            bodyText: res.text,
            kind: "metro-routes",
            sourceName: `${city.name} (metro)`,
            sourceRelationId: String(city.relationId),
        });
        console.log(
            `  ✓ metro routes stored (${sizeBytes} B → gz ${r.gzipBytes} B in ${res.ms} ms)`,
        );
    } catch (e) {
        console.warn(`  ✗ metro routes upload: ${e.message}`);
    }
    await sleep(DELAY_MS);
}

/* ───────────────────────── Tile packs (v336) ────────────────────────── *
 *
 * Extract a small self-contained PMTiles archive for one city from the
 * master basemap (server-side range reads, so we don't download the
 * whole 127 GB), and upload it to /admin/store-tile-pack. The client
 * downloads it whole and serves city tiles from memory — replacing the
 * map-preload bucket's thousands of per-tile range requests with one
 * download.
 *
 * Requires the `pmtiles` Go CLI (github.com/protomaps/go-pmtiles).
 * checkPmtilesBinary() verifies it once at startup.
 */

/** Web-Mercator tile X for a longitude at integer zoom. */
function lonToTileX(lon, z) {
    return Math.floor(((lon + 180) / 360) * 2 ** z);
}
/** Web-Mercator tile Y for a latitude at integer zoom. */
function latToTileY(lat, z) {
    const r = (lat * Math.PI) / 180;
    return Math.floor(
        ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z,
    );
}
/** Tile count covering [minLon,minLat,maxLon,maxLat] at zoom z. */
function tileCountForBbox([minLon, minLat, maxLon, maxLat], z) {
    const x0 = lonToTileX(minLon, z);
    const x1 = lonToTileX(maxLon, z);
    const y0 = latToTileY(maxLat, z); // north → smaller y
    const y1 = latToTileY(minLat, z);
    return (Math.abs(x1 - x0) + 1) * (Math.abs(y1 - y0) + 1);
}
/** Deepest zoom whose single-zoom tile count fits the cap, or null if
 *  even z12 is too big (county-scale extent — skip, the range walk +
 *  master fallback handles it). */
function chooseTilePackMaxZoom(bbox) {
    for (let z = TILE_PACK_MAX_ZOOM; z >= 12; z--) {
        if (tileCountForBbox(bbox, z) <= TILE_PACK_MAX_TILES) return z;
    }
    return null;
}

/** Verify the pmtiles CLI is callable. Returns true/false; logs install
 *  guidance on failure. Called once at startup when --tile-packs is on. */
function checkPmtilesBinary() {
    try {
        execFileSync(PMTILES_BIN, ["version"], { stdio: "pipe" });
        return true;
    } catch {
        try {
            // Older builds use --version instead of the `version` verb.
            execFileSync(PMTILES_BIN, ["--version"], { stdio: "pipe" });
            return true;
        } catch {
            console.error(
                `[tile-packs] '${PMTILES_BIN}' not runnable. Install the pmtiles CLI:\n` +
                    "  https://github.com/protomaps/go-pmtiles/releases\n" +
                    "  (download the binary for your OS, put it on PATH, or pass --pmtiles-bin <path>)\n" +
                    "Continuing with tile packs DISABLED for this run.",
            );
            return false;
        }
    }
}

async function processTilePack(city, effectiveExtent) {
    if (!effectiveExtent || !city.relationId) {
        return;
    }
    // Photon extent shape: [maxLat, minLng, minLat, maxLng].
    const [maxLat, minLng, minLat, maxLng] = effectiveExtent;
    const bbox = [minLng, minLat, maxLng, maxLat];
    const maxZoom = chooseTilePackMaxZoom(bbox);
    if (maxZoom === null) {
        console.log(
            `  ⤼ tile-pack ${city.name}: bbox too large (county-scale), skipping`,
        );
        return;
    }

    // Skip if already uploaded (HEAD on the public /tiles route).
    const packUrl = `${WORKER}/tiles/tile-packs/v1/${city.relationId}.pmtiles`;
    try {
        const head = await fetch(packUrl, { method: "HEAD" });
        if (head.ok) {
            console.log(
                `  ⤼ tile-pack ${city.name} already present — skipping`,
            );
            return;
        }
    } catch {
        /* HEAD failed (network) — fall through and try to build it */
    }

    const tmp = path.join(
        os.tmpdir(),
        `jlhs-pack-${city.relationId}.pmtiles`,
    );
    const bboxArg = `${minLng},${minLat},${maxLng},${maxLat}`;
    try {
        // `pmtiles extract` reads the master over HTTP range requests
        // (only the bbox tiles + directories, not the whole archive)
        // and writes a self-contained pack.
        execFileSync(
            PMTILES_BIN,
            [
                "extract",
                MASTER_PMTILES_URL,
                tmp,
                `--bbox=${bboxArg}`,
                `--minzoom=${TILE_PACK_MIN_ZOOM}`,
                `--maxzoom=${maxZoom}`,
            ],
            { stdio: "pipe" },
        );
    } catch (e) {
        console.warn(
            `  ✗ tile-pack ${city.name} extract failed: ${e.message?.split("\n")[0] ?? e}`,
        );
        safeUnlink(tmp);
        return;
    }

    let size;
    try {
        size = fs.statSync(tmp).size;
    } catch {
        console.warn(`  ✗ tile-pack ${city.name}: extract produced no file`);
        return;
    }
    if (size > TILE_PACK_MAX_BYTES) {
        console.log(
            `  ⤼ tile-pack ${city.name}: ${(size / 1e6).toFixed(1)} MB over cap, skipping`,
        );
        safeUnlink(tmp);
        return;
    }

    try {
        const buf = fs.readFileSync(tmp);
        if (size <= TILE_PACK_SINGLE_SHOT) {
            const resp = await fetchRetry(
                `${WORKER}/admin/store-tile-pack?osmId=${city.relationId}`,
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/octet-stream",
                        Authorization: `Bearer ${SECRET}`,
                    },
                    body: buf,
                },
                "store-tile-pack",
            );
            if (resp.ok) {
                console.log(
                    `  ✓ tile-pack ${city.name} stored (z0-${maxZoom}, ${(size / 1e6).toFixed(1)} MB)`,
                );
            } else {
                console.warn(
                    `  ✗ tile-pack ${city.name} upload status ${resp.status}`,
                );
            }
        } else {
            await uploadTilePackMultipart(city, buf, size, maxZoom);
        }
    } catch (e) {
        console.warn(`  ✗ tile-pack ${city.name} upload: ${e.message}`);
    } finally {
        safeUnlink(tmp);
    }
    await sleep(DELAY_MS);
}

/**
 * Upload a large tile pack via R2 multipart (v345): create → part×N →
 * complete. Each part is TILE_PACK_PART_BYTES (last is the remainder).
 * Bails (and abandons the upload) on any part failure — a half-written
 * multipart upload that never completes is auto-reaped by R2, so
 * there's nothing to clean up.
 */
async function uploadTilePackMultipart(city, buf, size, maxZoom) {
    const base = `${WORKER}/admin/store-tile-pack?osmId=${city.relationId}`;
    const auth = { Authorization: `Bearer ${SECRET}` };
    // 1. create
    const createResp = await fetchRetry(
        `${base}&action=create`,
        { method: "POST", headers: auth },
        "tile-pack create",
    );
    if (!createResp.ok) {
        console.warn(
            `  ✗ tile-pack ${city.name} multipart create status ${createResp.status}`,
        );
        return;
    }
    const { uploadId } = await createResp.json();
    // 2. parts
    const parts = [];
    let partNumber = 1;
    for (let off = 0; off < buf.length; off += TILE_PACK_PART_BYTES) {
        const chunk = buf.subarray(
            off,
            Math.min(off + TILE_PACK_PART_BYTES, buf.length),
        );
        const partResp = await fetchRetry(
            `${base}&action=part&uploadId=${encodeURIComponent(uploadId)}&partNumber=${partNumber}`,
            {
                method: "POST",
                headers: {
                    ...auth,
                    "Content-Type": "application/octet-stream",
                },
                body: chunk,
            },
            `tile-pack part ${partNumber}`,
        );
        if (!partResp.ok) {
            console.warn(
                `  ✗ tile-pack ${city.name} part ${partNumber} status ${partResp.status} — abandoning`,
            );
            return;
        }
        const { etag } = await partResp.json();
        parts.push({ partNumber, etag });
        partNumber++;
    }
    // 3. complete
    const completeResp = await fetchRetry(
        `${base}&action=complete&uploadId=${encodeURIComponent(uploadId)}`,
        {
            method: "POST",
            headers: { ...auth, "Content-Type": "application/json" },
            body: JSON.stringify(parts),
        },
        "tile-pack complete",
    );
    if (completeResp.ok) {
        console.log(
            `  ✓ tile-pack ${city.name} stored multipart (z0-${maxZoom}, ${(size / 1e6).toFixed(1)} MB, ${parts.length} parts)`,
        );
    } else {
        console.warn(
            `  ✗ tile-pack ${city.name} multipart complete status ${completeResp.status}`,
        );
    }
}

function safeUnlink(p) {
    try {
        fs.unlinkSync(p);
    } catch {
        /* already gone */
    }
}

/**
 * Prewarm every country's national HSR network (v214). HSR is an
 * inter-city dataset, so one `area["ISO3166-1"=XX]` query per country
 * is complete and gap-free where per-city bboxes overlapped + left
 * gaps — and there are only ~25 HSR countries, far fewer upstream
 * hits than per-city. Runs once per script invocation, after the
 * city loop, gated by --skip-hsr.
 */
async function processHsrCountries() {
    console.log(`=== HSR by country (${HSR_COUNTRIES.length} countries) ===`);
    for (const iso of HSR_COUNTRIES) {
        const q = hsrCountryQuery(iso);
        if (await isFresh(q, `hsr ${iso}`)) {
            console.log(`[HSR ${iso}] already cached — skipping`);
            continue;
        }
        console.log(`[HSR ${iso}] fetching`);
        const res = await fetchOverpass(q, `hsr ${iso}`);
        if (!res) continue;
        const parsed = safeJSON(res.text);
        if (parsed) {
            try {
                const r = await uploadToWorker({
                    query: q,
                    bodyText: res.text,
                    kind: "hsr",
                    sourceName: iso,
                });
                console.log(
                    `  ✓ HSR ${iso} stored (${r.rawBytes} B raw → ${r.gzipBytes} B gz in ${res.ms} ms, ${parsed.elements?.length ?? 0} ways)`,
                );
            } catch (e) {
                console.warn(`  ✗ HSR ${iso} upload: ${e.message}`);
            }
        }
        await sleep(DELAY_MS);
    }
}

function safeJSON(text) {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

/**
 * Compute the city's bounding box from the boundary geometry we just
 * fetched. The Overpass `relation(N);out geom;` response inlines
 * each member way's coordinates under `members[].geometry`, so we
 * walk every point and track min/max lat/lon. Returned in Photon's
 * `[maxLat, minLng, minLat, maxLng]` shape because that's what the
 * worker and the client query builders expect.
 *
 * This is what unblocks refs+HSR for the bundled HAND_CURATED /
 * BULK_CITIES entries that ship without an extent field — the user
 * pointed out the screenshot showing every major city saying "no
 * extent — skipping refs/HSR." We already have the geometry in hand
 * after the boundary query; computing the bbox is local + free.
 */
function extentFromBoundaryResponse(parsed) {
    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLng = Infinity;
    let maxLng = -Infinity;
    let found = false;

    const consume = (lat, lon) => {
        if (typeof lat !== "number" || typeof lon !== "number") return;
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
        // Range sanity — guards against picking up unrelated numeric
        // fields and against [lng,lat]/[lat,lng] swaps producing
        // garbage corners.
        if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return;
        found = true;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (lon < minLng) minLng = lon;
        if (lon > maxLng) maxLng = lon;
    };

    // Walk the whole response for coordinates rather than assuming a
    // fixed shape. Boundaries reach R2 in several Overpass shapes:
    // a relation with `members[].geometry[]` (out geom), top-level
    // ways with their own `geometry[]`, bare `{lat,lon}` nodes, and —
    // for some admin areas — geometry nested under sub-members. An
    // earlier rigid `type==="relation"` + `members[].geometry` walk
    // silently returned null for the shapes it didn't anticipate
    // (e.g. Nairobi returned "no extent" while Lagos worked); finding
    // ANY in-range coordinate is both simpler and correct, since the
    // bbox of every coordinate IS the extent regardless of nesting.
    const visit = (node) => {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) {
            // Leaf GeoJSON coordinate pair: [lon, lat(, alt)].
            if (
                node.length >= 2 &&
                typeof node[0] === "number" &&
                typeof node[1] === "number"
            ) {
                consume(node[1], node[0]);
                return;
            }
            for (const child of node) visit(child);
            return;
        }
        // Overpass point shape: {lat, lon} on bare nodes + node members.
        if (typeof node.lat === "number" && typeof node.lon === "number") {
            consume(node.lat, node.lon);
        }
        if (node.geometry) visit(node.geometry);
        if (node.members) visit(node.members);
        if (node.elements) visit(node.elements);
        if (node.coordinates) visit(node.coordinates);
    };
    visit(parsed);

    if (!found) return null;
    return [maxLat, minLng, minLat, maxLng];
}

/**
 * Drain the discovery backlog: repeatedly tell the worker to resolve
 * the next batch of bundled candidate city-NAMES into OSM relation
 * ids (via Photon, server-side), until the unresolved count stops
 * dropping. `list-cities` only returns names that have a relation id,
 * so until this runs the prewarmer only sees the ~170 pre-resolved
 * cities — the other ~1150 are bare names waiting here.
 *
 * The worker parks names Photon can't resolve after a few attempts
 * (v215), so a run of dead names no longer blocks the queue — but we
 * still stop once `stillUnresolved` flatlines, since the remainder is
 * either dead or will need more cron ticks to age out.
 */
async function drainDiscovery() {
    console.log(`=== draining discovery backlog ===`);
    let lastRemaining = Infinity;
    let stalls = 0;
    for (let call = 0; call < 300; call++) {
        let resp;
        try {
            resp = await fetchRetry(
                `${WORKER}/admin/discover`,
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${SECRET}`,
                    },
                    body: JSON.stringify({ batch: 25 }),
                },
                "discover",
            );
        } catch (e) {
            console.warn(`  discover call threw: ${e?.message ?? e}`);
            break;
        }
        if (!resp.ok) {
            console.warn(`  discover HTTP ${resp.status} — stopping`);
            break;
        }
        const data = await resp.json().catch(() => null);
        if (!data) break;
        const resolved = Array.isArray(data.resolved) ? data.resolved.length : 0;
        const dupes = Array.isArray(data.duplicates) ? data.duplicates.length : 0;
        const remaining = data.stillUnresolved ?? 0;
        console.log(
            `  call ${call + 1}: +${resolved} resolved${dupes ? `, ${dupes} parked (dup)` : ""}, ${remaining} unresolved`,
        );
        if (remaining === 0) {
            console.log(`  discovery backlog empty`);
            break;
        }
        // Stall detection: stop once the unresolved count stops
        // dropping, REGARDLESS of the resolved count. The old guard
        // also required `resolved === 0`, but the overnight log hit a
        // case where every call reported "+25 resolved, 1257
        // unresolved" — names resolved server-side but didn't leave
        // the queue (the head-vs-full matching bug, now fixed in the
        // worker). With resolved>0 the stall guard never tripped and
        // the loop burned all 300 calls for nothing. Progress is
        // measured by `remaining` falling, full stop.
        if (remaining >= lastRemaining) {
            stalls++;
            if (stalls >= 4) {
                console.log(
                    `  unresolved count flatlined at ${remaining} (no progress over ${stalls} calls) — stopping discovery`,
                );
                break;
            }
        } else {
            stalls = 0;
        }
        lastRemaining = remaining;
    }
}

/**
 * Discover the one-ring of adjacent admin areas around a city: the
 * same-admin_level boundary relations whose centre sits within ~25 km of
 * the city centre. Mirrors the client's `buildAdjacentAdminQuery`
 * (src/maps/api/playAreaExtensions.ts) so we warm exactly what the seeker
 * can add. Returns `{ relationId, name }` for each neighbour (excluding
 * the city itself) so they can be processed as full play areas.
 */
async function findNeighbors(city) {
    // Get the city's admin_level + centroid from its boundary. The main
    // loop already warmed it, so this hits R2 (served in a few ms).
    const bq = boundaryQuery(city.relationId);
    let parsed = null;
    const cached = await fetchCached(bq);
    if (cached) {
        parsed = cached;
    } else {
        const res = await fetchOverpass(bq, `one-ring boundary ${city.name}`);
        if (res) parsed = safeJSON(res.text);
    }
    if (!parsed || !Array.isArray(parsed.elements)) return [];

    const ext = extentFromBoundaryResponse(parsed);
    if (!ext) return [];
    const [maxLat, minLng, minLat, maxLng] = ext;
    const lat = (maxLat + minLat) / 2;
    const lng = (minLng + maxLng) / 2;

    const rel =
        parsed.elements.find(
            (e) => e.type === "relation" && e.id === city.relationId,
        ) ?? parsed.elements.find((e) => e.type === "relation");
    const adminLevel = rel?.tags?.admin_level;
    if (!adminLevel) return [];

    // ADJACENT_SEARCH_DEFAULT_RADIUS_KM = 25 on the client. `out tags
    // center;` (not `out ids;`) so we get each neighbour's name for
    // photon warming + readable logs when we treat it as a play area.
    const q = `[out:json][timeout:60];relation["admin_level"="${adminLevel}"]["type"="boundary"](around:25000,${lat},${lng});out tags center;`;
    const res = await fetchOverpass(q, `one-ring neighbors ${city.name}`);
    if (!res) return [];
    const data = safeJSON(res.text);
    const neighbors = (data?.elements ?? [])
        .filter(
            (e) =>
                e.type === "relation" &&
                typeof e.id === "number" &&
                e.id !== city.relationId,
        )
        .map((e) => ({
            relationId: e.id,
            name: e.tags?.name || e.tags?.["name:en"] || `r${e.id}`,
        }));
    return neighbors.slice(0, ONE_RING_MAX_PER_CITY);
}

/**
 * One-ring pass: warm the adjacent areas of the top N cities as FULL
 * play areas. v442: each discovered neighbour now runs through the same
 * `processCity` pipeline as a curated city — boundary, references,
 * transit, metro routes, elevation, photon, and its own adjacent-search
 * queries — not just the boundary+refs warm it used to do. A neighbour a
 * seeker folds in via "Extend play area" then behaves exactly like the
 * primary did. Deduped against the main city list and across cities, and
 * bounded by ONE_RING_TOP × ONE_RING_MAX_PER_CITY so the pass stays
 * sane. (processCity does NOT recurse into one-ring, so no neighbour-of-
 * neighbour blow-up.)
 */
async function processOneRing(cities) {
    const top = cities.slice(0, ONE_RING_TOP);
    const cityIds = new Set(cities.map((c) => c.relationId));
    const seen = new Set();
    const processed = []; // v684: return neighbours warmed, for the verify pass
    console.log(
        `=== one-ring: neighbors of top ${top.length} cities as full play areas (max ${ONE_RING_MAX_PER_CITY}/city) ===`,
    );
    for (const city of top) {
        let neighbors = [];
        try {
            neighbors = await findNeighbors(city);
        } catch (e) {
            console.warn(
                `  ! one-ring discover ${city.name} failed:`,
                e?.message ?? e,
            );
            continue;
        }
        for (const n of neighbors) {
            if (seen.has(n.relationId) || cityIds.has(n.relationId)) continue;
            seen.add(n.relationId);
            try {
                // Treat the neighbour as any other play area.
                await processCity(n);
                processed.push(n);
            } catch (e) {
                console.warn(
                    `  ! one-ring process ${n.name} (r${n.relationId}) failed:`,
                    e?.message ?? e,
                );
            }
        }
    }
    console.log(
        `=== one-ring: processed ${processed.length} unique neighbour play areas ===`,
    );
    return processed;
}

/**
 * v696: warm ONE city end-to-end — its primary, then each adjacent area as a
 * full play area, then verify + stamp its star — so the city is completely
 * ready (and starred) before the caller moves on. `globalSeen` dedupes
 * neighbours across cities (a shared suburb isn't re-warmed). Used by the
 * --city-complete path; mirrors what the main-loop + one-ring + verify passes
 * do in aggregate, just per-city instead of in three separate phases.
 */
async function processCityComplete(city, globalSeen) {
    await processCity(city);

    if (DO_ONE_RING) {
        let neighbors = [];
        try {
            neighbors = await findNeighbors(city);
        } catch (e) {
            console.warn(
                `  ! adjacents discover ${city.name} failed:`,
                e?.message ?? e,
            );
        }
        for (const n of neighbors) {
            if (globalSeen.has(n.relationId)) continue;
            globalSeen.add(n.relationId);
            try {
                await processCity(n);
            } catch (e) {
                console.warn(
                    `  ! adjacent ${n.name} (r${n.relationId}) failed:`,
                    e?.message ?? e,
                );
            }
        }
    }

    // Stamp the star NOW — primary + adjacents are cached, so the city
    // lights up in the app the instant it's done, in warm order.
    if (DO_VERIFY) {
        try {
            const v = await verifyCity(city.relationId);
            if (v?.fullyCurated) {
                console.log(`  ★ ${city.name} — fully cached & starred`);
            } else {
                console.log(
                    `  ☆ ${city.name} — primary warm, star pending` +
                        (v && typeof v.neighboursTotal === "number"
                            ? ` (${v.neighboursTotal} neighbours)`
                            : ""),
                );
            }
        } catch {
            /* verify is best-effort */
        }
    }
}

async function main() {
    console.log(`=== laptop-prewarm against ${WORKER} ===`);

    if (DO_TILE_PACKS) {
        tilePacksEnabled = checkPmtilesBinary();
        if (tilePacksEnabled) {
            console.log(
                `tile packs ENABLED (extracting from ${MASTER_PMTILES_URL})`,
            );
        }
    }

    if (DO_DISCOVER && !ONLY_CITY && !VERIFY_ONLY) {
        try {
            await drainDiscovery();
        } catch (e) {
            console.warn(`! discovery drain failed:`, e?.message ?? e);
        }
    }

    let cities = await listCities();
    console.log(`fetched ${cities.length} cities; processing up to ${MAX_CITIES}`);

    // v693: --priority-regions takes precedence over --seed-first (it already
    // orders by population within each region tier, so it subsumes "biggest
    // first" while adding the player-region tiers on top).
    if (PRIORITY_REGIONS) {
        const withCountry = cities.filter((c) => c.country).length;
        cities = orderByPriorityRegions(cities, PRIORITY_REGIONS);
        console.log(
            `--priority-regions: warming ${PRIORITY_REGIONS.join(",")} first ` +
                `(then by population); ${withCountry}/${cities.length} cities have a country tag`,
        );
    } else if (SEED_FIRST) {
        const seedIds = await fetchSeedIds();
        cities = orderSeedFirst(cities, seedIds);
        console.log(
            `--seed-first: ${seedIds.length} seed cities ordered first (biggest → smallest)`,
        );
    }

    // v684: --verify-only — skip all warming, just stamp stars for cities
    // that are already fully cached (e.g. right after a completed warm run).
    if (VERIFY_ONLY && !ONLY_CITY) {
        await verifyStars(cities.slice(0, MAX_CITIES));
        console.log("=== done (verify-only) ===");
        return;
    }

    let todo = cities.slice(0, MAX_CITIES);
    if (ONLY_CITY) {
        const isId = /^\d+$/.test(ONLY_CITY);
        const needle = ONLY_CITY.toLowerCase();
        let matches = cities.filter((c) =>
            isId
                ? String(c.relationId) === ONLY_CITY
                : (c.name ?? "").toLowerCase().includes(needle),
        );
        // Numeric id not in the bundled list: synthesise it. processCity
        // derives the extent from the boundary query, so this is enough
        // to build a tile pack for any OSM relation.
        if (matches.length === 0 && isId) {
            matches = [{ relationId: Number(ONLY_CITY), name: `r${ONLY_CITY}` }];
        }
        if (matches.length === 0) {
            console.error(
                `--only-city "${ONLY_CITY}" matched no city (by name). ` +
                    `Pass the OSM relation id instead to build it directly.`,
            );
            process.exit(1);
        }
        todo = matches;
        console.log(
            `--only-city "${ONLY_CITY}" → ${todo.length} match(es): ${todo
                .map((c) => `${c.name} (r${c.relationId})`)
                .join(", ")}`,
        );
    } else {
        // v641: --cold-only — drop cities already warmed (boundary +
        // adjacency), so a run heads straight for un-warmed cities instead
        // of re-verifying the cron-kept-warm front of the list.
        if (COLD_ONLY) {
            const warm = await fetchWarmedRelationIds();
            if (warm.size > 0) {
                const before = todo.length;
                todo = todo.filter((c) => !warm.has(String(c.relationId)));
                console.log(
                    `--cold-only: skipped ${before - todo.length} already-warm cities; ${todo.length} cold remain`,
                );
            }
        }
        // Shuffle so successive runs sample different cities (matches the
        // cron's per-run shuffle) — a run then warms a fresh slice rather
        // than always re-walking the list head. Deterministic order isn't
        // needed here; the per-query check-fresh makes it idempotent.
        // SKIP the shuffle with --seed-first / --priority-regions: the point
        // there is to warm cities in a deliberate order, not a random slice.
        if (!SEED_FIRST && !PRIORITY_REGIONS) {
            for (let i = todo.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [todo[i], todo[j]] = [todo[j], todo[i]];
            }
        }
    }
    // v696: --city-complete warms each city end-to-end (primary + adjacents
    // + star stamp) before the next, so a city is fully READY and STARRED in
    // warm order (NYC whole, then LA whole, …). The separate tail-end
    // one-ring + batch-verify passes are skipped — they're inline now.
    const cityCompleteSeen = new Set(todo.map((c) => c.relationId));
    let oneRingProcessed = [];
    if (CITY_COMPLETE && !ONLY_CITY) {
        for (let i = 0; i < todo.length; i++) {
            try {
                await processCityComplete(todo[i], cityCompleteSeen);
            } catch (e) {
                console.warn(`! ${todo[i].name} failed:`, e?.message ?? e);
            }
            if ((i + 1) % 10 === 0) {
                console.log(`--- progress: ${i + 1}/${todo.length} ---`);
            }
        }
    } else {
        for (let i = 0; i < todo.length; i++) {
            try {
                await processCity(todo[i]);
            } catch (e) {
                console.warn(`! ${todo[i].name} failed:`, e?.message ?? e);
            }
            if ((i + 1) % 10 === 0) {
                console.log(`--- progress: ${i + 1}/${todo.length} ---`);
            }
        }

        // v360 / v442: one-ring neighbour warming (default on). Runs after
        // the main loop so the top cities' boundaries are already cached for
        // the centroid/admin_level lookups in findNeighbors, then processes
        // each neighbour as a full play area.
        if (DO_ONE_RING && !ONLY_CITY) {
            try {
                oneRingProcessed = (await processOneRing(cities)) ?? [];
            } catch (e) {
                console.warn(`! one-ring pass failed:`, e?.message ?? e);
            }
        }
    }

    // HSR runs once after the city loop — it's keyed by country, not
    // city, so iterating it per-city would just re-fetch the same ~25
    // national networks hundreds of times.
    if (DO_HSR && !ONLY_CITY) {
        try {
            await processHsrCountries();
        } catch (e) {
            console.warn(`! HSR pass failed:`, e?.message ?? e);
        }
    }

    // v684: verify + stamp stars now (primary + adjacents both cached), so
    // the app lights up immediately instead of waiting for the cron to pick
    // each city. Runs after one-ring so a city's adjacents are warm before
    // it's checked. Verify covers the processed cities AND the one-ring
    // neighbours (which became fully-cached play areas of their own).
    if (DO_VERIFY && !ONLY_CITY && !CITY_COMPLETE) {
        try {
            const verifyList = [...todo];
            if (DO_ONE_RING) {
                const seen = new Set(verifyList.map((c) => c.relationId));
                for (const c of oneRingProcessed) {
                    if (!seen.has(c.relationId)) verifyList.push(c);
                }
            }
            await verifyStars(verifyList);
        } catch (e) {
            console.warn(`! verify pass failed:`, e?.message ?? e);
        }
    }

    console.log("=== done ===");
}

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith("--")) continue;
        const k = a.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
            out[k] = true;
        } else {
            out[k] = next;
            i++;
        }
    }
    return out;
}

main().catch((e) => {
    console.error("fatal:", e);
    process.exit(1);
});
