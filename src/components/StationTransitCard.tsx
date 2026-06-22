import { useStore } from "@nanostores/react";
import { MapPin, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Drawer as VaulDrawer } from "vaul";

import { JourneyCard } from "@/components/JourneyCard";
import { lastKnownPosition } from "@/lib/context";
import { fetchTripPlan, type Journey } from "@/lib/journey/plan";
import { selectedMapStation } from "@/lib/journey/state";

/**
 * Map-first trip info. Opens when the user taps a station / candidate
 * hiding zone on the map (`selectedMapStation`), and plans a trip TO
 * that station from the player's live GPS departing now.
 *
 * Identical for both roles — the seeker uses it to plan a route TO a
 * candidate hiding zone from where they're standing now; the hider
 * uses it while exploring where to hide. Whether the *hider* could
 * have reached a station in time is the colored-dots overlay's job
 * (TravelTimesOverlay on the seeker map), not this card's — keeping
 * them separate avoids conflating "could the hider have made it" with
 * "how do I, the seeker, get there now".
 */
export function StationTransitCard() {
    const station = useStore(selectedMapStation);
    const $gps = useStore(lastKnownPosition);

    const [planning, setPlanning] = useState(false);
    const [journey, setJourney] = useState<Journey | null>(null);
    const [source, setSource] = useState<string | undefined>(undefined);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!station) {
            setJourney(null);
            setSource(undefined);
            setError(null);
            setPlanning(false);
            return;
        }
        if (!$gps) {
            setError("Waiting for your GPS position…");
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
                    origin: { lat: $gps.lat, lng: $gps.lng },
                    destination: {
                        lat: station.lat,
                        lng: station.lng,
                        name: station.name,
                    },
                    departAt: Date.now(),
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
    }, [station?.lat, station?.lng, $gps?.lat, $gps?.lng]);

    const close = () => selectedMapStation.set(null);

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
                                    Your route from where you are now
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

                        <div className="mt-3">
                            <JourneyCard
                                journey={journey}
                                source={source}
                                loading={planning}
                                error={error}
                            />
                        </div>
                    </div>
                </VaulDrawer.Content>
            </VaulDrawer.Portal>
        </VaulDrawer.Root>
    );
}

export default StationTransitCard;
