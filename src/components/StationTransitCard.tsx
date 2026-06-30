import { useStore } from "@nanostores/react";
import { Flag, MapPin, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "react-toastify";
import { Drawer as VaulDrawer } from "vaul";

import { JourneyCard } from "@/components/JourneyCard";
import { appConfirm } from "@/lib/confirm";
import { lastKnownPosition } from "@/lib/context";
import {
    allowedTransit,
    endgameStartedAt,
    hidingPeriodEndsAt,
} from "@/lib/gameSetup";
import { roundFoundAt } from "@/lib/hiderRole";
import { fetchTripPlan, type Journey } from "@/lib/journey/plan";
import { selectedMapStation } from "@/lib/journey/state";
import { seekerStartEndgame } from "@/lib/multiplayer/store";
import { cn } from "@/lib/utils";

/** Pretty label for an inferred transit mode. */
const MODE_LABELS: Record<string, string> = {
    subway: "Metro",
    tram: "Tram",
    light_rail: "Light rail",
    train: "Train",
    bus: "Bus",
    ferry: "Ferry",
};
const modeLabel = (m: string) =>
    MODE_LABELS[m] ?? m.charAt(0).toUpperCase() + m.slice(1);

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
export function StationTransitCard({
    allowEndgame = false,
}: {
    /** Seeker surface only: show the "Start endgame here" action, which
     *  declares the seekers have entered THIS candidate zone (rulebook
     *  p43 — the endgame begins once seekers reach the hider's zone). The
     *  hider's copy of this card never gets it. */
    allowEndgame?: boolean;
} = {}) {
    const station = useStore(selectedMapStation);
    const $gps = useStore(lastKnownPosition);
    const $allowed = useStore(allowedTransit);
    const $endsAt = useStore(hidingPeriodEndsAt);
    const $endgame = useStore(endgameStartedAt);
    const $found = useStore(roundFoundAt);

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
                    modes: $allowed,
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
    }, [station?.lat, station?.lng, $gps?.lat, $gps?.lng, $allowed.join(",")]);

    const close = () => selectedMapStation.set(null);

    // Endgame trigger is offered only on the seeker surface, once the
    // hiding period is over and before the endgame is armed / the hider is
    // found. Per the rulebook the endgame starts when the seekers reach
    // the hider's zone — selecting that zone's station here is the natural
    // place to declare it.
    const canTriggerEndgame =
        allowEndgame &&
        station !== null &&
        $endsAt !== null &&
        Date.now() >= $endsAt &&
        $endgame === null &&
        $found === null;

    const handleStartEndgame = async () => {
        const ok = await appConfirm({
            title: "Start the endgame here?",
            description: `Tells the hider you've reached their zone${
                station?.name ? ` — ${station.name}` : ""
            }, so they must lock to a final spot. If you've got the wrong zone, the hider can refute it and you keep searching. Only declare it once you're actually inside the hider's zone and off transit.`,
            confirmLabel: "Start endgame",
        });
        if (!ok) return;
        seekerStartEndgame();
        toast.success("Endgame declared — hider notified.", {
            autoClose: 2500,
        });
        close();
    };

    return (
        <VaulDrawer.Root
            open={station !== null}
            onOpenChange={(o) => {
                if (!o) close();
            }}
            shouldScaleBackground={false}
            // Non-modal so the map behind stays interactive: you can tap
            // another zone to switch the selection without closing the
            // card first. No dark scrim for the same reason.
            modal={false}
        >
            <VaulDrawer.Portal>
                <VaulDrawer.Content className="fixed inset-x-0 bottom-0 z-[1045] mt-24 flex max-h-[80vh] flex-col rounded-t-[10px] border bg-background text-foreground pb-[env(safe-area-inset-bottom)]">
                    <div className="mx-auto mt-3 mb-1 h-1.5 w-12 shrink-0 rounded-full bg-foreground/25" />
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
                                {station?.modes && station.modes.length > 0 && (
                                    <div className="mt-1.5 flex flex-wrap gap-1">
                                        {station.modes.map((m) => (
                                            <span
                                                key={m}
                                                className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-poppins font-semibold uppercase tracking-wide bg-primary/15 text-primary"
                                            >
                                                {modeLabel(m)}
                                            </span>
                                        ))}
                                    </div>
                                )}
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

                        {canTriggerEndgame && (
                            <div className="mt-3 space-y-1.5">
                                <button
                                    type="button"
                                    onClick={handleStartEndgame}
                                    className={cn(
                                        "flex w-full items-center justify-center gap-2 rounded-md px-3 py-2.5",
                                        "border-2 border-yellow-500/60 bg-yellow-500/15",
                                        "text-yellow-600 dark:text-yellow-300",
                                        "hover:bg-yellow-500/25 active:bg-yellow-500/30 transition-colors",
                                        "text-xs font-poppins font-bold uppercase tracking-wider",
                                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                    )}
                                >
                                    <Flag
                                        className="h-4 w-4"
                                        strokeWidth={2.5}
                                    />
                                    Start endgame here
                                </button>
                                <p className="text-[11px] leading-snug text-muted-foreground text-center px-1">
                                    Declare you&apos;ve reached this zone. The
                                    hider locks to a final spot — or refutes it
                                    if you&apos;re at the wrong place.
                                </p>
                            </div>
                        )}
                    </div>
                </VaulDrawer.Content>
            </VaulDrawer.Portal>
        </VaulDrawer.Root>
    );
}

export default StationTransitCard;
