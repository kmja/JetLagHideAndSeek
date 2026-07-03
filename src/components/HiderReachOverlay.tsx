import { useStore } from "@nanostores/react";
import {
    booleanPointInPolygon,
    circle as turfCircle,
    featureCollection as turfFeatureCollection,
    simplify as turfSimplify,
} from "@turf/turf";
import type { Units } from "@turf/turf";
import { useEffect, useRef } from "react";

import {
    hidingRadius,
    hidingRadiusUnits,
    lastKnownPosition,
    polyGeoJSON,
} from "@/lib/context";
import {
    allowedTransit,
    gameSize,
    HIDING_PERIOD_MINUTES,
    hidingPeriodEndsAt,
} from "@/lib/gameSetup";
import { haversineMeters } from "@/lib/geo";
import { hidingZone } from "@/lib/hiderRole";
import { hiderReachFC, showHiderReach } from "@/lib/journey/state";
import { type AreaStation, fetchAreaStations } from "@/lib/journey/stations";
import { safeUnion } from "@/maps/geo-utils";

/**
 * Hider's "Hiding zones" overlay — the mirror of the seeker's
 * hiding-zones station field. It scans the area around the hider's
 * live GPS for every candidate hiding-zone station and publishes them
 * to a shadow FC that `HiderBackgroundMap` paints as name-labeled dots
 * (styled identically to the seeker's `hiding-zones-*` layers).
 *
 * v643: reachability was removed. Earlier versions fanned out a
 * per-station journey-arrivals fetch to colour-code reachable vs
 * out-of-reach — but that round-trip was the slow, flaky part the user
 * flagged ("hiding zones don't work well"). The overlay is now a pure
 * station field, matching the seeker version. Whether one SPECIFIC
 * tapped zone is reachable before the whistle is now an on-demand check
 * in `StationTransitCard`, where the trip is already being planned.
 *
 * Anchored at the hider's live GPS (`lastKnownPosition`), not at the
 * seeker's `gameStartPosition`.
 *
 * Gates: hiding (or grace) phase only — outside those phases the
 * overlay is meaningless, so it auto-disables itself rather than
 * burning quota. Also auto-disables once the hider has committed a
 * zone (the trip-plan card takes over the "how do I get there" job).
 *
 * Re-runs the scan when GPS moves more than 100 m OR the allowed-mode
 * set changes OR the game size flips — anything finer would burn quota
 * for trivially-different results.
 */
export function HiderReachOverlay() {
    const enabled = useStore(showHiderReach);
    const $gps = useStore(lastKnownPosition);
    const $hidingEndsAt = useStore(hidingPeriodEndsAt);
    const $size = useStore(gameSize);
    const $allowed = useStore(allowedTransit);
    const $zone = useStore(hidingZone);
    const $poly = useStore(polyGeoJSON);
    const $radius = useStore(hidingRadius);
    const $units = useStore(hidingRadiusUnits);

    // Memoise the last-fetched anchor so a sub-100m GPS jitter
    // doesn't kick off a fresh Overpass scan.
    const lastAnchorRef = useRef<{ lat: number; lng: number } | null>(null);

    useEffect(() => {
        // Off → clear and bail. Also drop the anchor memo so the NEXT
        // enable always re-fetches: without this, toggling the overlay
        // off (which clears the FC) and back on while standing still hit
        // the <100 m deadband below and returned early WITHOUT
        // re-painting — leaving the overlay permanently blank until GPS
        // happened to move 100 m.
        if (!enabled) {
            hiderReachFC.set(null);
            lastAnchorRef.current = null;
            return;
        }
        // No GPS, no clock → nothing to compute. Reset the anchor too so
        // the fetch fires the moment a fix arrives (deps include $gps).
        if (!$gps || !$hidingEndsAt) {
            hiderReachFC.set(null);
            lastAnchorRef.current = null;
            return;
        }
        // Auto-disable once the hider has locked their zone — at
        // that point the survey view is no longer guidance, it's
        // clutter. The trip-plan card takes over.
        if ($zone) {
            hiderReachFC.set(null);
            return;
        }
        const now = Date.now();
        if (now >= $hidingEndsAt) {
            // Past the whistle — the overlay can't help and the
            // grace-window picker is taking the screen anyway.
            hiderReachFC.set(null);
            return;
        }

        // GPS deadband — skip re-fetch if the hider hasn't moved AND we
        // already have a painted result to keep. The `get()` guard
        // matters: if the previous pass produced nothing yet (or was
        // cleared), a sub-100 m jitter must NOT short-circuit us into
        // leaving the overlay blank — we re-fetch instead.
        if (lastAnchorRef.current && hiderReachFC.get()) {
            const m = haversineMeters(
                $gps.lat,
                $gps.lng,
                lastAnchorRef.current.lat,
                lastAnchorRef.current.lng,
            );
            if (m < 100) {
                // Same anchor, same FC — let the previous state stand.
                return;
            }
        }
        lastAnchorRef.current = { lat: $gps.lat, lng: $gps.lng };

        let cancelled = false;

        (async () => {
            const stations = await fetchAreaStations($gps.lat, $gps.lng, {
                hidingDurationMin: HIDING_PERIOD_MINUTES[$size],
                allowed: $allowed,
            }).catch((e) => {
                console.warn("HiderReachOverlay: station fetch failed", e);
                return [] as AreaStation[];
            });
            if (cancelled) return;
            if (stations.length === 0) {
                hiderReachFC.set({ type: "FeatureCollection", features: [] });
                return;
            }

            // Play-area cull: stations outside the boundary are useless
            // — the hider can't hide there. `fetchAreaStations` is
            // bbox-centred on the hider's GPS so its results routinely
            // spill outside small play areas. Skipped when the boundary
            // hasn't hydrated yet so the overlay still works on a cold
            // start (graceful degrade — same pattern as the question-
            // impact filter).
            let inArea = stations;
            if ($poly) {
                inArea = stations.filter((s) => {
                    try {
                        return booleanPointInPolygon(
                            [s.lng, s.lat],
                            $poly as never,
                        );
                    } catch {
                        return true;
                    }
                });
            }

            hiderReachFC.set(buildFC(inArea, $radius, $units));
        })();

        return () => {
            cancelled = true;
        };
    }, [
        enabled,
        $gps?.lat,
        $gps?.lng,
        $hidingEndsAt,
        $size,
        $allowed,
        $zone,
        $radius,
        $units,
        // $poly: re-fetch when the play-area polygon resolves so we
        // pick up the cull instead of a one-shot "no boundary yet"
        // pass that includes out-of-area stations.
        $poly,
    ]);

    return null;
}

/** Cap on how many station circles feed the unioned extent fill. The
 *  fill is a coarse "possible-hiding area" envelope, so unioning the
 *  closest ~120 (distance-sorted) is plenty — it keeps a dense metro's
 *  union off the "hundreds of circles → multi-second main-thread block"
 *  path while still covering the core cluster of dots. */
const MAX_UNION_CIRCLES = 120;

/**
 * Build the hiding-zones FeatureCollection — matching the seeker's
 * `styleStations` "stations" style: one centre POINT per station (name
 * label + dot) PLUS a single `safeUnion`-ed extent POLYGON of every
 * station's hiding-radius circle. Unioning paints the covered area once
 * at a uniform faint opacity (instead of compounding per-circle fills)
 * and gives a clean envelope of the possible-hiding area.
 */
function buildFC(
    stations: AreaStation[],
    radius: number,
    units: Units,
): GeoJSON.FeatureCollection {
    const points: GeoJSON.Feature[] = stations.map((s) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [s.lng, s.lat] },
        properties: { stopId: String(s.id), name: s.name },
    }));

    // Per-station hiding-radius circles → a single union polygon. This is
    // the ONE expensive step: `turf.union` over hundreds of overlapping
    // circles in a dense metro (Chicago, 180 bus-stop circles) blocked the
    // main thread for seconds (reported freeze/stutter). Bound the cost:
    //   • LOW-poly circles (12 steps, not 32) — a faint envelope doesn't
    //     need smooth arcs, and fewer vertices makes every union + the
    //     final tessellation far cheaper.
    //   • Cap the union INPUT (the closest `MAX_UNION_CIRCLES`); stations
    //     are distance-sorted, so the closest ones form the extent's core.
    //   • `simplify` the result so the map re-tessellates a light polygon.
    //   • try/catch so any failure just drops the fill (dots still show).
    let union: GeoJSON.Feature | null = null;
    try {
        const circles = stations
            .slice(0, MAX_UNION_CIRCLES)
            .map((s) =>
                turfCircle([s.lng, s.lat], radius, { units, steps: 12 }),
            );
        if (circles.length >= 2) {
            const merged = safeUnion(
                turfFeatureCollection(circles) as never,
            ) as GeoJSON.Feature | null;
            union = merged
                ? (turfSimplify(merged as never, {
                      tolerance: 0.0008,
                      highQuality: false,
                  }) as GeoJSON.Feature)
                : null;
        } else if (circles.length === 1) {
            union = circles[0] as GeoJSON.Feature;
        }
    } catch (e) {
        console.warn("HiderReachOverlay: union fill failed", e);
        union = null;
    }

    return {
        type: "FeatureCollection",
        features: [...(union ? [union] : []), ...points],
    };
}

export default HiderReachOverlay;
