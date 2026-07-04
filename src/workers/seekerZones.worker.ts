/// <reference lib="webworker" />
/**
 * Off-main-thread compute for the SEEKER's hiding-zones overlay.
 *
 * Two operations, both pure wrappers over `src/lib/zonePipeline.ts`
 * (the single shared implementation — the main thread falls back to
 * calling it directly where Workers are unavailable):
 *
 *   - "prepare": build every station's 512-step hiding-radius circle
 *     and drop the ones outside the remaining valid area (simplify +
 *     union + per-circle booleanIntersects — seconds of work in a
 *     dense metro).
 *   - "style": union ALL the circles into the overlay's extent fill
 *     (the single heaviest op in the seeker overlay).
 *
 * Message in:  { id, op: "prepare"|"style", ...op payload }
 * Message out: { id, ok: true, result } | { id, ok: false, error }
 * (Errors are surfaced, not swallowed — the caller's existing
 * catch → toast path owns them, matching the old inline behaviour.)
 */

import type { Units } from "@turf/turf";
import type { FeatureCollection, MultiPolygon, Polygon } from "geojson";

import { prepareZoneCircles, styleZoneStations } from "@/lib/zonePipeline";
import type { StationCircle, StationPlace } from "@/maps/api/types";

type ZoneRequest =
    | {
          id: number;
          op: "prepare";
          places: StationPlace[];
          radius: number;
          units: Units;
          area: FeatureCollection<Polygon | MultiPolygon>;
      }
    | {
          id: number;
          op: "style";
          circles: StationCircle[];
          style: string;
      };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (e: MessageEvent<ZoneRequest>) => {
    const msg = e.data;
    try {
        const result =
            msg.op === "prepare"
                ? prepareZoneCircles(
                      msg.places,
                      msg.radius,
                      msg.units,
                      msg.area,
                  )
                : styleZoneStations(msg.circles, msg.style);
        ctx.postMessage({ id: msg.id, ok: true, result });
    } catch (err) {
        ctx.postMessage({
            id: msg.id,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
        });
    }
};
