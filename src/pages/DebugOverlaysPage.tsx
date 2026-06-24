import { useStore } from "@nanostores/react";
import { ArrowLeft } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { GoGoGoOverlay } from "@/components/GoGoGoOverlay";
import { HiderTimer } from "@/components/HiderTimer";
import { LocationPauseBanner } from "@/components/LocationPauseBanner";
import { MapTilesVeil } from "@/components/MapTilesVeil";
import { PendingAnswerOverlay } from "@/components/PendingAnswerOverlay";
import { SeekerFrozenBanner } from "@/components/SeekerFrozenBanner";
import { ThermometerOverlay } from "@/components/ThermometerOverlay";
import { Button } from "@/components/ui/button";
import { questions, triggerLocalRefresh } from "@/lib/context";
import {
    endgameStartedAt,
    gamePausedForLocationAt,
    gameSize,
    gameStartCelebrationAt,
    hidingPeriodEndsAt,
    locationGraceStartedAt,
    seekersFrozenUntil,
    setupCompleted,
} from "@/lib/gameSetup";
import { roundFoundAt, roundLog } from "@/lib/hiderRole";
import { cn } from "@/lib/utils";

/**
 * Developer overlay gallery at `/debug/overlays` — preview the floating
 * timer / pending-question / banner / celebration overlays in isolation,
 * in each of their states, without setting up a real game.
 *
 * SAFETY: most overlays read PERSISTENT global atoms (hidingPeriodEndsAt,
 * questions, …). Driving them means writing those atoms, which would
 * otherwise clobber a real in-progress game. So this page snapshots every
 * atom it touches on mount and RESTORES them on unmount (i.e. when you
 * navigate away). A "Restore now" button does it on demand. Caveat: a
 * hard refresh / tab close while a preview is active skips the restore —
 * the banner below says so.
 *
 * How it works: all display overlays are mounted unconditionally; each
 * self-gates on its atoms and renders nothing until its atoms are set.
 * Selecting a preset neutralises every sandbox atom, then sets just the
 * ones that preset needs — so exactly one overlay shows at a time, no
 * cross-overlay atom conflicts. (Effect/fetch overlays — TravelTimes,
 * HiderReach — are deliberately excluded; they hit the network.)
 */

// A throwaway lat/lng for mock question geometry (central London).
const MOCK_LAT = 51.5074;
const MOCK_LNG = -0.1278;

type SandboxSnapshot = {
    hidingPeriodEndsAt: number | null;
    gameSize: ReturnType<typeof gameSize.get>;
    setupCompleted: boolean;
    endgameStartedAt: number | null;
    gameStartCelebrationAt: number | null;
    seekersFrozenUntil: number | null;
    locationGraceStartedAt: number | null;
    gamePausedForLocationAt: number | null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    questions: any;
    roundFoundAt: number | null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    roundLog: any;
};

function snapshot(): SandboxSnapshot {
    return {
        hidingPeriodEndsAt: hidingPeriodEndsAt.get(),
        gameSize: gameSize.get(),
        setupCompleted: setupCompleted.get(),
        endgameStartedAt: endgameStartedAt.get(),
        gameStartCelebrationAt: gameStartCelebrationAt.get(),
        seekersFrozenUntil: seekersFrozenUntil.get(),
        locationGraceStartedAt: locationGraceStartedAt.get(),
        gamePausedForLocationAt: gamePausedForLocationAt.get(),
        questions: questions.get(),
        roundFoundAt: roundFoundAt.get(),
        roundLog: roundLog.get(),
    };
}

function restore(s: SandboxSnapshot): void {
    hidingPeriodEndsAt.set(s.hidingPeriodEndsAt);
    gameSize.set(s.gameSize);
    setupCompleted.set(s.setupCompleted);
    endgameStartedAt.set(s.endgameStartedAt);
    gameStartCelebrationAt.set(s.gameStartCelebrationAt);
    seekersFrozenUntil.set(s.seekersFrozenUntil);
    locationGraceStartedAt.set(s.locationGraceStartedAt);
    gamePausedForLocationAt.set(s.gamePausedForLocationAt);
    questions.set(s.questions);
    roundFoundAt.set(s.roundFoundAt);
    roundLog.set(s.roundLog);
    triggerLocalRefresh.set(Math.random());
}

/** Neutralise every overlay-driving atom so nothing renders, ready for a
 *  preset to set exactly what it needs. */
function neutralise(): void {
    hidingPeriodEndsAt.set(null);
    endgameStartedAt.set(null);
    gameStartCelebrationAt.set(null);
    seekersFrozenUntil.set(null);
    locationGraceStartedAt.set(null);
    gamePausedForLocationAt.set(null);
    roundFoundAt.set(null);
    questions.set([]);
    // setupCompleted stays true so the timer/banners are allowed to mount.
    setupCompleted.set(true);
    triggerLocalRefresh.set(Math.random());
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockRadiusQuestion(createdAt: number | undefined): any {
    return {
        id: "radius",
        key: 999001,
        data: {
            lat: MOCK_LAT,
            lng: MOCK_LNG,
            radius: 5,
            unit: "kilometers",
            drag: true,
            ...(createdAt !== undefined ? { createdAt } : {}),
        },
    };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockStartedThermometer(): any {
    return {
        id: "thermometer",
        key: 999002,
        data: {
            status: "started",
            startedAt: Date.now() - 90_000,
            targetSig: "1km",
            distance: "1km",
            latA: MOCK_LAT,
            lngA: MOCK_LNG,
            latB: MOCK_LAT,
            lngB: MOCK_LNG,
            drag: true,
        },
    };
}

interface Preset {
    id: string;
    group: string;
    label: string;
    apply: () => void;
}

const PRESETS: Preset[] = [
    // ── Timer ──────────────────────────────────────────────────
    {
        id: "timer-hiding-5m",
        group: "Timer",
        label: "Hiding period · 5:00 left",
        apply: () => hidingPeriodEndsAt.set(Date.now() + 5 * 60_000),
    },
    {
        id: "timer-hiding-20s",
        group: "Timer",
        label: "Hiding period · 0:20 left",
        apply: () => hidingPeriodEndsAt.set(Date.now() + 20_000),
    },
    {
        id: "timer-seeking",
        group: "Timer",
        label: "Seeking · hidden 2:00",
        apply: () => hidingPeriodEndsAt.set(Date.now() - 2 * 60_000),
    },
    // ── Pending question ───────────────────────────────────────
    {
        id: "pending-not-sent",
        group: "Pending question",
        label: "Radar · not sent",
        apply: () => questions.set([mockRadiusQuestion(undefined)]),
    },
    {
        id: "pending-waiting",
        group: "Pending question",
        label: "Radar · waiting for answer",
        apply: () => questions.set([mockRadiusQuestion(Date.now())]),
    },
    {
        id: "pending-overdue",
        group: "Pending question",
        label: "Radar · overdue",
        apply: () =>
            questions.set([mockRadiusQuestion(Date.now() - 6 * 60_000)]),
    },
    {
        id: "thermo-started",
        group: "Pending question",
        label: "Thermometer · running pill",
        apply: () => questions.set([mockStartedThermometer()]),
    },
    // ── Banners ────────────────────────────────────────────────
    {
        id: "loc-grace",
        group: "Banner",
        label: "Location sharing · grace countdown",
        apply: () => locationGraceStartedAt.set(Date.now()),
    },
    {
        id: "loc-paused",
        group: "Banner",
        label: "Location sharing · paused",
        apply: () => gamePausedForLocationAt.set(Date.now()),
    },
    {
        id: "frozen",
        group: "Banner",
        label: "Seekers frozen (Move powerup)",
        apply: () => seekersFrozenUntil.set(Date.now() + 45_000),
    },
    // ── Celebration ────────────────────────────────────────────
    {
        id: "gogogo",
        group: "Celebration",
        label: "Go, go, go! (game start)",
        apply: () => {
            hidingPeriodEndsAt.set(Date.now() + 30 * 60_000);
            gameStartCelebrationAt.set(Date.now());
        },
    },
];

const GROUPS = Array.from(new Set(PRESETS.map((p) => p.group)));

export function DebugOverlaysPage() {
    useStore(triggerLocalRefresh);
    const snapRef = useRef<SandboxSnapshot | null>(null);
    const [active, setActive] = useState<string | null>(null);
    // MapTilesVeil is prop-driven (no atoms), handled separately.
    const [veil, setVeil] = useState<null | "loading" | "timedout">(null);

    useEffect(() => {
        snapRef.current = snapshot();
        return () => {
            if (snapRef.current) restore(snapRef.current);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const applyPreset = (p: Preset) => {
        neutralise();
        setVeil(null);
        p.apply();
        triggerLocalRefresh.set(Math.random());
        setActive(p.id);
    };

    const clearAll = () => {
        neutralise();
        setVeil(null);
        setActive(null);
    };

    const restoreNow = () => {
        if (snapRef.current) restore(snapRef.current);
        setActive("(restored)");
        setVeil(null);
    };

    return (
        <div className="dark fixed inset-0 z-0 overflow-hidden bg-[hsl(var(--sidebar-background))] text-[hsl(var(--sidebar-foreground))]">
            {/* Faux-map backdrop so positioned overlays read against a
                map-like surface, not a flat panel. */}
            <div
                className="absolute inset-0 opacity-[0.15]"
                style={{
                    backgroundImage:
                        "linear-gradient(hsl(var(--border)) 1px, transparent 1px), linear-gradient(90deg, hsl(var(--border)) 1px, transparent 1px)",
                    backgroundSize: "32px 32px",
                }}
                aria-hidden
            />

            {/* The real overlays — all mounted, each self-gates on its
                atoms. Exactly one shows per preset. */}
            <HiderTimer />
            <PendingAnswerOverlay />
            <ThermometerOverlay />
            <LocationPauseBanner />
            <SeekerFrozenBanner />
            <GoGoGoOverlay />
            {veil !== null && (
                <MapTilesVeil
                    visible
                    timedOut={veil === "timedout"}
                    label={
                        veil === "timedout"
                            ? "Map tiles are slow to load"
                            : "Loading map"
                    }
                    sublabel={
                        veil === "timedout"
                            ? "Hang tight — still trying"
                            : undefined
                    }
                />
            )}

            {/* Control panel. z above the non-fullscreen overlays; the
                full-screen GoGoGo (z-[1070]) intentionally covers it —
                dismiss it with its own button to get back here. */}
            <div className="absolute top-3 left-3 z-[1065] w-[18rem] max-w-[calc(100vw-1.5rem)] max-h-[calc(100vh-1.5rem)] overflow-y-auto rounded-xl border border-border bg-background/95 backdrop-blur shadow-xl">
                <div className="px-4 pt-3 pb-2 border-b border-border flex items-center gap-2">
                    <Link
                        to="/"
                        className="inline-flex items-center justify-center w-7 h-7 rounded-md hover:bg-accent shrink-0"
                        aria-label="Back to app"
                        title="Back (restores your game state)"
                    >
                        <ArrowLeft className="w-4 h-4" />
                    </Link>
                    <div className="min-w-0">
                        <div className="font-display font-extrabold uppercase text-sm leading-none tracking-wide">
                            Overlay gallery
                        </div>
                        <div className="text-[10px] text-muted-foreground leading-tight mt-0.5">
                            /debug/overlays
                        </div>
                    </div>
                </div>

                <div className="px-4 py-2 text-[11px] leading-snug text-muted-foreground border-b border-border">
                    Sandbox — your real game state is snapshotted now and
                    restored when you leave (or tap Restore). A hard refresh
                    while a preview is active skips the restore.
                </div>

                <div className="p-3 space-y-3">
                    {GROUPS.map((group) => (
                        <div key={group} className="space-y-1.5">
                            <div className="text-[10px] uppercase tracking-[0.14em] font-poppins font-bold text-muted-foreground">
                                {group}
                            </div>
                            <div className="flex flex-col gap-1.5">
                                {PRESETS.filter((p) => p.group === group).map(
                                    (p) => (
                                        <button
                                            key={p.id}
                                            type="button"
                                            onClick={() => applyPreset(p)}
                                            className={cn(
                                                "w-full text-left px-2.5 py-1.5 rounded-md text-xs",
                                                "border transition-colors",
                                                active === p.id
                                                    ? "bg-primary text-primary-foreground border-primary"
                                                    : "bg-secondary/40 border-border hover:bg-accent",
                                            )}
                                        >
                                            {p.label}
                                        </button>
                                    ),
                                )}
                            </div>
                        </div>
                    ))}

                    {/* Loading veil — prop-driven, not atom-driven. */}
                    <div className="space-y-1.5">
                        <div className="text-[10px] uppercase tracking-[0.14em] font-poppins font-bold text-muted-foreground">
                            Loading veil
                        </div>
                        <div className="flex flex-col gap-1.5">
                            <button
                                type="button"
                                onClick={() => {
                                    neutralise();
                                    setActive(null);
                                    setVeil("loading");
                                }}
                                className={cn(
                                    "w-full text-left px-2.5 py-1.5 rounded-md text-xs border transition-colors",
                                    veil === "loading"
                                        ? "bg-primary text-primary-foreground border-primary"
                                        : "bg-secondary/40 border-border hover:bg-accent",
                                )}
                            >
                                Tiles loading
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    neutralise();
                                    setActive(null);
                                    setVeil("timedout");
                                }}
                                className={cn(
                                    "w-full text-left px-2.5 py-1.5 rounded-md text-xs border transition-colors",
                                    veil === "timedout"
                                        ? "bg-primary text-primary-foreground border-primary"
                                        : "bg-secondary/40 border-border hover:bg-accent",
                                )}
                            >
                                Tiles slow (timed out)
                            </button>
                        </div>
                    </div>
                </div>

                <div className="p-3 border-t border-border flex gap-2">
                    <Button
                        variant="outline"
                        size="sm"
                        className="flex-1"
                        onClick={clearAll}
                    >
                        Clear
                    </Button>
                    <Button
                        variant="outline"
                        size="sm"
                        className="flex-1"
                        onClick={restoreNow}
                    >
                        Restore
                    </Button>
                </div>
            </div>
        </div>
    );
}

export default DebugOverlaysPage;
