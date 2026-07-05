import { useStore } from "@nanostores/react";
import { LocateFixed, MapPin, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Drawer as VaulDrawer } from "vaul";

import { JourneyCard } from "@/components/JourneyCard";
import { Button } from "@/components/ui/button";
import { lastKnownPosition } from "@/lib/context";
import { allowedTransit } from "@/lib/gameSetup";
import {
    fetchTripPlan,
    type Journey,
    type PlanResponse,
    type TravelPlace,
} from "@/lib/journey/plan";
import { seekerTripPlannerOpen } from "@/lib/journey/state";
import { useOwnedTripRoute } from "@/hooks/useOwnedTripRoute";
import { cn } from "@/lib/utils";
import { forwardGeocodeOne } from "@/maps/api/geocode";

/**
 * Seeker's trip planner. The seeker types or pastes a place name (or
 * an explicit "lat,lng" pair) and gets a single planned journey from
 * their live GPS to that destination — same renderer the hider uses
 * (`JourneyCard`) on top of the same `/api/travel/plan` worker
 * endpoint.
 *
 * Why a fresh component: the existing PlacePicker is play-area-search-
 * specific (filters to OSM relations of admin/place type for boundary
 * fetch). For ad-hoc trip destinations we want any landmark, station,
 * or address — that's `forwardGeocodeOne` with `filter=false`.
 *
 * GPS origin is `lastKnownPosition` — the seeker is the one taking
 * the trip; there's no scenario where they'd want to compute a trip
 * from somewhere they aren't standing.
 */
export function SeekerTripPlannerSheet() {
    const open = useStore(seekerTripPlannerOpen);
    const $gps = useStore(lastKnownPosition);
    const $allowed = useStore(allowedTransit);
    // We only need to know IF we have a fix to trigger the first plan —
    // NOT the live coordinates. Re-planning on coordinate changes is what
    // made the card reload constantly: a city GPS fix can jump hundreds of
    // metres while standing still (urban multipath), past any sane
    // movement threshold. So we plan once when a fix is available and
    // re-plan only on Refresh / destination / mode changes (see effect).
    const hasGps = $gps != null;

    const [query, setQuery] = useState("");
    const [destination, setDestination] = useState<TravelPlace | null>(null);
    const [searching, setSearching] = useState(false);
    const [searchError, setSearchError] = useState<string | null>(null);

    const [planning, setPlanning] = useState(false);
    const [journey, setJourney] = useState<Journey | null>(null);
    const [source, setSource] = useState<string | undefined>(undefined);
    const [planError, setPlanError] = useState<string | null>(null);
    const [nonce, setNonce] = useState(0);
    // Last-planned input signature (destination + modes + refresh nonce).
    // GPS is excluded so position jitter doesn't re-plan; see the effect.
    const lastSigRef = useRef<string | null>(null);

    // Mirror the planned journey onto the map route overlay; clear it
    // when there's no journey or the planner unmounts.
    useOwnedTripRoute(journey);

    // On close, only clear the transient search-input state. The
    // destination + planned journey PERSIST so (a) the route overlay
    // stays visible on the map once the drawer is out of the way — the
    // whole point of drawing it — and (b) reopening resumes the last
    // trip. "Change" (clearDestination) is the explicit way to drop it.
    useEffect(() => {
        if (!open) {
            setQuery("");
            setSearchError(null);
        }
    }, [open]);

    // Plan ONCE per (destination, modes, refresh) — GPS is deliberately
    // NOT in the signature or the deps, so a jittering city fix can't
    // re-run this. We read the freshest `lastKnownPosition` lazily at plan
    // time (so Refresh always recomputes from where you are now). The
    // effect re-fires only when: the destination changes, the allowed
    // modes change, the user taps Refresh (nonce), or a GPS fix first
    // becomes available (`hasGps` false→true) to drive the initial plan.
    useEffect(() => {
        if (!open || !destination || !hasGps) return;
        const sig = `${destination.lat},${destination.lng}|${$allowed.join(",")}|${nonce}`;
        if (lastSigRef.current === sig) return;
        const gps = lastKnownPosition.get();
        if (!gps) return;
        lastSigRef.current = sig;
        let cancelled = false;
        const controller = new AbortController();
        setPlanning(true);
        setPlanError(null);
        (async () => {
            const resp: PlanResponse | null = await fetchTripPlan(
                {
                    origin: { lat: gps.lat, lng: gps.lng },
                    destination,
                    departAt: Date.now(),
                    modes: $allowed,
                },
                controller.signal,
            );
            if (cancelled) return;
            setPlanning(false);
            if (!resp) {
                setJourney(null);
                setSource(undefined);
                setPlanError(
                    "Couldn't reach the route planner — check your connection.",
                );
                return;
            }
            setJourney(resp.journey);
            setSource(resp.source);
            if (!resp.journey)
                setPlanError("No route could be planned right now.");
        })();
        return () => {
            cancelled = true;
            controller.abort();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, destination?.lat, destination?.lng, $allowed, nonce, hasGps]);

    const search = async () => {
        const q = query.trim();
        if (!q) return;
        setSearching(true);
        setSearchError(null);
        try {
            // Allow explicit "lat, lng" pasted input.
            const coord = parseLatLng(q);
            if (coord) {
                setDestination({
                    ...coord,
                    name: `${coord.lat.toFixed(4)}, ${coord.lng.toFixed(4)}`,
                });
                return;
            }
            const hit = await forwardGeocodeOne(q);
            if (!hit) {
                setSearchError(
                    "Couldn't find that place — try a more specific name or paste lat, lng.",
                );
                return;
            }
            setDestination({
                lat: hit.lat,
                lng: hit.lng,
                name: hit.displayName,
            });
        } catch {
            setSearchError("Search failed — try again.");
        } finally {
            setSearching(false);
        }
    };

    const clearDestination = () => {
        setDestination(null);
        setJourney(null);
        setSource(undefined);
        setPlanError(null);
        lastSigRef.current = null;
    };

    return (
        <VaulDrawer.Root
            open={open}
            onOpenChange={(o) => seekerTripPlannerOpen.set(o)}
            shouldScaleBackground={false}
        >
            <VaulDrawer.Portal>
                <VaulDrawer.Overlay className="fixed inset-0 z-[1040] bg-black/60" />
                <VaulDrawer.Content className="fixed inset-x-0 bottom-0 z-[1045] mt-24 flex h-auto max-h-[85vh] flex-col rounded-t-[10px] border bg-background text-foreground pb-[env(safe-area-inset-bottom)]">
                    <div className="mx-auto mt-3 mb-1 h-1.5 w-12 shrink-0 rounded-full bg-foreground/25" />
                    <div className="overflow-y-auto px-6 pt-4 pb-6 space-y-4">
                        <div className="space-y-1.5">
                            <VaulDrawer.Title className="text-lg font-semibold leading-none tracking-tight">
                                Plan a trip
                            </VaulDrawer.Title>
                            <VaulDrawer.Description className="text-sm text-muted-foreground">
                                Live route from your current GPS to a place you
                                want to visit. Walking estimate when no live
                                schedule exists for your area.
                            </VaulDrawer.Description>
                        </div>

                        {/* GPS pane */}
                        <div
                            className={cn(
                                "rounded-sm border border-border bg-secondary/40 p-2",
                                "flex items-center gap-2 text-xs",
                            )}
                        >
                            <LocateFixed
                                className={cn(
                                    "w-4 h-4",
                                    $gps
                                        ? "text-primary"
                                        : "text-muted-foreground",
                                )}
                            />
                            <span className="text-muted-foreground">From</span>
                            <span className="font-bold tabular-nums">
                                {$gps
                                    ? `${$gps.lat.toFixed(4)}, ${$gps.lng.toFixed(4)}`
                                    : "GPS unavailable — enable location"}
                            </span>
                        </div>

                        {/* Destination input */}
                        {!destination && (
                            <div className="space-y-2">
                                <div className="text-[10px] uppercase tracking-[0.16em] font-poppins font-bold text-muted-foreground">
                                    Destination
                                </div>
                                <div className="flex gap-2">
                                    <input
                                        type="text"
                                        value={query}
                                        onChange={(e) =>
                                            setQuery(e.target.value)
                                        }
                                        onKeyDown={(e) => {
                                            if (e.key === "Enter") {
                                                e.preventDefault();
                                                void search();
                                            }
                                        }}
                                        placeholder="Place name, station, or lat, lng"
                                        className={cn(
                                            "flex-1 h-9 px-3 rounded-md bg-background border border-border",
                                            "text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                        )}
                                        autoFocus
                                    />
                                    <Button
                                        size="sm"
                                        onClick={() => void search()}
                                        disabled={
                                            searching || query.trim() === ""
                                        }
                                        className="gap-1.5"
                                    >
                                        <Search className="w-3.5 h-3.5" />
                                        {searching ? "Searching…" : "Search"}
                                    </Button>
                                </div>
                                {searchError && (
                                    <p className="text-xs text-destructive">
                                        {searchError}
                                    </p>
                                )}
                            </div>
                        )}

                        {/* Destination summary */}
                        {destination && (
                            <div className="space-y-2">
                                <div className="text-[10px] uppercase tracking-[0.16em] font-poppins font-bold text-muted-foreground">
                                    Destination
                                </div>
                                <div
                                    className={cn(
                                        "rounded-sm border border-border bg-secondary/40 p-2.5",
                                        "flex items-center gap-2",
                                    )}
                                >
                                    <MapPin className="w-4 h-4 text-primary shrink-0" />
                                    <div className="flex-1 min-w-0">
                                        <div className="text-sm font-inter-tight font-bold truncate">
                                            {destination.name ?? "Picked place"}
                                        </div>
                                        <div className="text-[10px] text-muted-foreground tabular-nums">
                                            {destination.lat.toFixed(4)},{" "}
                                            {destination.lng.toFixed(4)}
                                        </div>
                                    </div>
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        onClick={clearDestination}
                                        className="gap-1 text-xs"
                                    >
                                        Change
                                    </Button>
                                </div>

                                <JourneyCard
                                    title="Route"
                                    journey={journey}
                                    source={source}
                                    loading={planning}
                                    error={planError}
                                    onRefresh={() => setNonce((n) => n + 1)}
                                />
                            </div>
                        )}

                        {!$gps && (
                            <p className="text-[11px] leading-snug text-muted-foreground">
                                Trip planning needs your live GPS to set the
                                origin. Enable location for this site in your
                                browser settings and reopen the planner.
                            </p>
                        )}
                    </div>
                </VaulDrawer.Content>
            </VaulDrawer.Portal>
        </VaulDrawer.Root>
    );
}

function parseLatLng(s: string): { lat: number; lng: number } | null {
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(s);
    if (!m) return null;
    const lat = Number(m[1]);
    const lng = Number(m[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    return { lat, lng };
}

export default SeekerTripPlannerSheet;
