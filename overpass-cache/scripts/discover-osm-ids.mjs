#!/usr/bin/env node
/**
 * Photon-powered discovery: turn a list of "City, Country"
 * strings into an array of { name, relationId } entries you can
 * feed to bulk-prewarm.mjs. Use when you want to grow
 * bulk-cities.json beyond the hand-curated starter set.
 *
 * Input file format (JSON):
 *   ["Stockholm, Sweden", "Manchester, United Kingdom", ...]
 *
 * Output (also JSON, suitable for bulk-prewarm directly):
 *   [
 *     { "name": "Stockholm, Sweden", "relationId": 398021 },
 *     { "name": "Manchester, United Kingdom", "relationId": 88084 },
 *     ...
 *   ]
 *
 * Photon's free tier is sturdy but not unlimited — the script
 * paces itself at ~1 req/s by default. For 1000 cities expect
 * 15–20 minutes of wall clock.
 *
 * Usage:
 *   node scripts/discover-osm-ids.mjs \
 *     --input ./names.json \
 *     --output ./bulk-cities.json \
 *     [--delay 1000] \
 *     [--append]                 # merge with an existing output
 */

import fs from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
    const args = { _: [] };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith("--")) {
            const key = a.slice(2);
            const next = argv[i + 1];
            if (next === undefined || next.startsWith("--")) {
                args[key] = true;
            } else {
                args[key] = next;
                i++;
            }
        } else {
            args._.push(a);
        }
    }
    return args;
}

function fail(msg, code = 1) {
    console.error(`✗ ${msg}`);
    process.exit(code);
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

/** Photon's `/api/?q=…` returns features ranked by their
 *  popularity score. For city-scale boundaries we want the
 *  highest-osm_value `city`/`town`/`municipality`/`county`
 *  /`state` feature whose `osm_type === "R"` (relation). */
async function resolveRelationId(name) {
    const u = new URL("https://photon.komoot.io/api/");
    u.searchParams.set("q", name);
    u.searchParams.set("limit", "10");
    u.searchParams.set("lang", "en");
    const resp = await fetch(u.toString(), {
        headers: { Accept: "application/json" },
    });
    if (!resp.ok) {
        throw new Error(`Photon HTTP ${resp.status}`);
    }
    const data = await resp.json();
    const features = data.features || [];
    // Filter: relations only, with an osm_id; prefer admin levels.
    const relations = features.filter(
        (f) =>
            f.properties &&
            f.properties.osm_type === "R" &&
            typeof f.properties.osm_id === "number",
    );
    if (relations.length === 0) return null;
    // Prefer features whose osm_value is an admin-ish type. Falls
    // back to the first relation if none match — usually fine.
    const ADMIN_PREFS = new Set([
        "city",
        "town",
        "municipality",
        "county",
        "state",
        "administrative",
        "region",
    ]);
    const sorted = [...relations].sort((a, b) => {
        const aw = ADMIN_PREFS.has(a.properties.osm_value) ? 1 : 0;
        const bw = ADMIN_PREFS.has(b.properties.osm_value) ? 1 : 0;
        return bw - aw;
    });
    return sorted[0].properties.osm_id;
}

async function main() {
    const args = parseArgs(process.argv);
    const inputPath = args.input;
    const outputPath = args.output;
    if (!inputPath) fail("--input <names.json> is required");
    if (!outputPath) fail("--output <bulk-cities.json> is required");
    const delay = parseInt(args.delay || "1000", 10);

    const raw = await fs.readFile(path.resolve(inputPath), "utf8");
    let names;
    try {
        names = JSON.parse(raw);
    } catch (e) {
        fail(`Input not valid JSON: ${e.message}`);
    }
    if (!Array.isArray(names)) fail("Input must be a JSON array of strings.");

    /** Pre-load existing output so --append doesn't lose work. */
    let existing = [];
    if (args.append) {
        try {
            const raw = await fs.readFile(path.resolve(outputPath), "utf8");
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) existing = parsed;
        } catch {
            /* file didn't exist or unparseable — start fresh */
        }
    }
    const seenNames = new Set(existing.map((e) => e.name));
    const seenIds = new Set(existing.map((e) => e.relationId));

    console.log(
        `▶ Resolving ${names.length} city names via Photon ` +
            `(delay=${delay} ms)`,
    );
    const out = [...existing];
    let resolved = 0;
    let skipped = 0;
    let failed = 0;
    for (let i = 0; i < names.length; i++) {
        const name = names[i];
        if (typeof name !== "string" || name.trim() === "") {
            console.warn(`  · #${i} skipped: not a string`);
            skipped++;
            continue;
        }
        if (seenNames.has(name)) {
            console.log(`  · ${name} — already in output`);
            skipped++;
            continue;
        }
        try {
            const id = await resolveRelationId(name);
            if (!id) {
                console.warn(`  ✗ ${name} — no relation match`);
                failed++;
            } else if (seenIds.has(id)) {
                console.log(`  · ${name} — relation ${id} already known`);
                skipped++;
            } else {
                console.log(`  ✓ ${name} → ${id}`);
                out.push({ name, relationId: id });
                seenNames.add(name);
                seenIds.add(id);
                resolved++;
                // Checkpoint every 25 resolves so a crash mid-run
                // doesn't lose progress.
                if (resolved % 25 === 0) {
                    await fs.writeFile(
                        path.resolve(outputPath),
                        JSON.stringify(out, null, 2) + "\n",
                    );
                }
            }
        } catch (e) {
            console.error(`  ✗ ${name} — ${e.message}`);
            failed++;
        }
        if (i < names.length - 1 && delay > 0) await sleep(delay);
    }

    await fs.writeFile(
        path.resolve(outputPath),
        JSON.stringify(out, null, 2) + "\n",
    );
    console.log("");
    console.log(`✔ Done. ${resolved} resolved · ${skipped} skipped · ${failed} failed.`);
    console.log(`   Wrote ${out.length} total entries to ${outputPath}`);
}

main().catch((e) => fail(e.stack || e.message));
