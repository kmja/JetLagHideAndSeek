import { ArrowLeft } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
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
 * Developer overlay gallery at `/debug/overlays` — every floating
 * timer / pending-question / banner / celebration / veil overlay shown
 * AT ONCE, side by side, each in its own cell. The data driving them is
 * deliberately incoherent (the timer is mid-hiding while a thermometer is
 * running and the seekers are frozen and location is in grace…) — the
 * point is to eyeball every overlay's visual at a glance, not to model a
 * real game state.
 *
 * Why cells: these overlays position with `fixed` / `absolute` against
 * the viewport and read GLOBAL atoms, so mounted naively they'd all stack
 * on top of each other at the same screen position. Each cell sets a
 * non-`none` `transform`, which makes it the containing block for its
 * overlay's `fixed`/`absolute` positioning — so each overlay lays itself
 * out within its own cell instead of the whole window.
 *
 * SAFETY: the overlays read PERSISTENT global atoms, so driving them
 * writes those atoms. We snapshot every atom we touch on mount and RESTORE
 * on unmount (and via the Restore button). A hard refresh while the
 * gallery is open skips the restore — the header says so.
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

/**
 * Light every overlay up at once. Values are intentionally simultaneous
 * and incoherent — we just want each overlay's gate satisfied so it
 * renders. The `locationMode` arg flips the one banner that has two
 * mutually-exclusive states (grace countdown vs hard pause).
 */
function arm(locationMode: "grace" | "paused"): void {
    setupCompleted.set(true);
    endgameStartedAt.set(null);
    roundFoundAt.set(null);
    // Hiding period running → HiderTimer (hiding) + GoGoGo countdown.
    hidingPeriodEndsAt.set(Date.now() + 5 * 60_000);
    gameStartCelebrationAt.set(Date.now());
    seekersFrozenUntil.set(Date.now() + 45_000);
    locationGraceStartedAt.set(locationMode === "grace" ? Date.now() : null);
    gamePausedForLocationAt.set(locationMode === "paused" ? Date.now() : null);
    // One pending radar (PendingAnswerOverlay) + one running thermometer
    // (ThermometerOverlay). Each overlay filters to its own kind.
    questions.set([mockRadiusQuestion(Date.now()), mockStartedThermometer()]);
    triggerLocalRefresh.set(Math.random());
}

/** A single labelled gallery cell that becomes the containing block for
 *  its overlay's fixed/absolute positioning. */
function Cell({
    label,
    children,
}: {
    label: string;
    children: ReactNode;
}) {
    return (
        <div className="flex flex-col gap-1.5">
            <div className="text-[10px] uppercase tracking-[0.14em] font-poppins font-bold text-muted-foreground">
                {label}
            </div>
            <div
                className={cn(
                    "relative h-72 rounded-lg border border-border overflow-hidden",
                    "bg-[hsl(var(--sidebar-background))]",
                )}
                // A non-`none` transform makes this the containing block
                // for the overlay's `fixed`/`absolute` positioning, so it
                // lays out inside the cell rather than the viewport.
                style={{ transform: "translateZ(0)" }}
            >
                {/* Faux-map grid so positioned overlays read against a
                    map-like surface, not a flat panel. */}
                <div
                    className="absolute inset-0 opacity-[0.15]"
                    style={{
                        backgroundImage:
                            "linear-gradient(hsl(var(--border)) 1px, transparent 1px), linear-gradient(90deg, hsl(var(--border)) 1px, transparent 1px)",
                        backgroundSize: "28px 28px",
                    }}
                    aria-hidden
                />
                {children}
            </div>
        </div>
    );
}

export function DebugOverlaysPage() {
    const snapRef = useRef<SandboxSnapshot | null>(null);
    const [locationMode, setLocationMode] = useState<"grace" | "paused">(
        "grace",
    );

    useEffect(() => {
        snapRef.current = snapshot();
        arm("grace");
        return () => {
            if (snapRef.current) restore(snapRef.current);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const reArm = () => arm(locationMode);
    const toggleLocation = () => {
        const next = locationMode === "grace" ? "paused" : "grace";
        setLocationMode(next);
        arm(next);
    };
    const restoreNow = () => {
        if (snapRef.current) restore(snapRef.current);
    };

    return (
        <div className="dark min-h-screen bg-[hsl(var(--sidebar-background))] text-[hsl(var(--sidebar-foreground))]">
            {/* Header */}
            <div className="sticky top-0 z-10 flex items-center gap-3 px-4 py-3 border-b border-border bg-background/95 backdrop-blur">
                <Link
                    to="/"
                    className="inline-flex items-center justify-center w-8 h-8 rounded-md hover:bg-accent shrink-0"
                    aria-label="Back to app"
                    title="Back (restores your game state)"
                >
                    <ArrowLeft className="w-4 h-4" />
                </Link>
                <div className="min-w-0 flex-1">
                    <div className="font-display font-extrabold uppercase text-sm leading-none tracking-wide">
                        Overlay gallery
                    </div>
                    <div className="text-[10px] text-muted-foreground leading-tight mt-0.5">
                        All overlays at once · your game state is restored
                        when you leave (hard refresh skips it)
                    </div>
                </div>
                <Button variant="outline" size="sm" onClick={toggleLocation}>
                    Location: {locationMode}
                </Button>
                <Button variant="outline" size="sm" onClick={reArm}>
                    Re-arm
                </Button>
                <Button variant="outline" size="sm" onClick={restoreNow}>
                    Restore
                </Button>
            </div>

            {/* Gallery grid */}
            <div className="p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                <Cell label="Hider timer (hiding)">
                    <HiderTimer />
                </Cell>
                <Cell label="Pending question">
                    <PendingAnswerOverlay />
                </Cell>
                <Cell label="Thermometer pill">
                    <ThermometerOverlay />
                </Cell>
                <Cell label={`Location banner (${locationMode})`}>
                    <LocationPauseBanner />
                </Cell>
                <Cell label="Seekers frozen (Move)">
                    <SeekerFrozenBanner />
                </Cell>
                <Cell label="Game start (Go, go, go)">
                    <GoGoGoOverlay />
                </Cell>
                <Cell label="Map tiles loading">
                    <MapTilesVeil visible label="Loading map" />
                </Cell>
                <Cell label="Map tiles slow (timed out)">
                    <MapTilesVeil
                        visible
                        timedOut
                        label="Map tiles are slow to load"
                        sublabel="Hang tight — still trying"
                    />
                </Cell>
            </div>
        </div>
    );
}

export default DebugOverlaysPage;
