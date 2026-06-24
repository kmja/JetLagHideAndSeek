#!/usr/bin/env node
/**
 * audit-city-drift.mjs
 *
 * Flags curated prewarm cities whose hardcoded OSM relation id does NOT
 * match what the CLIENT actually fetches. The client never uses the
 * curated id directly — it resolves the city NAME through Photon's
 * play-area search and fetches whatever relation that resolves to. When
 * the curated id (cities.ts / bulk-cities.json) and Photon's resolution
 * disagree, the prewarm warms a boundary the client never requests and
 * the city stays cold (the London 65606-vs-175342 bug).
 *
 * This script replicates the client's resolution EXACTLY — the same
 * Photon forward query, the same relation/place-or-boundary filter, the
 * same dedupe, and the same re-ranking (place-type + area + exact-name +
 * famous-country bonuses) from src/maps/api/geocode.ts — so the id it
 * computes is the one the client would fetch. Anything it flags as DRIFT
 * is a real mismatch to fix in cities.ts / bulk-cities.json.
 *
 * Runs on a machine with Photon access (the cache worker's sandbox can't
 * reach photon.komoot.io). It reads the merged city table from the
 * deployed worker's /admin/list-cities so the audit covers exactly what
 * gets prewarmed (hand-curated + bulk + discovered).
 *
 * Usage:
 *   node scripts/audit-city-drift.mjs \
 *     --worker https://jlhs-overpass-cache.<acct>.workers.dev \
 *     --secret <ADMIN_SECRET> \
 *     [--photon https://photon.komoot.io/api/] \
 *     [--lang en] [--delay-ms 1100] [--limit N] [--json]
 *
 * Output: a human-readable report grouped into DRIFT / NO-RESOLUTION /
 * ERROR / OK, plus a summary line. `--json` emits the raw findings array
 * instead (for piping into a fix script later).
 */

/* ───────────────────────── arg parsing ───────────────────────── */

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith("--")) continue;
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
            out[key] = true; // boolean flag
        } else {
            out[key] = next;
            i++;
        }
    }
    return out;
}

const args = parseArgs(process.argv.slice(2));
const WORKER = (args.worker || "").replace(/\/+$/, "");
const SECRET = args.secret;
const PHOTON = (args.photon || "https://photon.komoot.io/api/").replace(
    /\/+$/,
    "/",
);
const LANG = args.lang || "en";
const DELAY_MS = Number(args["delay-ms"] ?? 1100);
const LIMIT = args.limit ? Number(args.limit) : Infinity;
const AS_JSON = Boolean(args.json);
// --explain "Paris,Amsterdam" : diagnose WHY those names resolve the way
// they do (full candidate list + score breakdown). Doesn't need the
// worker/secret — it only hits Photon.
const EXPLAIN =
    typeof args.explain === "string"
        ? args.explain
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
        : null;

if (!EXPLAIN && (!WORKER || !SECRET)) {
    console.error(
        "Missing --worker and/or --secret.\n" +
            "Usage: node scripts/audit-city-drift.mjs --worker <url> --secret <ADMIN_SECRET>\n" +
            'Or diagnose specific cities: --explain "Paris,Amsterdam"',
    );
    process.exit(2);
}

/* ──────────────── client scoring (mirror of geocode.ts) ──────────────── */

// PLACE_TYPE_SCORE — copied verbatim from src/maps/api/geocode.ts. Keep
// in sync if that table changes.
const PLACE_TYPE_SCORE = {
    country: 1200,
    city: 1000,
    town: 900,
    municipality: 850,
    village: 800,
    suburb: 600,
    hamlet: 500,
    borough: 450,
    district: 400,
    neighbourhood: 300,
    quarter: 300,
    locality: 200,
    state: 500,
    region: 400,
    province: 300,
    county: 200,
    administrative: 100,
};

function stripSuffix(s) {
    return s.replace(
        /\s+(kommun|län|municipality|county|district|prefecture|province|borough)$/i,
        "",
    );
}

// Mirror of scorePlayAreaResult(). `originalIndex` is the position within
// the FILTERED+DEDUPED list (that's what geocode.ts passes the ranker).
function scorePlayAreaResult(p, originalIndex, query) {
    const name = (p.name ?? "").toLowerCase();
    const q = query.toLowerCase().trim();

    const photonRankBonus = 80 / Math.sqrt(originalIndex + 1);

    const typeFromValue = PLACE_TYPE_SCORE[(p.osm_value ?? "").toLowerCase()] ?? 0;
    const typeFromType = PLACE_TYPE_SCORE[(p.type ?? "").toLowerCase()] ?? 0;
    const typeBonus = Math.max(typeFromValue, typeFromType);

    let areaBonus = 0;
    const extent = p.extent;
    if (extent && extent.length >= 4) {
        // Photon raw extent is [west, north, east, south] =
        // [minLng, maxLat, maxLng, minLat]. The client swaps it before
        // scoring, but the area math uses absolute differences and the
        // midpoint, both order-independent — so compute straight from the
        // raw lat pair (1,3) and lng pair (0,2).
        const latA = extent[1];
        const latB = extent[3];
        const lngA = extent[0];
        const lngB = extent[2];
        if (
            [latA, latB, lngA, lngB].every((v) => typeof v === "number")
        ) {
            const midLat = (latA + latB) / 2;
            const km2 =
                Math.abs(latA - latB) *
                111 *
                Math.abs(lngA - lngB) *
                111 *
                Math.cos((midLat * Math.PI) / 180);
            if (km2 > 0) areaBonus = Math.min(600, Math.log10(km2) * 100);
        }
    }

    const strippedName = stripSuffix(name);
    const strippedQ = stripSuffix(q);
    let exactNameBonus = 0;
    if (strippedName === strippedQ) exactNameBonus = 500;
    else if (strippedName.startsWith(strippedQ + " ")) exactNameBonus = 300;

    return photonRankBonus + typeBonus + areaBonus + exactNameBonus;
}

/**
 * Resolve a query string to the relation id the CLIENT would fetch.
 * Mirrors geocode(address, lang, filter=true) → rankPlayAreaResults()[0].
 * Returns { resolvedId, resolvedName, candidates } or { error }.
 */
async function resolveLikeClient(query) {
    const url = `${PHOTON}?lang=${encodeURIComponent(LANG)}&q=${encodeURIComponent(query)}`;
    let res;
    try {
        res = await fetch(url, { headers: { Accept: "application/json" } });
    } catch (e) {
        return { error: `fetch failed: ${e.message ?? e}` };
    }
    if (res.status === 429) return { error: "photon 429 (rate limited)" };
    if (!res.ok) return { error: `photon ${res.status}` };
    let json;
    try {
        json = await res.json();
    } catch (e) {
        return { error: `bad JSON: ${e.message ?? e}` };
    }
    const features = json.features ?? [];

    // famousCountry = country of Photon's RAW #1 result (before filter).
    const famousCountry = features[0]?.properties?.country ?? null;

    // Filter to place/boundary relations, dedupe by osm_id (first wins).
    const seen = new Set();
    const deduped = [];
    for (const f of features) {
        const p = f.properties ?? {};
        if (p.osm_type !== "R") continue;
        const key = (p.osm_key ?? "").toLowerCase();
        if (key !== "place" && key !== "boundary") continue;
        if (seen.has(p.osm_id)) continue;
        seen.add(p.osm_id);
        deduped.push(p);
    }
    if (deduped.length === 0) {
        return { resolvedId: null, resolvedName: null, candidates: [] };
    }

    const scored = deduped.map((p, originalIndex) => {
        const base = scorePlayAreaResult(p, originalIndex, query);
        const country = (p.country ?? "").toLowerCase();
        const famousBonus =
            famousCountry && country === famousCountry.toLowerCase() ? 700 : 0;
        return { p, score: base + famousBonus, originalIndex };
    });
    scored.sort((a, b) =>
        b.score !== a.score ? b.score - a.score : a.originalIndex - b.originalIndex,
    );

    const top = scored[0].p;
    return {
        resolvedId: top.osm_id ?? null,
        resolvedName: top.name ?? null,
        candidates: scored.slice(0, 3).map((s) => ({
            id: s.p.osm_id,
            name: s.p.name,
            score: Math.round(s.score),
        })),
    };
}

/* ───────────────────────────── main ───────────────────────────── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The query a user actually types is the bare city name — strip a
// trailing ", <country/state>" (e.g. "London, UK" → "London"). This is
// what the client's play-area search sees; the famous-country re-rank
// then disambiguates same-named places.
function queryFromName(name) {
    const comma = name.indexOf(",");
    return (comma === -1 ? name : name.slice(0, comma)).trim();
}

/**
 * Diagnostic: print the full candidate list + score breakdown for a
 * query, so we can see WHY the winner won (e.g. a larger same-named
 * relation beating the canonical city on area). Mirrors resolveLikeClient
 * but exposes every candidate and its score components.
 */
async function explainQuery(rawName) {
    const query = queryFromName(rawName);
    const url = `${PHOTON}?lang=${encodeURIComponent(LANG)}&q=${encodeURIComponent(query)}`;
    console.log(`\n=== "${rawName}"  (query="${query}") ===`);
    let res;
    try {
        res = await fetch(url, { headers: { Accept: "application/json" } });
    } catch (e) {
        console.log(`  fetch failed: ${e.message ?? e}`);
        return;
    }
    if (!res.ok) {
        console.log(`  photon ${res.status}`);
        return;
    }
    const features = (await res.json()).features ?? [];
    const famousCountry = features[0]?.properties?.country ?? null;
    console.log(
        `  raw #1 country (famous-bonus anchor): ${famousCountry ?? "(none)"}`,
    );
    const seen = new Set();
    const cands = [];
    for (const f of features) {
        const p = f.properties ?? {};
        if (p.osm_type !== "R") continue;
        const key = (p.osm_key ?? "").toLowerCase();
        if (key !== "place" && key !== "boundary") continue;
        if (seen.has(p.osm_id)) continue;
        seen.add(p.osm_id);
        cands.push(p);
    }
    if (cands.length === 0) {
        console.log("  no place/boundary relations");
        return;
    }
    const rows = cands.map((p, i) => {
        const base = scorePlayAreaResult(p, i, query);
        const country = (p.country ?? "").toLowerCase();
        const famous =
            famousCountry && country === famousCountry.toLowerCase() ? 700 : 0;
        return { p, i, base, famous, score: base + famous };
    });
    rows.sort((a, b) => b.score - a.score || a.i - b.i);
    for (const r of rows) {
        const p = r.p;
        console.log(
            `  ${String(Math.round(r.score)).padStart(5)}  id=${String(p.osm_id).padEnd(9)} ` +
                `${(p.name ?? "?").padEnd(22)} key=${p.osm_key}/${p.osm_value ?? "-"} type=${p.type ?? "-"} ` +
                `country=${p.country ?? "-"} famous=${r.famous}`,
        );
    }
    console.log(`  -> winner: ${rows[0].p.osm_id} (${rows[0].p.name})`);
}

async function main() {
    if (EXPLAIN) {
        for (let i = 0; i < EXPLAIN.length; i++) {
            await explainQuery(EXPLAIN[i]);
            if (i < EXPLAIN.length - 1) await sleep(DELAY_MS);
        }
        return;
    }
    const listUrl = `${WORKER}/admin/list-cities?secret=${encodeURIComponent(SECRET)}`;
    let cities;
    try {
        const r = await fetch(listUrl, { headers: { Accept: "application/json" } });
        if (!r.ok) {
            console.error(`/admin/list-cities returned ${r.status}`);
            process.exit(1);
        }
        cities = (await r.json()).cities ?? [];
    } catch (e) {
        console.error(`Failed to fetch city list: ${e.message ?? e}`);
        process.exit(1);
    }

    const subset = cities.slice(0, LIMIT);
    if (!AS_JSON) {
        console.log(
            `Auditing ${subset.length}/${cities.length} cities against ${PHOTON} (lang=${LANG}, ${DELAY_MS}ms apart)\n`,
        );
    }

    const findings = [];
    for (let i = 0; i < subset.length; i++) {
        const city = subset[i];
        const query = queryFromName(city.name);
        const r = await resolveLikeClient(query);
        let status;
        if (r.error) status = "ERROR";
        else if (r.resolvedId === null) status = "NO-RESOLUTION";
        else if (String(r.resolvedId) === String(city.relationId)) status = "OK";
        else status = "DRIFT";

        findings.push({
            name: city.name,
            query,
            curatedId: city.relationId,
            resolvedId: r.resolvedId ?? null,
            resolvedName: r.resolvedName ?? null,
            status,
            error: r.error ?? null,
            candidates: r.candidates ?? [],
        });

        if (!AS_JSON) {
            const tag =
                status === "DRIFT"
                    ? "DRIFT  "
                    : status === "NO-RESOLUTION"
                      ? "NO-RES "
                      : status === "ERROR"
                        ? "ERROR  "
                        : "ok     ";
            const detail =
                status === "DRIFT"
                    ? `curated ${city.relationId} → photon ${r.resolvedId} (${r.resolvedName})`
                    : status === "NO-RESOLUTION"
                      ? `curated ${city.relationId} → photon found no place/boundary relation`
                      : status === "ERROR"
                        ? r.error
                        : `${city.relationId}`;
            console.log(
                `[${i + 1}/${subset.length}] ${tag} ${city.name}  (q="${query}")  ${detail}`,
            );
        }

        if (i < subset.length - 1) await sleep(DELAY_MS);
    }

    if (AS_JSON) {
        console.log(JSON.stringify(findings, null, 2));
        return;
    }

    const by = (s) => findings.filter((f) => f.status === s);
    const drift = by("DRIFT");
    const nores = by("NO-RESOLUTION");
    const errs = by("ERROR");
    console.log(
        `\nSummary: ${by("OK").length} ok, ${drift.length} drift, ${nores.length} no-resolution, ${errs.length} error (of ${findings.length})`,
    );
    if (drift.length > 0) {
        console.log("\nDRIFT (fix the curated id to the resolved one):");
        for (const f of drift) {
            console.log(
                `  ${f.name}: ${f.curatedId} → ${f.resolvedId}  (${f.resolvedName})`,
            );
        }
    }
    if (errs.length > 0) {
        console.log(
            "\nERRORs were likely Photon rate-limiting — re-run with a larger --delay-ms to re-check those.",
        );
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
