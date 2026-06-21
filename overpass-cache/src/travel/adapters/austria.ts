/**
 * Austria — ÖBB via `v6.oebb.transport.rest` (transport.rest / FPTF).
 *
 * Same `hafas-rest-api` codebase + FPTF response shape as the German DB
 * adapter, just a different base URL — so it reuses `planViaFptf` +
 * `parseFptfJourneys` wholesale. KEYLESS. Covers Austria nationwide
 * (ÖBB rail + S-Bahn + regional bus/tram via VAO data) plus cross-
 * border Central Europe.
 *
 * Not live-testable here; request + response shapes are the verified
 * transport.rest contract, walking backstop covers a wrong request.
 * The README leans on station IDs in examples, so the coordinate
 * params are worth one live confirmation.
 */

import type { Journey, PlanRequest } from "../types";
import { planViaFptf } from "./germany";

const OEBB_REST_URL = "https://v6.oebb.transport.rest/journeys";

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
