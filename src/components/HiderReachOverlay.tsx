import { useStore } from "@nanostores/react";
import { booleanPointInPolygon } from "@turf/turf";
import { useEffect, useRef } from "react";

import { lastKnownPosition, polyGeoJSON } from "@/lib/context";
import {
    allowedTransit,
    gameSize,
    gameStartPosition,
    HIDING_PERIOD_MINUTES,
    hidingPeriodEndsAt,
} from "@/lib/gameSetup";
import { haversineMeters } from "@/lib/geo";
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
    const $poly = useStore(polyGeoJSON);
    const $gameStart = useStore(gameStartPosition);

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
            let plausible = stations.filter(
                (s) => s.distanceMeters / 1000 <= maxKm,
            );
            // Play-area cull: stations outside the boundary are useless
            // — the hider can't hide there, so paying the arrivals
            // round-trip for them is pure waste. `fetchAreaStations`
            // is bbox-centred on the hider's GPS so its results
            // routinely spill outside small play areas. Skipped when
            // the boundary hasn't hydrated yet so the overlay still
            // works on a cold start (graceful degrade — same pattern
            // as the question-impact filter).
            if ($poly) {
                const before = plausible.length;
                plausible = plausible.filter((s) => {
                    try {
                        return booleanPointInPolygon(
                            [s.lng, s.lat],
                            $poly as never,
                        );
                    } catch {
                        return true;
                    }
                });
                if (before !== plausible.length) {
                    // Stations dropped here would otherwise burn one
                    // arrivals-fetch each — visible in worker logs
                    // when debugging reach quota.
                    console.debug(
                        `HiderReachOverlay: dropped ${before - plausible.length} out-of-play-area station(s)`,
                    );
                }
            }

            // Optimistic: paint dots immediately, no labels.
            hiderReachFC.set(
                buildFC(
                    plausible,
                    new Map(),
                    new Map(),
                    $hidingEndsAt,
                    true,
                ),
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
            // Hider arrivals — "from where I am now, can I get to this
            // station before the whistle?".
            //
            // Seeker arrivals (in parallel) — "from the shared game-
            // start position, departing the moment the whistle blows,
            // how soon could the seekers reach this station?". This is
            // the strategic-pruning data: a station that's reachable
            // for the hider but trivially reachable for the seekers
            // too is a bad hiding pick, and the safetyMinutes gap is
            // what the colored dot encodes for the hider. The anchor
            // is fixed for the whole game (gameStartPosition + whistle
            // departAt) so the worker's R2 cache covers the repeat
            // hits on every GPS-move re-fetch.
            const hiderPromise = provider.fetchArrivals(
                { lat: $gps.lat, lng: $gps.lng, departAt: now },
                stops,
                controller.signal,
            );
            const seekerPromise = $gameStart
                ? provider
                      .fetchArrivals(
                          {
                              lat: $gameStart.lat,
                              lng: $gameStart.lng,
                              departAt: $hidingEndsAt,
                          },
                          stops,
                          controller.signal,
                      )
                      .catch(() => [] as { stopId: string; arrivalAt: number | null }[])
                : Promise.resolve(
                      [] as { stopId: string; arrivalAt: number | null }[],
                  );

            const [arrivals, seekerArrivals] = await Promise.all([
                hiderPromise,
                seekerPromise,
            ]);
            if (cancelled) return;

            const arrivalMap = new Map<string, number>();
            for (const r of arrivals) {
                if (r.arrivalAt != null && r.arrivalAt <= $hidingEndsAt) {
                    arrivalMap.set(r.stopId, r.arrivalAt);
                }
            }
            const seekerArrivalMap = new Map<string, number>();
            for (const r of seekerArrivals) {
                if (r.arrivalAt != null) {
                    seekerArrivalMap.set(r.stopId, r.arrivalAt);
                }
            }
            hiderReachFC.set(
                buildFC(
                    plausible,
                    arrivalMap,
                    seekerArrivalMap,
                    $hidingEndsAt,
                    false,
                ),
            );
        })();

        return () => {
            cancelled = true;
            controller.abort();
        };
    }, [
        enabled,
        $gps?.lat,
        $gps?.lng,
        $hidingEndsAt,
        $size,
        $allowed,
        $zone,
        // $poly: re-fetch when the play-area polygon resolves so we
        // pick up the cull instead of a one-shot "no boundary yet"
        // pass that includes out-of-area stations.
        $poly,
        // $gameStart: re-fetch when the game-start anchor resolves so
        // safetyMinutes populates after a cold start. Coords-only
        // dependency keeps the effect from re-running on identity
        // changes when the value is unchanged.
        $gameStart?.lat,
        $gameStart?.lng,
    ]);

    return null;
}

/** Sized for the "top reasonable transit mode" pre-filter. Subway is
 *  the fastest mode the game offers; using its speed (with slack)
 *  prevents us from culling rail-reachable stations. */
const TOP_SPEED_KMH = 80;

function buildFC(
    stations: AreaStation[],
    hiderArrivals: Map<string, number>,
    seekerArrivals: Map<string, number>,
    budget: number,
    includeUnknown: boolean,
): GeoJSON.FeatureCollection<
    GeoJSON.Point,
    {
        stopId: string;
        name?: string;
        arrivalLabel: string;
        safetyMinutes?: number;
    }
> {
    const features: GeoJSON.Feature<
        GeoJSON.Point,
        {
            stopId: string;
            name?: string;
            arrivalLabel: string;
            safetyMinutes?: number;
        }
    >[] = [];
    for (const s of stations) {
        const arrival = hiderArrivals.get(String(s.id));
        const reachable = arrival != null && arrival <= budget;
        if (!includeUnknown && !reachable) continue;
        // safetyMinutes: how long the hider has at this station before
        // the seekers can arrive. seekerArrival - whistle = wait time
        // the seekers face after starting; positive = hider has buffer,
        // ≤0 = seekers can be there at or before the whistle.
        const seekerArrival = seekerArrivals.get(String(s.id));
        // safetyMinutes is intentionally OMITTED from the props when
        // unknown — MapLibre expressions can't compare against a JSON
        // null literal, so the layer's `has` check distinguishes
        // "no seeker arrival yet" from a real number.
        const props: {
            stopId: string;
            name?: string;
            arrivalLabel: string;
            safetyMinutes?: number;
        } = {
            stopId: String(s.id),
            name: s.name,
            arrivalLabel: reachable ? formatHHMM(arrival!) : "",
        };
        if (seekerArrival != null) {
            props.safetyMinutes = Math.round(
                (seekerArrival - budget) / 60_000,
            );
        }
        features.push({
            type: "Feature",
            geometry: { type: "Point", coordinates: [s.lng, s.lat] },
            properties: props as never,
        });
    }
    return { type: "FeatureCollection", features };
}

function formatHHMM(unixMs: number): string {
    const d = new Date(unixMs);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default HiderReachOverlay;
