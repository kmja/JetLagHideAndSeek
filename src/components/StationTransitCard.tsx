import { useStore } from "@nanostores/react";
import {
    CheckCircle2,
    ChevronDown,
    Clock,
    Flag,
    Loader2,
    MapPin,
    Route,
    X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "react-toastify";
import { Drawer as VaulDrawer } from "vaul";

import { JourneyCard } from "@/components/JourneyCard";
import { appConfirm } from "@/lib/confirm";
import { lastKnownPosition } from "@/lib/context";
import { haversineMeters } from "@/lib/geo";
import {
    allowedTransit,
    endgameStartedAt,
    hidingPeriodEndsAt,
    TRANSIT_ICONS,
} from "@/lib/gameSetup";
import { roundFoundAt } from "@/lib/hiderRole";
import {
    type Departure,
    type DepartureBoard,
    fetchDepartures,
} from "@/lib/journey/departures";
import { fetchTripPlan, type Journey } from "@/lib/journey/plan";
import {
    selectedMapStation,
    stationCardInsetPx,
} from "@/lib/journey/state";
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

    // Live departure board for the tapped stop — "what leaves here next?"
    // so the hider can adapt on the fly. Depends only on the STATION (not
    // the hider's GPS), so it's a separate fetch from the trip plan above.
    const [departures, setDepartures] = useState<DepartureBoard | null>(null);
    const [depLoading, setDepLoading] = useState(false);

    // Progressive disclosure: the card opens compact (title + reachability)
    // and the route/departures detail is behind an expander. (A vaul
    // snap-point / drag-to-expand version was tried but caused a hard UI
    // freeze on some devices — reverted to this deterministic toggle.)
    const [expanded, setExpanded] = useState(false);
    const [tab, setTab] = useState<"trip" | "departures">("trip");

    // Fresh station tap → collapse back + reset to the Trip tab so the card
    // doesn't stay sprawled open across selections.
    useEffect(() => {
        setExpanded(false);
        setTab("trip");
    }, [station?.lat, station?.lng]);

    // (Map-interactivity while this non-modal card is open is handled globally
    // by installBodyPointerEventsGuard — no per-card body-lock clearing here.)

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
            setJourney(
                trimTrailingAccessWalk(resp.journey, {
                    lat: station.lat,
                    lng: station.lng,
                }),
            );
            setSource(resp.source);
        })();
        return () => {
            cancelled = true;
            controller.abort();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [station?.lat, station?.lng, $gps?.lat, $gps?.lng, $allowed.join(",")]);

    // Departure board — refetched whenever the tapped stop or the allowed
    // modes change. Independent of GPS.
    useEffect(() => {
        if (!station) {
            setDepartures(null);
            setDepLoading(false);
            return;
        }
        let cancelled = false;
        const controller = new AbortController();
        setDepLoading(true);
        setDepartures(null);
        (async () => {
            const board = await fetchDepartures(
                { lat: station.lat, lng: station.lng, name: station.name },
                $allowed,
                controller.signal,
            );
            if (cancelled) return;
            setDepLoading(false);
            setDepartures(board);
        })();
        return () => {
            cancelled = true;
            controller.abort();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [station?.lat, station?.lng, $allowed.join(",")]);

    // (v789: the on-map trip-route overlay was removed — a planned route is a
    // straight leg-to-leg line, not a street path, so it was misleading. The
    // JourneyCard below still shows the textual route/legs.)

    // Publish the drawer's on-screen height so the hider map can refit
    // the trip-route view with a matching bottom inset — keeping the GPS
    // dot + tapped zone in frame as the card opens, expands or collapses.
    // A ResizeObserver catches the expand/collapse height changes.
    const contentRef = useRef<HTMLDivElement | null>(null);
    const cardOpen = station !== null;
    useEffect(() => {
        if (!cardOpen) {
            stationCardInsetPx.set(0);
            return;
        }
        const el = contentRef.current;
        if (!el || typeof ResizeObserver === "undefined") return;
        const publish = () =>
            stationCardInsetPx.set(
                Math.round(el.getBoundingClientRect().height),
            );
        publish();
        const ro = new ResizeObserver(publish);
        ro.observe(el);
        return () => {
            ro.disconnect();
            stationCardInsetPx.set(0);
        };
    }, [cardOpen]);

    // Swipe-UP on the compact card expands it (the requested drag
    // gesture) — a plain touch-delta check, deliberately NOT vaul snap
    // points (those hard-froze the UI on some devices, v651). Downward
    // drags stay vaul's own dismiss gesture; when expanded, touches
    // belong to the scrollable content so the handler stands down.
    const touchStartY = useRef<number | null>(null);
    const onCardTouchStart = (e: React.TouchEvent) => {
        touchStartY.current = e.touches[0]?.clientY ?? null;
    };
    const onCardTouchEnd = (e: React.TouchEvent) => {
        const startY = touchStartY.current;
        touchStartY.current = null;
        if (startY == null || expanded) return;
        const endY = e.changedTouches[0]?.clientY ?? startY;
        if (startY - endY > 40) setExpanded(true);
    };

    const close = () => selectedMapStation.set(null);

    // Reachability check (v643) — on-demand, one zone at a time. While the
    // hiding period is still running, compare the planned arrival at this
    // station with the whistle: can the hider actually get here in time to
    // hide? This is the per-zone replacement for the old overlay-wide
    // colour-coding (which was slow because it fanned out an arrivals fetch
    // for every station). Only shown during the hiding period with a
    // resolved journey; after the whistle (or with no plan yet) there's
    // nothing to judge.
    const reachability =
        journey && $endsAt !== null && Date.now() < $endsAt
            ? {
                  reachable: journey.arriveAt <= $endsAt,
                  // Minutes of slack before / past the whistle (rounded).
                  marginMin: Math.round(($endsAt - journey.arriveAt) / 60_000),
                  arriveAt: journey.arriveAt,
              }
            : null;

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
                <VaulDrawer.Content
                    ref={contentRef}
                    // Keep the card OPEN when the user taps the map behind
                    // it (non-modal, so the map still receives the tap and
                    // switches the selected zone in place — the reported
                    // "can't click other zones while the drawer is open").
                    // Radix would otherwise dismiss on any outside press.
                    onPointerDownOutside={(e) => e.preventDefault()}
                    onInteractOutside={(e) => e.preventDefault()}
                    onTouchStart={onCardTouchStart}
                    onTouchEnd={onCardTouchEnd}
                    className="fixed inset-x-0 bottom-0 z-[1045] mt-24 flex max-h-[80vh] flex-col rounded-t-[10px] border bg-background text-foreground pb-[env(safe-area-inset-bottom)]"
                >
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

                        {reachability && (
                            <div
                                className={cn(
                                    "mt-3 flex items-start gap-2.5 rounded-lg border-2 px-3 py-2.5",
                                    reachability.reachable
                                        ? "border-success/40 bg-success/10 text-success"
                                        : "border-destructive/40 bg-destructive/10 text-destructive",
                                )}
                            >
                                {reachability.reachable ? (
                                    <CheckCircle2
                                        className="mt-0.5 h-4.5 w-4.5 shrink-0"
                                        strokeWidth={2.5}
                                    />
                                ) : (
                                    <Clock
                                        className="mt-0.5 h-4.5 w-4.5 shrink-0"
                                        strokeWidth={2.5}
                                    />
                                )}
                                <div className="min-w-0">
                                    <div className="font-poppins text-xs font-bold uppercase tracking-wider">
                                        {reachability.reachable
                                            ? "Reachable in time"
                                            : "Out of reach"}
                                    </div>
                                    <p className="mt-0.5 text-[11px] leading-snug text-foreground/70">
                                        {reachability.reachable
                                            ? `Arrives ${formatClock(
                                                  reachability.arriveAt,
                                              )} — about ${reachability.marginMin} min before the whistle.`
                                            : `Arrives ${formatClock(
                                                  reachability.arriveAt,
                                              )} — about ${Math.abs(
                                                  reachability.marginMin,
                                              )} min after the whistle.`}
                                    </p>
                                </div>
                            </div>
                        )}

                        {canTriggerEndgame && (
                            <div className="mt-3 space-y-1.5">
                                <button
                                    type="button"
                                    onClick={handleStartEndgame}
                                    className={cn(
                                        "flex w-full items-center justify-center gap-2 rounded-md px-3 py-3",
                                        "border-2 border-yellow-500/60 bg-yellow-500/15",
                                        "text-yellow-600 dark:text-yellow-300",
                                        "hover:bg-yellow-500/25 active:bg-yellow-500/30 transition-colors",
                                        "text-sm font-poppins font-bold uppercase tracking-wider",
                                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                    )}
                                >
                                    <Flag
                                        className="h-4 w-4"
                                        strokeWidth={2.5}
                                    />
                                    Start endgame here
                                </button>
                                <p className="text-xs leading-snug text-muted-foreground text-center px-1">
                                    Declare you&apos;ve reached this zone. The
                                    hider locks to a final spot — or refutes it
                                    if you&apos;re at the wrong place.
                                </p>
                            </div>
                        )}

                        {/* Progressive disclosure — the route + departures
                            detail is behind this expander so the card opens
                            compact (just the title + reachability). */}
                        <button
                            type="button"
                            onClick={() => setExpanded((e) => !e)}
                            aria-expanded={expanded}
                            className="mt-3 flex w-full items-center justify-between rounded-lg border border-border/70 bg-sidebar-accent/40 px-3 py-2.5 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                            <span className="text-sm font-semibold">
                                {expanded
                                    ? "Hide details"
                                    : "Route & departures"}
                            </span>
                            <ChevronDown
                                className={cn(
                                    "h-4 w-4 text-muted-foreground transition-transform duration-200",
                                    expanded && "rotate-180",
                                )}
                            />
                        </button>

                        {expanded && (
                            <div className="mt-3">
                                {/* Tabs — Trip vs Departures. */}
                                <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
                                    <TabButton
                                        active={tab === "trip"}
                                        onClick={() => setTab("trip")}
                                        label="Trip"
                                    />
                                    <TabButton
                                        active={tab === "departures"}
                                        onClick={() => setTab("departures")}
                                        label="Departures"
                                        count={upcomingDepartureCount(
                                            departures,
                                        )}
                                    />
                                </div>
                                <div className="mt-3">
                                    {tab === "trip" ? (
                                        <JourneyCard
                                            journey={journey}
                                            source={source}
                                            loading={planning}
                                            error={error}
                                        />
                                    ) : (
                                        <DeparturesSection
                                            loading={depLoading}
                                            board={departures}
                                        />
                                    )}
                                </div>
                            </div>
                        )}
                    </div>
                </VaulDrawer.Content>
            </VaulDrawer.Portal>
        </VaulDrawer.Root>
    );
}

/**
 * Trim a redundant trailing WALK leg from a journey planned TO a station.
 *
 * When the destination is a transit stop (the user tapped a station on
 * the map), most planners still append a short "access walk" from the
 * alighting stop to the exact destination pin. If the last transit leg
 * already alights AT the destination station, that walk is an artifact —
 * it adds fake travel time and a bogus final "Walk → Destination" step
 * (reported: "the last step isn't arriving at the station"). Drop it and
 * re-anchor the arrival to the real transit arrival at the station.
 *
 * Conservative: only trims when the leg BEFORE the trailing walk is a
 * transit leg whose alighting point is within ~350 m of the destination
 * station. A genuine onward walk (alight a stop away and walk in) alights
 * far from the station, so it's kept.
 */
function trimTrailingAccessWalk(
    journey: Journey,
    dest: { lat: number; lng: number },
): Journey {
    const legs = journey.legs ?? [];
    if (legs.length < 2) return journey;
    const last = legs[legs.length - 1];
    if (last.mode !== "walk") return journey;
    const prev = legs[legs.length - 2];
    if (prev.mode === "walk") return journey; // don't collapse two walks
    const alightNearDest =
        haversineMeters(prev.to.lat, prev.to.lng, dest.lat, dest.lng) <= 350;
    if (!alightNearDest) return journey; // real onward walk — keep it
    const trimmed = legs.slice(0, -1);
    const arriveAt = prev.arriveAt;
    return {
        ...journey,
        legs: trimmed,
        arriveAt,
        durationMin: Math.max(
            1,
            Math.round((arriveAt - journey.departAt) / 60_000),
        ),
    };
}

/** One tab in the Trip/Departures switcher. */
function TabButton({
    active,
    onClick,
    label,
    count,
}: {
    active: boolean;
    onClick: () => void;
    label: string;
    count?: number;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-pressed={active}
            className={cn(
                "flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-semibold transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                active
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
            )}
        >
            {label}
            {typeof count === "number" && count > 0 && (
                <span className="rounded-full bg-primary/15 px-1.5 text-[10px] font-bold tabular-nums text-primary">
                    {count}
                </span>
            )}
        </button>
    );
}

/** Count of still-upcoming departures on a board (for the tab badge). */
function upcomingDepartureCount(board: DepartureBoard | null): number {
    if (!board || !board.available) return 0;
    const now = Date.now();
    return board.departures.filter((d) => d.time >= now - 60_000).length;
}

/** Mode icon for a departure — the transit-mode glyphs used across the
 *  app, with a generic fallback for an unclassified `"transit"` row. */
function departureIcon(mode: Departure["mode"]): LucideIcon {
    return (TRANSIT_ICONS as Record<string, LucideIcon>)[mode] ?? Route;
}

/**
 * Live departure board for the tapped stop — the "what leaves here next?"
 * list the hider reads to adapt on the fly. Renders a loading row while
 * fetching; a quiet empty state when the region has no live board.
 */
function DeparturesSection({
    loading,
    board,
}: {
    loading: boolean;
    board: DepartureBoard | null;
}) {
    if (loading) {
        return (
            <div className="flex items-center gap-2 rounded-lg border border-border/60 px-3 py-2.5 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Loading departures…
            </div>
        );
    }
    // No board at all (fetch failed / no coverage) → a quiet note rather
    // than a scary error; the Trip tab is still useful.
    if (!board || !board.available) {
        return (
            <div className="rounded-lg border border-border/60 px-3 py-2.5 text-xs text-muted-foreground">
                No live departures for this stop.
            </div>
        );
    }

    const now = Date.now();
    // Only future departures are actionable.
    const upcoming = board.departures.filter((d) => d.time >= now - 60_000);

    if (upcoming.length === 0) {
        return (
            <div className="rounded-lg border border-border/60 px-3 py-2.5 text-xs text-muted-foreground">
                No departures in the next couple of hours.
            </div>
        );
    }

    return (
        <ul className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/60">
            {upcoming.map((d, i) => {
                const Icon = departureIcon(d.mode);
                return (
                    <li
                        key={`${d.time}-${d.line ?? ""}-${i}`}
                        className="flex items-center gap-2.5 px-3 py-2"
                    >
                        <span
                            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded bg-primary/15 text-primary"
                            title={modeLabel(d.mode)}
                            aria-label={modeLabel(d.mode)}
                        >
                            <Icon className="h-4 w-4" />
                        </span>
                        <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-semibold leading-tight">
                                {d.line ?? modeLabel(d.mode)}
                            </div>
                            {d.headsign && (
                                <div className="truncate text-[11px] leading-tight text-muted-foreground">
                                    {d.headsign}
                                </div>
                            )}
                        </div>
                        <div className="shrink-0 text-right">
                            <div className="text-sm font-bold tabular-nums leading-tight">
                                {relativeMinutes(d.time, now)}
                            </div>
                            <div className="text-[10px] leading-tight text-muted-foreground tabular-nums">
                                {formatClock(d.time)}
                                {d.realtime ? " · live" : ""}
                            </div>
                        </div>
                    </li>
                );
            })}
        </ul>
    );
}

/** "Now" / "3 min" / "1 h 5" style countdown to a departure. */
function relativeMinutes(unixMs: number, now: number): string {
    const mins = Math.round((unixMs - now) / 60_000);
    if (mins <= 0) return "Now";
    if (mins < 60) return `${mins} min`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m === 0 ? `${h} h` : `${h} h ${m}`;
}

/** Local "HH:MM" clock label for a Unix-ms timestamp. */
function formatClock(unixMs: number): string {
    const d = new Date(unixMs);
    return `${String(d.getHours()).padStart(2, "0")}:${String(
        d.getMinutes(),
    ).padStart(2, "0")}`;
}

export default StationTransitCard;
