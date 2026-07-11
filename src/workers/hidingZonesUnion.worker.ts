/// <reference lib="webworker" />
/**
 * Off-main-thread compute for the hider hiding-zones overlay's unioned
 * extent fill.
 *
 * `turf.union` over hundreds of overlapping hiding-radius circles (a
 * dense metro like Chicago: ~180 bus-stop circles) is a heavy, seconds-
 * long synchronous job. Running it on the main thread froze the whole
 * app while the overlay loaded. Doing it HERE, in a dedicated worker,
 * means the UI stays fully responsive — the overlay's dots are painted
 * immediately on the main thread and this fill arrives whenever it's
 * ready, with no hitch.
 *
 * Message in:  { id, stations: {lng,lat}[], radius, units }
 * Message out: { id, union: Feature | null }
 */

import {
    circle as turfCircle,
    featureCollection as turfFeatureCollection,
    simplify as turfSimplify,
    union as turfUnion,
} from "@turf/turf";
import type { Units } from "@turf/turf";
import type { Feature } from "geojson";

interface UnionRequest {
    id: number;
    stations: { lng: number; lat: number }[];
    radius: number;
    units: Units;
}

/** Cap on how many circles feed the union — a safety bound on the
 *  worker's wall-clock for a pathological mega-city. v750: raised 220 → 700
 *  so a big rail metro's extent fill spans the WHOLE play area (matching the
 *  seeker overlay + the now-1200 dot cap) instead of covering only a corner.
 *  The input is spatially-uniformly ordered (`spatialUniformOrder` in
 *  stations.ts), so this first-N slice is an even area-wide sample. turf.union
 *  batches the whole FeatureCollection in one call, so 700 circles stay
 *  tractable off the main thread. */
const MAX_UNION_CIRCLES = 700;

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (e: MessageEvent<UnionRequest>) => {
    const { id, stations, radius, units } = e.data;
    let union: Feature | null = null;
    try {
        const circles = stations
            .slice(0, MAX_UNION_CIRCLES)
            .map((s) =>
                // Smooth circles (64 steps) so the merged envelope matches
                // the seeker overlay's look — the earlier 16-step + heavy
                // simplify made blocky, angular arcs. It's all off the main
                // thread here, so the extra vertices don't hitch the app.
                turfCircle([s.lng, s.lat], radius, { units, steps: 64 }),
            );
        if (circles.length >= 2) {
            const merged = turfUnion(
                turfFeatureCollection(circles) as never,
            ) as Feature | null;
            // Only a GENTLE simplify (~22 m) to trim vertices for render
            // without visibly flattening the arcs (the old 88 m tolerance
            // is what made the edges look chunky).
            union = merged
                ? (turfSimplify(merged as never, {
                      tolerance: 0.0002,
                      highQuality: false,
                  }) as Feature)
                : null;
        } else if (circles.length === 1) {
            union = circles[0] as Feature;
        }
    } catch {
        union = null;
    }
    ctx.postMessage({ id, union });
};
