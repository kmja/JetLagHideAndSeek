/**
 * Walking fallback adapter.
 *
 * The universal backstop: every coordinate on Earth is "served" by
 * walking, so this adapter is always last in the dispatch order and
 * always returns a journey. It needs no API key and makes no network
 * call — it's pure arithmetic — which also makes it the one adapter
 * we can exhaustively unit-test offline.
 *
 * The estimate is deliberately humble: great-circle distance scaled
 * by a circuity factor (streets aren't straight lines) divided by an
 * average walking speed. It is NOT a road-network isochrone — that's
 * a later enrichment that would route over the OSM ways the overpass
 * cache already holds. For a single A→B "could I walk there, and
 * roughly how long?" answer, a circuity-adjusted straight line is
 * honest and good enough; the client labels walking-sourced journeys
 * as estimates precisely because of this.
 */

import type { Journey, TravelPlace, TravelPoint } from "../types";

/** Average walking speed in metres per second (~5 km/h), the same
 *  figure most journey planners assume for pedestrian legs. */
export const WALK_SPEED_MPS = 1.4;

/** Multiplier accounting for the fact that walked paths follow
 *  streets rather than the crow's flight. 1.3 is a commonly used
 *  circuity factor for dense urban grids. */
export const WALK_CIRCUITY = 1.3;

/** Great-circle distance between two coordinates, in metres. */
export function haversineMeters(a: TravelPoint, b: TravelPoint): number {
    const R = 6_371_000; // mean Earth radius, metres
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const h =
        Math.sin(dLat / 2) ** 2 +
        Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Estimated on-foot travel time in seconds between two coordinates,
 *  including the circuity adjustment. */
export function walkingSeconds(a: TravelPoint, b: TravelPoint): number {
    const meters = haversineMeters(a, b) * WALK_CIRCUITY;
    return meters / WALK_SPEED_MPS;
}

/**
 * Build a single-leg walking journey from `origin` to `destination`
 * departing at `departAt` (Unix ms). Always succeeds for finite
 * coordinates.
 */
export function walkingJourney(
    origin: TravelPoint,
    destination: TravelPlace,
    departAt: number,
): Journey {
    const distanceMeters = Math.round(haversineMeters(origin, destination) * WALK_CIRCUITY);
    const durationSec = distanceMeters / WALK_SPEED_MPS;
    const arriveAt = departAt + Math.round(durationSec * 1000);
    return {
        departAt,
        arriveAt,
        durationMin: Math.max(1, Math.round(durationSec / 60)),
        transfers: 0,
        legs: [
            {
                mode: "walk",
                from: { lat: origin.lat, lng: origin.lng },
                to: {
                    lat: destination.lat,
                    lng: destination.lng,
                    name: destination.name,
                },
                departAt,
                arriveAt,
                distanceMeters,
            },
        ],
    };
}
