/**
 * Pure geometry pipeline for the SEEKER's hiding-zones overlay — the
 * heavy synchronous turf work extracted from `ZoneSidebar` so it can run
 * inside a Web Worker (`src/workers/seekerZones.worker.ts`) instead of
 * blocking the main thread (same disease the hider overlay had in a
 * dense metro, same cure — see `hidingZonesUnion.worker.ts`).
 *
 * Everything here is pure data-in/data-out (plain GeoJSON): no atoms, no
 * toasts, no fetches — those stay in `ZoneSidebar`. The module is
 * imported by BOTH the worker and the main thread (the manager falls
 * back to a direct call where Workers are unavailable), so there is ONE
 * implementation and the two paths can't drift.
 *
 * Deliberately does NOT import from the `@/maps/geo-utils` /
 * `@/maps/api` barrels — those pull the Overpass/api graph into the
 * worker bundle; the 5-line `safeUnion` is inlined instead.
 */

import {
    booleanIntersects as turfBooleanIntersects,
    circle as turfCircle,
    featureCollection as turfFeatureCollection,
    getCoord as turfGetCoord,
    simplify as turfSimplify,
    union as turfUnion,
} from "@turf/turf";
import type { Units } from "@turf/turf";
import type {
    Feature,
    FeatureCollection,
    MultiPolygon,
    Polygon,
} from "geojson";

import type { StationCircle, StationPlace } from "@/maps/api/types";

/** Local copy of `maps/geo-utils` `safeUnion` (see header for why). */
function safeUnion(
    input: FeatureCollection<Polygon | MultiPolygon>,
): Feature<Polygon | MultiPolygon> {
    if (input.features.length === 1) return input.features[0];
    const union = turfUnion(input);
    if (union) return union;
    throw new Error("No features");
}

/**
 * Build each candidate station's hiding-radius circle and keep only the
 * ones whose zone still overlaps the remaining valid area.
 *
 * Mirrors the original ZoneSidebar block exactly:
 *   - 512-step circles (~6 m chord on a 500 m radius — smooth at z18).
 *   - The remaining area (`questionFinishedMapData` = play area minus
 *     every eliminated region) is simplified (~100 m tolerance) then
 *     unioned; a station survives iff its circle intersects it.
 *   - A union failure THROWS (parity with the old inline `safeUnion`
 *     call) so the caller's existing catch → toast path fires rather
 *     than silently keeping/dropping everything.
 */
export function prepareZoneCircles(
    places: StationPlace[],
    radius: number,
    units: Units,
    area: FeatureCollection<Polygon | MultiPolygon>,
): StationCircle[] {
    const unionized = safeUnion(
        turfSimplify(area, { tolerance: 0.001 }) as FeatureCollection<
            Polygon | MultiPolygon
        >,
    );

    return places
        .map((place) =>
            turfCircle(turfGetCoord(place as never), radius, {
                steps: 512,
                units,
                properties: place,
            }),
        )
        .filter((circle) => {
            if (!unionized) return true;
            return turfBooleanIntersects(circle, unionized);
        }) as StationCircle[];
}

/**
 * Style the (question-filtered, enabled) station circles for the map —
 * verbatim move of ZoneSidebar's `styleStations`. The "stations" and
 * "no-overlap" branches union EVERY 512-step circle, which is the single
 * heaviest operation in the seeker overlay (the union of hundreds of
 * high-poly circles) — the reason this runs in the worker.
 */
export function styleZoneStations(
    circles: StationCircle[],
    style: string,
): FeatureCollection | Feature {
    switch (style) {
        case "no-display":
            return { type: "FeatureCollection", features: [] };

        case "no-overlap":
            // safeUnion → turf.union throws on an empty collection; guard.
            if (circles.length === 0)
                return { type: "FeatureCollection", features: [] };
            return safeUnion(turfFeatureCollection(circles));

        case "stations": {
            // Dots + name labels + a single UNIONED extent fill. Filling
            // each circle separately compounds opacity where zones overlap
            // (4+ overlapping zones turn the basemap into an opaque wash);
            // unioning paints the covered area exactly once at a uniform
            // faint opacity, and its outline becomes the clean envelope of
            // the possible-hiding area rather than crisscrossing arcs.
            // turf.union (inside safeUnion) needs ≥2 geometries, so only
            // union when there are at least 2 circles; 1 → that circle; 0 →
            // no fill. (A bare 0/1 case otherwise threw "Must have at least
            // 2 geometries" → the map error boundary.)
            const union =
                circles.length >= 2
                    ? (safeUnion(turfFeatureCollection(circles)) as Feature)
                    : (circles[0] ?? null);
            return turfFeatureCollection([
                ...(union ? [union] : []),
                ...circles.map((c) => c.properties as Feature),
            ] as never);
        }

        default:
            // "zones": individual circles (per-zone fill + outline) plus
            // centre points so the name labels render here too. This view
            // deliberately shows each zone distinctly.
            return turfFeatureCollection([
                ...circles,
                ...circles.map((c) => c.properties as Feature),
            ] as never);
    }
}
