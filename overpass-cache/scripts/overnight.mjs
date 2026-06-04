#!/usr/bin/env node
/**
 * One-shot overnight prefill: run discovery on
 * `bulk-city-names.json`, then bulk-prewarm against the resulting
 * `bulk-cities.json`. Lets a fresh R2 bucket get to ~600 warm
 * city boundaries with a single command.
 *
 * Env:
 *   WORKER_URL      Required. e.g. https://jlhs-overpass-cache.<sub>.workers.dev
 *   ADMIN_SECRET    Required. The bearer token configured on the worker.
 *
 * Usage:
 *   ADMIN_SECRET=… WORKER_URL=… node scripts/overnight.mjs
 *
 * Resumable: both sub-scripts skip already-done work, so killing
 * and rerunning costs nothing.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function fail(msg) {
    console.error(`✗ ${msg}`);
    process.exit(1);
}

function run(cmd, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, {
            stdio: "inherit",
            env: process.env,
        });
        child.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`${cmd} exited with code ${code}`));
        });
    });
}

const worker = process.env.WORKER_URL;
const adminSecret = process.env.ADMIN_SECRET;
if (!worker) fail("WORKER_URL env var is required.");
if (!adminSecret) fail("ADMIN_SECRET env var is required.");

const root = path.resolve(__dirname, "..");
const namesPath = path.join(root, "bulk-city-names.json");
const citiesPath = path.join(root, "bulk-cities.json");

console.log("=== Stage 1/2: discover OSM relation ids via Photon ===");
console.log(`    in:  ${namesPath}`);
console.log(`    out: ${citiesPath} (append)`);
await run("node", [
    path.join(__dirname, "discover-osm-ids.mjs"),
    "--input",
    namesPath,
    "--output",
    citiesPath,
    "--append",
]);

console.log("");
console.log("=== Stage 2/2: bulk-prewarm into R2 ===");
console.log(`    in: ${citiesPath}`);
console.log(`    worker: ${worker}`);
await run("node", [
    path.join(__dirname, "bulk-prewarm.mjs"),
    "--worker",
    worker,
    "--input",
    citiesPath,
]);

console.log("");
console.log("✔ Overnight prewarm complete.");
