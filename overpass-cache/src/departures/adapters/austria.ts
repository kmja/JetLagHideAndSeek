/**
 * Austria (ÖBB `v6.oebb.transport.rest`) departure-board adapter.
 *
 * Reuses the shared transport.rest stationboard fetch (`germany.ts`
 * `fetchViaFptf`) against the ÖBB instance, mirroring how the trip
 * planner's `austria.ts` reuses `planViaFptf`. Same `canServe` box as
 * the planner.
 *
 * ⚠️ As noted in the trip planner, the ÖBB transport.rest instance has
 * been unreliable (404s for Austrian-local queries). This adapter
 * defers cleanly (null → next adapter → MOTIS) when it fails, so it's
 * safe to keep for the day the instance is healthy without risking the
 * DACH fallback.
 */

import { canServe as austriaCanServe } from "../../travel/adapters/austria";
import type { Departure } from "../types";
import { fetchViaFptf } from "./germany";

const OEBB_BASE = "https://v6.oebb.transport.rest";

export const canServe = austriaCanServe;

export async function fetchBoard(
    _baseUrlIgnored: string,
    lat: number,
    lng: number,
    when: number,
    max: number,
    signal?: AbortSignal,
): Promise<{ stopName?: string; departures: Departure[] } | null> {
    return fetchViaFptf(OEBB_BASE, lat, lng, when, max, signal);
}
