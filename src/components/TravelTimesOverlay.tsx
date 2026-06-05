import { useStore } from "@nanostores/react";
import { useEffect, useRef } from "react";

import { hidingZonesGeoJSON, questions } from "@/lib/context";
import { activeJourneyProvider } from "@/lib/journey/registry";
import {
    journeyAnchorMode,
    showTravelTimes,
    trafiklabApiKey,
    travelTimesFC,
} from "@/lib/journey/state";
import type { JourneyAnchor, JourneyStop } from "@/lib/journey/types";

/**
 * Computes journey arrival times at every station in the current
 * hiding-zones overlay and publishes the result to the
 * `travelTimesFC` shadow atom for Map.tsx to render.
 *
 * Sibling-component pattern: renders nothing visible itself; the
 * map's symbol layer reads from the atom we write to. Same shape
 * as ZoneSidebar's hidingZonesGeoJSON dance.
 *
 * Activation gates:
 *   - `showTravelTimes` flag is on (toggled from MapDisplayControls).
 *   - An active journey provider exists (`activeJourneyProvider()`
 *     returns non-null — i.e. at least one provider has its API
 *     key set).
 *   - `hidingZonesGeoJSON` is populated with point features. The
 *     station list piggybacks on whatever ZoneSidebar already
 *     loaded; if hiding zones aren't enabled there are no stations
 *     to label and the overlay no-ops.
 *
 * Re-runs whenever the anchor changes — that means whenever the
 * seeker answers a new question (which moves the hider's last-
 * known location) OR the user toggles between hider-anchor and
 * seeker-anchor modes.
 */
export function TravelTimesOverlay() {
    const enabled = useStore(showTravelTimes);
    const anchorMode = useStore(journeyAnchorMode);
    const zones = useStore(hidingZonesGeoJSON);
    const $questions = useStore(questions);
    // Subscribe so the effect re-runs when the user enters or
    // clears their API key without a page reload.
    useStore(trafiklabApiKey);

    // Seeker GPS for the "seeker-anchor" mode. One-shot per render —
    // we don't continuously re-fetch; a manual toggle of the
    // overlay or a new question is the natural refresh trigger.
    const seekerPosRef = useRef<{ lat: number; lng: number; at: number } | null>(
        null,
    );

    useEffect(() => {
        if (!enabled) {
            travelTimesFC.set(null);
            return;
        }
        const provider = activeJourneyProvider();
        if (!provider) {
            travelTimesFC.set(null);
            return;
        }
        const stations = extractStations(zones);
        if (stations.length === 0) {
            travelTimesFC.set(null);
            return;
        }

        let cancelled = false;
        const controller = new AbortController();

        const resolveAnchor = async (): Promise<JourneyAnchor | null> => {
            if (anchorMode === "hider") {
                // Most recent answered (drag=false) question with
                // coordinates IS the hider's last-known location.
                // Falls back to the latest pending question if
                // nothing's been answered yet (the seeker is still
                // bounding the original location).
                const sorted = [...$questions]
                    .filter((q) => {
                        const d = q.data as { lat?: unknown; lng?: unknown };
                        return (
                            typeof d.lat === "number" &&
                            typeof d.lng === "number"
                        );
                    })
                    .sort((a, b) => {
                        const ad = (a.data as { createdAt?: number }).createdAt ?? 0;
                        const bd = (b.data as { createdAt?: number }).createdAt ?? 0;
                        return bd - ad;
                    });
                const latest = sorted[0];
                if (!latest) return null;
                const d = latest.data as {
                    lat: number;
                    lng: number;
                    createdAt?: number;
                };
                return {
                    lat: d.lat,
                    lng: d.lng,
                    departAt: d.createdAt ?? Date.now(),
                };
            }
            // Seeker mode — grab GPS once and stash it so a re-
            // render without a new question doesn't repeatedly
            // ask the user for location permission.
            if (seekerPosRef.current && Date.now() - seekerPosRef.current.at < 60_000) {
                return {
                    lat: seekerPosRef.current.lat,
                    lng: seekerPosRef.current.lng,
                    departAt: Date.now(),
                };
            }
            if (typeof navigator === "undefined" || !navigator.geolocation) {
                return null;
            }
            return new Promise<JourneyAnchor | null>((resolve) => {
                navigator.geolocation.getCurrentPosition(
                    (pos) => {
                        seekerPosRef.current = {
                            lat: pos.coords.latitude,
                            lng: pos.coords.longitude,
                            at: Date.now(),
                        };
                        resolve({
                            lat: pos.coords.latitude,
                            lng: pos.coords.longitude,
                            departAt: Date.now(),
                        });
                    },
                    () => resolve(null),
                    { enableHighAccuracy: true, timeout: 6_000, maximumAge: 30_000 },
                );
            });
        };

        (async () => {
            const anchor = await resolveAnchor();
            if (cancelled) return;
            if (!anchor) {
                // No anchor yet (hider mode + zero questions, or
                // seeker mode + GPS denied) — clear so the overlay
                // doesn't display stale data.
                travelTimesFC.set(null);
                return;
            }

            // Optimistic immediate publish so the user sees station
            // markers right away, with arrival times filling in as
            // requests resolve. Avoids the "nothing happens until
            // ResRobot replies" UX.
            travelTimesFC.set(stationsToFC(stations, new Map(), anchor.departAt));

            const results = await provider.fetchArrivals(
                anchor,
                stations,
                controller.signal,
            );
            if (cancelled) return;

            const arrivalMap = new Map<string, number>();
            for (const r of results) {
                if (r.arrivalAt != null) arrivalMap.set(r.stopId, r.arrivalAt);
            }
            travelTimesFC.set(stationsToFC(stations, arrivalMap, anchor.departAt));
        })();

        return () => {
            cancelled = true;
            controller.abort();
        };
        // anchorMode + zones are the meaningful inputs; $questions
        // shows up because hider-mode anchor reads from it.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled, anchorMode, zones, $questions.length]);

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

/** Build the FeatureCollection shape Map.tsx expects from
 *  travelTimesFC. Stations without a known arrival still appear
 *  (with an empty label) so the user sees something the moment
 *  the overlay turns on. */
function stationsToFC(
    stations: JourneyStop[],
    arrivals: Map<string, number>,
    departAt: number,
): GeoJSON.FeatureCollection<
    GeoJSON.Point,
    {
        stopId: string;
        name?: string;
        arrivalLabel?: string;
        reachable?: boolean;
        reached?: boolean;
    }
> {
    const now = Date.now();
    return {
        type: "FeatureCollection",
        features: stations.map((s) => {
            const arrival = arrivals.get(s.id);
            const reachable = arrival != null && arrival >= departAt;
            const reached = arrival != null && arrival <= now;
            return {
                type: "Feature",
                geometry: { type: "Point", coordinates: [s.lng, s.lat] },
                properties: {
                    stopId: s.id,
                    name: s.name,
                    arrivalLabel: arrival != null ? formatHHMM(arrival) : "",
                    reachable,
                    reached,
                },
            };
        }),
    };
}

function formatHHMM(unixMs: number): string {
    const d = new Date(unixMs);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default TravelTimesOverlay;
