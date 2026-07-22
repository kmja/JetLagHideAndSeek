import { useStore } from "@nanostores/react";
import { useEffect, useRef } from "react";
import { toast } from "react-toastify";

import { pointInPlayArea } from "@/maps/geo-utils/playAreaIndex";

import {
    hidingRadius,
    hidingRadiusUnits,
    lastKnownPosition,
    mapGeoLocation,
    polyGeoJSON,
} from "@/lib/context";
import { allowedTransit, hidingPeriodEndsAt } from "@/lib/gameSetup";
import { hidingZone } from "@/lib/hiderRole";
import { computeHidingUnion } from "@/lib/journey/hidingZonesUnion";
import {
    hiderReachFC,
    hiderReachLoading,
    showHiderReach,
} from "@/lib/journey/state";
import { type AreaStation, fetchAreaStations } from "@/lib/journey/stations";
import { encodeStationModes } from "@/lib/stationModes";

/**
 * Hider's "Hiding zones" overlay — the mirror of the seeker's
 * hiding-zones station field. It fetches every candidate hiding-zone
 * station in the PLAY AREA and publishes them to a shadow FC that
 * `HiderBackgroundMap` paints as name-labeled dots + a unioned extent
 * fill (styled identically to the seeker's `hiding-zones-*` layers).
 *
 * v661: the fetch is keyed to the play area, not the hider's GPS —
 * `fetchAreaStations` now rides the seeker's `findPlacesInZone` path,
 * so the Overpass query is byte-identical to the seeker's and shares
 * its R2 cache entry (warm for prewarmed cities). GPS is only a
 * client-side sort anchor, so there's no more re-fetch-on-movement
 * deadband: the station set only changes when the play area or the
 * allowed-mode set does.
 *
 * v643: reachability was removed. Earlier versions fanned out a
 * per-station journey-arrivals fetch to colour-code reachable vs
 * out-of-reach — but that round-trip was the slow, flaky part. Whether
 * one SPECIFIC tapped zone is reachable before the whistle is an
 * on-demand check in `StationTransitCard`.
 *
 * Gates: hiding (or grace) phase only — outside those phases the
 * overlay is meaningless, so it auto-disables itself rather than
 * burning quota. Also auto-disables once the hider has committed a
 * zone (the trip-plan card takes over the "how do I get there" job).
 */
export function HiderReachOverlay() {
    const enabled = useStore(showHiderReach);
    const $hidingEndsAt = useStore(hidingPeriodEndsAt);
    const $allowed = useStore(allowedTransit);
    const $zone = useStore(hidingZone);
    const $poly = useStore(polyGeoJSON);
    const $radius = useStore(hidingRadius);
    const $units = useStore(hidingRadiusUnits);

    // v803: auto-SHOW the candidate hiding zones during the hiding period so
    // the hider can see which zone they'd commit to. One-shot per hiding
    // period (keyed on the deadline) so a manual toggle-off still sticks; a
    // new round re-enables. Cleared once a zone is committed (the main effect
    // below turns the overlay off then).
    const autoShownForRef = useRef<number | null>(null);
    // v1066: one-shot auto-HIDE when a zone is first committed (the survey view
    // becomes clutter, the trip-plan card takes over) — but only ONCE, so the
    // hider can manually re-toggle it back on afterwards. Keyed on the committed
    // zone identity so a fresh commit re-fires but a manual re-enable sticks.
    const autoHiddenForRef = useRef<string | null>(null);
    useEffect(() => {
        if (
            $hidingEndsAt !== null &&
            Date.now() < $hidingEndsAt &&
            $zone === null &&
            autoShownForRef.current !== $hidingEndsAt
        ) {
            autoShownForRef.current = $hidingEndsAt;
            showHiderReach.set(true);
        }
        // Auto-hide once, the first time this specific zone is committed.
        if ($zone) {
            const key = String($zone.committedAt);
            if (autoHiddenForRef.current !== key) {
                autoHiddenForRef.current = key;
                showHiderReach.set(false);
            }
        } else {
            autoHiddenForRef.current = null;
        }
    }, [$hidingEndsAt, $zone]);

    useEffect(() => {
        // Default: not loading. Every early return below (off / zone
        // committed / past whistle) leaves it false; only the
        // commit-to-fetch path flips it true.
        hiderReachLoading.set(false);
        // Off → clear and bail.
        if (!enabled) {
            hiderReachFC.set(null);
            return;
        }
        // v782: a terminal "can't/shouldn't draw" outcome must turn the
        // TOGGLE off, not just clear the FC — otherwise the Map-options
        // "Hiding zones" button reads ON while the map is empty (the
        // reported mismatch). Turning `showHiderReach` off re-runs this
        // effect, which then hits the `!enabled` branch above and settles.
        // Loading is the ONLY non-drawing state that legitimately stays on.
        const turnOff = () => {
            hiderReachFC.set(null);
            showHiderReach.set(false);
        };
        // No clock → nothing to survey yet.
        if (!$hidingEndsAt) {
            turnOff();
            return;
        }
        // v1066: committing a zone / passing the whistle no longer FORCE the
        // overlay off from here — that made a MANUAL toggle-on immediately flip
        // back off ("clicked, nothing happens"). The one-shot auto-HIDE on
        // commit lives in the auto effect above, so it still declutters
        // automatically but the hider can re-enable it whenever they want (the
        // candidate zones are still computable after commit / past the whistle).

        let cancelled = false;
        const controller = new AbortController();
        hiderReachLoading.set(true);

        void (async () => {
          try {
            // Distance-sort anchor only (never part of the query): the
            // hider's live GPS when available, else the play-area centre.
            const gps = lastKnownPosition.get();
            const centre = mapGeoLocation.get()?.geometry?.coordinates;
            const anchorLat = gps?.lat ?? (centre?.[0] as number) ?? 0;
            const anchorLng = gps?.lng ?? (centre?.[1] as number) ?? 0;

            // v667/v782: a FAILED fetch (Overpass rate-limited / soft-timed-
            // out) must not masquerade as "loaded, zero zones" — the old
            // catch-to-[] did exactly that (the Chicago empty-overlay bug).
            // Both a failure AND a genuinely-empty result now turn the toggle
            // OFF (via turnOff) so the "Hiding zones" button never reads ON
            // over an empty map; the toast explains what happened.
            let stations: AreaStation[];
            try {
                stations = await fetchAreaStations(anchorLat, anchorLng, {
                    allowed: $allowed,
                    radius: $radius,
                    units: $units,
                });
            } catch (e) {
                console.warn("HiderReachOverlay: station fetch failed", e);
                if (!cancelled) {
                    turnOff();
                    toast.error(
                        "Couldn't load hiding zones — the map data service timed out or is rate-limited. Turn the overlay back on to retry.",
                        { toastId: "hider-reach-failed" },
                    );
                }
                return;
            }
            if (cancelled) return;
            if (stations.length === 0) {
                turnOff();
                toast.info(
                    "No candidate hiding zones found in the play area for the allowed transit modes.",
                    { toastId: "hider-reach-empty" },
                );
                return;
            }

            // Play-area cull. The `/api/area-stations` endpoint returns a
            // 2 km-PADDED bbox superset (a RECTANGLE around the play area's
            // extent — for NYC that rectangle swallows a big slab of NJ), so
            // this cull to the actual boundary polygon is load-bearing, not
            // belt-and-braces. v752 fix: `$poly` is a FeatureCollection, but
            // the old `booleanPointInPolygon(pt, $poly)` requires a
            // Polygon/MultiPolygon — it THREW on the FC and the catch kept
            // EVERY station (no cull), which only became visible once the
            // 180-near-the-hider cap was removed (dots spilled into NJ). Use
            // `pointInPlayArea`, which handles a FeatureCollection.
            let inArea = stations;
            if ($poly) {
                inArea = stations.filter((s) =>
                    pointInPlayArea($poly, s.lng, s.lat),
                );
            }

            // Compute the unioned extent fill OFF the main thread (the
            // union of hundreds of circles is the one heavy step; a worker
            // keeps the whole app responsive while it loads) and paint the
            // WHOLE overlay in ONE update — dots + circles appear together
            // after a single loading period, never staggered. On any
            // worker failure `union` is null and we fall back to dots-only,
            // still in one set.
            const points = stationPoints(inArea);
            const union = await computeHidingUnion(
                inArea.map((s) => ({ lng: s.lng, lat: s.lat })),
                $radius,
                $units,
                controller.signal,
            );
            if (cancelled) return;
            hiderReachFC.set({
                type: "FeatureCollection",
                features: union ? [union, ...points] : points,
            });
          } finally {
            // Loading done — but only clear the flag if THIS run wasn't
            // superseded (a newer run owns the flag then).
            if (!cancelled) hiderReachLoading.set(false);
          }
        })();

        return () => {
            cancelled = true;
            controller.abort();
            hiderReachLoading.set(false);
        };
    }, [
        enabled,
        $hidingEndsAt,
        $allowed,
        $zone,
        $radius,
        $units,
        // $poly: re-fetch when the play-area polygon resolves — the query
        // string is built from it, so the settled boundary IS the real
        // cache key (and the cull needs it too).
        $poly,
    ]);

    return null;
}

/**
 * Station centre POINTS (dot + name label per station), matching the
 * seeker's `hiding-zones-points`/`-labels`. Combined with the off-thread
 * unioned extent fill into a single FC so the whole overlay reveals at
 * once.
 */
function stationPoints(stations: AreaStation[]): GeoJSON.Feature[] {
    return stations.map((s) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [s.lng, s.lat] },
        // v1105: carry the station's transit mode so a DIRECT tap on the dot
        // (HiderBackgroundMap Tier 1) can show the right glyph (subway/train/
        // tram/…). Without it, a direct-dot tap fell back to the generic pin —
        // only the tap-in-empty-space path (findZoneAtPoint) had the mode.
        // v1115: carry the FULL mode set (pipe-joined; MapLibre props are
        // primitives) so a multi-mode hub shows every glyph on a direct tap.
        properties: {
            stopId: String(s.id),
            name: s.name,
            mode: s.mode,
            modes: encodeStationModes(s.modes),
        },
    }));
}

export default HiderReachOverlay;
