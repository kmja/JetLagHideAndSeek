#!/usr/bin/env node
/**
 * Fast-fill country-shard references via the worker's
 * /admin/prewarm-country-ref endpoint.
 *
 * Complement to the hourly cron's COUNTRY_REFS_PER_TICK (2/tick → ~5
 * days). This script drains the full 214-shard list in ~6–10 hours by
 * letting Overpass set the pace via the worker's existing slot-wait +
 * semaphore logic — the script just chains shards back-to-back and
 * blocks on each. The worker stays the only entity that talks to
 * overpass-api.de, so we keep the same rate-limit discipline whether
 * shards are warmed by cron or by this script.
 *
 * Usage:
 *
 *   ADMIN_SECRET=… node scripts/country-refs-warm.mjs \
 *       --worker https://jlhs-overpass-cache.<sub>.workers.dev
 *
 * Options:
 *   --worker <url>              Worker base URL (no trailing slash). Required.
 *   --filter <iso-prefix>       Only warm shards whose iso starts with prefix
 *                               (e.g. `--filter US-` for the four US splits).
 *                               Repeatable; defaults to all shards.
 *   --skip-fresh                Don't even request shards already fresh — by
 *                               default we ask the worker, which returns
 *                               "skipped-fresh" cheaply for fresh ones. Use
 *                               this on a strict-budget rerun.
 *   --delay-after-store <ms>    Wait between shards we actually stored.
 *                               Default 1500ms; the worker's slot-wait already
 *                               paces, but this layers in a tiny extra cushion
 *                               so we don't immediately re-ask overpass for
 *                               the next shard.
 *   --max-retries <n>           Per-shard retry budget on transient errors.
 *                               Default 2.
 *
 * Resumable: the worker's prewarm function is idempotent (skips fresh
 * shards), so rerunning the script picks up where it left off. Safe to
 * Ctrl+C and restart any time.
 */

import { argv, env, exit, stderr, stdout } from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

const ARGS = parseArgs(argv.slice(2));

if (!ARGS.worker) usage("Missing --worker");
if (!env.ADMIN_SECRET) usage("ADMIN_SECRET must be set in the environment");

const WORKER = ARGS.worker.replace(/\/+$/, "");
const FILTERS = ARGS.filter;
const SKIP_FRESH_LOCALLY = ARGS.skipFresh;
const DELAY_AFTER_STORE_MS = ARGS.delayAfterStore;
const MAX_RETRIES = ARGS.maxRetries;

async function main() {
    // Pull the live shard list off the worker's own status endpoint so
    // the script never goes out of sync with the deployed table.
    const status = await getJson(`${WORKER}/admin/country-refs-status`);
    if (!status?.enabled) {
        log(
            "⚠  COUNTRY_REFS_PREWARM_ENABLED is not 'true' on the deployed " +
                "worker. The endpoint will still work, but the cron isn't " +
                "running and the slicing path won't read shards either. " +
                "Continuing — set the var to 'true' when ready.",
        );
    }
    const candidates = status.shards.filter((s) => matchesFilter(s.iso));
    log(`Found ${candidates.length} candidate shards (after filter).`);

    let totalAttempted = 0;
    let totalStored = 0;
    let totalSkippedFresh = 0;
    let totalFailed = 0;
    let totalBytes = 0;

    for (let i = 0; i < candidates.length; i++) {
        const shard = candidates[i];
        const pos = `[${i + 1}/${candidates.length}]`;
        if (SKIP_FRESH_LOCALLY && shard.status === "fresh") {
            log(`${pos} ${shard.iso} already fresh (${shard.ageHours}h), skip`);
            totalSkippedFresh++;
            continue;
        }
        const result = await warmWithRetries(shard.iso);
        totalAttempted++;
        if (!result) {
            totalFailed++;
            log(`${pos} ${shard.iso} ✗ gave up after ${MAX_RETRIES} retries`);
            continue;
        }
        if (result.status === "stored") {
            const kb = result.sizeBytes
                ? (result.sizeBytes / 1024).toFixed(1)
                : "?";
            log(`${pos} ${shard.iso} ✓ stored (${kb} KB)`);
            totalStored++;
            totalBytes += result.sizeBytes ?? 0;
            // Tiny cushion — the worker already slot-paced, but giving
            // overpass an extra heartbeat before the next ask keeps the
            // mirror happy across long sustained runs.
            await sleep(DELAY_AFTER_STORE_MS);
        } else if (result.status === "skipped-fresh") {
            log(`${pos} ${shard.iso} ⏵ already fresh (worker-side)`);
            totalSkippedFresh++;
        } else if (result.status === "slot-timeout") {
            // The mirror is throttled past the worker's wait cap. Back
            // off harder than the per-store delay and try the next
            // shard — we don't retry-spin here because the worker
            // already retried internally.
            log(`${pos} ${shard.iso} ⏸ slot timeout, backing off 30 s`);
            await sleep(30_000);
        } else {
            log(`${pos} ${shard.iso} ? unknown status: ${result.status}`);
        }
    }

    log("\n=== Done ===");
    log(`Stored:        ${totalStored}`);
    log(`Skipped fresh: ${totalSkippedFresh}`);
    log(`Failed:        ${totalFailed}`);
    log(`Attempted:     ${totalAttempted}`);
    log(`Total bytes:   ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);
}

async function warmWithRetries(iso) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const r = await postJson(`${WORKER}/admin/prewarm-country-ref`, {
                iso,
            });
            return r;
        } catch (e) {
            const backoff = 5_000 * (attempt + 1);
            if (attempt === MAX_RETRIES) return null;
            log(
                `   ${iso} attempt ${attempt + 1} failed (${e.message}), ` +
                    `retry in ${backoff / 1000}s`,
            );
            await sleep(backoff);
        }
    }
    return null;
}

async function getJson(url) {
    const resp = await fetch(url);
    if (!resp.ok) {
        throw new Error(`GET ${url} → ${resp.status}`);
    }
    return resp.json();
}

async function postJson(url, body) {
    const resp = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${env.ADMIN_SECRET}`,
        },
        body: JSON.stringify(body),
    });
    if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`POST ${url} → ${resp.status}: ${text.slice(0, 200)}`);
    }
    return resp.json();
}

function matchesFilter(iso) {
    if (FILTERS.length === 0) return true;
    return FILTERS.some((f) => iso.startsWith(f));
}

function parseArgs(args) {
    const out = {
        worker: null,
        filter: [],
        skipFresh: false,
        delayAfterStore: 1500,
        maxRetries: 2,
    };
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === "--worker") out.worker = args[++i];
        else if (a === "--filter") out.filter.push(args[++i]);
        else if (a === "--skip-fresh") out.skipFresh = true;
        else if (a === "--delay-after-store") out.delayAfterStore = +args[++i];
        else if (a === "--max-retries") out.maxRetries = +args[++i];
        else if (a === "--help" || a === "-h") usage();
        else usage(`Unknown argument: ${a}`);
    }
    return out;
}

function usage(msg) {
    if (msg) stderr.write(`Error: ${msg}\n\n`);
    stderr.write(
        "Usage: ADMIN_SECRET=… node scripts/country-refs-warm.mjs " +
            "--worker https://jlhs-overpass-cache.<sub>.workers.dev " +
            "[--filter ISO-PREFIX] [--skip-fresh] " +
            "[--delay-after-store 1500] [--max-retries 2]\n",
    );
    exit(msg ? 1 : 0);
}

function log(line) {
    stdout.write(line + "\n");
}

main().catch((e) => {
    stderr.write(`FATAL: ${e.stack ?? e}\n`);
    exit(1);
});
