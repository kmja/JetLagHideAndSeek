import { useStore } from "@nanostores/react";
import {
    AlertTriangle,
    Ban,
    Crosshair,
    Flag,
    Lock,
    LockOpen,
    MapPin,
    Sparkles,
    Timer,
    Trophy,
} from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "react-toastify";

import { Button } from "@/components/ui/button";
import { useVisibleInterval } from "@/hooks/useVisibleInterval";
import { appConfirm } from "@/lib/confirm";
import { confirmAndCommitZone } from "@/lib/hiderZoneCommit";
import {
    allowedTransit,
    effectiveHiddenDebitMs,
    endgameConfirmedAt,
    endgameStartedAt,
    formatTimeRemaining,
    gamePausedForLocationAt,
    gameSize,
    hiddenCreditMs,
    hiddenDebitMs,
    hidingPeriodEndsAt,
    pendingHidingDurationMin,
    setupCompleted,
} from "@/lib/gameSetup";
import { tallyTimeBonusMinutes } from "@/lib/hiderDeck";
import {
    hiderForfeited,
    hiderHand,
    hiderInbox,
    hidingSpot,
    hidingZone,
    radiusForGameSize,
    resetHiderRoundState,
    roundFoundAt,
    ZONE_GRACE_MS,
} from "@/lib/hiderRole";
import { lastKnownPosition } from "@/lib/context";
import { fetchAreaStations } from "@/lib/journey/stations";
import {
    endHidingPeriodEarly,
    startNewGame,
    startNewRound,
} from "@/lib/roundActions";
import { encodeQuestionForHider } from "@/lib/shareLinks";
import { cn } from "@/lib/utils";
import type { Question } from "@/maps/schema";

/**
 * sessionStorage key for a question the hider just explicitly bailed
 * out of from the answer view. The auto-redirect below treats this as
 * "stay on home for this one" so we don't trap the hider in a back-
 * button loop. Cleared automatically when the tab closes.
 *
 * Exported so HiderView can write to the same flag when its
 * "Hider home" back-link is pressed.
 */
export const ANSWER_VIEW_DISMISSED_KEY = "jlhs:hiderAnswerDismissedKey";

import {
    currentGameCode,
    multiplayerEnabled,
    participants,
} from "@/lib/multiplayer/session";
import {
    hiderCancelEndgame,
    hiderConfirmEndgame,
    seekerMarkFound,
    seekerRotateHider,
} from "@/lib/multiplayer/store";

import { HiderHandPanel } from "./HiderHandPanel";
import { HiderQuestionLog } from "./HiderQuestionLog";
import { HiderTripPlanCard } from "./HiderTripPlanCard";
import { SectionPill, SizeBadge } from "./JetLagLogo";
import { RotateHiderDialog } from "./multiplayer/RotateHiderDialog";
import {
    type FoundStation,
    NearbyStationsPicker,
} from "./NearbyStationsPicker";
import { HiderActiveCurses } from "./HiderActiveCurses";
import { ScoutedSpotsPanel } from "./ScoutedSpotsPanel";
import { SeekerETACard } from "./SeekerETACard";

// Lazy-load the inline picker — leaflet must stay out of the SSR graph.
const InlineLocationPicker = lazy(() => import("./InlineLocationPicker"));
const ZonePreviewMap = lazy(() => import("./ZonePreviewMap"));

/**
 * Persistent hider home. Visible at `/h` when no `?q=` query param is
 * present (HiderView handles the URL-parse path for incoming
 * question links).
 *
 * Renders a **phase-aware** stack:
 *
 *   • `hiding`  — Countdown is dominant, with explainer copy and a
 *                 hiding-zone picker (GPS-based station suggest or
 *                 inline map). The hider sets their 500 m / 1 km
 *                 zone here before the timer runs out.
 *
 *   • `seeking` — Hiding zone is locked; the hider sees the question
 *                 log (rendered with the seeker's own card
 *                 components), the deck hand, and a dice roller for
 *                 curse cards that need it. A "Lock down spot" CTA
 *                 transitions to the endgame phase.
 *
 *   • `endgame` — Hiding spot is locked. Tight focus on the spot
 *                 ("stay here") with a placeholder for the seeker's
 *                 live position once we have multiplayer plumbing
 *                 for it. Question log and hand stay visible but
 *                 de-emphasised.
 *
 *   • `over`    — `roundFoundAt` is set. Final score banner on top;
 *                 everything else collapsed.
 */
type HiderPhase =
    | "hiding"
    | "grace"
    | "forfeit"
    | "seeking"
    | "endgame"
    | "over"
    | "pre-game";

/**
 * The phase-aware action body — exported as the content the
 * HiderShell mounts inside the Settings sheet of HiderBottomNav.
 * The legacy `HiderHome` export below is a thin wrapper that
 * re-adds the standalone-page chrome (max-width, padding, hand-fan
 * spacer) so any non-shell caller still works.
 */
export function HiderHomeContent() {
    const navigate = useNavigate();
    const $hidingZone = useStore(hidingZone);
    const $hidingSpot = useStore(hidingSpot);
    const $hidingEndsAt = useStore(hidingPeriodEndsAt);
    const $gameSize = useStore(gameSize);
    const $inbox = useStore(hiderInbox);
    const $hand = useStore(hiderHand);
    const $foundAt = useStore(roundFoundAt);
    const $endgameStartedAt = useStore(endgameStartedAt);
    const $endgameConfirmedAt = useStore(endgameConfirmedAt);
    const $forfeited = useStore(hiderForfeited);

    // 1-Hz tick — drives the countdown / elapsed timers.
    // Visibility-aware so the locked-phone case doesn't keep
    // waking the CPU once per second.
    const [now, setNow] = useState(() => Date.now());
    useVisibleInterval(() => setNow(Date.now()), 1000, $hidingEndsAt !== null);

    const inHidingPeriod = $hidingEndsAt !== null && now < $hidingEndsAt;
    const elapsedAnchor = $foundAt ?? now;
    const hiddenElapsedMs = $hidingEndsAt
        ? Math.max(0, elapsedAnchor - $hidingEndsAt)
        : 0;
    const roundOver = $foundAt !== null;
    const timeBonusMinutes = useMemo(
        () => tallyTimeBonusMinutes($hand, $gameSize),
        [$hand, $gameSize],
    );

    // Zone-grace window: if the hiding period has ended and the hider
    // never committed a zone, they get a short ZONE_GRACE_MS window to
    // pick one manually. v670 (rulebook p341): when the window closes
    // with still no zone, we AUTO-COMMIT the hider's nearest transit
    // station as their zone ("if the hiding period ends and you're
    // somewhere else, that's where your hiding zone is") — NOT forfeit.
    // Forfeit remains only the technical fallback when we can't resolve
    // any station at all (no GPS fix / no stations in range).
    const graceEndsAt = $hidingEndsAt ? $hidingEndsAt + ZONE_GRACE_MS : null;
    const inGraceWindow =
        $hidingEndsAt !== null &&
        !inHidingPeriod &&
        $hidingZone === null &&
        graceEndsAt !== null &&
        now < graceEndsAt;
    const graceRemainingMs = graceEndsAt ? Math.max(0, graceEndsAt - now) : 0;
    // The auto-commit fires once the grace window closes with still no
    // zone (and the round isn't already over / forfeited).
    const shouldAutoCommit =
        $hidingEndsAt !== null &&
        !inHidingPeriod &&
        $hidingZone === null &&
        graceEndsAt !== null &&
        now >= graceEndsAt &&
        !roundOver &&
        !$forfeited;
    const autoCommitFiredRef = useRef(false);
    // Re-arm per round/period (a fresh hidingPeriodEndsAt = new round or a
    // Move re-anchor), so the next grace window can auto-commit again.
    useEffect(() => {
        autoCommitFiredRef.current = false;
    }, [$hidingEndsAt]);
    useEffect(() => {
        if (!shouldAutoCommit || autoCommitFiredRef.current) return;
        autoCommitFiredRef.current = true;
        const deadline = graceEndsAt ?? Date.now();
        const forfeit = () => {
            // Couldn't resolve a station (no GPS / empty area) — fall back
            // to the loss-by-no-zone terminal state.
            hiderForfeited.set(true);
            if (roundFoundAt.get() === null) {
                roundFoundAt.set(deadline);
                seekerMarkFound(deadline);
            }
        };
        const gps = lastKnownPosition.get();
        if (!gps) {
            forfeit();
            return;
        }
        const radiusMeters = radiusForGameSize(gameSize.get());
        void fetchAreaStations(gps.lat, gps.lng, {
            allowed: allowedTransit.get(),
        })
            .then((stations) => {
                // Guard: the hider may have committed manually in the
                // meantime, or the round may have moved on.
                if (hidingZone.get() !== null || roundFoundAt.get() !== null) {
                    return;
                }
                const nearest = stations[0];
                if (!nearest) {
                    forfeit();
                    return;
                }
                hidingZone.set({
                    stationName: nearest.name || "Hiding zone",
                    stationLat: nearest.lat,
                    stationLng: nearest.lng,
                    radiusMeters,
                    committedAt: Date.now(),
                });
                toast.info(
                    `Hiding period ended — your zone was set to your nearest station: ${nearest.name}.`,
                    { autoClose: 5000 },
                );
            })
            .catch(() => forfeit());
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [shouldAutoCommit, graceEndsAt]);

    const phase: HiderPhase = (() => {
        if (!$hidingEndsAt) return "pre-game";
        if ($forfeited) return "forfeit";
        if (roundOver) return "over";
        if (inHidingPeriod) return "hiding";
        if (inGraceWindow) return "grace";
        if ($hidingSpot) return "endgame";
        return "seeking";
    })();

    // Auto-route to the answer view when a question is waiting. The
    // seeker can only have one open question at a time (game rule
    // enforced on the seeker side), so the inbox has at most one
    // un-replied entry — and if it's there, the hider's job is to
    // answer it. Skipping straight to /h?q=… mirrors what would have
    // happened if they'd tapped the seeker's SMS link directly.
    //
    // Two guards keep this from being annoying:
    //   - Phase must allow questions (seeking/endgame). The hiding
    //     phase is for setting up your zone, not answering anything.
    //   - sessionStorage tracks whether the hider explicitly bailed
    //     out of this exact question (via "Hider home" back link).
    //     Same key → stay on home. New key → redirect.
    useEffect(() => {
        if (phase !== "seeking" && phase !== "endgame") return;
        const waiting = $inbox.filter((e) => !e.repliedAt);
        if (waiting.length !== 1) return;
        const entry = waiting[0];
        try {
            const dismissed = sessionStorage.getItem(ANSWER_VIEW_DISMISSED_KEY);
            if (dismissed === String(entry.key)) return;
        } catch {
            /* sessionStorage may be unavailable (private mode, etc.) —
               proceed with the redirect rather than getting stuck. */
        }
        const question = {
            id: entry.id,
            key: entry.key,
            data: entry.data,
        } as Question;
        try {
            const url = encodeQuestionForHider(question);
            const parsed = new URL(url);
            window.location.assign(
                parsed.pathname + parsed.search + parsed.hash,
            );
        } catch {
            const payload = JSON.stringify(question);
            window.location.assign(`/h?q=${encodeURIComponent(payload)}`);
        }
    }, [$inbox, phase]);

    const startNewGame = async () => {
        const ok = await appConfirm({
            title: "Start a new game?",
            description:
                "Clears your hiding zone, question log, hand, and discard pile on this device.",
            confirmLabel: "New game",
            destructive: true,
        });
        if (!ok) return;
        setupCompleted.set(false);
        hidingPeriodEndsAt.set(null);
        // Clear pending-boundary-load wait too — otherwise
        // GameStartWatcher would replay the previous game's
        // hiding-period kickoff once the new boundary settled.
        pendingHidingDurationMin.set(null);
        roundFoundAt.set(null);
        // Wipes inbox + hand + zone + spot + foundAt. Same helper the
        // seeker side calls.
        resetHiderRoundState();
        navigate("/setup");
    };

    return (
        // Sheet-friendly container: no min-h-screen, no max-width
        // clamp, modest horizontal padding. The Settings sheet of
        // HiderBottomNav provides scroll + header chrome; this
        // panel is just the phase content.
        <div className="flex flex-col px-4 pb-6 text-foreground">
            {/* Final score on top once the round closes */}
            {phase === "over" && $hidingEndsAt && (
                <FinalScoreBanner
                    foundAt={$foundAt!}
                    hidingEndsAt={$hidingEndsAt}
                    timeBonusMinutes={timeBonusMinutes}
                />
            )}

            {/* Endgame banner. Surfaces the moment the seeker flips the
                trigger, regardless of phase. Loud yellow to interrupt
                whatever the hider is doing — rulebook p43 says they
                need to lock to a final stationary spot the instant
                this hits, no negotiation. */}
            {$endgameStartedAt !== null && phase !== "over" && (
                <section
                    className={cn(
                        "rounded-md border-2 border-yellow-500 bg-yellow-500/15",
                        "px-4 py-3 mb-4 flex flex-col gap-3",
                    )}
                >
                    <div
                        className={cn(
                            "flex items-start gap-3",
                            // Stop the urgent pulse once the hider has
                            // resolved the claim by confirming.
                            $endgameConfirmedAt == null && "animate-pulse",
                        )}
                    >
                        <Flag className="w-5 h-5 shrink-0 text-yellow-400 mt-0.5" />
                        <div className="flex-1 space-y-1">
                            <div className="text-[10px] uppercase tracking-[0.18em] font-poppins font-bold text-yellow-400">
                                {$endgameConfirmedAt != null
                                    ? "Endgame — locked down"
                                    : "Endgame — they say they're here"}
                            </div>
                            <p className="text-sm text-foreground leading-snug">
                                {$endgameConfirmedAt != null
                                    ? "You've confirmed the seekers are in your zone. Stay put at your final spot until they find you."
                                    : "The seeker says they've reached your zone. If they're right, confirm and lock to a single spot — once you do, you can't move until the round ends. If they're at the wrong place, refute it and keep moving."}
                            </p>
                        </div>
                    </div>
                    {/* Before the hider resolves the claim: confirm (the
                        seekers really are here — the positive signal the
                        tabletop rules leave implicit) or refute (wrong
                        zone; rulebook p43 — the hider is the authority on
                        their own zone, so a wrong claim doesn't bind
                        them). Once confirmed, the choice is spent. */}
                    {$endgameConfirmedAt == null && (
                        <div className="flex flex-col sm:flex-row flex-wrap gap-2">
                            <Button
                                className="flex-1 bg-yellow-500 text-black hover:bg-yellow-400"
                                onClick={async () => {
                                    const ok = await appConfirm({
                                        title: "They're in your zone?",
                                        description:
                                            "Confirms to the seekers that they've reached your zone, so they switch to hunting your final spot. Commit to a single hiding spot below — once the endgame is confirmed you can't move until the round ends.",
                                        confirmLabel: "Confirm — lock down",
                                    });
                                    if (!ok) return;
                                    hiderConfirmEndgame();
                                    toast.success(
                                        "Endgame confirmed — seekers notified.",
                                        { autoClose: 2500 },
                                    );
                                }}
                            >
                                <Lock className="w-4 h-4 mr-1.5" />
                                They&apos;re here — lock down
                            </Button>
                            <Button
                                variant="outline"
                                className="flex-1 border-yellow-500/60 text-yellow-700 dark:text-yellow-300 hover:bg-yellow-500/15"
                                onClick={async () => {
                                    const ok = await appConfirm({
                                        title: "They're not in your zone?",
                                        description:
                                            "Tells the seekers they haven't reached your zone yet, so they keep searching — and you keep your freedom to move. Only do this if they're genuinely at the wrong place.",
                                        confirmLabel: "Refute endgame",
                                    });
                                    if (!ok) return;
                                    hiderCancelEndgame();
                                    toast.info(
                                        "Endgame refuted — seekers notified.",
                                        { autoClose: 2500 },
                                    );
                                }}
                            >
                                <LockOpen className="w-4 h-4 mr-1.5" />
                                They&apos;re not in my zone
                            </Button>
                        </div>
                    )}
                </section>
            )}

            {phase === "pre-game" && (
                <section
                    className={cn(
                        "rounded-md border-2 border-dashed border-border",
                        "px-4 py-5 mb-4 space-y-3",
                    )}
                >
                    <div className="flex items-start gap-3">
                        <AlertTriangle className="w-5 h-5 shrink-0 text-yellow-500 mt-0.5" />
                        <div className="flex-1 space-y-1">
                            <div className="text-[10px] uppercase tracking-[0.16em] font-poppins font-bold text-yellow-500">
                                Waiting on the seeker
                            </div>
                            <p className="text-sm text-foreground leading-snug">
                                The hiding period hasn&apos;t started on this
                                device yet. Once the seeker finishes game setup,
                                your timer will appear here.
                            </p>
                        </div>
                    </div>
                    <div className="rounded-sm bg-secondary/30 px-3 py-2.5 text-xs text-muted-foreground leading-snug space-y-1.5">
                        <div className="text-[10px] uppercase tracking-[0.16em] font-poppins font-bold text-muted-foreground">
                            What happens next
                        </div>
                        <ol className="list-decimal pl-4 space-y-0.5">
                            <li>
                                Seeker picks the play area, transit modes, and
                                game size in their wizard.
                            </li>
                            <li>
                                Tapping <em>Start</em> on their device begins
                                the hiding period. You&apos;ll see a countdown
                                here.
                            </li>
                            <li>
                                Pick a hiding zone before the timer ends —
                                that&apos;s the area inside which you must stay.
                            </li>
                        </ol>
                    </div>
                </section>
            )}

            {phase === "hiding" && (
                <HidingPhaseView
                    zone={$hidingZone}
                    radiusMeters={radiusForGameSize($gameSize)}
                />
            )}

            {phase === "grace" && (
                <GracePhaseView
                    graceRemainingMs={graceRemainingMs}
                    radiusMeters={radiusForGameSize($gameSize)}
                />
            )}

            {phase === "forfeit" && <ForfeitView onNewGame={startNewGame} />}

            {phase === "seeking" && (
                <SeekingPhaseView
                    zone={$hidingZone}
                    radiusMeters={radiusForGameSize($gameSize)}
                    spot={$hidingSpot}
                />
            )}

            {phase === "endgame" && (
                <EndgamePhaseView spot={$hidingSpot!} />
            )}

            {phase === "over" && (
                <PostRoundView
                    hiddenElapsedMs={hiddenElapsedMs}
                    size={$gameSize}
                    zone={$hidingZone}
                    spot={$hidingSpot}
                />
            )}

            {/* The "Draw N keep K" modal lives at the HiderView level
                so it also fires after sharing an answer from `/h?q=…`
                (not just from `/h`). It self-suppresses when
                `pendingDraw` is null. */}
        </div>
    );
}

/**
 * Standalone hider-home page — legacy entry point. The new shell
 * (HiderShell) wraps the same body but draws its own header / nav
 * around it. This wrapper exists so a non-shell render (e.g. a
 * future debug surface or a print view) still works.
 */
export function HiderHome() {
    return (
        <div className="min-h-screen pb-[160px] bg-background">
            <HiderHomeContent />
        </div>
    );
}

/* ────────────────── Phase 1: HIDING ────────────────── */

function HidingPhaseView({
    zone,
    radiusMeters,
}: {
    zone: ReturnType<typeof hidingZone.get>;
    radiusMeters: number;
}) {
    return (
        <>
            {/* v786: the big in-drawer countdown block was replaced by the
                compact golden badge in the drawer header (HidingCountdownBadge).
                Only the End-hiding shortcut stays here, and only once a zone is
                committed — before that there's nowhere to hide, so ending would
                strand the hider (same gate as the on-map timer button). */}
            {zone !== null && (
                <div className="mb-4 flex justify-center">
                    <Button
                        onClick={endHidingPeriodEarly}
                        variant="outline"
                        size="sm"
                        className="gap-1.5"
                    >
                        <Flag className="w-3.5 h-3.5" strokeWidth={2.5} />
                        End timer
                    </Button>
                </div>
            )}

            {/* Zone picker — GPS-based station suggest + inline map */}
            <HidingZoneSection
                zone={zone}
                radiusMeters={radiusMeters}
                showStationSuggest
            />
        </>
    );
}

/* ────────────────── Phase 1b: GRACE (no zone at deadline) ────────────────── */

/**
 * Shown when the hiding clock ran out and the hider never committed a
 * zone. The game is locked for ZONE_GRACE_MS; the hider should pick a
 * station now. If the countdown hits zero with still no zone, the parent
 * AUTO-COMMITS the hider's nearest transit station (rulebook p341) — so
 * this is a "pick, or we pick your nearest for you" window, not a
 * forfeit clock.
 */
function GracePhaseView({
    graceRemainingMs,
    radiusMeters,
}: {
    graceRemainingMs: number;
    radiusMeters: number;
}) {
    return (
        <>
            <section className="rounded-md border-2 border-warning bg-warning/10 px-4 py-5 mb-4 text-center">
                <div className="flex items-center justify-center gap-2 mb-1.5">
                    <Lock className="w-4 h-4 text-warning" />
                    <div className="text-[10px] uppercase tracking-[0.2em] font-poppins font-bold text-warning">
                        Pick your zone now
                    </div>
                </div>
                <div className="font-inter-tight italic font-black tabular-nums text-5xl text-warning leading-none">
                    {formatTimeRemaining(graceRemainingMs)}
                </div>
                <p className="text-xs text-muted-foreground mt-2 leading-snug">
                    The hiding period ended before you locked in a zone. Pick a
                    transit station from your current location — if this timer
                    runs out first, your nearest station becomes your zone
                    automatically.
                </p>
            </section>

            <HidingZoneSection
                zone={null}
                radiusMeters={radiusMeters}
                showStationSuggest
                lockToStations
            />
            {/* Trip-plan card — once the hider picks a zone in the
                grace window, surface the live journey to it the same
                way the hiding phase does. Mostly a no-op since they
                probably won't move much before committing, but it
                keeps the UX consistent across phases. */}
            <div className="mt-3">
                <HiderTripPlanCard />
            </div>
        </>
    );
}

/* ────────────────── Phase 1c: FORFEIT ────────────────── */

function ForfeitView({ onNewGame }: { onNewGame: () => void }) {
    return (
        <section className="rounded-md border-2 border-destructive bg-destructive/10 px-4 py-5 mb-4">
            <div className="flex items-start gap-3">
                <Ban className="w-6 h-6 shrink-0 text-destructive mt-0.5" />
                <div className="flex-1 space-y-1.5">
                    <div className="text-sm uppercase tracking-[0.16em] font-poppins font-black text-destructive">
                        Round forfeited
                    </div>
                    <p className="text-sm text-foreground leading-snug">
                        You didn&apos;t lock in a hiding zone before the grace
                        period ran out, so this round is lost. The zone has to
                        be centered on a transit station and chosen before time
                        expires.
                    </p>
                </div>
            </div>
            <div className="mt-4 grid grid-cols-1 gap-2">
                <Button
                    onClick={onNewGame}
                    variant="outline"
                    className="gap-1.5"
                >
                    <Sparkles className="w-4 h-4" />
                    New game
                </Button>
            </div>
        </section>
    );
}

/* ────────────────── Phase 2: SEEKING ────────────────── */

function SeekingPhaseView({
    zone,
    radiusMeters,
    spot,
}: {
    zone: ReturnType<typeof hidingZone.get>;
    radiusMeters: number;
    spot: ReturnType<typeof hidingSpot.get>;
}) {
    // v633: once the hider is in their zone and the seekers are hunting,
    // the drawer is trimmed to just the zone info + scouted spots. The
    // live elapsed timer lives on the map (HiderMapTimer), seeker pins are
    // on the map, the question log has its own nav "Questions" drawer, and
    // the hand is on the fan — so none of those are duplicated here.
    const $endgameStartedAt = useStore(endgameStartedAt);
    return (
        <>
            {/* Zone general info — the committed zone card + read-only map. */}
            <HidingZoneSection zone={zone} radiusMeters={radiusMeters} />

            {/* Earliest possible seeker arrival at the hider's station,
                computed from gameStartPosition + the whistle. Self-renders
                null if there's no zone / no game-start anchor / no transit
                provider — the "how long until they could reach me" read. */}
            <SeekerETACard />

            {/* Active curses the hider has cast on the seekers (v906) — a
                mirror of the seeker's curse inbox so the hider can track
                what's slowing the seekers down. Self-hides when none. */}
            <HiderActiveCurses />

            {/* Lock-down affordance surfaces ONLY once the seekers have
                claimed the endgame ("we're in your zone"). That's the one
                moment the hider commits a final spot; hidden during normal
                seeking to keep this stage focused. */}
            {$endgameStartedAt !== null && (
                <HidingSpotSection spot={spot} roundOver={false} />
            )}

            {/* Scouted spots — the walk-around notebook, handy for pivoting
                to a backup spot if the original gets compromised. */}
            <ScoutedSpotsPanel />
        </>
    );
}

/* ────────────────── Phase 3: ENDGAME ────────────────── */

function EndgamePhaseView({
    spot,
}: {
    spot: NonNullable<ReturnType<typeof hidingSpot.get>>;
}) {
    // v633: trimmed to the essentials for "locked in your zone, seekers
    // hunting" — the locked spot (the refined zone) + scouted spots. The
    // live elapsed timer + seeker pins are on the map; the question log +
    // hand have their own surfaces.
    return (
        <>
            {/* Spot map — zoomed in tight on the locked spot. The
                InlineLocationPicker handles its own lazy leaflet load. */}
            <section className="mt-1">
                <div className="flex items-center gap-2 mb-2">
                    <Crosshair className="w-4 h-4 text-primary" />
                    <SectionPill>Locked-in spot</SectionPill>
                </div>
                <Suspense
                    fallback={
                        <div className="w-full h-[40vh] rounded-md border border-dashed border-border flex items-center justify-center text-xs text-muted-foreground">
                            Loading map…
                        </div>
                    }
                >
                    <InlineLocationPicker
                        latitude={spot.lat}
                        longitude={spot.lng}
                        onChange={() => {
                            /* read-only during endgame */
                        }}
                        height="h-[45vh]"
                    />
                </Suspense>
                <div className="mt-2 text-xs text-muted-foreground leading-snug px-1">
                    {spot.description && (
                        <span className="font-medium text-foreground">
                            {spot.description}.{" "}
                        </span>
                    )}
                    Locked at {new Date(spot.lockedAt).toLocaleTimeString()}.
                    You can&apos;t move from here until the seeker finds you or
                    the round ends.
                </div>
            </section>

            {/* Scouted spots stay handy for reference. */}
            <ScoutedSpotsPanel />
        </>
    );
}

/* ────────────────── Phase: POST-ROUND (after found) ────────────────── */

function PostRoundView({
    hiddenElapsedMs,
    size,
    zone,
    spot,
}: {
    hiddenElapsedMs: number;
    size: ReturnType<typeof gameSize.get>;
    zone: ReturnType<typeof hidingZone.get>;
    spot: ReturnType<typeof hidingSpot.get>;
}) {
    void zone;
    return (
        <>
            <section className="rounded-md border-2 border-muted/40 bg-secondary/30 px-4 py-3 mb-4 flex items-center gap-3 opacity-80">
                <Timer className="w-5 h-5 shrink-0 text-muted-foreground" />
                <div className="flex flex-col leading-none gap-1">
                    <span className="text-[9px] font-inter-tight font-bold uppercase tracking-[0.18em] text-muted-foreground">
                        Hidden for (final)
                    </span>
                    <span className="font-inter-tight italic font-black tabular-nums text-2xl text-primary leading-none">
                        {formatElapsed(hiddenElapsedMs)}
                    </span>
                </div>
                <SizeBadge size={size} className="ml-auto" />
            </section>
            {spot && <HidingSpotSection spot={spot} roundOver />}
            <HiderQuestionLog />
            <HiderHandPanel />
        </>
    );
}

/* ────────────────── Shared sub-sections ────────────────── */

/* ────────────────── Final score banner ────────────────── */

function FinalScoreBanner({
    foundAt,
    hidingEndsAt,
    timeBonusMinutes,
}: {
    foundAt: number;
    hidingEndsAt: number;
    timeBonusMinutes: number;
}) {
    const $credit = useStore(hiddenCreditMs);
    // Subscribe so the figure settles if a location pause is resolved.
    useStore(hiddenDebitMs);
    useStore(gamePausedForLocationAt);
    const seekMs = Math.max(
        0,
        Math.max(0, foundAt - hidingEndsAt) +
            $credit -
            effectiveHiddenDebitMs(foundAt),
    );
    // v670: time-bonus cards ADD to the hider's time (rulebook p79 —
    // longest hide wins), so the final score is seek time PLUS bonuses.
    // (This was inverted — subtracting them — which both contradicted the
    // rulebook and made holding bonuses hurt the hider.)
    const finalMs = seekMs + timeBonusMinutes * 60_000;

    // Multiplayer-aware new-round flow. In an online room with 2+
    // participants we open the hider-rotation picker so the table
    // can hand off the role; otherwise we fall back to the simple
    // app-styled confirm prompt (offline / solo case).
    const $multiplayerEnabled = useStore(multiplayerEnabled);
    const $code = useStore(currentGameCode);
    const $participants = useStore(participants);
    const [rotateDialogOpen, setRotateDialogOpen] = useState(false);
    const canRotateHider =
        $multiplayerEnabled && $code !== null && $participants.length >= 2;

    const onNewRound = async () => {
        if (canRotateHider) {
            setRotateDialogOpen(true);
            return;
        }
        const ok = await appConfirm({
            title: "Start a new round?",
            description:
                "Hiding zone, hand, discard pile and inbox reset. Play area + transit + size stay the same.",
            confirmLabel: "New round",
        });
        if (!ok) return;
        startNewRound();
    };

    const handleConfirmRotation = (
        primaryHiderId: string,
        coHiderIds: string[],
    ) => {
        seekerRotateHider(primaryHiderId, coHiderIds);
        // Local cleanup runs on this device. The bridge wipes
        // hider-only stores on role transitions (see
        // `reconcileLocalRoleFromPresence`) so the player switching
        // out of the hider seat doesn't carry stale zone/hand data.
        startNewRound();
        setRotateDialogOpen(false);
    };

    const onNewGame = async () => {
        const ok = await appConfirm({
            title: "Start a new game?",
            description:
                "Drops the play area, transit, and size — the setup wizard will re-open.",
            confirmLabel: "New game",
            destructive: true,
        });
        if (!ok) return;
        startNewGame();
    };

    return (
        <section className="rounded-md border-2 border-primary bg-primary/10 px-4 py-4 mb-4">
            <div className="flex items-center gap-2 mb-3">
                <Trophy className="w-5 h-5 text-primary" />
                <span className="font-inter-tight font-black uppercase text-sm tracking-[0.16em] text-primary">
                    Round ended · final score
                </span>
            </div>
            <div className="flex items-center justify-center">
                <div className="text-center">
                    <div className="text-[9px] font-inter-tight font-bold uppercase tracking-[0.18em] text-muted-foreground mb-1">
                        Final
                    </div>
                    <div className="font-inter-tight italic font-black tabular-nums text-4xl text-primary leading-none">
                        {formatElapsed(finalMs)}
                    </div>
                </div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-center text-xs">
                <div className="rounded-sm bg-background/40 border border-border py-2 px-1">
                    <div className="text-[9px] uppercase tracking-[0.16em] text-muted-foreground">
                        Seek time
                    </div>
                    <div className="font-inter-tight font-bold tabular-nums text-base mt-0.5">
                        {formatElapsed(seekMs)}
                    </div>
                </div>
                <div className="rounded-sm bg-background/40 border border-border py-2 px-1">
                    <div className="text-[9px] uppercase tracking-[0.16em] text-muted-foreground">
                        Bonus minutes
                    </div>
                    <div className="font-inter-tight font-bold tabular-nums text-base mt-0.5">
                        +{timeBonusMinutes}m
                    </div>
                </div>
            </div>
            <p className="text-[10px] text-muted-foreground mt-3 text-center leading-snug">
                Time bonus cards in your hand add to your final time. Longest
                single hide wins.
            </p>
            <div className="mt-3 grid grid-cols-2 gap-2">
                <Button onClick={onNewRound} className="gap-1.5">
                    <Sparkles className="w-4 h-4" />
                    New round
                </Button>
                <Button variant="outline" onClick={onNewGame}>
                    New game
                </Button>
            </div>
            {/* Hider-rotation dialog. Only opens when an online room
                has 2+ participants — see canRotateHider gate above. */}
            <RotateHiderDialog
                open={rotateDialogOpen}
                onOpenChange={setRotateDialogOpen}
                onConfirm={handleConfirmRotation}
            />
        </section>
    );
}

/* ────────────────── Hiding zone section ────────────────── */

function HidingZoneSection({
    zone,
    radiusMeters,
    disabled,
    showStationSuggest,
    lockToStations,
}: {
    zone: ReturnType<typeof hidingZone.get>;
    radiusMeters: number;
    disabled?: boolean;
    /** When true (phase 1), surface the GPS-based station-suggest list
     *  as the primary path. Otherwise just the inline map. */
    showStationSuggest?: boolean;
    /** When true (grace window), force the nearby-stations picker and
     *  hide the "Pick on map" toggle — the house rule requires the
     *  hider choose a station from their *current* GPS location. */
    lockToStations?: boolean;
}) {
    const [editing, setEditing] = useState(zone === null);
    const [mode] = useState<"stations" | "map">(
        showStationSuggest || lockToStations ? "stations" : "map",
    );
    const [draftLat, setDraftLat] = useState<number>(zone?.stationLat ?? 0);
    const [draftLng, setDraftLng] = useState<number>(zone?.stationLng ?? 0);
    const [draftName, setDraftName] = useState<string>(zone?.stationName ?? "");

    useEffect(() => {
        if (zone) {
            setDraftLat(zone.stationLat);
            setDraftLng(zone.stationLng);
            setDraftName(zone.stationName);
        }
    }, [zone]);

    const commitZone = (override?: {
        lat: number;
        lng: number;
        name: string;
    }) => {
        const lat = override?.lat ?? draftLat;
        const lng = override?.lng ?? draftLng;
        const name = override?.name ?? draftName;
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            toast.error("Pin a location for your station first.");
            return;
        }
        hidingZone.set({
            stationName: name || "Hiding zone",
            stationLat: lat,
            stationLng: lng,
            radiusMeters,
            committedAt: Date.now(),
        });
        setEditing(false);
        toast.success("Hiding zone committed.", { autoClose: 2000 });

        // If the hiding period is still running, offer the hider
        // the rulebook shortcut: they've reached their spot, do they
        // want to end the hiding period early and let the seekers
        // start looking? The seeker's countdown jumps to zero (mirror
        // over multiplayer to keep everyone in sync). Skipped silently
        // if the hider is past the hiding period anyway.
        if (
            hidingPeriodEndsAt.get() !== null &&
            (hidingPeriodEndsAt.get() ?? 0) > Date.now()
        ) {
            void appConfirm({
                title: "End hiding period now?",
                description:
                    "Zone committed. End the hiding period early and alert the seekers? You can keep the timer running if you want a bit more time in your spot.",
                confirmLabel: "End it now",
                cancelLabel: "Keep timer running",
            }).then((ok) => {
                if (!ok) return;
                endHidingPeriodEarly();
            });
        }
    };

    return (
        <section className="mt-1">
            {/* The "Select hiding zone" heading only makes sense while
                PICKING — once a zone is committed (read-only view) it reads
                wrong (you've already selected), so it's hidden then (v799). */}
            {!(zone && !editing) && (
                <div className="flex items-center gap-2 mb-3">
                    <h2 className="text-sm font-semibold tracking-tight">
                        Select hiding zone
                    </h2>
                </div>
            )}
            {zone && !editing ? (
                // v879: compact committed-zone card — a small SQUARE map
                // preview on the left (radius circle framed tight) + the zone
                // name beside it. The lock-icon block + the large read-only map
                // below were removed; the small preview conveys the zone at a
                // glance without the vertical bulk.
                <div className="rounded-md border border-border bg-secondary/40 p-3 flex items-center gap-3">
                    <Suspense
                        fallback={
                            <div className="w-20 h-20 rounded-lg border border-dashed border-border shrink-0" />
                        }
                    >
                        <ZonePreviewMap
                            lat={zone.stationLat}
                            lng={zone.stationLng}
                            radiusMeters={radiusMeters}
                            padding={6}
                            className="w-20 h-20 shrink-0"
                        />
                    </Suspense>
                    <div className="min-w-0 flex-1">
                        <div className="text-base font-inter-tight font-bold leading-tight truncate">
                            {zone.stationName}
                        </div>
                        <div className="text-xs text-muted-foreground tabular-nums mt-0.5">
                            {zone.stationLat.toFixed(5)},{" "}
                            {zone.stationLng.toFixed(5)}
                        </div>
                    </div>
                    {/* v803: no "Change" — locking a zone can't be undone. */}
                </div>
            ) : (
                <div className="space-y-3">
                    {/* v781: the "Nearby stations / Pick on map" toggle was
                        removed to declutter the drawer. The station list is
                        the in-drawer picker; map-picking is still available by
                        tapping the map behind the drawer. `mode` stays at its
                        initial value (stations when suggested/locked). */}
                    {mode === "stations" ? (
                        <NearbyStationsPicker
                            onPick={(s: FoundStation) => {
                                // Shared confirm-and-commit flow (also used by
                                // the on-map HiderZoneHint, v787) — asks "Lock
                                // in?" before committing this round-defining
                                // choice, then offers to end hiding early.
                                void confirmAndCommitZone(s, radiusMeters).then(
                                    (committed) => {
                                        if (committed) setEditing(false);
                                    },
                                );
                            }}
                        />
                    ) : (
                        <>
                            <Suspense
                                fallback={
                                    <div className="w-full h-[40vh] rounded-md border border-dashed border-border flex items-center justify-center text-xs text-muted-foreground">
                                        Loading map…
                                    </div>
                                }
                            >
                                <InlineLocationPicker
                                    latitude={draftLat}
                                    longitude={draftLng}
                                    onChange={(la, ln) => {
                                        if (la !== null) setDraftLat(la);
                                        if (ln !== null) setDraftLng(ln);
                                    }}
                                    radiusMeters={radiusMeters}
                                />
                            </Suspense>
                            <input
                                type="text"
                                value={draftName}
                                onChange={(e) => setDraftName(e.target.value)}
                                placeholder="Station name (e.g. Mariatorget)"
                                className={cn(
                                    "w-full px-3 py-2 rounded-md border border-border",
                                    "bg-secondary/40 text-sm",
                                    "focus:outline-none focus:ring-2 focus:ring-ring",
                                )}
                            />
                            <div className="flex justify-end gap-2">
                                {zone && (
                                    <Button
                                        variant="outline"
                                        onClick={() => setEditing(false)}
                                    >
                                        Cancel
                                    </Button>
                                )}
                                <Button
                                    onClick={() => commitZone()}
                                    disabled={disabled}
                                >
                                    <Lock className="w-3.5 h-3.5 mr-1" />
                                    Commit zone
                                </Button>
                            </div>
                        </>
                    )}
                </div>
            )}
        </section>
    );
}

/* ────────────────── Hiding spot lockdown section ────────────────── */

function HidingSpotSection({
    spot,
    roundOver,
}: {
    spot: ReturnType<typeof hidingSpot.get>;
    roundOver: boolean;
}) {
    const [editing, setEditing] = useState(spot === null);
    const [draftDesc, setDraftDesc] = useState(spot?.description ?? "");
    const [draftLat, setDraftLat] = useState<number>(spot?.lat ?? 0);
    const [draftLng, setDraftLng] = useState<number>(spot?.lng ?? 0);
    const [locating, setLocating] = useState(false);

    useEffect(() => {
        if (spot) {
            setDraftDesc(spot.description ?? "");
            setDraftLat(spot.lat);
            setDraftLng(spot.lng);
        }
    }, [spot]);

    const useMyGps = () => {
        if (typeof navigator === "undefined" || !navigator.geolocation) {
            toast.error("Location access isn't available on this device.");
            return;
        }
        setLocating(true);
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                setDraftLat(pos.coords.latitude);
                setDraftLng(pos.coords.longitude);
                setLocating(false);
                toast.success("Pinned to your current GPS.", {
                    autoClose: 1500,
                });
            },
            (err) => {
                setLocating(false);
                toast.error(
                    err.code === err.PERMISSION_DENIED
                        ? "Location permission denied."
                        : "Couldn't get your GPS location.",
                );
            },
            { enableHighAccuracy: true, timeout: 8000 },
        );
    };

    const commitSpot = () => {
        if (!Number.isFinite(draftLat) || !Number.isFinite(draftLng)) {
            toast.error("Set your spot's GPS first.");
            return;
        }
        hidingSpot.set({
            lat: draftLat,
            lng: draftLng,
            description: draftDesc.trim() || undefined,
            lockedAt: Date.now(),
        });
        setEditing(false);
        toast.success("Hiding spot locked.", { autoClose: 2000 });
    };

    return (
        <section className="mt-5">
            <div className="flex items-center gap-2 mb-2">
                <Crosshair className="w-4 h-4 text-muted-foreground" />
                <SectionPill>Hiding spot</SectionPill>
                {spot && !editing && (
                    <span className="text-[10px] text-muted-foreground tabular-nums ml-1">
                        locked
                    </span>
                )}
            </div>
            {spot && !editing ? (
                <div className="rounded-sm border border-border bg-secondary/40 p-3 flex items-start gap-3">
                    <Lock className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                    <div className="min-w-0 flex-1">
                        {spot.description && (
                            <div className="font-inter-tight font-bold uppercase tracking-wide text-sm leading-tight">
                                {spot.description}
                            </div>
                        )}
                        <div className="text-xs text-muted-foreground tabular-nums">
                            {spot.lat.toFixed(5)}, {spot.lng.toFixed(5)}
                        </div>
                    </div>
                    {!roundOver && (
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setEditing(true)}
                        >
                            <LockOpen className="w-3.5 h-3.5 mr-1" />
                            Move
                        </Button>
                    )}
                </div>
            ) : (
                <div className="space-y-3">
                    <p className="text-xs text-muted-foreground leading-snug px-1">
                        Hiding period is over. Pin your spot and stay there —
                        the seeker can&apos;t ask new questions if you keep
                        moving (rulebook p43).
                    </p>
                    <div className="flex gap-2">
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={useMyGps}
                            disabled={locating}
                            className="gap-1.5"
                        >
                            <MapPin className="w-3.5 h-3.5" />
                            {locating ? "Locating…" : "Use my GPS"}
                        </Button>
                        {Number.isFinite(draftLat) &&
                            Number.isFinite(draftLng) &&
                            (draftLat !== 0 || draftLng !== 0) && (
                                <span className="self-center text-[11px] text-muted-foreground tabular-nums">
                                    {draftLat.toFixed(5)}, {draftLng.toFixed(5)}
                                </span>
                            )}
                    </div>
                    <input
                        type="text"
                        value={draftDesc}
                        onChange={(e) => setDraftDesc(e.target.value)}
                        placeholder="Optional: a short description (bench by the library)"
                        className={cn(
                            "w-full px-3 py-2 rounded-md border border-border",
                            "bg-secondary/40 text-sm",
                            "focus:outline-none focus:ring-2 focus:ring-ring",
                        )}
                    />
                    <div className="flex justify-end gap-2">
                        {spot && (
                            <Button
                                variant="outline"
                                onClick={() => setEditing(false)}
                            >
                                Cancel
                            </Button>
                        )}
                        <Button
                            onClick={commitSpot}
                            disabled={
                                !Number.isFinite(draftLat) ||
                                !Number.isFinite(draftLng) ||
                                (draftLat === 0 && draftLng === 0)
                            }
                        >
                            <Lock className="w-3.5 h-3.5 mr-1" />
                            Lock spot
                        </Button>
                    </div>
                </div>
            )}
        </section>
    );
}

/* ────────────────── tiny formatters ────────────────── */

function formatElapsed(ms: number): string {
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n: number) => String(n).padStart(2, "0");
    if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
    return `${pad(m)}:${pad(s)}`;
}

export default HiderHome;
