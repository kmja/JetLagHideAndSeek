/**
 * Self-hosted MOTIS — the LICENSE-CLEAN universal fallback.
 *
 * MOTIS (motis-project) is open-source FOSS. The public transitous.org
 * instance we also call is community-run and flagged "non-commercial"
 * — but the ENGINE has no such restriction. So an operator who wants a
 * universal planner without that caveat (or who is commercial) can run
 * their own MOTIS over the Mobility Database GTFS feeds (Docker image +
 * a small VM / Fly.io / Hetzner box; NOT Cloudflare Workers — MOTIS
 * needs a persistent process with feeds in memory) and point this
 * adapter at it via `MOTIS_SELF_HOSTED_URL`.
 *
 * It speaks the same MOTIS plan API as Transitous, so it reuses
 * `transitous.planViaMotis` via a configurable base URL + the shared
 * `parseMotisPlan`. When the env var is set this is ordered AHEAD of the
 * public Transitous instance (so your own box wins and the
 * non-commercial public one is only a backstop). When unset it defers.
 *
 * ⚠️ `MOTIS_SELF_HOSTED_URL` must be the FULL plan-endpoint URL,
 * including the version segment, because MOTIS uses path-based
 * versioning: a fresh self-hosted `:master` build serves
 * `…/api/v6/plan`, while the public Transitous instance currently
 * serves `…/api/v1/plan`. Match whatever your instance exposes (check
 * `GET /api/openapi.yaml`). The request/response contract is identical
 * across versions; only the `vN` differs.
 *
 * Full deployment recipe: overpass-cache/SELF_HOSTING_MOTIS.md.
 */

import type { Journey, PlanRequest } from "../types";
import { planViaMotis } from "./transitous";

/** Universal — your self-hosted MOTIS covers whatever feeds you load
 *  (typically the whole Mobility Database, i.e. most of the world). */
export function canServe(_lat: number, _lng: number): boolean {
    return true;
}

export async function planJourney(
    baseUrl: string,
    req: PlanRequest,
    departAt: number,
    signal?: AbortSignal,
): Promise<Journey | null> {
    return planViaMotis(baseUrl, req, departAt, signal);
}
