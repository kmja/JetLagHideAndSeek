import { useStore } from "@nanostores/react";
import { useEffect, useRef } from "react";

import { lastKnownPosition } from "@/lib/context";
import {
    allowedTransit,
    gameSize,
    HIDING_PERIOD_MINUTES,
    hidingPeriodEndsAt,
} from "@/lib/gameSetup";
import { hidingZone } from "@/lib/hiderRole";
import { activeJourneyProvider } from "@/lib/journey/registry";
import { hiderReachFC, showHiderReach } from "@/lib/journey/state";
import { type AreaStation, fetchAreaStations } from "@/lib/journey/stations";
import type { JourneyStop } from "@/lib/journey/types";

/**
 * Hider's reach overlay — the *mirror image* of the seeker's
 * `TravelTimesOverlay`. Same shape: anchor + many stops →
 * `/api/journey/arrivals` → filter to reachable before the whistle
 * → publish to a shadow FC the background map renders.
 *
 * Differences from the seeker's version:
 *
 *   • Anchored at the hider's live GPS (`lastKnownPosition`), not at
 *     `gameStartPosition`. The hider is in the survey phase: "from
 *     where I am NOW, which candidate hiding zones can I still
 *     reach before the timer expires?".
 *   • Departure is "now", not the start of the hiding period.
 *   • Stations come from a fresh area-wide scan via Overpass
 *     (`fetchAreaStations`), not from `hidingZonesGeoJSON` (which is
 *     a seeker-only deduction state).
 *
 * Gates: hiding (or grace) phase only — outside those phases the
 * overlay is meaningless, so it auto-disables itself rather than
 * burning quota when the hider is already seeking / locked-down /
 * post-game.
 *
 * Re-runs the fetch when GPS moves more than 100 m OR allowed-mode
 * set changes OR game-size flips — anything finer would burn quota
 * for trivially-different answers; anything coarser would be stale
 * once the hider starts moving.
 */
export function HiderReachOverlay() {
    const enabled = useStore(showHiderReach);
    const $gps = useStore(lastKnownPosition);
    const $hidingEndsAt = useStore(hidingPeriodEndsAt);
    const $size = useStore(gameSize);
    const $allowed = useStore(allowedTransit);
    const $zone = useStore(hidingZone);

    // Memoise the last-fetched anchor so a sub-100m GPS jitter
    // doesn't kick off a fresh Overpass + arrivals fan-out.
    const lastAnchorRef = useRef<{ lat: number; lng: number } | null>(null);

    useEffect(() => {
        // Off → clear and bail.
        if (!enabled) {
            hiderReachFC.set(null);
            return;
        }
        // No GPS, no clock → nothing to compute.
        if (!$gps || !$hidingEndsAt) {
            hiderReachFC.set(null);
            return;
        }
        // Auto-disable once the hider has locked their zone — at
        // that point the reach view is no longer guidance, it's
        // clutter. The trip-plan card takes over the "how do I get
        // there" job.
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

        // GPS deadband — skip re-fetch if the hider hasn't moved.
        if (lastAnchorRef.current) {
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
        const controller = new AbortController();

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

            // Pre-filter: stations whose straight-line distance can't
            // possibly be covered before the whistle (even at the
            // fastest mode) are definitely unreachable — drop them
            // before paying the proxy round-trip.
            const minutesLeft = ($hidingEndsAt - now) / 60_000;
            const maxKm = (TOP_SPEED_KMH * minutesLeft) / 60;
            const plausible = stations.filter(
                (s) => s.distanceMeters / 1000 <= maxKm,
            );

            // Optimistic: paint dots immediately, no labels.
            hiderReachFC.set(
                buildFC(plausible, new Map(), $hidingEndsAt, true),
            );

            const provider = activeJourneyProvider();
            if (!provider) {
                // No transit provider for this region — leave the
                // dots up with empty labels; the user still sees
                // every candidate zone, just without arrival times.
                return;
            }

            const stops: JourneyStop[] = plausible.map((s) => ({
                id: String(s.id),
                name: s.name,
                lat: s.lat,
                lng: s.lng,
            }));
            const arrivals = await provider.fetchArrivals(
                { lat: $gps.lat, lng: $gps.lng, departAt: now },
                stops,
                controller.signal,
            );
            if (cancelled) return;

            const arrivalMap = new Map<string, number>();
            for (const r of arrivals) {
                if (r.arrivalAt != null && r.arrivalAt <= $hidingEndsAt) {
                    arrivalMap.set(r.stopId, r.arrivalAt);
                }
            }
            hiderReachFC.set(
                buildFC(plausible, arrivalMap, $hidingEndsAt, false),
            );
        })();

        return () => {
            cancelled = true;
            controller.abort();
        };
    }, [enabled, $gps?.lat, $gps?.lng, $hidingEndsAt, $size, $allowed, $zone]);

    return null;
}

/** Sized for the "top reasonable transit mode" pre-filter. Subway is
 *  the fastest mode the game offers; using its speed (with slack)
 *  prevents us from culling rail-reachable stations. */
const TOP_SPEED_KMH = 80;

function buildFC(
    stations: AreaStation[],
    arrivals: Map<string, number>,
    budget: number,
    includeUnknown: boolean,
): GeoJSON.FeatureCollection<
    GeoJSON.Point,
    { stopId: string; name?: string; arrivalLabel: string }
> {
    const features: GeoJSON.Feature<
        GeoJSON.Point,
        { stopId: string; name?: string; arrivalLabel: string }
    >[] = [];
    for (const s of stations) {
        const arrival = arrivals.get(String(s.id));
        const reachable = arrival != null && arrival <= budget;
        if (!includeUnknown && !reachable) continue;
        features.push({
            type: "Feature",
            geometry: { type: "Point", coordinates: [s.lng, s.lat] },
            properties: {
                stopId: String(s.id),
                name: s.name,
                arrivalLabel: reachable ? formatHHMM(arrival!) : "",
            },
        });
    }
    return { type: "FeatureCollection", features };
}

function formatHHMM(unixMs: number): string {
    const d = new Date(unixMs);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function haversineMeters(
    lat1: number,
    lng1: number,
    lat2: number,
    lng2: number,
): number {
    const R = 6_371_000;
    const phi1 = (lat1 * Math.PI) / 180;
    const phi2 = (lat2 * Math.PI) / 180;
    const dphi = ((lat2 - lat1) * Math.PI) / 180;
    const dlambda = ((lng2 - lng1) * Math.PI) / 180;
    const a =
        Math.sin(dphi / 2) ** 2 +
        Math.cos(phi1) * Math.cos(phi2) * Math.sin(dlambda / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export default HiderReachOverlay;
