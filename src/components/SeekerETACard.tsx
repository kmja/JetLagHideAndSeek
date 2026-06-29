import { useStore } from "@nanostores/react";
import { Loader2, Radar } from "lucide-react";
import { useEffect, useState } from "react";

import { hidingZone } from "@/lib/hiderRole";
import { activeJourneyProvider } from "@/lib/journey/registry";
import { seekerLocations } from "@/lib/multiplayer/session";
import { cn } from "@/lib/utils";

/**
 * "How close are the seekers?" — the hider's awareness card for the
 * active phase.
 *
 * Anchored at the seekers' LIVE shared position, departing NOW. Per the
 * game rules, the seeker team moves and travels as one, so any seeker
 * broadcasting a recent location is a fine anchor (we pick the freshest
 * broadcast). The card answers "how soon could the seekers reach my
 * hiding-zone station from where they are right now?", which only
 * makes sense once they're moving (the seeking phase) — game-start
 * isn't a useful proxy: the seekers have been moving since the
 * whistle.
 *
 * Renders nothing when:
 *   - no committed hiding zone
 *   - no seeker is currently sharing their location (the rule is they
 *     MUST share; outside the grace window the game pauses — that
 *     pause is wired separately, this card just stays quiet)
 *   - no journey provider for this region
 */
const STALE_THRESHOLD_MS = 60_000;

export function SeekerETACard() {
    const $zone = useStore(hidingZone);
    const $seekers = useStore(seekerLocations);

    // Pick the freshest seeker broadcast; ignore anything older than
    // STALE_THRESHOLD_MS to avoid showing an ETA from a position that
    // hasn't been updated in a while.
    const seeker = (() => {
        const now = Date.now();
        let best: { lat: number; lng: number; ts: number } | null = null;
        for (const s of Object.values($seekers)) {
            if (now - s.ts > STALE_THRESHOLD_MS) continue;
            if (best === null || s.ts > best.ts) {
                best = { lat: s.lat, lng: s.lng, ts: s.ts };
            }
        }
        return best;
    })();

    const [arrivalAt, setArrivalAt] = useState<number | null>(null);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (!$zone || !seeker) {
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
                    {
                        lat: seeker.lat,
                        lng: seeker.lng,
                        departAt: Date.now(),
                    },
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
            setArrivalAt(r && r.arrivalAt != null ? r.arrivalAt : null);
        })();
        return () => {
            cancelled = true;
            controller.abort();
        };
        // Anchor changes infrequently — re-fetching on every GPS jitter
        // would burn quota for no signal change. We round the seeker
        // coords to 4 decimals (~11 m) so a 5-m wiggle doesn't refire,
        // but a real move does.
    }, [
        $zone,
        seeker == null,
        seeker?.lat != null ? Number(seeker.lat.toFixed(4)) : null,
        seeker?.lng != null ? Number(seeker.lng.toFixed(4)) : null,
    ]);

    if (!$zone) return null;
    if (!seeker) {
        // No live seeker location. The "must share" enforcement +
        // pause-after-grace lives elsewhere; this card simply stays
        // hidden until a broadcast lands.
        return null;
    }

    const now = Date.now();
    const minutesAway =
        arrivalAt != null ? Math.round((arrivalAt - now) / 60_000) : null;

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
                    "border-success/40 bg-success/10",
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
                    <div className="mt-0.5 text-sm font-inter-tight font-bold">
                        {minutesAway < 0 ? (
                            <>They could already be there.</>
                        ) : minutesAway === 0 ? (
                            <>Any minute now.</>
                        ) : (
                            <>~{minutesAway} min away</>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

export default SeekerETACard;
