/**
 * Australia — La Trobe University public OpenTripPlanner instance.
 *
 * `ptplanner.latrobe.edu.au` runs a single OTP 1.5 deployment with
 * **eight per-state routers**: `vic`, `qld`, `sa`, `wa`, `tas`, `nt`,
 * `act`, `nsw`. KEYLESS. Documented in a Jan 2025 MDPI Computers paper
 * (https://www.mdpi.com/2073-431X/15/1/58), with a GTFS validity window
 * spanning Jan 2025–Jun 2026.
 *
 * Coverage: Brisbane (QLD/TransLink), Melbourne (VIC/PTV), Adelaide
 * (SA/Adelaide Metro), Perth (WA/Transperth), Hobart (TAS), Darwin
 * (NT), Canberra (ACT), Sydney (NSW/TfNSW). Reuses the generic
 * `planViaOtp` + `parseOtpPlan` helpers (same wire shape as Estonia +
 * Barcelona).
 *
 * ⚠️ NSW deliberately excluded here — the dedicated TfNSW EFA adapter
 * (`nsw.ts`) is the official source and dispatch-orders ahead of this
 * one anyway. La Trobe `nsw` is a fallback only if `nsw.ts` defers (no
 * key).
 *
 * ⚠️ This is an academic-hosted instance — no SLA. When it errors or
 * returns null the dispatcher falls through to the Transitous
 * universal backstop (Mobility Database has every Australian state's
 * GTFS), so coverage degrades to "slower" rather than "missing".
 *
 * Live-test status: NOT yet probed from this branch (sandbox blocks
 * egress to the host). Confirm with:
 *
 *   curl 'https://ptplanner.latrobe.edu.au/otp/routers/qld/plan?fromPlace=-27.4698,153.0251&toPlace=-27.4975,153.0137&mode=TRANSIT,WALK&date=06-22-2026&time=09:00am'
 */

import type { Journey, PlanRequest } from "../types";
import { planViaOtp } from "./otp";

const LATROBE_BASE = "https://ptplanner.latrobe.edu.au/otp/routers";

/** All of Australia. The router id is chosen per-coordinate by the
 *  per-state bbox check below; this top-level box just lets the
 *  dispatcher know we're a candidate for Australian origins. */
const AU_BBOX = { minLat: -44.0, maxLat: -10.0, minLng: 112.0, maxLng: 154.0 };

export function canServe(lat: number, lng: number): boolean {
    return (
        lat >= AU_BBOX.minLat &&
        lat <= AU_BBOX.maxLat &&
        lng >= AU_BBOX.minLng &&
        lng <= AU_BBOX.maxLng
    );
}

/** Per-state bboxes (coarse — La Trobe's GTFS is the source of truth,
 *  so we just need a "which router probably owns this coord" hint).
 *  Tested first-match wins; ordered to put dense capitals at the top
 *  so a corner overlap doesn't matter. NSW is OMITTED here — the
 *  official TfNSW adapter (`nsw.ts`) owns NSW dispatch. */
const ROUTERS: Array<{
    id: string;
    minLat: number;
    maxLat: number;
    minLng: number;
    maxLng: number;
}> = [
    // ACT — tiny enclave inside NSW, must come BEFORE any NSW-overlap
    // fallback. Pure Canberra footprint.
    { id: "act", minLat: -35.95, maxLat: -35.12, minLng: 148.76, maxLng: 149.4 },
    // Greater Melbourne + regional VIC.
    { id: "vic", minLat: -39.2, maxLat: -33.98, minLng: 140.96, maxLng: 149.98 },
    // SEQ + regional QLD (everything north of NSW).
    { id: "qld", minLat: -29.18, maxLat: -10.68, minLng: 138.0, maxLng: 153.55 },
    // Adelaide + regional SA.
    { id: "sa", minLat: -38.06, maxLat: -25.99, minLng: 129.0, maxLng: 141.0 },
    // Perth + WA (the big one).
    { id: "wa", minLat: -35.13, maxLat: -13.69, minLng: 112.92, maxLng: 129.0 },
    // Tasmania (mainland + Bruny/Flinders/King).
    { id: "tas", minLat: -43.65, maxLat: -39.57, minLng: 143.81, maxLng: 148.45 },
    // Darwin + regional NT.
    { id: "nt", minLat: -26.0, maxLat: -10.96, minLng: 129.0, maxLng: 138.0 },
];

function routerFor(lat: number, lng: number): string | null {
    for (const r of ROUTERS) {
        if (
            lat >= r.minLat &&
            lat <= r.maxLat &&
            lng >= r.minLng &&
            lng <= r.maxLng
        ) {
            return r.id;
        }
    }
    return null;
}

export async function planJourney(
    req: PlanRequest,
    departAt: number,
    signal?: AbortSignal,
): Promise<Journey | null> {
    const router = routerFor(req.origin.lat, req.origin.lng);
    if (!router) return null;
    return planViaOtp(
        `${LATROBE_BASE}/${router}`,
        req,
        departAt,
        signal,
    );
}
