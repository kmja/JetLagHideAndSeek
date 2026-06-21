/**
 * Barcelona — TMB (Transports Metropolitans de Barcelona) planner.
 *
 * TMB's `/v1/planner/plan` is an OpenTripPlanner REST endpoint, so it
 * reuses the generic `planViaOtp` + `parseOtpPlan` — the only extra is
 * the `app_id` + `app_key` query params (free TMB developer keys, no
 * billing). Covers the Barcelona metropolitan area (metro + bus + FGC +
 * Rodalies).
 *
 * Keyed: defers without both TMB keys. Not live-testable here; OTP REST
 * shape is standard, walking backstop covers a wrong request.
 */

import type { Journey, PlanRequest } from "../types";
import { planViaOtp } from "./otp";

const TMB_OTP_BASE = "https://api.tmb.cat/v1/planner";

/** Barcelona metropolitan-area bbox. */
const BCN_BBOX = { minLat: 41.2, maxLat: 41.65, minLng: 1.85, maxLng: 2.35 };

export function canServe(lat: number, lng: number): boolean {
    return (
        lat >= BCN_BBOX.minLat &&
        lat <= BCN_BBOX.maxLat &&
        lng >= BCN_BBOX.minLng &&
        lng <= BCN_BBOX.maxLng
    );
}

export async function planJourney(
    req: PlanRequest,
    appId: string,
    appKey: string,
    departAt: number,
    signal?: AbortSignal,
): Promise<Journey | null> {
    return planViaOtp(TMB_OTP_BASE, req, departAt, signal, {
        app_id: appId,
        app_key: appKey,
    });
}
