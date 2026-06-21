/**
 * Ireland — TFI / NTA Journey Planner (Mentz EFA).
 *
 * The backend of transportforireland.ie's official journey planner is a
 * Mentz EFA instance — the SAME software family as Sydney's TfNSW — and
 * it serves `outputFormat=rapidJSON`, so it reuses `parseEfaTrip` from
 * the NSW adapter. KEYLESS public endpoint (an unkeyed public EFA, not
 * a published developer product — use politely; the worker's cache
 * dedupes repeats). Covers Ireland nationwide (Dublin Bus/Luas/DART +
 * national bus/rail).
 *
 * Not live-testable here; EFA rapidJSON shape is verified shared with
 * TfNSW, walking backstop covers a wrong request.
 */

import type { Journey, PlanRequest } from "../types";
import { parseEfaTrip } from "./nsw";

const TFI_EFA_URL =
    "https://journeyplanner.transportforireland.ie/nta/XSLT_TRIP_REQUEST2";
const UPSTREAM_TIMEOUT_MS = 9_000;

/** Ireland bbox (incl. Northern Ireland edge — TFI plans cross-border
 *  to Belfast). Atlantic west to the Irish Sea. */
const IRELAND_BBOX = {
    minLat: 51.4,
    maxLat: 55.4,
    minLng: -10.6,
    maxLng: -5.3,
};

export function canServe(lat: number, lng: number): boolean {
    return (
        lat >= IRELAND_BBOX.minLat &&
        lat <= IRELAND_BBOX.maxLat &&
        lng >= IRELAND_BBOX.minLng &&
        lng <= IRELAND_BBOX.maxLng
    );
}

export async function planJourney(
    req: PlanRequest,
    departAt: number,
    signal?: AbortSignal,
): Promise<Journey | null> {
    const depart = new Date(departAt);
    const url = new URL(TFI_EFA_URL);
    url.searchParams.set("outputFormat", "rapidJSON");
    url.searchParams.set("coordOutputFormat", "WGS84[DD.ddddd]");
    url.searchParams.set("type_origin", "coord");
    // EFA coord input is lng:lat:<srs>.
    url.searchParams.set(
        "name_origin",
        `${req.origin.lng}:${req.origin.lat}:WGS84[DD.ddddd]`,
    );
    url.searchParams.set("type_destination", "coord");
    url.searchParams.set(
        "name_destination",
        `${req.destination.lng}:${req.destination.lat}:WGS84[DD.ddddd]`,
    );
    url.searchParams.set("itdDate", ymd(depart));
    url.searchParams.set("itdTime", hm(depart));
    url.searchParams.set("itdTripDateTimeDepArr", "dep");
    url.searchParams.set("calcNumberOfTrips", "1");

    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);

    let resp: Response;
    try {
        resp = await fetch(url.toString(), {
            signal: ctrl.signal,
            headers: { Accept: "application/json" },
        });
    } catch (e) {
        console.warn("Ireland (TFI EFA) fetch failed:", e);
        return null;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
    }
    if (!resp.ok) {
        console.warn("Ireland non-OK:", resp.status, resp.statusText);
        return null;
    }
    let json: unknown;
    try {
        json = await resp.json();
    } catch {
        return null;
    }
    return parseEfaTrip(json, req.destination);
}

function ymd(d: Date): string {
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

function hm(d: Date): string {
    return `${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
}
