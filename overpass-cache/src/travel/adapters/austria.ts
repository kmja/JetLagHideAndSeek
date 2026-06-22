/**
 * Austria — DB HAFAS via `v6.db.transport.rest` (transport.rest / FPTF).
 *
 * The dedicated ÖBB instance (`v6.oebb.transport.rest`) was shut down —
 * its `/journeys` route now 404s ("Cannot GET /journeys"). Deutsche
 * Bahn's HAFAS (the same keyless `v6.db.transport.rest` the Germany
 * adapter uses) carries ÖBB and covers Austrian rail + cross-border
 * Central Europe, so we reuse it here. Dense intra-city Vienna transit
 * (U-Bahn/tram) that DB HAFAS doesn't resolve simply returns null and
 * the dispatcher falls through to the universal Transitous backstop.
 *
 * Reuses `planViaFptf` + `parseFptfJourneys` wholesale (identical
 * request + FPTF response shape as Germany).
 */

import type { Journey, PlanRequest } from "../types";
import { planViaFptf } from "./germany";

// DB HAFAS — same instance as germany.ts (it carries ÖBB data). The
// retired v6.oebb.transport.rest is intentionally not used.
const OEBB_REST_URL = "https://v6.db.transport.rest/journeys";

/** Austria bbox — Bregenz (9.7E) to the Hungarian border (17.2E),
 *  Carinthia (46.3N) up to the Czech/German border (49.1N). Disjoint
 *  from Switzerland (≤10.5E only below 47.7N) and Germany (≥47.7N) in
 *  practice; minor overlap at the corners is handled by dispatch
 *  order + null-fallthrough. */
const AUSTRIA_BBOX = { minLat: 46.3, maxLat: 49.1, minLng: 9.5, maxLng: 17.2 };

export function canServe(lat: number, lng: number): boolean {
    return (
        lat >= AUSTRIA_BBOX.minLat &&
        lat <= AUSTRIA_BBOX.maxLat &&
        lng >= AUSTRIA_BBOX.minLng &&
        lng <= AUSTRIA_BBOX.maxLng
    );
}

export async function planJourney(
    req: PlanRequest,
    departAt: number,
    signal?: AbortSignal,
): Promise<Journey | null> {
    return planViaFptf(OEBB_REST_URL, "Austria", req, departAt, signal);
}
