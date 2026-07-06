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
 *   2. PHOTON reconcile (--reconcile, default ON) → for each city, forward-
 *      geocode its name the way the APP does and prefer the relation id
 *      PHOTON returns, because the in-app star matches a search result by
 *      `properties.osm_id`. A "correct" OSM id Photon never returns is
 *      useless (the London 65606-vs-175342 drift). Wikidata's id is the
 *      fallback when Photon yields nothing usable.
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
 *        [--email you@example.com]
 *
 *   --limit N       how many cities to pull from Wikidata (default 500;
 *                   raise to 3000 once you've validated the ids match).
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Top-N cities by population WITH an OSM relation id. P279* keeps it to
 *  city-like classes; if Wikidata times out, lower --limit or drop the
 *  transitive subclass hop. */
const SPARQL = `
SELECT ?city ?cityLabel ?pop ?osmrel WHERE {
  ?city wdt:P1082 ?pop .
  ?city wdt:P402 ?osmrel .
  ?city wdt:P31/wdt:P279* wd:Q515 .
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

/** Photon forward-geocode → the relation id the APP would resolve this
 *  name to. Returns the reconciled relationId (or null to keep Wikidata's). */
async function photonRelationId(name, wikidataRelId) {
    const url =
        "https://photon.komoot.io/api/?limit=8&q=" + encodeURIComponent(name);
    let json;
    try {
        const res = await fetch(url, { headers: { "User-Agent": UA } });
        if (!res.ok) return null;
        json = await res.json();
    } catch {
        return null;
    }
    const rels = (json.features ?? []).filter(
        (f) => f.properties?.osm_type === "R" && f.properties?.osm_id,
    );
    if (rels.length === 0) return null;
    // If Wikidata's id is among Photon's results, it agrees — keep it.
    if (rels.some((f) => f.properties.osm_id === wikidataRelId)) {
        return wikidataRelId;
    }
    // Otherwise prefer Photon's TOP relation for this name — that's the id
    // the in-app search will actually return, so the star will match.
    return rels[0].properties.osm_id;
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

    if (RECONCILE) {
        console.log(`[world-cities] reconciling ids via Photon (~1 req/s) …`);
        let fixed = 0;
        for (let i = 0; i < cities.length; i++) {
            const c = cities[i];
            const rid = await photonRelationId(c.name, c.relationId);
            if (rid && rid !== c.relationId) {
                c.relationId = rid;
                fixed++;
            }
            if ((i + 1) % 50 === 0) {
                console.log(`  … ${i + 1}/${cities.length} (${fixed} corrected)`);
            }
            await sleep(1100);
        }
        console.log(`[world-cities] reconcile done — ${fixed} ids corrected`);
        // Re-dedupe: a reconcile can collapse two names onto one relation.
        const seen = new Set();
        cities = cities.filter((c) =>
            seen.has(c.relationId) ? false : (seen.add(c.relationId), true),
        );
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
    let merged = cities;
    if (!REPLACE && existsSync(OUT)) {
        const prior = JSON.parse(readFileSync(OUT, "utf8"));
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
            (REPLACE ? " (replaced)" : " (merged)"),
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
