/**
 * Estonia — peatus.ee (Estonian Transport Administration).
 *
 * peatus.ee is a Digitransit/OTP deployment covering Estonia
 * nationwide, with a KEYLESS public OTP REST `/plan` endpoint — so it
 * reuses the generic `planViaOtp` + `parseOtpPlan`. Covers Tallinn,
 * Tartu, Pärnu and the national bus/rail network.
 *
 * Not live-testable here; OTP REST shape is standard and the walking
 * backstop covers a wrong request. Worth one live probe of the exact
 * `v1/routers/estonia` path.
 */

import type { Journey, PlanRequest } from "../types";
import { planViaOtp } from "./otp";

const ESTONIA_OTP_BASE = "https://api.peatus.ee/routing/v1/routers/estonia";

/** Estonia bbox. North edge 59.7 keeps Tallinn (59.44) in while staying
 *  below Helsinki (60.17, Finnish); the 59.5–59.7 sliver is the Gulf of
 *  Finland (water), so no real overlap with the Digitransit FI box. */
const ESTONIA_BBOX = { minLat: 57.5, maxLat: 59.7, minLng: 21.5, maxLng: 28.2 };

export function canServe(lat: number, lng: number): boolean {
    return (
        lat >= ESTONIA_BBOX.minLat &&
        lat <= ESTONIA_BBOX.maxLat &&
        lng >= ESTONIA_BBOX.minLng &&
        lng <= ESTONIA_BBOX.maxLng
    );
}

export async function planJourney(
    req: PlanRequest,
    departAt: number,
    signal?: AbortSignal,
): Promise<Journey | null> {
    return planViaOtp(ESTONIA_OTP_BASE, req, departAt, signal);
}
