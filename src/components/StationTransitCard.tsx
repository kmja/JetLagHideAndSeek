import { useStore } from "@nanostores/react";
import {
    CheckCircle2,
    ChevronDown,
    Clock,
    Flag,
    Loader2,
    MapPin,
    Route,
    Tent,
    X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { JourneyCard } from "@/components/JourneyCard";
import { appConfirm } from "@/lib/confirm";
import {
    hidingRadius,
    hidingRadiusUnits,
    lastKnownPosition,
} from "@/lib/context";
import { haversineMeters } from "@/lib/geo";
import {
    allowedTransit,
    endgameStartedAt,
    hidingPeriodEndsAt,
    TRANSIT_ICONS,
    type TransitMode,
} from "@/lib/gameSetup";
import { hidingZone, playerRole, roundFoundAt } from "@/lib/hiderRole";
import { confirmAndCommitZone } from "@/lib/hiderZoneCommit";
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

/** Pick the station's headline transit-mode icon (v834 — replaces the
 *  generic teardrop pin). Prefers the "biggest" mode when a stop serves
 *  several; falls back to the map-pin when the modes are unknown. */
const MODE_ICON_PRIORITY = ["train", "subway", "tram", "ferry", "bus"];
function modeIconFor(modes?: string[]): LucideIcon {
    const primary = MODE_ICON_PRIORITY.find((m) => modes?.includes(m));
    return primary
        ? (TRANSIT_ICONS[primary as keyof typeof TRANSIT_ICONS] ?? MapPin)
        : MapPin;
}

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
    allowHiderCommit = false,
}: {
    /** Seeker surface only: show the "Start endgame here" action, which
     *  declares the seekers have entered THIS candidate zone (rulebook
     *  p43 — the endgame begins once seekers reach the hider's zone). The
     *  hider's copy of this card never gets it. */
    allowEndgame?: boolean;
    /** Hider surface only (v1020): show a "Hide here" action so the hider
     *  can commit a tapped zone straight from the map, not just via the
     *  Zone drawer's picker. Only while the hiding period runs and no zone
     *  is committed yet. */
    allowHiderCommit?: boolean;
} = {}) {
    const station = useStore(selectedMapStation);
    const $gps = useStore(lastKnownPosition);
    const $radius = useStore(hidingRadius);
    const $radiusUnits = useStore(hidingRadiusUnits);
    const $allowed = useStore(allowedTransit);
    const $endsAt = useStore(hidingPeriodEndsAt);
    const $role = useStore(playerRole);
    const $committedZone = useStore(hidingZone);
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

    const close = () => selectedMapStation.set(null);

    // Card is a plain map OVERLAY (v834 — not a vaul drawer, so the map + app
    // header stay fully interactive behind it). The compact card responds to
    // vertical swipes on its own. v844: now anchored to the TOP, so the
    // gestures flip — swipe DOWN (toward the content it reveals) expands to
    // the route/departures detail, swipe UP (off the top edge) dismisses.
    // When expanded, touches belong to the scrollable content, so the gesture
    // stands down.
    const touchStartY = useRef<number | null>(null);
    const onCardTouchStart = (e: React.TouchEvent) => {
        touchStartY.current = e.touches[0]?.clientY ?? null;
    };
    const onCardTouchEnd = (e: React.TouchEvent) => {
        const startY = touchStartY.current;
        touchStartY.current = null;
        if (startY == null || expanded) return;
        const endY = e.changedTouches[0]?.clientY ?? startY;
        if (endY - startY > 40) setExpanded(true);
        else if (startY - endY > 40) close();
    };

    // Reachability check (v643) — on-demand, one zone at a time. While the
    // hiding period is still running, compare the planned arrival at this
    // station with the whistle: can the hider actually get here in time to
    // hide? This is the per-zone replacement for the old overlay-wide
    // colour-coding (which was slow because it fanned out an arrivals fetch
    // for every station). Only shown during the hiding period with a
    // resolved journey; after the whistle (or with no plan yet) there's
    // nothing to judge.
    // The zone's hiding-radius in metres (shared by the reachability gate,
    // the seeker endgame gate, and the hider inside-zone gate).
    const endgameRadiusM = $radius * ($radiusUnits === "miles" ? 1609.34 : 1000);
    // v1022: is the HIDER physically inside the tapped zone? "Hide here" only
    // shows then, and it also suppresses the reachability banner (moot once
    // you're standing in it). GPS within the radius (+ a small GPS-noise
    // margin); no fix → can't tell → not offered.
    const hiderInsideZone =
        allowHiderCommit &&
        $role === "hider" &&
        station !== null &&
        !!$gps &&
        haversineMeters($gps.lat, $gps.lng, station.lat, station.lng) <=
            endgameRadiusM + 100;
    // v1022: when the hider is already INSIDE the zone (and can commit it),
    // "can I reach it in time" is moot — hide the reachability banner.
    const reachability =
        journey &&
        $endsAt !== null &&
        Date.now() < $endsAt &&
        !hiderInsideZone
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
    // v979: only offer "Start endgame here" for a zone the seeker has
    // actually REACHED — you can't declare the endgame before arriving
    // (rulebook p43), so showing the button for a far-off zone is pointless
    // (and the server would just deny it). Gate on the seeker's live GPS
    // being within the zone's hiding-radius (+ a generous margin for GPS
    // noise). With NO GPS fix we can't tell, so we still show it (the server
    // makes the final call).
    const seekerReachedZone =
        !$gps ||
        station === null ||
        haversineMeters($gps.lat, $gps.lng, station.lat, station.lng) <=
            endgameRadiusM + 150;
    const canTriggerEndgame =
        allowEndgame &&
        station !== null &&
        $endsAt !== null &&
        Date.now() >= $endsAt &&
        $endgame === null &&
        $found === null &&
        seekerReachedZone;

    // v1020: hider can commit the tapped zone directly from the map — only
    // while the hiding period runs, nothing is committed yet, and the hider
    // is inside the zone (`hiderInsideZone`, computed above).
    const canCommitZone =
        hiderInsideZone &&
        $committedZone === null &&
        $endsAt !== null &&
        Date.now() < $endsAt;
    const handleCommitZone = async () => {
        if (!station) return;
        const radiusM =
            $radius * ($radiusUnits === "miles" ? 1609.34 : 1000);
        const ok = await confirmAndCommitZone(
            {
                lat: station.lat,
                lng: station.lng,
                name: station.name,
                modes: station.modes as TransitMode[] | undefined,
            },
            radiusM,
        );
        if (ok) selectedMapStation.set(null);
    };

    const handleStartEndgame = async () => {
        // Rulebook p43: the endgame begins only once the seekers physically
        // REACH the hider's zone. Guard against declaring it from a zone the
        // seeker isn't actually standing in — check the seeker's live GPS
        // against the tapped zone's hiding-radius circle. GPS is noisy in the
        // dense cores this game is played in, so a generous margin keeps a
        // face-to-face declaration from being falsely blocked; only a clearly
        // outside position gets a warning (still overridable — the SERVER
        // validates the claim against the hider's secret zone regardless).
        const zoneName = station?.name ? ` — ${station.name}` : "";
        const radiusM =
            $radius * ($radiusUnits === "miles" ? 1609.34 : 1000);
        const zone = station
            ? {
                  lat: station.lat,
                  lng: station.lng,
                  radiusMeters: radiusM,
                  name: station.name ?? "",
              }
            : null;
        const GPS_MARGIN_M = 100;
        if ($gps && station) {
            const distM = haversineMeters(
                $gps.lat,
                $gps.lng,
                station.lat,
                station.lng,
            );
            if (distM > radiusM + GPS_MARGIN_M) {
                const overshoot = Math.round(distM - radiusM);
                const ok = await appConfirm({
                    title: "You don't seem to be in this zone",
                    description: `Your GPS puts you about ${overshoot} m outside${zoneName}'s zone. The endgame only begins once you've actually reached the hider's zone and are off transit. Declare it anyway?`,
                    confirmLabel: "Declare anyway",
                    destructive: true,
                });
                if (!ok) return;
                seekerStartEndgame(zone);
                close();
                return;
            }
        }
        // v959: new-rules copy — the SERVER checks your GPS against the hider's
        // secret zone. There's no manual hider confirm/refute anymore: get it
        // right and the endgame locks in (the map cuts to the final zone); get
        // it wrong and you're told to keep searching, nothing else happens.
        const ok = await appConfirm({
            title: "Declare the endgame here?",
            description: `We'll check your location against the hider's zone${zoneName}. If you've truly reached it, the endgame begins — the hider must lock to a final spot and your map zeroes in on this zone. If not, you'll be told to keep searching. Only declare it once you're actually inside the hider's zone and off transit.`,
            confirmLabel: "Declare endgame",
        });
        if (!ok) return;
        seekerStartEndgame(zone);
        close();
    };

    if (station === null) return null;
    const StationIcon = modeIconFor(station.modes);

    return (
        // v835: a FLOATING map-overlay card (not a full-bleed drawer) —
        // centred, fully rounded + shadowed, matching the other on-map
        // overlay cards (PendingAnswerOverlay etc.). It's a plain positioned
        // div (NOT a vaul drawer), so there's zero body-pointer-events
        // manipulation and the map + app header stay fully interactive:
        // pan / zoom / tap another zone to switch. v844: anchored to the TOP
        // of the map (below the app header), like the pending-answer overlay;
        // the top offset clears the top bar's safe-area + content height.
        // Dismiss with the top-right X (or an upward swipe on touch).
        <div
            ref={contentRef}
            role="dialog"
            aria-label={station.name ?? "Selected station"}
            onTouchStart={onCardTouchStart}
            onTouchEnd={onCardTouchEnd}
            className="fixed top-[calc(env(safe-area-inset-top,0px)+4.25rem)] left-1/2 z-[1045] flex max-h-[70vh] w-[min(94vw,460px)] -translate-x-1/2 flex-col overflow-hidden rounded-2xl border border-border bg-background text-foreground shadow-2xl animate-in fade-in slide-in-from-top-4 duration-200"
        >
            <div className="overflow-y-auto px-5 pt-4 pb-5">
                        <div className="flex items-start gap-2.5">
                            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/15">
                                <StationIcon className="h-4.5 w-4.5 text-primary" />
                            </span>
                            <div className="min-w-0 flex-1">
                                <h2 className="font-inter-tight text-lg font-bold leading-tight">
                                    {station.name ?? "Selected station"}
                                </h2>
                            </div>
                            <button
                                type="button"
                                onClick={close}
                                aria-label="Close"
                                title="Close"
                                className="-mr-1 -mt-1 shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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

                        {canCommitZone && (
                            <div className="mt-3 space-y-1.5">
                                <button
                                    type="button"
                                    onClick={handleCommitZone}
                                    className={cn(
                                        "flex w-full items-center justify-center gap-2 rounded-md px-3 py-3",
                                        "border-2 border-primary/60 bg-primary/15",
                                        "text-primary",
                                        "hover:bg-primary/25 active:bg-primary/30 transition-colors",
                                        "text-sm font-poppins font-bold uppercase tracking-wider",
                                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                    )}
                                >
                                    <Tent className="h-4 w-4" strokeWidth={2.5} />
                                    Hide here
                                </button>
                                <p className="text-xs leading-snug text-muted-foreground text-center px-1">
                                    Lock in this station as your hiding zone for
                                    the round.
                                </p>
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
                                    Declare you&apos;ve reached this zone.
                                    We&apos;ll check your location against the
                                    hider&apos;s — if it&apos;s right, the endgame
                                    begins and the hider locks to a final spot.
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
        </div>
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
