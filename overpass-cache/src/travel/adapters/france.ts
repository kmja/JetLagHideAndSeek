/**
 * Île-de-France (Paris) — IDFM PRIM journey planner.
 *
 * Île-de-France Mobilités exposes a **Navitia-shaped** journey API
 * through its PRIM marketplace. Same request + response contract as
 * navitia.io, so this reuses `planViaNavitia` + `parseNavitiaJourneys`
 * wholesale — the only differences are the base URL (the `fr-idf`
 * coverage) and the auth header (`apikey:` instead of `Authorization:`).
 *
 * Why a dedicated adapter when navitia.io already covers Paris: PRIM is
 * the *authoritative* IdF source (RATP/SNCF Transilien/RER/Metro/tram/
 * bus, with IdF real-time), and it's a **separate free quota pool**
 * (20 000 journeys/day) — so heavy Paris use doesn't burn the shared
 * navitia.io free tier. Ordered ahead of `navitia` for IdF origins;
 * the broad navitia fallback still catches the rest of France.
 *
 * Key: free PRIM account (no billing) at
 * https://prim.iledefrance-mobilites.fr — set `PRIM_API_KEY`. Defers
 * (returns null) when unset, same pattern as navitia / Trafiklab.
 *
 * Docs: https://prim.iledefrance-mobilites.fr/en/apis/idfm-navitia-general-v2
 */

import type { Journey, PlanRequest } from "../types";
import { planViaNavitia } from "./navitia";

const PRIM_URL =
    "https://prim.iledefrance-mobilites.fr/marketplace/v2/navitia/coverage/fr-idf/journeys";

/** Île-de-France bbox — the eight IdF départements (75/77/78/91/92/93/
 *  94/95). Roughly Mantes (1.4°E) to Provins (3.6°E), Étampes (48.3°N)
 *  to Beauvais-edge (49.25°N). Outside this, navitia.io's broad-Europe
 *  box handles the rest of France. */
const IDF_BBOX = { minLat: 48.1, maxLat: 49.25, minLng: 1.4, maxLng: 3.6 };

export function canServe(lat: number, lng: number): boolean {
    return (
        lat >= IDF_BBOX.minLat &&
        lat <= IDF_BBOX.maxLat &&
        lng >= IDF_BBOX.minLng &&
        lng <= IDF_BBOX.maxLng
    );
}

export async function planJourney(
    req: PlanRequest,
    apiKey: string,
    departAt: number,
    signal?: AbortSignal,
): Promise<Journey | null> {
    // PRIM authenticates with an `apikey` header (not navitia.io's
    // `Authorization`).
    return planViaNavitia(
        PRIM_URL,
        { apikey: apiKey },
        req,
        departAt,
        signal,
    );
}
