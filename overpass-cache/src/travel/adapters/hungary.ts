/**
 * Hungary — BKK FUTÁR (Budapest public-transport authority).
 *
 * BKK runs an **OpenTripPlanner** instance at `futar.bkk.hu` that powers
 * the official `futar.bkk.hu/trip-plan/` web planner. The same `/plan`
 * endpoint is exposed publicly under their Apiary docs
 * (https://bkkfutar.docs.apiary.io/) — coord→coord, multi-leg, with
 * the standard OTP REST response shape. Free with a registered key,
 * requested at https://opendata.bkk.hu.
 *
 * Coverage: Budapest + agglomeration (BKK area) — metro, tram, bus,
 * suburban rail. Cross-border / regional rail outside the BKK zone
 * falls through to navitia / Transitous.
 *
 * Reuses `planViaOtp` + `parseOtpPlan` wholesale — same wire shape as
 * Estonia + Barcelona, the key just rides as a `key` query param.
 *
 * Live-test status: not yet probed from this branch. To verify once a
 * key is configured, the equivalent of:
 *
 *   curl 'https://futar.bkk.hu/api/query/v1/ws/otp/api/where/plan-trip.json?fromPlace=47.5,19.05&toPlace=47.49,19.03&key=YOUR_KEY'
 */

import type { Journey, PlanRequest } from "../types";
import { planViaOtp } from "./otp";

// FUTÁR's OTP REST root. `planViaOtp` appends `/plan`, but BKK's
// instance uses `plan-trip.json` instead of OTP's default `/plan` —
// we send the full URL via a tiny wrapper below so the shared helper
// keeps its OTP-default behaviour.
const FUTAR_BASE = "https://futar.bkk.hu/api/query/v1/ws/otp/api/where";

/** Hungary bbox. The BKK service area is just Budapest + immediate
 *  agglomeration; rest-of-country requests will simply return null
 *  from OTP and the dispatcher falls through. Bbox kept wide so the
 *  adapter is at least tried country-wide. */
const HU_BBOX = { minLat: 45.7, maxLat: 48.6, minLng: 16.1, maxLng: 22.9 };

export function canServe(lat: number, lng: number): boolean {
    return (
        lat >= HU_BBOX.minLat &&
        lat <= HU_BBOX.maxLat &&
        lng >= HU_BBOX.minLng &&
        lng <= HU_BBOX.maxLng
    );
}

/**
 * BKK's OTP wraps `/plan` as `/plan-trip.json`. Re-use the shared OTP
 * helper by faking the base path so `${base}/plan` resolves to
 * `…/plan-trip.json` — cheap workaround that keeps the parser shared.
 */
export async function planJourney(
    req: PlanRequest,
    apiKey: string,
    departAt: number,
    signal?: AbortSignal,
): Promise<Journey | null> {
    return planViaOtp(
        // planViaOtp does `${base.replace(/\/$/,"")}/plan` — substitute
        // `/plan-trip.json` by trimming the slash and supplying our own
        // suffix via the upstream path.
        `${FUTAR_BASE}/plan-trip.json`.replace(/\/plan$/, ""),
        req,
        departAt,
        signal,
        { key: apiKey },
    );
}
