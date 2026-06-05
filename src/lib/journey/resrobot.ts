/**
 * Trafiklab ResRobot 2.1 adapter — Swedish public + national transit
 * (SL, SJ, Västtrafik, Skånetrafiken, MTR Express, etc., all in one
 * federated journey planner).
 *
 * Docs: https://www.trafiklab.se/api/our-apis/resrobot-v21/
 *
 * Architectural note: the API key NEVER lives in the browser. The
 * client posts the (anchor, stops) batch to the JOURNEY_API
 * endpoint exposed by the overpass-cache worker; that worker reads
 * its TRAFIKLAB_API_KEY secret and fans out the per-stop ResRobot
 * trip calls server-side. Reasons:
 *
 *   1. Players don't need to register for a Trafiklab account and
 *      paste a key into settings before the Travel Times overlay
 *      works — it works out of the box.
 *   2. The free-tier quota is shared and cached across all
 *      players, so heavy use by one player doesn't burn the
 *      quota for others.
 *   3. The proxy caches arrivals in Cloudflare's edge cache and
 *      R2 keyed by (anchor, dest, 5-min departure bucket) so the
 *      common "toggle overlay off and on again" case is fully
 *      free server-side too.
 *
 * Provider remains its own module so adding Norway (Entur),
 * Finland (Digitransit), etc. is just a new file + a registry
 * line. Each future provider would have its own server proxy with
 * its own region-specific cache.
 */

import { JOURNEY_API } from "@/maps/api/constants";

import type {
    JourneyAnchor,
    JourneyProvider,
    JourneyResult,
    JourneyStop,
} from "./types";

/** Hard cap on a single proxy round-trip. The proxy itself caps
 *  per-upstream calls at 8 s and parallelizes them, so its
 *  worst-case wall clock is roughly that — leave a slack budget
 *  on top of that for the round trip + payload. */
const PROXY_TIMEOUT_MS = 20_000;

export function createResRobotProvider(): JourneyProvider {
    return {
        id: "resrobot",
        displayName: "ResRobot (Sweden — SL, SJ, Västtrafik …)",
        isAvailable() {
            // Always available — the API key is server-side. The
            // proxy itself may return 503 if the operator hasn't
            // configured the secret yet, but that's a runtime
            // condition we surface as empty arrivals, not a UI gate.
            return true;
        },
        async fetchArrivals(
            anchor: JourneyAnchor,
            stops: JourneyStop[],
            signal?: AbortSignal,
        ): Promise<JourneyResult[]> {
            if (stops.length === 0) return [];

            const ctrl = new AbortController();
            const onAbort = () => ctrl.abort();
            signal?.addEventListener("abort", onAbort, { once: true });
            const timer = setTimeout(
                () => ctrl.abort(),
                PROXY_TIMEOUT_MS,
            );

            let resp: Response;
            try {
                resp = await fetch(JOURNEY_API, {
                    method: "POST",
                    signal: ctrl.signal,
                    headers: {
                        "Content-Type": "application/json",
                        Accept: "application/json",
                    },
                    body: JSON.stringify({ anchor, stops }),
                });
            } catch {
                // Network / abort. Treat as a full miss so the UI
                // shows pins-without-labels rather than throwing.
                return stops.map((s) => ({ stopId: s.id, arrivalAt: null }));
            } finally {
                clearTimeout(timer);
                signal?.removeEventListener("abort", onAbort);
            }
            if (!resp.ok) {
                // 503: operator hasn't set TRAFIKLAB_API_KEY.
                // 400: malformed input (shouldn't happen from this
                // adapter; logged for debugging).
                if (resp.status !== 503) {
                    console.warn(
                        "Journey proxy returned",
                        resp.status,
                        resp.statusText,
                    );
                }
                return stops.map((s) => ({ stopId: s.id, arrivalAt: null }));
            }
            let body: { results?: JourneyResult[] };
            try {
                body = (await resp.json()) as { results?: JourneyResult[] };
            } catch {
                return stops.map((s) => ({ stopId: s.id, arrivalAt: null }));
            }
            if (!Array.isArray(body.results)) {
                return stops.map((s) => ({ stopId: s.id, arrivalAt: null }));
            }
            // The proxy guarantees same-order, same-length output —
            // but be defensive against a misbehaving deploy by
            // re-keying by stopId and merging back into the
            // request order.
            const byId = new Map<string, number | null>();
            for (const r of body.results) {
                byId.set(r.stopId, r.arrivalAt ?? null);
            }
            return stops.map((s) => ({
                stopId: s.id,
                arrivalAt: byId.get(s.id) ?? null,
            }));
        },
    };
}
