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
 * It speaks the exact same MOTIS v2 `/api/v1/plan` API as Transitous,
 * so it reuses `transitous.planJourney` logic via a configurable base
 * URL and the shared `parseMotisPlan`. When the env var is set this is
 * ordered AHEAD of the public Transitous instance (so your own box wins
 * and the non-commercial public one is only a backstop). When unset it
 * defers.
 *
 * See README / CLAUDE.md "M5" notes for the self-host recipe.
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
