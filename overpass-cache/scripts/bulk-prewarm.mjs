#!/usr/bin/env node
/**
 * Bulk-prewarm the R2 cache from a JSON list of OSM relation
 * ids. Reads `bulk-cities.json` (or a path given via --input),
 * splits it into batches, POSTs each batch to the worker's
 * /admin/prewarm endpoint with the configured Bearer token, and
 * paces between batches so we don't hammer Overpass.
 *
 * Designed to run overnight on a laptop / tiny VPS: a 1000-city
 * list at the defaults (~2 s/relation) takes about 35 min and
 * leaves you with that many relations warm in R2. Anything
 * already fresh in R2 is skipped server-side (no upstream cost).
 *
 * Usage:
 *   ADMIN_SECRET=xxx node scripts/bulk-prewarm.mjs
 *   ADMIN_SECRET=xxx node scripts/bulk-prewarm.mjs \
 *     --worker https://jlhs-overpass-cache.<sub>.workers.dev \
 *     --input ./bulk-cities.json \
 *     --batch 10 \
 *     --delay-between-relations 1500 \
 *     --delay-between-batches 2000
 *
 * Resumable: if you kill it mid-run, restarting picks up where
 * it left off because the worker skips already-fresh entries.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

async function main() {
    const args = parseArgs(process.argv);
    const secret = process.env.ADMIN_SECRET || args.secret;
    if (!secret) {
        fail(
            "ADMIN_SECRET is required (env var or --secret). Set it via " +
                "`wrangler secret put ADMIN_SECRET` on the worker first.",
        );
    }
    const worker =
        args.worker ||
        process.env.WORKER_URL ||
        "https://jlhs-overpass-cache.karl-mj-andersson.workers.dev";
    const inputPath = path.resolve(
        args.input || path.join(__dirname, "..", "bulk-cities.json"),
    );
    const batchSize = parseInt(args.batch || "10", 10);
    const delayBetweenRelations = parseInt(
        args["delay-between-relations"] || "1500",
        10,
    );
    const delayBetweenBatches = parseInt(
        args["delay-between-batches"] || "2000",
        10,
    );

    const raw = await fs
        .readFile(inputPath, "utf8")
        .catch(() => fail(`Could not read input list at ${inputPath}`));
    let list;
    try {
        list = JSON.parse(raw);
    } catch (e) {
        fail(`Input list is not valid JSON: ${e.message}`);
    }
    if (!Array.isArray(list)) fail("Input list must be a JSON array.");

    // Accept either of these shapes:
    //   [{ name: "Stockholm", relationId: 398021 }, ...]
    //   [398021, 65606, ...]
    const entries = list
        .map((x, i) => {
            if (typeof x === "number") return { name: undefined, relationId: x };
            if (
                x &&
                typeof x.relationId === "number" &&
                Number.isFinite(x.relationId)
            ) {
                return { name: x.name, relationId: x.relationId };
            }
            console.warn(`✗ entry #${i} skipped: invalid shape`);
            return null;
        })
        .filter(Boolean);
    if (entries.length === 0) fail("No usable entries in input list.");

    console.log(
        `▶ Bulk prewarm: ${entries.length} relations · worker ${worker}`,
    );
    console.log(
        `   batch=${batchSize}, ` +
            `delay-between-relations=${delayBetweenRelations} ms, ` +
            `delay-between-batches=${delayBetweenBatches} ms`,
    );

    let processed = 0;
    let stored = 0;
    let skipped = 0;
    let failed = 0;
    const t0 = Date.now();

    for (let i = 0; i < entries.length; i += batchSize) {
        const batch = entries.slice(i, i + batchSize);
        const payload = {
            relationIds: batch.map((e) => e.relationId),
            names: batch.map((e) => e.name ?? ""),
            delayBetweenMs: delayBetweenRelations,
        };
        const batchLabel = `batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(
            entries.length / batchSize,
        )}`;
        try {
            const resp = await fetch(`${worker}/admin/prewarm`, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${secret}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(payload),
            });
            if (!resp.ok) {
                const text = await resp.text();
                console.error(
                    `✗ ${batchLabel} HTTP ${resp.status}: ${text.slice(0, 200)}`,
                );
                failed += batch.length;
            } else {
                const json = await resp.json();
                for (const r of json.results || []) {
                    processed++;
                    if (r.status === "stored") {
                        stored++;
                        const sz =
                            typeof r.sizeBytes === "number"
                                ? ` ${(r.sizeBytes / 1024).toFixed(0)} KB`
                                : "";
                        console.log(
                            `  ✓ ${r.relationId}${r.name ? ` (${r.name})` : ""}${sz}`,
                        );
                    } else if (r.status === "skipped-fresh") {
                        skipped++;
                        console.log(
                            `  · ${r.relationId}${r.name ? ` (${r.name})` : ""} — already fresh`,
                        );
                    } else {
                        failed++;
                        console.log(
                            `  ✗ ${r.relationId}${r.name ? ` (${r.name})` : ""} — ${r.status}`,
                        );
                    }
                }
            }
        } catch (e) {
            console.error(`✗ ${batchLabel} threw: ${e.message}`);
            failed += batch.length;
        }
        const pct = ((i + batch.length) / entries.length) * 100;
        console.log(
            `   ${batchLabel} done. progress ${pct.toFixed(1)}% · ` +
                `${stored} stored, ${skipped} fresh-skip, ${failed} failed`,
        );
        if (i + batchSize < entries.length && delayBetweenBatches > 0) {
            await sleep(delayBetweenBatches);
        }
    }

    const totalSec = ((Date.now() - t0) / 1000).toFixed(0);
    console.log("");
    console.log(`✔ Done in ${totalSec}s.`);
    console.log(
        `   ${processed} processed · ${stored} newly stored · ` +
            `${skipped} already-fresh-skipped · ${failed} failed`,
    );
}

main().catch((e) => fail(e.stack || e.message));
