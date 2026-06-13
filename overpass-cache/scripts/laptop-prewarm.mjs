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
 *     [--skip-discover] [--skip-boundaries] [--skip-references] [--skip-hsr] \
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
 *   Once, after the city loop:
 *     3. HSR      — one `area["ISO3166-1"=XX]; way[...highspeed=yes]`
 *                   query per country in HSR_COUNTRIES. HSR is an
 *                   inter-city network, so it's keyed by country, not
 *                   city (v214).
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

import process from "node:process";

const args = parseArgs(process.argv.slice(2));
if (!args.worker || !args.secret) {
    console.error("usage: --worker URL --secret SECRET [--max N] [--delay-ms 2000]");
    process.exit(1);
}

const WORKER = args.worker.replace(/\/+$/, "");
const SECRET = args.secret;
const MAX_CITIES = args.max ? parseInt(args.max, 10) : Infinity;
const DELAY_MS = args["delay-ms"] ? parseInt(args["delay-ms"], 10) : 2000;
const DO_BOUNDARIES = !args["skip-boundaries"];
const DO_REFS = !args["skip-references"];
const DO_HSR = !args["skip-hsr"];
const DO_DISCOVER = !args["skip-discover"];

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
    "US",
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

// Byte-identical to buildHsrCountryQuery in overpass-cache/src/index.ts
// and src/maps/api/playAreaPrefetch.ts. The R2 key hashes this exact
// string.
function hsrCountryQuery(iso) {
    return `\n[out:json][timeout:180];\narea["ISO3166-1"="${iso}"]["admin_level"="2"]->.hsrArea;\nway["railway"="rail"]["highspeed"="yes"](area.hsrArea);\nout geom;\n`;
}

/* ------------------------- Network helpers ------------------------ */

async function fetchOverpass(query, label) {
    // Up to 3 attempts. Between attempts we re-check /api/status so a
    // 429 from a transient burst doesn't make us give up immediately —
    // but we don't loop forever either, since a persistent 429 means
    // the server genuinely wants us to back off and the cron / next
    // run will catch this city later.
    for (let attempt = 1; attempt <= 3; attempt++) {
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
                    `  ⚠ ${label} 429, retry ${attempt}/3 after ${waitSec} s`,
                );
                await sleep(waitSec * 1000);
                continue;
            }
            if (!resp.ok) {
                console.warn(
                    `  ✗ ${label} overpass ${resp.status} ${resp.statusText} (${dur} ms)`,
                );
                return null;
            }
            const text = await resp.text();
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
    console.warn(`  ✗ ${label} gave up after 3 attempts`);
    return null;
}

async function uploadToWorker({ query, body, kind, sourceName, sourceRelationId }) {
    const resp = await fetch(`${WORKER}/admin/store-prewarmed`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${SECRET}`,
        },
        body: JSON.stringify({
            query,
            body,
            kind,
            sourceName,
            sourceRelationId,
        }),
    });
    if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`store-prewarmed failed: ${resp.status} ${text}`);
    }
    return resp.json();
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

async function listCities() {
    const resp = await fetch(`${WORKER}/admin/list-cities`, {
        headers: { Authorization: `Bearer ${SECRET}` },
    });
    if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`list-cities failed: ${resp.status} ${text}`);
    }
    const data = await resp.json();
    return data.cities ?? [];
}

/* ----------------------------- Main ------------------------------ */

async function processCity(city) {
    console.log(`[${city.name}] r${city.relationId}`);

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

    if (DO_BOUNDARIES) {
        const q = boundaryQuery(city.relationId);
        if (await isFresh(q, "boundary")) {
            console.log(`  ⤼ boundary already cached — skipping`);
            // Still pull the extent from the cached boundary so refs+HSR
            // can run. We don't actually need to download it from
            // upstream — we have it in R2 — but the laptop script
            // doesn't have a direct R2 read path. Easiest: hit the
            // public /api/interpreter, which serves from R2 in <10 ms
            // on a hit, and parse the geometry locally. No upstream
            // traffic, no rate-limit cost.
            if (!effectiveExtent) {
                const cached = await fetchCached(q);
                if (cached) {
                    const derived = extentFromBoundaryResponse(cached);
                    if (derived) {
                        effectiveExtent = derived;
                        console.log(
                            `  ⌐ extent derived from cached boundary geom`,
                        );
                    }
                }
            }
        } else {
        const res = await fetchOverpass(q, "boundary");
        if (res) {
            const parsed = safeJSON(res.text);
            if (parsed && Array.isArray(parsed.elements) && parsed.elements.length > 0) {
                try {
                    const r = await uploadToWorker({
                        query: q,
                        body: parsed,
                        kind: "boundary",
                        sourceName: city.name,
                        sourceRelationId: String(city.relationId),
                    });
                    console.log(
                        `  ✓ boundary stored (${r.sizeBytes} B in ${res.ms} ms)`,
                    );
                } catch (e) {
                    console.warn(`  ✗ boundary upload: ${e.message}`);
                }
                if (!effectiveExtent) {
                    const derived = extentFromBoundaryResponse(parsed);
                    if (derived) {
                        effectiveExtent = derived;
                        console.log(
                            `  ⌐ extent derived from boundary geom: [${derived.map((n) => n.toFixed(3)).join(", ")}]`,
                        );
                    }
                }
            } else {
                console.warn(`  ⚠ boundary response empty / unparseable`);
            }
            await sleep(DELAY_MS);
        }
        }
    }

    if (!effectiveExtent && DO_REFS) {
        console.log(`  ⤼ no extent available — skipping refs`);
    }

    if (effectiveExtent && DO_REFS) {
        const q = referenceQuery(effectiveExtent);
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
                        body: parsed,
                        kind: "references",
                        sourceName: city.name,
                        sourceRelationId: String(city.relationId),
                    });
                    console.log(
                        `  ✓ refs stored (${r.sizeBytes} B in ${res.ms} ms, ${parsed.elements?.length ?? 0} elements)`,
                    );
                } catch (e) {
                    console.warn(`  ✗ refs upload: ${e.message}`);
                }
            }
            await sleep(DELAY_MS);
        }
        }
    }
    // HSR is no longer per-city — see processHsrCountries(), run once
    // after the whole city loop.
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
                    body: parsed,
                    kind: "hsr",
                    sourceName: iso,
                });
                console.log(
                    `  ✓ HSR ${iso} stored (${r.sizeBytes} B in ${res.ms} ms, ${parsed.elements?.length ?? 0} ways)`,
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
            resp = await fetch(`${WORKER}/admin/discover`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${SECRET}`,
                },
                body: JSON.stringify({ batch: 25 }),
            });
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
        const remaining = data.stillUnresolved ?? 0;
        console.log(
            `  call ${call + 1}: +${resolved} resolved, ${remaining} unresolved`,
        );
        if (remaining === 0) {
            console.log(`  discovery backlog empty`);
            break;
        }
        // Stall detection: if the unresolved count isn't dropping, the
        // front of the queue is either dead names mid-parking or names
        // that need more cron ticks to park. Either way the laptop
        // can't make further progress this run — bail rather than spin.
        if (remaining >= lastRemaining && resolved === 0) {
            stalls++;
            if (stalls >= 4) {
                console.log(
                    `  unresolved count flatlined at ${remaining} — stopping discovery`,
                );
                break;
            }
        } else {
            stalls = 0;
        }
        lastRemaining = remaining;
    }
}

async function main() {
    console.log(`=== laptop-prewarm against ${WORKER} ===`);

    if (DO_DISCOVER) {
        try {
            await drainDiscovery();
        } catch (e) {
            console.warn(`! discovery drain failed:`, e?.message ?? e);
        }
    }

    const cities = await listCities();
    console.log(`fetched ${cities.length} cities; processing up to ${MAX_CITIES}`);

    const todo = cities.slice(0, MAX_CITIES);
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

    // HSR runs once after the city loop — it's keyed by country, not
    // city, so iterating it per-city would just re-fetch the same ~25
    // national networks hundreds of times.
    if (DO_HSR) {
        try {
            await processHsrCountries();
        } catch (e) {
            console.warn(`! HSR pass failed:`, e?.message ?? e);
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
