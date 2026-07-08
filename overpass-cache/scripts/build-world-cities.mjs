#!/usr/bin/env node
/**
 * build-world-cities.mjs — regenerate `overpass-cache/world-cities.json`,
 * the SINGLE canonical prewarm seed list (top-N biggest cities worldwide).
 *
 * Why this exists: there is no free dataset of "biggest city → the exact
 * OSM relation id the app's search returns". Population lists lack OSM ids;
 * OSM lacks a population ranking. This script joins them:
 *
 *   1. WIKIDATA (one SPARQL query) → the top-N cities by population, each
 *      with its OSM relation id (P402) and country code. Free, keyless.
 *   2. PHOTON reconcile (--reconcile, default ON) → for each city, resolve
 *      its name through the APP'S EXACT play-area ranking (a verbatim port
 *      of geocode.ts's rankPlayAreaResults) and take the top relation. The
 *      in-app star matches a search result by `properties.osm_id`, so the
 *      baked id must be the one the app's search returns — this makes the
 *      seed correct BY CONSTRUCTION (no hand-maintained override list). A
 *      "correct" OSM id the app never surfaces is useless (the London
 *      65606-vs-175342 drift). Wikidata's id is the fallback when Photon
 *      yields no usable relation.
 *   3. EXTENT (--extent, default OFF) → derive each relation's bbox via
 *      polygons.osm.fr (same source the client uses). Optional because the
 *      worker cron/laptop already backfill extents; bake them only if you
 *      want the seed self-contained.
 *
 * Output entry shape: { name, relationId, population?, extent? } where
 * extent is Photon-style [maxLat, minLng, minLat, maxLng]. cities.ts reads
 * this file as the bundled seed; the R2 growth/state doc adds player-picked
 * areas + curation stamps on top (see getPopularCities).
 *
 * Usage:
 *   node scripts/build-world-cities.mjs [--limit N] [--no-reconcile]
 *        [--extent] [--replace] [--out world-cities.json]
 *        [--region na,eu] [--continents Q49,Q46] [--new-limit N]
 *        [--email you@example.com]
 *
 *   --limit N       how many cities to pull from Wikidata (default 500;
 *                   raise to 3000 once you've validated the ids match).
 *                   With --region/--continents, set this to a BUFFER above
 *                   --new-limit (the top cities in a region are usually
 *                   already seeded, so query more to find N NEW ones).
 *   --region R      convenience continent filter — comma list of aliases:
 *                   na (North America), eu (Europe), sa, af, as, oc.
 *                   Maps to Wikidata continent QIDs. e.g. --region na,eu.
 *   --continents Q  explicit Wikidata continent QIDs (comma), if you want
 *                   ids not covered by --region. Merged with --region.
 *   --new-limit N   in MERGE mode, cap the run to the N BIGGEST cities that
 *                   aren't already in the file (by population). Existing
 *                   entries are always kept; this only bounds how many NEW
 *                   ones this run appends. Ignored with --replace.
 *   --no-reconcile  skip the Photon id-agreement pass (faster, riskier).
 *   --extent        derive + bake each city's bbox (adds ~1 req/city).
 *   --replace       overwrite the file; default MERGES into the existing
 *                   list (existing entries kept, new ones appended, ids
 *                   reconciled in place).
 *   --email         contact for the Wikidata/Photon User-Agent (be polite).
 *
 * All three services are free + keyless. Photon/polygons are rate-limited,
 * so the script self-throttles (~1 req/s). Runs on your machine — the CI
 * sandbox's egress policy blocks Wikidata/Photon.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..");

function arg(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    if (i === -1) return fallback;
    const next = process.argv[i + 1];
    if (!next || next.startsWith("--")) return true; // boolean flag
    return next;
}
const LIMIT = parseInt(arg("limit", "500"), 10) || 500;
const RECONCILE = arg("no-reconcile", false) ? false : true;
const DO_EXTENT = !!arg("extent", false);
const REPLACE = !!arg("replace", false);
const OUT = resolve(PKG_ROOT, String(arg("out", "world-cities.json")));
const EMAIL = String(arg("email", "worldcities@example.com"));
const UA = `JetLagHideAndSeek-worldcities/1.0 (${EMAIL})`;
const NEW_LIMIT = arg("new-limit", false)
    ? parseInt(String(arg("new-limit")), 10) || 0
    : 0;

// Continent filter (--region aliases + --continents QIDs). Empty = worldwide.
const REGION_TO_QID = {
    na: "Q49", // North America
    eu: "Q46", // Europe
    sa: "Q18", // South America
    af: "Q15", // Africa
    as: "Q48", // Asia
    oc: "Q55643", // Oceania
};
const continentQids = new Set();
const regionArg = arg("region", false);
if (regionArg && typeof regionArg === "string") {
    for (const r of regionArg.split(",").map((s) => s.trim().toLowerCase())) {
        if (REGION_TO_QID[r]) continentQids.add(REGION_TO_QID[r]);
        else if (r) console.warn(`[world-cities] unknown --region "${r}"`);
    }
}
const continentsArg = arg("continents", false);
if (continentsArg && typeof continentsArg === "string") {
    for (const q of continentsArg.split(",").map((s) => s.trim())) {
        if (/^Q\d+$/.test(q)) continentQids.add(q);
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Top-N cities by population WITH an OSM relation id. P279* keeps it to
 *  city-like classes; if Wikidata times out, lower --limit or drop the
 *  transitive subclass hop. When continents are given, join through the
 *  city's country (P17) to its continent (P30) and filter — so a run can
 *  target just North America + Europe, etc. */
const continentFilter =
    continentQids.size > 0
        ? `  ?city wdt:P17 ?country .
  ?country wdt:P30 ?continent .
  FILTER(?continent IN (${[...continentQids].map((q) => `wd:${q}`).join(", ")}))`
        : "";
const SPARQL = `
SELECT DISTINCT ?city ?cityLabel ?pop ?osmrel WHERE {
  ?city wdt:P1082 ?pop .
  ?city wdt:P402 ?osmrel .
  ?city wdt:P31/wdt:P279* wd:Q515 .
${continentFilter}
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul". }
}
ORDER BY DESC(?pop)
LIMIT ${LIMIT}
`;

async function fetchWikidata() {
    const url =
        "https://query.wikidata.org/sparql?format=json&query=" +
        encodeURIComponent(SPARQL);
    const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/sparql-results+json" },
    });
    if (!res.ok) throw new Error(`Wikidata ${res.status}: ${await res.text()}`);
    const json = await res.json();
    const rows = json.results?.bindings ?? [];
    const out = [];
    const seen = new Set();
    for (const r of rows) {
        const relationId = parseInt(r.osmrel?.value ?? "", 10);
        const name = r.cityLabel?.value ?? "";
        const population = parseInt(r.pop?.value ?? "", 10) || undefined;
        if (!Number.isFinite(relationId) || relationId <= 0) continue;
        if (!name || name.startsWith("Q")) continue; // unlabeled
        if (seen.has(relationId)) continue;
        seen.add(relationId);
        out.push({ name, relationId, population });
    }
    return out;
}

// ─────────────────────────────────────────────────────────────────────
// App-identical play-area ranking. PORTED VERBATIM from the client's
// src/maps/api/geocode.ts (PLACE_TYPE_SCORE + scorePlayAreaResult +
// rankPlayAreaResults + the geocode() filter/dedupe). This MUST stay in
// sync with geocode.ts: the in-app play-area search stars a result by its
// osm_id, so the generator has to pick the SAME relation the app's search
// would return — otherwise a baked id silently fails to match the star.
// Keeping it identical is what lets us drop the hand-maintained override
// list entirely (the seed is correct by construction).
// ─────────────────────────────────────────────────────────────────────
const PLACE_TYPE_SCORE = {
    country: 1200,
    city: 1000, town: 900, municipality: 850, village: 800, suburb: 600,
    hamlet: 500, borough: 450, district: 400, neighbourhood: 300, quarter: 300,
    locality: 200,
    state: 500, region: 400, province: 300, county: 200, administrative: 100,
};

function scorePlayAreaResult(feature, originalIndex, query) {
    const p = feature.properties ?? {};
    const name = (p.name ?? "").toLowerCase();
    const q = query.toLowerCase().trim();
    const photonRankBonus = 80 / Math.sqrt(originalIndex + 1);
    const typeFromValue = PLACE_TYPE_SCORE[(p.osm_value ?? "").toLowerCase()] ?? 0;
    const typeFromType = PLACE_TYPE_SCORE[(p.type ?? "").toLowerCase()] ?? 0;
    const typeBonus = Math.max(typeFromValue, typeFromType);
    let areaBonus = 0;
    const extent = p.extent; // app-order [maxLat, minLng, minLat, maxLng]
    if (extent && extent.length >= 4) {
        const [maxLat, minLng, minLat, maxLng] = extent;
        if ([maxLat, minLat, minLng, maxLng].every((n) => typeof n === "number")) {
            const midLat = (maxLat + minLat) / 2;
            const km2 =
                Math.abs(maxLat - minLat) * 111 *
                Math.abs(maxLng - minLng) * 111 *
                Math.cos((midLat * Math.PI) / 180);
            if (km2 > 0) areaBonus = Math.min(600, Math.log10(km2) * 100);
        }
    }
    const stripSuffix = (s) =>
        s.replace(
            /\s+(kommun|län|municipality|county|district|prefecture|province|borough)$/i,
            "",
        );
    const strippedName = stripSuffix(name);
    const strippedQ = stripSuffix(q);
    let exactNameBonus = 0;
    if (strippedName === strippedQ) exactNameBonus = 500;
    else if (strippedName.startsWith(strippedQ + " ")) exactNameBonus = 300;
    return photonRankBonus + typeBonus + areaBonus + exactNameBonus;
}

function rankPlayAreaResults(features, query, famousCountry) {
    const scored = features.map((feature, originalIndex) => {
        const base = scorePlayAreaResult(feature, originalIndex, query);
        const country = (feature.properties?.country ?? "").toLowerCase();
        const famousBonus =
            famousCountry && country === famousCountry.toLowerCase() ? 700 : 0;
        return { feature, score: base + famousBonus, originalIndex };
    });
    scored.sort((a, b) =>
        b.score !== a.score ? b.score - a.score : a.originalIndex - b.originalIndex,
    );
    return scored.map((s) => s.feature);
}

/** Resolve a city name to a relation EXACTLY as the app's play-area search
 *  does (geocode(name, "en", true)) and return the top relation's id — the
 *  id the in-app star will match. Falls back to Wikidata's id when Photon
 *  yields no usable relation. */
async function appResolveRelationId(name, wikidataRelId) {
    const url =
        "https://photon.komoot.io/api/?lang=en&q=" + encodeURIComponent(name);
    let features;
    try {
        const res = await fetch(url, { headers: { "User-Agent": UA } });
        if (!res.ok) return wikidataRelId;
        features = (await res.json()).features ?? [];
    } catch {
        return wikidataRelId;
    }
    // Convert Photon extent [minLng,maxLat,maxLng,minLat] → app order
    // [maxLat,minLng,minLat,maxLng], mirroring geocode().
    for (const f of features) {
        const e = f.properties?.extent;
        if (e && e.length >= 4) {
            f.properties.extent = [e[1], e[0], e[3], e[2]];
        }
    }
    const famousCountry = features[0]?.properties?.country ?? null;
    const seen = new Set();
    const deduped = features.filter((f) => {
        const pr = f.properties ?? {};
        if (pr.osm_type !== "R") return false;
        const key = (pr.osm_key ?? "").toLowerCase();
        if (key !== "place" && key !== "boundary") return false;
        if (seen.has(pr.osm_id)) return false;
        seen.add(pr.osm_id);
        return true;
    });
    if (deduped.length === 0) return wikidataRelId;
    const ranked = rankPlayAreaResults(deduped, name, famousCountry);
    return ranked[0]?.properties?.osm_id ?? wikidataRelId;
}

/** polygons.osm.fr bbox → Photon-style [maxLat, minLng, minLat, maxLng]. */
async function deriveExtent(relationId) {
    const url = `https://polygons.openstreetmap.fr/get_geojson.py?id=${relationId}&params=0`;
    let gj;
    try {
        const res = await fetch(url, { headers: { "User-Agent": UA } });
        if (!res.ok) return null;
        gj = await res.json();
    } catch {
        return null;
    }
    let minLat = Infinity,
        minLng = Infinity,
        maxLat = -Infinity,
        maxLng = -Infinity;
    const visit = (coords) => {
        if (typeof coords[0] === "number") {
            const [lng, lat] = coords;
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
            if (lng < minLng) minLng = lng;
            if (lng > maxLng) maxLng = lng;
            return;
        }
        for (const c of coords) visit(c);
    };
    try {
        visit(gj.coordinates ?? gj.geometry?.coordinates ?? []);
    } catch {
        return null;
    }
    if (!Number.isFinite(minLat) || !Number.isFinite(maxLng)) return null;
    return [maxLat, minLng, minLat, maxLng];
}

async function main() {
    console.log(
        `[world-cities] fetching top ${LIMIT} cities from Wikidata …`,
    );
    let cities = await fetchWikidata();
    console.log(`[world-cities] Wikidata returned ${cities.length} cities`);

    // Load the existing file up front so we can tell NEW cities from ones
    // already seeded — both for the --new-limit cap and the early-stop that
    // avoids reconciling the whole buffer once we have enough new ones.
    let prior = [];
    if (!REPLACE && existsSync(OUT)) {
        try {
            prior = JSON.parse(readFileSync(OUT, "utf8"));
        } catch {
            prior = [];
        }
    }
    const priorIds = new Set(prior.map((c) => c.relationId));

    if (RECONCILE) {
        console.log(
            `[world-cities] reconciling ids via Photon (~1 req/s)` +
                (NEW_LIMIT ? `, stopping at ${NEW_LIMIT} new` : "") +
                ` …`,
        );
        let fixed = 0;
        let newCount = 0;
        const seen = new Set();
        const kept = [];
        for (let i = 0; i < cities.length; i++) {
            const c = cities[i];
            const rid = await appResolveRelationId(c.name, c.relationId);
            if (rid && rid !== c.relationId) {
                c.relationId = rid;
                fixed++;
            }
            // Re-dedupe: a reconcile can collapse two names onto one relation.
            if (seen.has(c.relationId)) {
                await sleep(1100);
                continue;
            }
            seen.add(c.relationId);
            kept.push(c);
            if (!priorIds.has(c.relationId)) newCount++;
            if ((i + 1) % 50 === 0) {
                console.log(
                    `  … ${i + 1}/${cities.length} (${fixed} corrected, ${newCount} new)`,
                );
            }
            // Early stop: we have the N biggest not-yet-seeded cities (the
            // SPARQL is population-desc, so these ARE the biggest new ones).
            if (NEW_LIMIT && newCount >= NEW_LIMIT) {
                console.log(
                    `[world-cities] reached --new-limit ${NEW_LIMIT} new cities — stopping early`,
                );
                break;
            }
            await sleep(1100);
        }
        cities = kept;
        console.log(
            `[world-cities] reconcile done — ${fixed} ids corrected, ${newCount} new`,
        );
    } else if (NEW_LIMIT) {
        // No reconcile: cap by Wikidata id vs the existing file.
        const seen = new Set();
        const kept = [];
        let newCount = 0;
        for (const c of cities) {
            if (seen.has(c.relationId)) continue;
            seen.add(c.relationId);
            kept.push(c);
            if (!priorIds.has(c.relationId)) newCount++;
            if (newCount >= NEW_LIMIT) break;
        }
        cities = kept;
    }

    if (DO_EXTENT) {
        console.log(`[world-cities] deriving extents via polygons.osm.fr …`);
        for (let i = 0; i < cities.length; i++) {
            const ext = await deriveExtent(cities[i].relationId);
            if (ext) cities[i].extent = ext;
            if ((i + 1) % 50 === 0) {
                console.log(`  … ${i + 1}/${cities.length}`);
            }
            await sleep(1100);
        }
    }

    // Merge into (or replace) the existing file.
    const newlyAdded = cities.filter((c) => !priorIds.has(c.relationId)).length;
    let merged = cities;
    if (!REPLACE && prior.length > 0) {
        const byId = new Map();
        for (const c of prior) byId.set(c.relationId, c);
        for (const c of cities) byId.set(c.relationId, { ...byId.get(c.relationId), ...c });
        merged = [...byId.values()];
    }
    // Stable order: population desc (unranked last), then name.
    merged.sort(
        (a, b) =>
            (b.population ?? -1) - (a.population ?? -1) ||
            String(a.name).localeCompare(String(b.name)),
    );
    writeFileSync(OUT, JSON.stringify(merged, null, 0) + "\n");
    console.log(
        `[world-cities] wrote ${merged.length} cities → ${OUT}` +
            (REPLACE
                ? " (replaced)"
                : ` (merged; +${newlyAdded} new, ${prior.length} kept)`),
    );
    console.log(
        `[world-cities] next: commit the file, then the cron/laptop caches ` +
            `each city + its adjacents; the star lights up as fullyCuratedAt lands.`,
    );
}

main().catch((e) => {
    console.error("[world-cities] FAILED:", e);
    process.exit(1);
});
