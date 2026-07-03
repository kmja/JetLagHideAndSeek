import { useStore } from "@nanostores/react";
import { useEffect } from "react";
import { toast } from "react-toastify";

import { hidingZonesGeoJSON } from "@/lib/context";
import {
    gameSize,
    gameStartPosition,
    hidingPeriodEndsAt,
    HIDING_PERIOD_MINUTES,
} from "@/lib/gameSetup";
import { activeJourneyProvider } from "@/lib/journey/registry";
import {
    showTravelTimes,
    travelTimesFC,
    travelTimesLoading,
} from "@/lib/journey/state";
import type { JourneyStop } from "@/lib/journey/types";

/**
 * Computes journey arrival times at every station in the current
 * hiding-zones overlay and publishes the result to the
 * `travelTimesFC` shadow atom for Map.tsx to render.
 *
 * Anchor: the GPS position captured at game start (shared departure
 * point for both hider and all seekers), departing at the start of
 * the hiding period. Only stations reachable BEFORE the hiding period
 * ends are shown — that is, the hider had time to get there.
 *
 * Activation gates:
 *   - `showTravelTimes` toggle is on.
 *   - An active journey provider exists.
 *   - `gameStartPosition` is set (GPS was captured at game start).
 *   - `hidingPeriodEndsAt` is set (a game clock is running or has run).
 *   - `hidingZonesGeoJSON` has Point features to label.
 */
export function TravelTimesOverlay() {
    const enabled = useStore(showTravelTimes);
    const zones = useStore(hidingZonesGeoJSON);
    const $startPos = useStore(gameStartPosition);
    const $endsAt = useStore(hidingPeriodEndsAt);
    const $size = useStore(gameSize);

    useEffect(() => {
        // Default not-loading; only the commit-to-fetch path flips it true
        // (nanostores dedupes false→false).
        travelTimesLoading.set(false);
        if (!enabled) {
            travelTimesFC.set(null);
            return;
        }
        const provider = activeJourneyProvider();
        if (!provider) {
            travelTimesFC.set(null);
            // Silent-failure was the "toggle does nothing" bug (v630) —
            // tell the seeker why. Deduped by toastId.
            toast.info(
                "Travel times: no transit journey data is available for this area.",
                { toastId: "travel-times-no-provider", autoClose: 4000 },
            );
            return;
        }
        if (!$startPos || !$endsAt) {
            travelTimesFC.set(null);
            toast.info(
                "Travel times needs the GPS fix captured at game start — it isn't available for this game.",
                { toastId: "travel-times-no-start", autoClose: 4000 },
            );
            return;
        }
        const stations = extractStations(zones);
        if (stations.length === 0) {
            travelTimesFC.set(null);
            return;
        }

        let cancelled = false;
        const controller = new AbortController();
        travelTimesLoading.set(true);

        const hidingStartAt = $endsAt - HIDING_PERIOD_MINUTES[$size] * 60_000;
        const anchor = {
            lat: $startPos.lat,
            lng: $startPos.lng,
            departAt: hidingStartAt,
        };

        void (async () => {
            try {
                // Optimistic: show all stations immediately in the neutral
                // "pending" state so the overlay appears right away while
                // the API resolves.
                travelTimesFC.set(buildFC(stations, new Map(), $endsAt, true));

                const results = await provider.fetchArrivals(
                    anchor,
                    stations,
                    controller.signal,
                );
                if (cancelled) return;

                const arrivalMap = new Map<string, number>();
                for (const r of results) {
                    if (r.arrivalAt != null) {
                        arrivalMap.set(r.stopId, r.arrivalAt);
                    }
                }
                // Final: keep BOTH reachable and unreachable stations so
                // the seeker can scan candidate zones at a glance — green
                // dot means "the hider could be here", red dot means "rule
                // this zone out". The map layer paints the colours from the
                // `reachable` property; the HH:MM label only fires for
                // reachable stations.
                travelTimesFC.set(buildFC(stations, arrivalMap, $endsAt, false));
            } finally {
                if (!cancelled) travelTimesLoading.set(false);
            }
        })();

        return () => {
            cancelled = true;
            controller.abort();
            travelTimesLoading.set(false);
        };
    }, [enabled, $startPos, $endsAt, $size, zones]);

    return null;
}

/** Pull (lat, lng, id, name) tuples out of the hiding-zones
 *  FeatureCollection. Only Point features count — polygon zones
 *  aren't stations. */
function extractStations(
    fc: GeoJSON.FeatureCollection | null,
): JourneyStop[] {
    if (!fc || !Array.isArray(fc.features)) return [];
    const out: JourneyStop[] = [];
    for (const f of fc.features) {
        if (!f?.geometry || f.geometry.type !== "Point") continue;
        const [lng, lat] = f.geometry.coordinates as [number, number];
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        const props = (f.properties ?? {}) as {
            id?: string | number;
            name?: string;
            properties?: { id?: string | number; name?: string };
        };
        const id = String(
            props.id ?? props.properties?.id ?? `${lat.toFixed(5)},${lng.toFixed(5)}`,
        );
        const name = props.name ?? props.properties?.name;
        out.push({ id, name, lat, lng });
    }
    return out;
}

/**
 * Build the FeatureCollection that Map.tsx renders for the overlay.
 * Every station in `stations` is emitted — Map.tsx colours the dot
 * by `reachable` (post-API) or paints it neutral while `pending`.
 *
 *   - includeUnknown=true  (optimistic pre-API step) → all stations
 *     marked pending, no labels.
 *   - includeUnknown=false (post-API) → reachable stations carry an
 *     HH:MM label and `reachable:true`; unreachable stations get no
 *     label and `reachable:false`.
 */
function buildFC(
    stations: JourneyStop[],
    arrivals: Map<string, number>,
    budget: number,
    includeUnknown: boolean,
): GeoJSON.FeatureCollection<
    GeoJSON.Point,
    {
        stopId: string;
        name?: string;
        arrivalLabel: string;
        reachable: boolean;
        pending: boolean;
    }
> {
    const features: GeoJSON.Feature<
        GeoJSON.Point,
        {
            stopId: string;
            name?: string;
            arrivalLabel: string;
            reachable: boolean;
            pending: boolean;
        }
    >[] = [];

    for (const s of stations) {
        const arrival = arrivals.get(s.id);
        const reachable = arrival != null && arrival <= budget;
        features.push({
            type: "Feature",
            geometry: { type: "Point", coordinates: [s.lng, s.lat] },
            properties: {
                stopId: s.id,
                name: s.name,
                arrivalLabel: reachable ? formatHHMM(arrival!) : "",
                reachable,
                pending: includeUnknown,
            },
        });
    }

    return { type: "FeatureCollection", features };
}

function formatHHMM(unixMs: number): string {
    const d = new Date(unixMs);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default TravelTimesOverlay;
