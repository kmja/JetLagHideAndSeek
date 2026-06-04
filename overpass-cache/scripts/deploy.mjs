#!/usr/bin/env node
/**
 * Wrapper around `wrangler deploy` that skips non-master
 * builds. Workers Builds re-runs the deploy command for every
 * branch push, but the overpass cache worker can't cleanly
 * preview-deploy because the R2 bucket binding is shared with
 * production and the secondary ADMIN_SECRET secret isn't
 * configured for preview environments. Easiest fix: only ship
 * prod from master.
 *
 * On Workers Builds, the branch name is exposed via
 * `WORKERS_CI_BRANCH`. Fall back to GITHUB_REF_NAME if that's
 * not set so the wrapper still works in other CI contexts.
 *
 * Set this as the deploy command in the Cloudflare Workers
 * Builds project for jlhs-overpass-cache:
 *
 *   node scripts/deploy.mjs
 *
 * Master pushes deploy as before; branch pushes log a skip
 * message and exit 0 (so the build is marked successful).
 */

import { spawnSync } from "node:child_process";

const branch =
    process.env.WORKERS_CI_BRANCH ||
    process.env.GITHUB_REF_NAME ||
    "";

const PROD_BRANCH = "master";

if (branch && branch !== PROD_BRANCH) {
    console.log(
        `[deploy] skipping wrangler deploy — current branch "${branch}" is not "${PROD_BRANCH}".`,
    );
    console.log(
        `[deploy] Workers Builds is treated as success; nothing was shipped to production.`,
    );
    process.exit(0);
}

const result = spawnSync(
    "npx",
    ["wrangler", "deploy", "--config", "wrangler.toml"],
    { stdio: "inherit" },
);
process.exit(result.status ?? 1);
