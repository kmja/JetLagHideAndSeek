import { useStore } from "@nanostores/react";
import { Flag, MapPin, Navigation, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Drawer as VaulDrawer } from "vaul";

import { JourneyCard } from "@/components/JourneyCard";
import { lastKnownPosition } from "@/lib/context";
import {
    gameSize,
    gameStartPosition,
    HIDING_PERIOD_MINUTES,
    hidingPeriodEndsAt,
} from "@/lib/gameSetup";
import { playerRole } from "@/lib/hiderRole";
import { fetchTripPlan, type Journey } from "@/lib/journey/plan";
import { selectedMapStation } from "@/lib/journey/state";
import { cn } from "@/lib/utils";

/**
 * Map-first trip info. Opens when the user taps a station / candidate
 * hiding zone on the map (`selectedMapStation`), and plans a trip TO
 * that station from the role-appropriate origin:
 *
 *   - Seeker → from `gameStartPosition` (where the hider started),
 *     departing at the start of the hiding period. The seeker's
 *     question while scanning candidate zones is "could the hider have
 *     reached here, and how?" — so we show the route AND a reachability
 *     verdict against `hidingPeriodEndsAt` (reachable in time → the
 *     hider could be here; not → rule this zone out).
 *   - Hider → from live GPS, departing now. While exploring where to
 *     hide, the question is "can I get there from where I am?".
 *
 * Reuses the shared `JourneyCard` renderer over the same
 * `/api/travel/plan` worker endpoint as the search-based planner.
 */
export function StationTransitCard() {
    const station = useStore(selectedMapStation);
    const $role = useStore(playerRole);
    const $gps = useStore(lastKnownPosition);
    const $startPos = useStore(gameStartPosition);
    const $endsAt = useStore(hidingPeriodEndsAt);
    const $size = useStore(gameSize);

    const isSeeker = $role === "seeker";

    const [planning, setPlanning] = useState(false);
    const [journey, setJourney] = useState<Journey | null>(null);
    const [source, setSource] = useState<string | undefined>(undefined);
    const [error, setError] = useState<string | null>(null);

    // Origin + departure depend on the role. Seekers reason from the
    // shared game-start position at the hiding-period start; hiders from
    // their live position, now.
    const origin = isSeeker ? $startPos : $gps;
    const departAt =
        isSeeker && $endsAt != null
            ? $endsAt - HIDING_PERIOD_MINUTES[$size] * 60_000
            : Date.now();

    useEffect(() => {
        if (!station) {
            setJourney(null);
            setSource(undefined);
            setError(null);
            setPlanning(false);
            return;
        }
        if (!origin) {
            setError(
                isSeeker
                    ? "No game-start position captured yet — can't estimate the hider's route."
                    : "Waiting for your GPS position…",
            );
            return;
        }
        let cancelled = false;
        const controller = new AbortController();
        setPlanning(true);
        setError(null);
        setJourney(null);
        (async () => {
            const resp = await fetchTripPlan(
                {
                    origin: { lat: origin.lat, lng: origin.lng },
                    destination: {
                        lat: station.lat,
                        lng: station.lng,
                        name: station.name,
                    },
                    departAt,
                },
                controller.signal,
            );
            if (cancelled) return;
            setPlanning(false);
            if (!resp || !resp.journey) {
                setError("Couldn't plan a route to this station.");
                return;
            }
            setJourney(resp.journey);
            setSource(resp.source);
        })();
        return () => {
            cancelled = true;
            controller.abort();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [station?.lat, station?.lng, origin?.lat, origin?.lng, departAt, isSeeker]);

    const close = () => selectedMapStation.set(null);

    // Seeker reachability verdict — only meaningful with a real transit
    // journey (walking-fallback arrival times aren't a schedule).
    const reachable =
        isSeeker &&
        journey != null &&
        $endsAt != null &&
        source !== "walking"
            ? journey.arriveAt <= $endsAt
            : null;

    return (
        <VaulDrawer.Root
            open={station !== null}
            onOpenChange={(o) => {
                if (!o) close();
            }}
            shouldScaleBackground={false}
        >
            <VaulDrawer.Portal>
                <VaulDrawer.Overlay className="fixed inset-0 z-[1040] bg-black/40" />
                <VaulDrawer.Content className="fixed inset-x-0 bottom-0 z-[1045] mt-24 flex max-h-[80vh] flex-col rounded-t-[10px] border bg-background text-foreground pb-[env(safe-area-inset-bottom)]">
                    <div className="mx-auto mt-3 mb-1 h-1.5 w-12 shrink-0 rounded-full bg-muted" />
                    <div className="overflow-y-auto px-5 pt-3 pb-6">
                        <div className="flex items-start gap-2.5">
                            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/15">
                                <MapPin className="h-4.5 w-4.5 text-primary" />
                            </span>
                            <div className="min-w-0 flex-1">
                                <VaulDrawer.Title className="font-inter-tight text-lg font-black uppercase leading-tight tracking-tight">
                                    {station?.name ?? "Selected station"}
                                </VaulDrawer.Title>
                                <VaulDrawer.Description className="mt-0.5 text-xs text-muted-foreground">
                                    {isSeeker
                                        ? "Could the hider have reached here from the start?"
                                        : "Your route to this station"}
                                </VaulDrawer.Description>
                            </div>
                            <button
                                type="button"
                                onClick={close}
                                aria-label="Close"
                                className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-accent"
                            >
                                <X className="h-4 w-4" />
                            </button>
                        </div>

                        {/* Seeker reachability verdict */}
                        {reachable !== null && (
                            <div
                                className={cn(
                                    "mt-3 flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-semibold",
                                    reachable
                                        ? "border-destructive/50 bg-destructive/10 text-destructive"
                                        : "border-emerald-500/50 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
                                )}
                            >
                                <Flag className="h-4 w-4 shrink-0" />
                                {reachable
                                    ? "Reachable in time — the hider could be here."
                                    : "Not reachable before the whistle — rule this zone out."}
                            </div>
                        )}

                        <div className="mt-3">
                            <JourneyCard
                                journey={journey}
                                source={source}
                                loading={planning}
                                error={error}
                                title={
                                    isSeeker
                                        ? "From game start"
                                        : "From your location"
                                }
                            />
                        </div>

                        <p className="mt-3 flex items-center gap-1.5 text-[11px] leading-snug text-muted-foreground">
                            {isSeeker ? (
                                <Navigation className="h-3 w-3 shrink-0" />
                            ) : (
                                <Navigation className="h-3 w-3 shrink-0" />
                            )}
                            {isSeeker
                                ? "Estimated from the shared game-start position at the hiding-period start."
                                : "Estimated from your live position now."}
                        </p>
                    </div>
                </VaulDrawer.Content>
            </VaulDrawer.Portal>
        </VaulDrawer.Root>
    );
}

export default StationTransitCard;
