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
 *     [--cold-only] [--skip-starred] [--adjacents] \
 *     [--skip-discover] [--skip-boundaries] [--skip-references] \
 *     [--skip-transit] [--skip-hsr] [--skip-photon] [--skip-adjacent] \
 *     [--skip-one-ring] [--one-ring-top N] [--one-ring-max-per-city N] \
 *     [--skip-tile-packs] [--master-pmtiles URL] [--pmtiles-bin path] \
 *     [--delay-ms 2000]
 *
 *   Tile packs are ON BY DEFAULT (v726) — built for every city processed,
 *   primaries AND (with --adjacents) their neighbours, since the v725 star
 *   gate requires a pack. Needs the go-pmtiles binary; if absent the run
 *   warns + continues data-only (no stars). `--skip-tile-packs` opts out.
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
import { fileURLToPath } from "node:url";
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
// v730: re-store every touched entry even if check-fresh says it's present
// (repairs the pre-v730 large-body encoding-desync poisoning).
const FORCE_RESTORE = !!args["force"];
// v701: `--skip-starred` drops cities that already carry the relevant STAR
// so a restart doesn't re-walk (HEAD every query + verify) the cities it
// already finished. In the DEFAULT primaries pass it skips cities in
// /api/warm-cities (primaryCuratedAt); in the --adjacents pass it skips
// /api/adjacent-ready-cities (adjacentsCuratedAt). Distinct from --cold-only
// (which keys off /admin/prewarmed-cities' boundary+adjacency heuristic):
// this keys off the actual star gate, so "skip what's done" means exactly
// what the app shows as done. CAVEAT: after a cache-key filter change (a new
// reference filter, a wrapper edit), do a FULL pass WITHOUT this flag first —
// a star stamped under the old key would otherwise be skipped and never
// re-verified/re-warmed under the new key. Ignored with --only-city.
const SKIP_STARRED = !!args["skip-starred"];
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
// v730: --audit-encoding — READ-ONLY check of each city's relation-id GET
// endpoints (refs/stations/water/metro/transit-bus). It parses each response
// to find entries poisoned by the pre-v730 large-body Content-Encoding desync
// (they exist in R2 but can't be decoded). No Overpass, no writes. Prints a
// copy-pasteable --only-city list of the affected cities to re-warm --force.
const AUDIT_ENCODING = !!args["audit-encoding"];
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
// v699.1: the legacy always-on one-ring pass is retired — adjacents are now
// the opt-in `--adjacents` phase (see DO_ADJACENTS above), using the worker's
// authoritative neighbour set. `processOneRing`/`findNeighbors` remain below
// but are no longer called (kept for reference / possible reuse).
// v699.1: TWO-PHASE warming.
//   DEFAULT (no flag) = PRIMARIES ONLY. Warm each curated city's own play
//     area (boundary/refs/stations/transit/water/…), verify → stamp
//     `primaryCuratedAt` (the ⭐: a normal game on this city is
//     Overpass-free). Fast; every curated city earns its star. NO adjacents.
//   --adjacents (alias --city-complete) = the ADJACENTS phase. Per city
//     (primary skip-if-fresh), warm its adjacent areas as full play areas
//     via the worker's real neighbour set, verify → stamp `adjacentsCuratedAt`
//     so the app can offer "extend play area" for it. Heavier; run it AFTER
//     a default pass has starred the primaries.
// So: run the default first (all primaries ⭐), then --adjacents to fill
// extend-support city-by-city. --city-complete is kept as the alias since it
// already does primary+adjacents per city.
const DO_ADJACENTS = !!args["adjacents"] || !!args["city-complete"];
const ONE_RING_TOP = args["one-ring-top"]
    ? parseInt(args["one-ring-top"], 10)
    : 100;
// Cap on neighbors warmed per city, so one pathological metro with dozens
// of tiny adjacent municipalities can't dominate the pass.
const ONE_RING_MAX_PER_CITY = args["one-ring-max-per-city"]
    ? parseInt(args["one-ring-max-per-city"], 10)
    : 12;
// Tile packs are ON BY DEFAULT (v726) — they're now part of the normal
// prewarm for BOTH primaries and adjacents, because the star gate (v725)
// requires a pack. They need the external `pmtiles` Go binary
// (github.com/protomaps/go-pmtiles); if it's absent the startup check
// disables them for the run (with a warning) so the data phases still run.
// Opt out with `--skip-tile-packs` (e.g. a data-only refresh, or a host
// without the binary). `--tile-packs` is still accepted as a no-op alias so
// old commands keep working.
const DO_TILE_PACKS = !args["skip-tile-packs"];
// Flipped off at startup if the pmtiles binary check fails, so the
// per-city loop skips pack extraction cleanly instead of throwing.
let tilePacksEnabled = DO_TILE_PACKS;
// Resolved lazily by checkPmtilesBinary() — starts as the explicit
// --pmtiles-bin or the bare name, then gets rewritten to whichever candidate
// actually ran (so processTilePack shells out to the right path).
let PMTILES_BIN = args["pmtiles-bin"] || "pmtiles";
const PMTILES_BIN_EXPLICIT = !!args["pmtiles-bin"];
// Master archive to extract city packs FROM. When --master-pmtiles isn't
// passed, main() auto-resolves the CURRENT basemap from the worker's
// `/api/basemap-url` (newest `basemap-z15-*.pmtiles` in R2) so the date-
// stamped filename doesn't have to be tracked by hand; this hard-coded
// value is only the fallback if that lookup fails. Explicit --master-pmtiles
// always wins.
const MASTER_PMTILES_EXPLICIT = !!args["master-pmtiles"];
let MASTER_PMTILES_URL =
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

let PAD_KM_REF = 50; // mirrors PAD_KM in worker (synced at startup)

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
// `let` (not const): syncReferenceFilters() overrides these at startup from
// the worker's /api/reference-filters so a hand-mirror drift self-heals.
let REFERENCE_FAMILY_FILTERS = [
    { filter: '["aeroway"="aerodrome"]["iata"]' },
    { filter: '["tourism"="aquarium"]' },
    { filter: '["amenity"="cinema"]' },
    // v686: `~"^consulate"` (was `="consulate"`) — MUST match the worker's
    // REFERENCE_FAMILY_FILTERS byte-for-byte or the refs R2 key diverges and
    // every laptop-warmed city misses its refs (the "no star / missing refs"
    // bug). The startup sync below fetches the canonical set and overrides
    // this list so a future drift self-heals instead of silently orphaning.
    { filter: '["diplomatic"~"^consulate"]' },
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
let AREA_STATION_FILTERS = [
    "[railway=station][subway=yes]",
    "[station=subway]",
    "[railway=station][subway!=yes]",
    "[railway=halt]",
    "[railway=tram_stop]",
    "[railway=halt][light_rail=yes]",
    "[public_transport=platform][tram=yes]",
    "[highway=bus_stop]",
    "[public_transport=platform][bus=yes]",
    "[amenity=ferry_terminal]",
    "[public_transport=platform][ferry=yes]",
    "[public_transport=platform][platform=ferry]",
];
let PAD_KM_STATIONS = 2;
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
let WATER_FILTERS = [
    '["natural"="water"]["name"]["water"!~"pond|basin|pool|fountain|wastewater|moat|tank|ditch"]',
    // v690: NO `["name"]` on the line filter (unnamed river/canal segments
    // are still bodies of water). Byte-identical to the worker builder.
    '["waterway"~"^(river|canal)$"]',
];
let PAD_KM_WATER = 2;
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
                // v730: gzip the body but declare it with a CUSTOM header,
                // NOT `Content-Encoding`. Cloudflare decompresses a large
                // inbound body when it sees `Content-Encoding: gzip`, which
                // desynced the stored bytes from the encoding metadata and
                // made the worker serve an unparseable body for the biggest
                // cities (London refs). With no standard Content-Encoding, CF
                // passes the gzip bytes through verbatim; the worker reads
                // `X-Body-Encoding` for the metadata, so bytes + metadata
                // always agree.
                "X-Body-Encoding": "gzip",
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
    // v730: --force re-stores every entry the run touches, ignoring the
    // check-fresh skip. Needed to repair entries that EXIST but are stored
    // WRONG (the pre-v730 large-body Content-Encoding desync poisoned the
    // biggest cities' refs) — a normal run skips them because they're
    // present. Use with --only-city / a big-city list to re-warm the
    // affected ones without re-doing the whole fleet.
    if (FORCE_RESTORE) return false;
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
        // Per-attempt timeout — Node's fetch has NO default timeout, so a
        // hung worker/CDN connection (socket open, no bytes) would stall the
        // WHOLE overnight run forever on one call. Abort at 90 s and retry.
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 90_000);
        try {
            return await fetch(url, { ...init, signal: ctrl.signal });
        } catch (e) {
            lastErr = e;
            const backoff = Math.min(2000 * 2 ** (i - 1), 16000);
            console.warn(
                `  ⚠ ${label} network error (${e?.cause?.code ?? e?.message ?? e}); retry ${i}/${attempts} in ${backoff} ms`,
            );
            if (i < attempts) await sleep(backoff);
        } finally {
            clearTimeout(timer);
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
/** v696: the EXACT adjacent-area relation ids the star gate checks for this
 *  city (`deriveAdjacentNeighbourIds` on the worker, from cached topological
 *  adjacency). Used by --city-complete so the neighbours warmed match the
 *  ones `verifyAndStampCity` requires — the local `findNeighbors`
 *  (admin_level-around) misses a megacity's real neighbours (NYC at
 *  admin_level 5 has none at its own level). Requires the city's
 *  adjacent-search queries to be cached first (processCity warms them).
 *  Returns [] on any failure. */
async function fetchCityNeighbours(relationId) {
    try {
        const resp = await fetchRetry(
            `${WORKER}/admin/city-neighbours?relationId=${relationId}`,
            { headers: { Authorization: `Bearer ${SECRET}` } },
            "city-neighbours",
        );
        if (!resp.ok) return [];
        const data = await resp.json();
        return Array.isArray(data.neighbours) ? data.neighbours : [];
    } catch {
        return [];
    }
}

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

/** v700: verify + log ONE city's star immediately after warming it. The
 *  default star is `primaryCached` (primary boundary+refs+stations in R2), so
 *  this reports that — not `fullyCurated` (primary + adjacents), which only
 *  the --adjacents phase can satisfy. No Overpass (read-only R2 HEADs), so
 *  it's cheap to call per city. Returns true when the primary is warm. */
/** Fetch a relation-id GET endpoint and classify it:
 *   "ok"       — decoded + parsed as JSON with real data.
 *   "miss"     — endpoint returned a cache:"miss"/"no-boundary" marker
 *                (never warmed under this key — NOT poisoned).
 *   "empty"    — parsed but genuinely empty (a real transit-less mode etc.).
 *   "poisoned" — a body is present but can't be decoded/parsed. This is the
 *                pre-v730 encoding desync: bytes and the Content-Encoding
 *                metadata disagree, so `resp.text()` throws (bad gunzip) or
 *                the result isn't JSON. THIS is what --force must re-warm.
 *   "error"    — HTTP/network error (worker down / not found). */
async function checkEndpointParse(url) {
    let resp;
    try {
        resp = await fetch(url, { cache: "no-store" });
    } catch {
        return "error";
    }
    if (!resp.ok) return "error";
    let text;
    try {
        text = await resp.text(); // undici gunzips per Content-Encoding here
    } catch {
        return "poisoned"; // decompression blew up → bytes ≠ encoding metadata
    }
    let j;
    try {
        j = JSON.parse(text);
    } catch {
        return "poisoned"; // decoded body isn't JSON (raw gzip served bare)
    }
    if (j && (j.cache === "miss" || j.cache === "no-boundary")) return "miss";
    const els = Array.isArray(j?.elements) ? j.elements.length : null;
    return els === 0 ? "empty" : "ok";
}

/** READ-ONLY audit: for each city, probe the relation-id GET endpoints and
 *  report which carry a POISONED (undecodable) entry. Prints a
 *  copy-pasteable --only-city list at the end so the operator re-warms ONLY
 *  the affected cities (`--force`) instead of the whole fleet. */
async function auditEncoding(cities) {
    const ENDPOINTS = [
        (id) => ({ label: "refs", url: `${WORKER}/api/refs/${id}` }),
        (id) => ({
            label: "stations",
            url: `${WORKER}/api/area-stations/${id}`,
        }),
        (id) => ({ label: "water", url: `${WORKER}/api/water/${id}` }),
        (id) => ({ label: "metro", url: `${WORKER}/api/metro/${id}` }),
        (id) => ({
            label: "transit/bus",
            url: `${WORKER}/api/transit/${id}/bus`,
        }),
    ];
    console.log(
        `=== audit-encoding: probing ${cities.length} cities (read-only, no Overpass) ===`,
    );
    const poisoned = [];
    let okC = 0,
        missC = 0,
        poisonEndpoints = 0;
    for (let i = 0; i < cities.length; i++) {
        const c = cities[i];
        const bad = [];
        for (const mk of ENDPOINTS) {
            const { label, url } = mk(c.relationId);
            const status = await checkEndpointParse(url);
            if (status === "poisoned") {
                bad.push(label);
                poisonEndpoints++;
            } else if (status === "ok" || status === "empty") okC++;
            else if (status === "miss") missC++;
        }
        if (bad.length) {
            poisoned.push(c);
            console.log(
                `  ✗ ${c.name} (r${c.relationId}) POISONED: ${bad.join(", ")}`,
            );
        }
        if ((i + 1) % 25 === 0)
            console.log(
                `  --- ${i + 1}/${cities.length} probed (${poisoned.length} poisoned so far) ---`,
            );
    }
    console.log(
        `=== audit done: ${poisoned.length}/${cities.length} cities have a poisoned entry ` +
            `(${poisonEndpoints} bad endpoints; ${okC} ok, ${missC} miss) ===`,
    );
    if (poisoned.length) {
        const ids = poisoned.map((c) => c.relationId).join(",");
        console.log(`\nRe-warm ONLY the affected cities:`);
        console.log(
            `  node scripts/laptop-prewarm.mjs --worker <url> --secret <secret> \\`,
        );
        console.log(`      --only-city "${ids}" --force --email <you>\n`);
        console.log(`(--only-city accepts this comma list of relation ids.)`);
    } else {
        console.log("No poisoned entries found — nothing to re-warm.");
    }
}

async function verifyPrimaryStar(city) {
    const v = await verifyCity(city.relationId);
    if (!v) {
        console.log(`  ? ${city.name} — verify failed (star unchanged)`);
        return false;
    }
    if (v.primaryCached) {
        const mark = v.stamped ? "★ (stamped)" : "★ (already)";
        console.log(`  ${mark} ${city.name} — primary warm`);
        return true;
    }
    // v700: print WHICH sub-check failed (boundary / extent / refs / stations)
    // so a "no star" is diagnosable at a glance instead of a mystery. The
    // common megacity case is extentSource:"none" — the boundary is cached but
    // too large to re-parse in the worker isolate.
    const d = v.primaryDetail;
    let why = "unknown";
    if (d) {
        const miss = [];
        if (!d.boundaryCached) miss.push("boundary");
        else if (!d.extentDerived) miss.push(`extent(${d.extentSource})`);
        else {
            if (!d.refsCached) miss.push("refs");
            if (!d.stationsCached) miss.push("stations");
        }
        // v725: the star now also needs the tile pack (run with --tile-packs).
        if (d.packCached === false) miss.push("pack");
        why = miss.length
            ? `missing ${miss.join("+")} [extent:${d.extentSource}]`
            : "unknown";
    }
    console.log(`  ✗ ${city.name} — no star (${why})`);
    return false;
}

/** Run the verify pass over a list of cities: stamp the PRIMARY star (v700)
 *  for every one whose primary is fully cached. No Overpass, so it's fast. */
async function verifyStars(cities) {
    console.log(`=== verifying stars for ${cities.length} cities ===`);
    let starred = 0;
    for (let i = 0; i < cities.length; i++) {
        const c = cities[i];
        const v = await verifyCity(c.relationId);
        if (v?.primaryCached) {
            starred++;
            if (v.stamped) {
                console.log(`  ★ ${c.name} — primary warm (stamped)`);
            }
        }
        if ((i + 1) % 50 === 0) {
            console.log(
                `  … verified ${i + 1}/${cities.length} (${starred} starred so far)`,
            );
        }
        await sleep(80); // gentle on the worker; these are R2-only ops
    }
    console.log(`=== verify done — ${starred}/${cities.length} primary-warm ===`);
}

/**
 * v701: the set of relation ids that already carry a STAR, read from the
 * public gate endpoint (no auth). `kind="warm"` → /api/warm-cities
 * (primaryCuratedAt, the ⭐); `kind="adjacent"` → /api/adjacent-ready-cities
 * (adjacentsCuratedAt). Used by --skip-starred to drop already-done cities so
 * a restart heads straight to the un-done tail. Returns an empty set on any
 * failure (so --skip-starred degrades to "process everything"). Ids are
 * stringified to match the todo filter.
 */
async function fetchStarredRelationIds(kind) {
    const path =
        kind === "adjacent" ? "/api/adjacent-ready-cities" : "/api/warm-cities";
    // v717: BUST the CDN cache. /api/warm-cities is served with
    // `Cache-Control: public, max-age=3600`, so within an hour of stamping a
    // city, a plain GET returns a STALE warm set that predates the stamp — so
    // --skip-starred wouldn't skip a just-starred city (LA/DC re-walked every
    // run). A unique `?t=` makes it a fresh origin hit + no-store on our side.
    const url = `${WORKER}${path}?t=${Date.now()}`;
    try {
        const resp = await fetchRetry(
            url,
            { cache: "no-store", headers: { "Cache-Control": "no-cache" } },
            "starred-cities",
        );
        if (!resp.ok) return new Set();
        const data = await resp.json();
        const ids = Array.isArray(data.ids) ? data.ids : [];
        return new Set(ids.map((n) => String(n)));
    } catch {
        return new Set();
    }
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

/**
 * v713: a city play area is never bigger than a big metro (~1.5° across).
 * A mis-resolved seed — "Ontario" pointing at the whole PROVINCE relation
 * (r68841, ~15° × ~21°) rather than a city — otherwise fires province-scale
 * refs/stations/water queries that soft-timeout (abort remarks) + 504, wasting
 * the run. Gate on span: >3° lat or >4.5° lng = a state/province/country, not a
 * city → skip. extent order: [maxLat, minLng, minLat, maxLng]. */
const MAX_EXTENT_SPAN_LAT_DEG = 3;
const MAX_EXTENT_SPAN_LNG_DEG = 4.5;
function isOversizedExtent(ext) {
    if (!Array.isArray(ext) || ext.length !== 4) return false;
    const [maxLat, minLng, minLat, maxLng] = ext;
    if (![maxLat, minLng, minLat, maxLng].every((n) => Number.isFinite(n)))
        return false;
    return (
        maxLat - minLat > MAX_EXTENT_SPAN_LAT_DEG ||
        maxLng - minLng > MAX_EXTENT_SPAN_LNG_DEG
    );
}

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

    // v713: bail on a state/province/country-scale extent (a mis-resolved
    // seed like "Ontario" → the whole province). Its refs/stations/water
    // queries would soft-timeout and waste the run; it's not a valid play
    // area regardless. (extentless cities fall through and are re-checked
    // against the boundary-derived extent below.)
    if (city.extent && isOversizedExtent(city.extent)) {
        const [mxLat, mnLng, mnLat, mxLng] = city.extent;
        console.log(
            `  ✗ ${city.name} — extent ${(mxLat - mnLat).toFixed(1)}° × ${(mxLng - mnLng).toFixed(1)}° is state/province-scale, not a city — SKIPPING`,
        );
        return;
    }

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
    // v713: second oversize gate for extentless cities whose boundary geom
    // turned out province-scale (the city.extent gate above only catches
    // pre-backfilled ones). Bail before the heavy refs/stations/water warms.
    if (refExtent && isOversizedExtent(refExtent)) {
        const [mxLat, mnLng, mnLat, mxLng] = refExtent;
        console.log(
            `  ✗ ${city.name} — boundary extent ${(mxLat - mnLat).toFixed(1)}° × ${(mxLng - mnLng).toFixed(1)}° is state/province-scale, not a city — SKIPPING`,
        );
        return;
    }
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

    // v334: per-city Photon warm-up — one forward search for the city's
    // name, hitting OUR worker's /api/photon/forward proxy (NOT
    // photon.komoot.io directly) so the response lands in R2 and the exact
    // "search for <city>" play-area query is an instant cache hit. Cheap
    // (kilobytes) and unblocks the most-clicked play-area picker flow.
    // v700: the reverse warm at the bbox centroid was REMOVED — the client
    // only ever reverse-geocodes the player's actual GPS / a tapped point at
    // full precision, never the exact 4-dp city centroid, and the worker
    // does no coordinate bucketing, so that key was never hit (audit: dead
    // warm). The forward warm stays. HEAD-first short-circuit inside
    // warmPhoton so a warm city doesn't pay the GET + DELAY_MS pacing sleep.
    if (DO_PHOTON) {
        await warmPhoton(
            `${WORKER}/api/photon/forward?lang=en&q=${encodeURIComponent(city.name)}`,
            `photon-forward "${city.name}"`,
        );
    }

    // v336: per-city tile pack. Heavy + needs the external pmtiles binary.
    // ON BY DEFAULT (v726) — built for every city processCity handles, so a
    // primary (default pass) AND each neighbour (--adjacents pass, which runs
    // processCity per neighbour) both get a pack. Disabled for the run when
    // the binary is missing or --skip-tile-packs. Uses the resolved
    // effectiveExtent (derived from boundary geometry when the city list
    // didn't carry one), same as refs/transit.
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

/** Find a LOCAL copy of the master basemap `key` (e.g.
 *  "basemap-z15-20260614.pmtiles") in the usual storage spots, so pack
 *  extraction reads the local 100+ GB file instead of HTTP-ranging the remote
 *  one per city. Returns the absolute path, or null if none exists. */
function findLocalBasemap(key) {
    if (!key) return null;
    const home = os.homedir();
    const candidates = [
        path.join(home, "jlhs-pmtiles", key),
        path.join(home, "Downloads", key),
        path.join(process.cwd(), key),
        key, // in case an absolute/relative path was somehow the key
    ];
    for (const c of candidates) {
        try {
            if (fs.existsSync(c) && fs.statSync(c).size > 0) return c;
        } catch {
            /* ignore */
        }
    }
    return null;
}

/** Verify the pmtiles CLI is callable. Returns true/false; logs install
 *  guidance on failure. Called once at startup when tile packs are enabled
 *  (the default; disable with --skip-tile-packs). */
function checkPmtilesBinary() {
    const isWin = process.platform === "win32";
    // Does one candidate run? Try the `version` verb, then legacy `--version`.
    const runs = (bin) => {
        for (const verArg of ["version", "--version"]) {
            try {
                execFileSync(bin, [verArg], { stdio: "pipe" });
                return true;
            } catch {
                /* try next */
            }
        }
        return false;
    };

    // Build the candidate list. An explicit --pmtiles-bin is tried as given
    // (plus a `.exe` sibling on Windows). Otherwise probe the bare name on
    // PATH AND common local drop spots (cwd, the script's dir, the repo root),
    // so a `pmtiles.exe` sitting next to the project is found without a flag —
    // the usual "I downloaded it here before" case.
    const withExe = (p) => (isWin && !/\.exe$/i.test(p) ? [p, `${p}.exe`] : [p]);
    let candidates;
    if (PMTILES_BIN_EXPLICIT) {
        candidates = withExe(PMTILES_BIN);
    } else {
        const scriptDir = path.dirname(fileURLToPath(import.meta.url));
        const home = os.homedir();
        const dirs = [
            process.cwd(),
            scriptDir,
            path.resolve(scriptDir, ".."), // overpass-cache/
            path.resolve(scriptDir, "..", ".."), // repo root
            // Common manual-install spots (go-pmtiles ships a bare binary in a
            // release folder; users typically leave it in Downloads or a
            // dedicated folder). Cheap fs.existsSync checks, so listing a few
            // is free and saves the --pmtiles-bin flag.
            path.join(home, "Downloads", "go-pmtiles"),
            path.join(home, "jlhs-pmtiles"),
            path.join(home, "jlhs-pmtiles", "pmtiles.exe-x"),
            path.join(home, "Downloads"),
        ];
        const names = ["pmtiles", "go-pmtiles"];
        candidates = [
            ...names.flatMap((n) => withExe(n)), // bare → PATH lookup
            ...dirs.flatMap((d) =>
                names.flatMap((n) => withExe(path.join(d, n))),
            ),
        ];
    }
    // Dedup while preserving order.
    candidates = [...new Set(candidates)];

    for (const c of candidates) {
        // A path candidate must exist on disk before we exec it (a bare name
        // is resolved by the OS, so skip the existence check there).
        const looksLikePath = c.includes(path.sep) || /[\\/]/.test(c);
        if (looksLikePath && !fs.existsSync(c)) continue;
        if (runs(c)) {
            PMTILES_BIN = c; // remember what actually worked
            if (c !== "pmtiles" && c !== "pmtiles.exe") {
                console.log(`  · using pmtiles binary: ${c}`);
            }
            return true;
        }
    }

    console.error(
        `[tile-packs] pmtiles CLI not found. Tried: ${candidates.join(", ")}\n` +
            "  Install it: https://github.com/protomaps/go-pmtiles/releases\n" +
            "  (download the binary for your OS, then EITHER put pmtiles(.exe) on\n" +
            "   PATH / in the repo folder, OR pass --pmtiles-bin <full\\path\\to\\pmtiles.exe>)\n" +
            "Continuing with tile packs DISABLED for this run.",
    );
    return false;
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

    {
        // v696: use the WORKER's neighbour set (the exact ids the star gate
        // checks), not the local admin_level-around findNeighbors — the two
        // diverge for megacities (NYC found 0 locally but the gate wants 14).
        // The primary's adjacent-search queries were just warmed by
        // processCity above, so the endpoint can derive them from R2.
        let neighbors = await fetchCityNeighbours(city.relationId);
        if (neighbors.length > 0) {
            console.log(
                `  ⇢ ${neighbors.length} adjacent area(s) to warm: ${neighbors
                    .map((n) => n.name)
                    .join(", ")}`,
            );
        }
        for (const n of neighbors) {
            if (globalSeen.has(n.relationId)) continue;
            globalSeen.add(n.relationId);
            try {
                await processCity(n);
                // v727: an adjacent can ALSO be a valid PRIMARY play area —
                // someone searches "the Bronx" directly. processCity just
                // warmed its boundary+refs+stations+pack (v726) AND stored its
                // extent/name (ensureCityExtent), so verify + stamp its OWN
                // primary star too. Then it lights up starred when searched,
                // not only as an NYC add-on. (Best-effort; the primary's own
                // stamp below is unaffected.)
                if (DO_VERIFY) {
                    const nv = await verifyCity(n.relationId);
                    if (nv?.primaryCached) {
                        console.log(
                            `    ★ ${n.name} (r${n.relationId}) — adjacent also starred as a primary`,
                        );
                    }
                }
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
            } else if (v) {
                // v697: say WHY it's pending — primary short, or which
                // adjacent(s) didn't fully cache (usually an Overpass 504
                // that exhausted its retries; a re-run picks it up).
                const missing = Array.isArray(v.uncuratedNeighbours)
                    ? v.uncuratedNeighbours
                    : [];
                const reason = !v.primaryCached
                    ? "primary not fully cached"
                    : `${v.neighboursCurated}/${v.neighboursTotal} adjacents cached` +
                      (missing.length
                          ? `; missing r${missing.join(", r")}`
                          : "");
                console.log(`  ☆ ${city.name} — star pending: ${reason}`);
            } else {
                console.log(`  ☆ ${city.name} — star pending (verify failed)`);
            }
        } catch {
            /* verify is best-effort */
        }
    }
}

/**
 * v700: pull the CANONICAL reference/station/water filter set from the worker
 * (`/api/reference-filters`) and OVERRIDE the local hand-mirrored copies, so a
 * byte-drift in this script (e.g. the v686 consulate `="consulate"` →
 * `~"^consulate"` change that orphaned every laptop-warmed city's refs under a
 * dead R2 key) self-heals instead of silently warming to keys the worker/app
 * never read. Loud when it corrects a drift. Degrades to the local copies if
 * the endpoint is unreachable (an old worker without the route, offline, etc.)
 * — those copies are now correct, so a miss is safe.
 */
async function syncReferenceFilters() {
    let data;
    try {
        const resp = await fetchRetry(
            `${WORKER}/api/reference-filters`,
            {},
            "reference-filters",
        );
        if (!resp.ok) {
            console.warn(
                `! reference-filters HTTP ${resp.status} — using local filter copies`,
            );
            return;
        }
        data = await resp.json();
    } catch (e) {
        console.warn(
            `! reference-filters fetch failed (${e?.message ?? e}) — using local filter copies`,
        );
        return;
    }
    const applyList = (label, remote, localArr, toLocal, fromLocal) => {
        if (!Array.isArray(remote) || remote.length === 0) return;
        const before = localArr.map(fromLocal).join("\n");
        const after = remote.join("\n");
        if (before !== after) {
            console.warn(
                `  ! ${label} filters DRIFTED from the worker — overriding local copy:`,
            );
            console.warn(`      local : ${before.replace(/\n/g, " | ")}`);
            console.warn(`      worker: ${after.replace(/\n/g, " | ")}`);
        }
        return remote.map(toLocal);
    };
    const nextRef = applyList(
        "reference",
        data.referenceFilters,
        REFERENCE_FAMILY_FILTERS,
        (f) => ({ filter: f }),
        (o) => o.filter,
    );
    if (nextRef) REFERENCE_FAMILY_FILTERS = nextRef;
    const nextStations = applyList(
        "station",
        data.stationFilters,
        AREA_STATION_FILTERS,
        (f) => f,
        (f) => f,
    );
    if (nextStations) AREA_STATION_FILTERS = nextStations;
    const nextWater = applyList(
        "water",
        data.waterFilters,
        WATER_FILTERS,
        (f) => f,
        (f) => f,
    );
    if (nextWater) WATER_FILTERS = nextWater;
    const applyPad = (label, remote, local, set) => {
        if (typeof remote !== "number" || !Number.isFinite(remote)) return;
        if (remote !== local) {
            console.warn(
                `  ! ${label} pad DRIFTED (local ${local} km → worker ${remote} km) — overriding`,
            );
            set(remote);
        }
    };
    applyPad("reference", data.referencePadKm, PAD_KM_REF, (v) => {
        PAD_KM_REF = v;
    });
    applyPad("station", data.stationPadKm, PAD_KM_STATIONS, (v) => {
        PAD_KM_STATIONS = v;
    });
    applyPad("water", data.waterPadKm, PAD_KM_WATER, (v) => {
        PAD_KM_WATER = v;
    });
}

async function main() {
    console.log(`=== laptop-prewarm against ${WORKER} ===`);

    // Sync the cache-key filter set from the worker FIRST, before any query is
    // built, so we never warm to a drifted (dead) R2 key.
    await syncReferenceFilters();

    if (DO_TILE_PACKS) {
        tilePacksEnabled = checkPmtilesBinary();
        if (tilePacksEnabled) {
            // Auto-resolve the current basemap (unless --master-pmtiles was
            // given) so a rebuilt basemap doesn't silently extract packs from
            // a stale archive.
            if (!MASTER_PMTILES_EXPLICIT) {
                try {
                    const r = await fetchRetry(
                        `${WORKER}/api/basemap-url`,
                        {},
                        "basemap-url",
                    );
                    const j = await r.json().catch(() => null);
                    if (j?.url) {
                        MASTER_PMTILES_URL = j.url;
                        console.log(`  · resolved current basemap: ${j.key}`);
                        // FAST PATH: if a LOCAL copy of that exact basemap
                        // exists, extract from it instead of HTTP-ranging the
                        // (huge) remote master per city. `pmtiles extract`
                        // takes a local path as source. Looks for the same
                        // filename in the usual master-storage spots.
                        const local = findLocalBasemap(j.key);
                        if (local) {
                            MASTER_PMTILES_URL = local;
                            console.log(
                                `  · using LOCAL basemap copy (much faster): ${local}`,
                            );
                        }
                    } else {
                        console.warn(
                            `  ⚠ /api/basemap-url returned no basemap; using fallback ${MASTER_PMTILES_URL}`,
                        );
                    }
                } catch (e) {
                    console.warn(
                        `  ⚠ basemap auto-resolve failed (${e?.message ?? e}); using fallback ${MASTER_PMTILES_URL}`,
                    );
                }
            }
            console.log(
                `tile packs ENABLED (extracting from ${MASTER_PMTILES_URL})`,
            );
        } else {
            // v725: the star requires a pack, so a run that can't build one
            // will warm the data but earn NO stars. Make that loud.
            console.warn(
                "! tile packs DISABLED (pmtiles binary missing) — data will " +
                    "warm but cities will NOT earn a star (v725 gate). Install " +
                    "go-pmtiles, or pass --skip-tile-packs + set " +
                    'WARM_STAR_REQUIRE_PACK="false" on the worker for data-only stars.',
            );
        }
    } else {
        console.log(
            "tile packs skipped (--skip-tile-packs) — cities will not earn a " +
                "star unless WARM_STAR_REQUIRE_PACK=\"false\" on the worker.",
        );
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
        // v730: --only-city accepts a COMMA-SEPARATED list of names/ids (so
        // the --audit-encoding output pastes straight in). Each token is an
        // exact relation id or a name substring; matches are unioned + deduped.
        const tokens = String(ONLY_CITY)
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean);
        const seen = new Set();
        const matches = [];
        for (const tok of tokens) {
            const isId = /^\d+$/.test(tok);
            const needle = tok.toLowerCase();
            let hits = cities.filter((c) =>
                isId
                    ? String(c.relationId) === tok
                    : (c.name ?? "").toLowerCase().includes(needle),
            );
            // Numeric id not in the bundled list: synthesise it. processCity
            // derives the extent from the boundary query, so this is enough
            // to build/re-warm any OSM relation.
            if (hits.length === 0 && isId) {
                hits = [{ relationId: Number(tok), name: `r${tok}` }];
            }
            if (hits.length === 0) {
                console.warn(`  ! --only-city token "${tok}" matched nothing`);
            }
            for (const h of hits) {
                if (seen.has(h.relationId)) continue;
                seen.add(h.relationId);
                matches.push(h);
            }
        }
        if (matches.length === 0) {
            console.error(
                `--only-city "${ONLY_CITY}" matched no city. Pass OSM relation ` +
                    `id(s) instead of names to build them directly.`,
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
        // v701: --skip-starred — drop cities already carrying the star for
        // THIS pass (default = primary star; --adjacents = adjacent-ready),
        // so a restart doesn't re-walk finished cities.
        if (SKIP_STARRED) {
            const kind = DO_ADJACENTS ? "adjacent" : "warm";
            const starred = await fetchStarredRelationIds(kind);
            if (starred.size > 0) {
                const before = todo.length;
                todo = todo.filter((c) => !starred.has(String(c.relationId)));
                console.log(
                    `--skip-starred: skipped ${before - todo.length} already-${kind === "adjacent" ? "adjacent-ready" : "starred"} cities; ${todo.length} remain`,
                );
            } else {
                console.warn(
                    `--skip-starred: no ${kind} stars returned — processing all (endpoint empty/unreachable?)`,
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
    // v730: --audit-encoding — READ-ONLY probe of the scoped cities' endpoints
    // for poisoned entries. Runs instead of any warming, then exits.
    if (AUDIT_ENCODING) {
        await auditEncoding(todo);
        return;
    }

    // Nothing left to warm (everything already starred / filtered out). Exit
    // with a DISTINCT code so an outer restart loop knows to STOP looping
    // rather than spin. Only meaningful with --skip-starred / --cold-only.
    if (todo.length === 0) {
        console.log("=== nothing to do — all target cities already done ===");
        process.exit(3);
    }

    // v699.1: TWO-PHASE.
    //   --adjacents → processCityComplete per city (primary skip-if-fresh +
    //     adjacent areas via the worker's real neighbour set + stamp
    //     adjacentsCuratedAt). The dedup set starts EMPTY so a shared suburb
    //     isn't re-warmed across two adjacent cities, but each city still
    //     warms all its own neighbours (a neighbour that's also a seed city
    //     just re-hits skip-if-fresh when it comes up on its own).
    //   DEFAULT → PRIMARIES ONLY (no adjacents, no one-ring). Fast; the batch
    //     verify at the end stamps primaryCuratedAt (the ⭐).
    // The legacy one-ring pass (processOneRing/findNeighbors) is retired — its
    // admin_level-around discovery diverged from the star gate for megacities;
    // --adjacents uses the worker's authoritative set instead.
    const cityCompleteSeen = new Set();
    if (DO_ADJACENTS && !ONLY_CITY) {
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
        // v700: DEFAULT primaries-only pass. Verify + stamp the PRIMARY star
        // right after warming EACH city (not a batch at the end), so a star
        // appears the instant a city is fully cached — the operator watching
        // the log sees ★ per city instead of nothing until the whole run
        // finishes. The verify is read-only R2 HEADs (no Overpass), so it's
        // cheap per city.
        let starred = 0;
        for (let i = 0; i < todo.length; i++) {
            try {
                await processCity(todo[i]);
                if (DO_VERIFY && (await verifyPrimaryStar(todo[i]))) starred++;
            } catch (e) {
                console.warn(`! ${todo[i].name} failed:`, e?.message ?? e);
            }
            if ((i + 1) % 10 === 0) {
                console.log(
                    `--- progress: ${i + 1}/${todo.length} (${starred} starred) ---`,
                );
            }
        }
        if (DO_VERIFY) {
            console.log(
                `=== primaries done — ${starred}/${todo.length} starred ===`,
            );
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

    // v700: the DEFAULT (primaries-only) pass now verifies + stamps the star
    // per city inline (see the loop above), so no end-of-run batch verify is
    // needed. The --adjacents pass verifies inline too (processCityComplete).

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

// Keep an overnight run ALIVE through stray async faults. Without these,
// one unhandled promise rejection (or a throw in a callback the per-city
// try/catch can't see) makes Node exit — the "it stops before it's done"
// symptom. Log loudly and keep going; the run is per-city-idempotent and a
// restart with --skip-starred resumes anyway.
process.on("unhandledRejection", (e) => {
    console.warn("unhandledRejection (continuing):", e?.message ?? e);
});
process.on("uncaughtException", (e) => {
    console.warn("uncaughtException (continuing):", e?.message ?? e);
});

main().catch((e) => {
    console.error("fatal:", e);
    process.exit(1);
});
