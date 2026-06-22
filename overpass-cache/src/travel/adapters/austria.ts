/**
 * Austria — currently DEFERS to the Transitous backstop.
 *
 * History: the dedicated ÖBB instance (`v6.oebb.transport.rest`) was
 * shut down (its `/journeys` route 404s). DB HAFAS
 * (`v6.db.transport.rest`) is reachable but HANGS on intra-Austrian
 * queries — a Vienna-local trip burned the full upstream timeout (8 s)
 * and returned nothing, because DB's HAFAS lacks good Austrian-local
 * routing data. Since this app's trips are overwhelmingly intra-city,
 * keeping DB here just taxed every Austrian request with a multi-second
 * hang before falling through. Transitous routes Vienna fine (~0.9 s),
 * so Austria defers to it.
 *
 * A real regional Austrian planner exists (VAO / AnachB) but is keyed;
 * wire it here behind an env key when available — `canServe` already
 * marks the territory.
 */

import type { Journey, PlanRequest } from "../types";

// (DB HAFAS via planViaFptf was tried and removed — see header. No
// keyless Austrian-local planner exists today.)

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
    _req: PlanRequest,
    _departAt: number,
    _signal?: AbortSignal,
): Promise<Journey | null> {
    // No working keyless Austrian planner today (ÖBB instance dead, DB
    // HAFAS hangs on Austrian-local). Defer to Transitous.
    return null;
}
