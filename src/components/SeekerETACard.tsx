import { useStore } from "@nanostores/react";
import { Footprints, Loader2, Radar, Train } from "lucide-react";
import { useEffect, useState } from "react";

// Reservations on the loading/walked flow are tracked here so a future
// pass can thread `source` ("walking" fallback) through the journey
// provider; today the seekers' ETA is rendered with the same fidelity
// as the hider's reach overlay's labels.

import {
    gameStartPosition,
    hidingPeriodEndsAt,
} from "@/lib/gameSetup";
import { hidingZone } from "@/lib/hiderRole";
import { activeJourneyProvider } from "@/lib/journey/registry";
import { cn } from "@/lib/utils";

/**
 * "How close are the seekers?" — the hider's awareness card for the
 * active phase. Computes the seekers' earliest possible arrival at the
 * hider's committed hiding-zone station, anchored at the shared
 * `gameStartPosition` and departing at the whistle (the worst-case
 * upper bound on seeker proximity — they could be slower in practice
 * if they took a detour, but never faster). Shown in the seeking
 * phase, hidden during pre-game / hiding / grace / forfeit / over.
 *
 * Uses the same `/api/journey/arrivals` proxy and the same anchor as
 * the hider's reach overlay, so the worker's R2 cache covers the
 * repeat hits as the card re-mounts. One station, one query — cheap.
 *
 * Renders nothing when:
 *   - no committed hiding zone (`hidingZone` is null)
 *   - no `gameStartPosition` captured
 *   - no `hidingPeriodEndsAt` set
 *   - no journey provider for this region (walks fallback would be
 *     misleading here — better to say nothing than to show a fake
 *     arrival)
 */
export function SeekerETACard() {
    const $zone = useStore(hidingZone);
    const $start = useStore(gameStartPosition);
    const $endsAt = useStore(hidingPeriodEndsAt);

    const [arrivalAt, setArrivalAt] = useState<number | null>(null);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (!$zone || !$start || !$endsAt) {
            setArrivalAt(null);
            return;
        }
        const provider = activeJourneyProvider();
        if (!provider) {
            setArrivalAt(null);
            return;
        }
        let cancelled = false;
        const controller = new AbortController();
        setLoading(true);
        (async () => {
            const results = await provider
                .fetchArrivals(
                    { lat: $start.lat, lng: $start.lng, departAt: $endsAt },
                    [
                        {
                            id: "hidingZone",
                            name: $zone.stationName,
                            lat: $zone.stationLat,
                            lng: $zone.stationLng,
                        },
                    ],
                    controller.signal,
                )
                .catch(() => []);
            if (cancelled) return;
            setLoading(false);
            const r = results[0];
            // The arrivals provider doesn't distinguish a walking-
            // fallback from a real transit answer here; a future pass
            // can thread a `source` field through if the seekers'
            // commute is borderline.
            setArrivalAt(r && r.arrivalAt != null ? r.arrivalAt : null);
        })();
        return () => {
            cancelled = true;
            controller.abort();
        };
    }, [$zone, $start?.lat, $start?.lng, $endsAt]);

    if (!$zone || !$start || !$endsAt) return null;

    const now = Date.now();
    const minutesAway =
        arrivalAt != null ? Math.round((arrivalAt - now) / 60_000) : null;
    const safetyMinutes =
        arrivalAt != null ? Math.round((arrivalAt - $endsAt) / 60_000) : null;

    // Color the band by how close the seekers are RIGHT NOW.
    //   ≥ 15 min away: comfortable
    //   5–14:           heads-up
    //   0–4:            imminent
    //   < 0:            they may already be there
    const tone =
        minutesAway == null
            ? "neutral"
            : minutesAway >= 15
              ? "comfortable"
              : minutesAway >= 5
                ? "heads-up"
                : minutesAway >= 0
                  ? "imminent"
                  : "arrived";

    return (
        <div
            className={cn(
                "rounded-md border px-3 py-2 flex items-start gap-2.5",
                tone === "comfortable" &&
                    "border-emerald-500/40 bg-emerald-500/10",
                tone === "heads-up" &&
                    "border-yellow-500/40 bg-yellow-500/10",
                tone === "imminent" &&
                    "border-orange-500/50 bg-orange-500/10",
                tone === "arrived" &&
                    "border-destructive/50 bg-destructive/10",
                tone === "neutral" && "border-border bg-secondary/40",
            )}
            aria-live="polite"
        >
            <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-sm bg-background/60">
                <Radar className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0 flex-1 leading-tight">
                <div className="text-[10px] font-poppins font-bold uppercase tracking-[0.14em] text-muted-foreground">
                    Seekers' ETA to your station
                </div>
                {loading && arrivalAt == null && (
                    <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground italic">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        Estimating…
                    </div>
                )}
                {!loading && minutesAway == null && (
                    <div className="mt-0.5 text-xs italic text-muted-foreground">
                        No transit route — couldn't estimate.
                    </div>
                )}
                {minutesAway != null && (
                    <>
                        <div className="mt-0.5 text-sm font-inter-tight font-bold">
                            {minutesAway < 0 ? (
                                <>They could already be there.</>
                            ) : minutesAway === 0 ? (
                                <>Any minute now.</>
                            ) : (
                                <>~{minutesAway} min away</>
                            )}
                        </div>
                        {safetyMinutes != null && (
                            <div className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-muted-foreground tabular-nums">
                                {safetyMinutes >= 0 ? (
                                    <>
                                        <Train className="h-3 w-3" />
                                        {safetyMinutes} min after the whistle
                                    </>
                                ) : (
                                    <>
                                        <Footprints className="h-3 w-3" />
                                        Reachable before the whistle blew
                                    </>
                                )}
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}

export default SeekerETACard;
