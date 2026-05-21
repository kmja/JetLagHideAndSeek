import { useStore } from "@nanostores/react";
import {
    AlertTriangle,
    Bus,
    Crosshair,
    Eye,
    Inbox,
    Lock,
    LockOpen,
    MapPin,
    Ship,
    Sparkles,
    Timer,
    Train,
    TrainTrack,
    TramFront,
    Trophy,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { toast } from "react-toastify";

import { Button } from "@/components/ui/button";
import {
    allowedTransit,
    formatTimeRemaining,
    gameSize,
    hidingPeriodEndsAt,
    HIDING_PERIOD_MINUTES,
    TRANSIT_LABELS,
    type TransitMode,
} from "@/lib/gameSetup";
import { tallyTimeBonusMinutes } from "@/lib/hiderDeck";
import {
    hiderHand,
    hiderInbox,
    hidingSpot,
    hidingZone,
    playerRole,
    radiusForGameSize,
    roundFoundAt,
} from "@/lib/hiderRole";
import { cn } from "@/lib/utils";

import { DiceRoller } from "./DiceRoller";
import { HiderHandPanel } from "./HiderHandPanel";
import { HiderQuestionLog } from "./HiderQuestionLog";
import {
    HideSeekMark,
    HideSeekWordmark,
    SectionPill,
    SizeBadge,
} from "./JetLagLogo";
import {
    NearbyStationsPicker,
    type FoundStation,
} from "./NearbyStationsPicker";

// Lazy-load the inline picker — leaflet must stay out of the SSR graph.
const InlineLocationPicker = lazy(() => import("./InlineLocationPicker"));

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
type HiderPhase = "hiding" | "seeking" | "endgame" | "over" | "pre-game";

export function HiderHome() {
    const $role = useStore(playerRole);
    const $hidingZone = useStore(hidingZone);
    const $hidingSpot = useStore(hidingSpot);
    const $hidingEndsAt = useStore(hidingPeriodEndsAt);
    const $gameSize = useStore(gameSize);
    const $inbox = useStore(hiderInbox);
    const $hand = useStore(hiderHand);
    const $foundAt = useStore(roundFoundAt);

    // 1-Hz tick — drives the countdown / elapsed timers.
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!$hidingEndsAt) return;
        const id = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(id);
    }, [$hidingEndsAt]);

    const inHidingPeriod = $hidingEndsAt !== null && now < $hidingEndsAt;
    const remainingMs = $hidingEndsAt
        ? Math.max(0, $hidingEndsAt - now)
        : 0;
    const elapsedAnchor = $foundAt ?? now;
    const hiddenElapsedMs = $hidingEndsAt
        ? Math.max(0, elapsedAnchor - $hidingEndsAt)
        : 0;
    const roundOver = $foundAt !== null;
    const timeBonusMinutes = useMemo(
        () => tallyTimeBonusMinutes($hand, $gameSize),
        [$hand, $gameSize],
    );

    const phase: HiderPhase = (() => {
        if (!$hidingEndsAt) return "pre-game";
        if (roundOver) return "over";
        if (inHidingPeriod) return "hiding";
        if ($hidingSpot) return "endgame";
        return "seeking";
    })();

    return (
        <div className="min-h-screen flex flex-col p-4 max-w-2xl mx-auto pb-12 bg-background text-foreground">
            {/* Header */}
            <header className="mb-4">
                <div className="flex items-center gap-3">
                    <HideSeekMark size={36} onDark={false} />
                    <HideSeekWordmark />
                    <SectionPill className="ml-auto">Hider</SectionPill>
                </div>
            </header>

            {/* Final score on top once the round closes */}
            {phase === "over" && $hidingEndsAt && (
                <FinalScoreBanner
                    foundAt={$foundAt!}
                    hidingEndsAt={$hidingEndsAt}
                    timeBonusMinutes={timeBonusMinutes}
                />
            )}

            {phase === "pre-game" && (
                <section className="rounded-md border border-dashed border-border px-4 py-3 mb-4 flex items-start gap-3">
                    <AlertTriangle className="w-5 h-5 shrink-0 text-yellow-500" />
                    <p className="text-sm text-muted-foreground leading-snug">
                        No hiding period set yet on this device. Once the
                        seeker starts the game, your timer will appear here.
                    </p>
                </section>
            )}

            {phase === "hiding" && (
                <HidingPhaseView
                    remainingMs={remainingMs}
                    totalMinutes={HIDING_PERIOD_MINUTES[$gameSize]}
                    size={$gameSize}
                    zone={$hidingZone}
                    radiusMeters={radiusForGameSize($gameSize)}
                />
            )}

            {phase === "seeking" && (
                <SeekingPhaseView
                    hiddenElapsedMs={hiddenElapsedMs}
                    size={$gameSize}
                    zone={$hidingZone}
                    radiusMeters={radiusForGameSize($gameSize)}
                    spot={$hidingSpot}
                />
            )}

            {phase === "endgame" && (
                <EndgamePhaseView
                    hiddenElapsedMs={hiddenElapsedMs}
                    size={$gameSize}
                    zone={$hidingZone}
                    radiusMeters={radiusForGameSize($gameSize)}
                    spot={$hidingSpot!}
                />
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

            <footer className="mt-auto pt-6 flex flex-col gap-2 text-center">
                {(() => {
                    const gameStarted = $inbox.length > 0;
                    return (
                        <Button
                            variant="outline"
                            size="sm"
                            disabled={gameStarted}
                            title={
                                gameStarted
                                    ? "Roles lock once you've received your first question. Start a new game to switch."
                                    : "Switch back to the seeker side"
                            }
                            onClick={() => {
                                if (
                                    confirm(
                                        "Switch back to the seeker side? Hider-side state (hiding zone, inbox, hand) stays saved on this device.",
                                    )
                                ) {
                                    playerRole.set("seeker");
                                    window.location.assign("/");
                                }
                            }}
                        >
                            Switch to seeker
                        </Button>
                    );
                })()}
                <p className="text-[10px] text-muted-foreground">
                    Jet Lag Hide and Seek · hider home ·{" "}
                    {$role === "hider" ? "active" : "guest"}
                </p>
            </footer>
        </div>
    );
}

/* ────────────────── Phase 1: HIDING ────────────────── */

const TRANSIT_ICONS: Record<TransitMode, LucideIcon> = {
    bus: Bus,
    tram: TramFront,
    train: Train,
    subway: TrainTrack,
    ferry: Ship,
};

function HidingPhaseView({
    remainingMs,
    totalMinutes,
    size,
    zone,
    radiusMeters,
}: {
    remainingMs: number;
    totalMinutes: number;
    size: ReturnType<typeof gameSize.get>;
    zone: ReturnType<typeof hidingZone.get>;
    radiusMeters: number;
}) {
    const $allowed = useStore(allowedTransit);

    return (
        <>
            {/* Big dominant countdown */}
            <section className="rounded-md border-2 border-primary bg-primary/5 px-4 py-5 mb-4 text-center">
                <div className="text-[10px] uppercase tracking-[0.2em] font-poppins font-bold text-muted-foreground mb-1.5">
                    Hiding period
                </div>
                <div className="font-inter-tight italic font-black tabular-nums text-5xl sm:text-6xl text-primary leading-none">
                    {formatTimeRemaining(remainingMs)}
                </div>
                <div className="text-xs text-muted-foreground mt-2">
                    of {totalMinutes} min · size{" "}
                    <SizeBadge size={size} className="inline-flex" />
                </div>
            </section>

            {/* Explainer */}
            <section className="rounded-md border border-border bg-secondary/30 px-4 py-3 mb-4 space-y-2 text-sm leading-snug">
                <p>
                    Pick a transit station of an allowed mode to hide
                    near. The{" "}
                    <span className="font-bold">
                        {(radiusMeters / 1000).toFixed(
                            radiusMeters >= 1000 ? 1 : 1,
                        )}{" "}
                        km
                    </span>{" "}
                    area around that station is your hiding zone.
                </p>
                <div className="flex flex-wrap items-center gap-1.5 pt-1">
                    <span className="text-[10px] uppercase tracking-[0.16em] font-poppins font-bold text-muted-foreground mr-1">
                        Allowed
                    </span>
                    {$allowed.length === 0 ? (
                        <span className="text-xs italic text-muted-foreground">
                            Walking only — no transit modes enabled
                        </span>
                    ) : (
                        $allowed.map((m) => {
                            const Icon = TRANSIT_ICONS[m];
                            return (
                                <span
                                    key={m}
                                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-secondary border border-border text-[11px]"
                                >
                                    <Icon className="w-3 h-3" />
                                    {TRANSIT_LABELS[m]}
                                </span>
                            );
                        })
                    )}
                </div>
                <p className="text-xs text-muted-foreground">
                    Once you arrive, tell the seekers — or let the
                    countdown run out if you want more strategy time.
                </p>
            </section>

            {/* Zone picker — GPS-based station suggest + inline map */}
            <HidingZoneSection
                zone={zone}
                radiusMeters={radiusMeters}
                showStationSuggest
            />
        </>
    );
}

/* ────────────────── Phase 2: SEEKING ────────────────── */

function SeekingPhaseView({
    hiddenElapsedMs,
    size,
    zone,
    radiusMeters,
    spot,
}: {
    hiddenElapsedMs: number;
    size: ReturnType<typeof gameSize.get>;
    zone: ReturnType<typeof hidingZone.get>;
    radiusMeters: number;
    spot: ReturnType<typeof hidingSpot.get>;
}) {
    return (
        <>
            <ElapsedHiddenBanner
                hiddenElapsedMs={hiddenElapsedMs}
                size={size}
            />

            {/* Hiding zone — locked at this phase; tap "Change" only
                in rule-bending emergencies. */}
            <HidingZoneSection
                zone={zone}
                radiusMeters={radiusMeters}
            />

            {/* Lockdown affordance — when the hider commits to their
                final spot the view transitions to endgame. */}
            <HidingSpotSection spot={spot} roundOver={false} />

            {/* Seeker-style question log replaces the old inbox UI */}
            <HiderQuestionLog />

            {/* Hand panel */}
            <HiderHandPanel />

            {/* Dice for curse cards */}
            <section className="mt-5">
                <div className="flex items-center gap-2 mb-2">
                    <Sparkles className="w-4 h-4 text-muted-foreground" />
                    <SectionPill>Utilities</SectionPill>
                </div>
                <DiceRoller />
            </section>
        </>
    );
}

/* ────────────────── Phase 3: ENDGAME ────────────────── */

function EndgamePhaseView({
    hiddenElapsedMs,
    size,
    zone,
    radiusMeters,
    spot,
}: {
    hiddenElapsedMs: number;
    size: ReturnType<typeof gameSize.get>;
    zone: ReturnType<typeof hidingZone.get>;
    radiusMeters: number;
    spot: NonNullable<ReturnType<typeof hidingSpot.get>>;
}) {
    return (
        <>
            {/* Tense elapsed banner — same numbers, different framing */}
            <section className="rounded-md border-2 border-yellow-500/70 bg-yellow-500/5 px-4 py-3 mb-4 flex items-center gap-3">
                <Eye className="w-5 h-5 shrink-0 text-yellow-500" />
                <div className="flex flex-col leading-none gap-1">
                    <span className="text-[9px] font-inter-tight font-bold uppercase tracking-[0.18em] text-muted-foreground">
                        Endgame · stay still
                    </span>
                    <span className="font-inter-tight italic font-black tabular-nums text-2xl text-yellow-500 leading-none">
                        {formatElapsed(hiddenElapsedMs)}
                    </span>
                </div>
                <SizeBadge size={size} className="ml-auto" />
            </section>

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
                    You can&apos;t move from here until the seeker
                    finds you or the round ends.
                </div>
            </section>

            {/* Seeker-position placeholder. Multiplayer live-location
                isn't wired yet, so we tell the hider what to expect
                when it is. */}
            <section className="mt-4 rounded-md border border-dashed border-border px-3 py-3 text-xs text-muted-foreground leading-snug">
                <span className="font-bold text-foreground">
                    Seeker position:
                </span>{" "}
                not connected yet. When live-share is wired, the
                seeker&apos;s last reported location will appear on
                the map above so you can feel the close-in.
                <br />
                Zone radius: {(radiusMeters / 1000).toFixed(1)} km.
            </section>

            {/* Question log + hand stay available but quieter */}
            <HiderQuestionLog />
            <HiderHandPanel />
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

function ElapsedHiddenBanner({
    hiddenElapsedMs,
    size,
}: {
    hiddenElapsedMs: number;
    size: ReturnType<typeof gameSize.get>;
}) {
    return (
        <section className="rounded-md border-2 border-yellow-500/60 bg-yellow-500/5 px-4 py-3 mb-4 flex items-center gap-3">
            <Timer className="w-5 h-5 shrink-0 text-yellow-500" />
            <div className="flex flex-col leading-none gap-1">
                <span className="text-[9px] font-inter-tight font-bold uppercase tracking-[0.18em] text-muted-foreground">
                    Hidden for
                </span>
                <span className="font-inter-tight italic font-black tabular-nums text-2xl text-primary leading-none">
                    {formatElapsed(hiddenElapsedMs)}
                </span>
            </div>
            <SizeBadge size={size} className="ml-auto" />
        </section>
    );
}

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
    const seekMs = Math.max(0, foundAt - hidingEndsAt);
    const finalMs = Math.max(0, seekMs - timeBonusMinutes * 60_000);

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
                        −{timeBonusMinutes}m
                    </div>
                </div>
            </div>
            <p className="text-[10px] text-muted-foreground mt-3 text-center leading-snug">
                Lower is better for the seeker; higher is better for the hider.
                Carry to the next round for cumulative scoring.
            </p>
        </section>
    );
}

/* ────────────────── Hiding zone section ────────────────── */

function HidingZoneSection({
    zone,
    radiusMeters,
    disabled,
    showStationSuggest,
}: {
    zone: ReturnType<typeof hidingZone.get>;
    radiusMeters: number;
    disabled?: boolean;
    /** When true (phase 1), surface the GPS-based station-suggest list
     *  as the primary path. Otherwise just the inline map. */
    showStationSuggest?: boolean;
}) {
    const [editing, setEditing] = useState(zone === null);
    const [mode, setMode] = useState<"stations" | "map">(
        showStationSuggest ? "stations" : "map",
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
    };

    return (
        <section className="mt-1">
            <div className="flex items-center gap-2 mb-2">
                <MapPin className="w-4 h-4 text-muted-foreground" />
                <SectionPill>Hiding zone</SectionPill>
                {zone && !editing && (
                    <span className="text-[10px] text-muted-foreground tabular-nums ml-1">
                        {(radiusMeters / 1000).toFixed(
                            radiusMeters >= 1000 ? 1 : 2,
                        )}{" "}
                        km radius
                    </span>
                )}
            </div>
            {zone && !editing ? (
                <div className="rounded-sm border border-border bg-secondary/40 p-3 flex items-start gap-3">
                    <Lock className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                    <div className="min-w-0 flex-1">
                        <div className="font-inter-tight font-bold uppercase tracking-wide text-sm">
                            {zone.stationName}
                        </div>
                        <div className="text-xs text-muted-foreground tabular-nums">
                            {zone.stationLat.toFixed(5)},{" "}
                            {zone.stationLng.toFixed(5)}
                        </div>
                    </div>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setEditing(true)}
                        disabled={disabled}
                    >
                        Change
                    </Button>
                </div>
            ) : (
                <div className="space-y-3">
                    {/* Mode switcher: GPS station list vs. inline map */}
                    <div className="flex items-center gap-1 text-xs">
                        <button
                            type="button"
                            onClick={() => setMode("stations")}
                            className={cn(
                                "px-2.5 py-1 rounded-sm font-poppins font-semibold",
                                "transition-colors",
                                mode === "stations"
                                    ? "bg-primary text-primary-foreground"
                                    : "bg-secondary text-foreground hover:bg-accent",
                            )}
                        >
                            Nearby stations
                        </button>
                        <button
                            type="button"
                            onClick={() => setMode("map")}
                            className={cn(
                                "px-2.5 py-1 rounded-sm font-poppins font-semibold",
                                "transition-colors",
                                mode === "map"
                                    ? "bg-primary text-primary-foreground"
                                    : "bg-secondary text-foreground hover:bg-accent",
                            )}
                        >
                            Pick on map
                        </button>
                    </div>

                    {mode === "stations" ? (
                        <NearbyStationsPicker
                            onPick={(s: FoundStation) => {
                                setDraftLat(s.lat);
                                setDraftLng(s.lng);
                                setDraftName(s.name);
                                commitZone({
                                    lat: s.lat,
                                    lng: s.lng,
                                    name: s.name,
                                });
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
            toast.error("Geolocation isn't available on this device.");
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
                        Hiding period is over. Pin your spot and stay there
                        — the seeker can&apos;t ask new questions if you
                        keep moving (rulebook p43).
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
                                    {draftLat.toFixed(5)},{" "}
                                    {draftLng.toFixed(5)}
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
