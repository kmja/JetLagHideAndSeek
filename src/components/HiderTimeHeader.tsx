import { useStore } from "@nanostores/react";
import { Flag, Sparkles, Timer, Trophy, Users } from "lucide-react";
import { useState } from "react";

import { CacheStatusPill } from "@/components/CacheStatusPill";
import { Button } from "@/components/ui/button";
import { useVisibleInterval } from "@/hooks/useVisibleInterval";
import {
    endgameStartedAt,
    formatTimeRemaining,
    hidingPeriodEndsAt,
} from "@/lib/gameSetup";
import {
    hiderForfeited,
    hidingSpot,
    hidingZone,
    roundFoundAt,
    ZONE_GRACE_MS,
} from "@/lib/hiderRole";
import { lobbyManualOpen } from "@/lib/multiplayer/session";
import { cn } from "@/lib/utils";

/**
 * Big sticky header for the hider shell. Mirrors the seeker's
 * top-left timer card: large MM:SS display, a phase pill above it,
 * and the lobby button floated top-right.
 *
 * The header is phase-aware — same derivation as HiderHome does
 * internally, but consolidated here so the shell renders without
 * cross-component dependencies:
 *
 *   • pre-game  — "Waiting on seeker" placeholder
 *   • hiding    — Big remaining-time countdown
 *   • grace     — Red "Pick a zone" countdown with the grace window
 *   • forfeit   — Red "Forfeited" stamp
 *   • seeking   — Elapsed-since-hiding-ended timer
 *   • endgame   — Yellow "Endgame" with the same elapsed timer
 *   • over      — Final elapsed snapshot ("Found at MM:SS")
 *
 * Mounted by HiderShell at `fixed top-0 inset-x-0 z-[1040]`.
 */
export function HiderTimeHeader() {
    const $hidingEndsAt = useStore(hidingPeriodEndsAt);
    const $endgameStartedAt = useStore(endgameStartedAt);
    const $foundAt = useStore(roundFoundAt);
    const $hidingZone = useStore(hidingZone);
    const $hidingSpot = useStore(hidingSpot);
    const $forfeited = useStore(hiderForfeited);

    const [now, setNow] = useState(() => Date.now());
    useVisibleInterval(
        () => setNow(Date.now()),
        1000,
        $hidingEndsAt !== null && $foundAt === null,
    );

    const inHidingPeriod = $hidingEndsAt !== null && now < $hidingEndsAt;
    const remainingMs = $hidingEndsAt ? Math.max(0, $hidingEndsAt - now) : 0;
    const graceEndsAt = $hidingEndsAt ? $hidingEndsAt + ZONE_GRACE_MS : null;
    const inGraceWindow =
        $hidingEndsAt !== null &&
        !inHidingPeriod &&
        $hidingZone === null &&
        graceEndsAt !== null &&
        now < graceEndsAt;
    const graceRemainingMs = graceEndsAt
        ? Math.max(0, graceEndsAt - now)
        : 0;
    const elapsedAnchor = $foundAt ?? now;
    const hiddenElapsedMs = $hidingEndsAt
        ? Math.max(0, elapsedAnchor - $hidingEndsAt)
        : 0;
    const roundOver = $foundAt !== null;

    const phase: HeaderPhase = (() => {
        if (!$hidingEndsAt) return "pre-game";
        if ($forfeited) return "forfeit";
        if (roundOver) return "over";
        if (inHidingPeriod) return "hiding";
        if (inGraceWindow) return "grace";
        if ($hidingSpot) return "endgame";
        return "seeking";
    })();

    return (
        <header
            className={cn(
                "fixed top-0 inset-x-0 z-[1040]",
                "bg-background/95 backdrop-blur-sm border-b border-border",
                "pt-[max(0.5rem,env(safe-area-inset-top))]",
            )}
        >
            <div className="flex items-center justify-between gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                    <PhaseLabel phase={phase} />
                    <TimerDisplay
                        phase={phase}
                        remainingMs={remainingMs}
                        graceRemainingMs={graceRemainingMs}
                        hiddenElapsedMs={hiddenElapsedMs}
                        endgameOn={$endgameStartedAt !== null}
                    />
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    <CacheStatusPill />
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => lobbyManualOpen.set(true)}
                        className="gap-1.5 h-9 text-xs"
                        title="Open the game lobby"
                    >
                        <Users className="w-3.5 h-3.5" />
                        Lobby
                    </Button>
                </div>
            </div>
        </header>
    );
}

type HeaderPhase =
    | "pre-game"
    | "hiding"
    | "grace"
    | "forfeit"
    | "seeking"
    | "endgame"
    | "over";

function PhaseLabel({ phase }: { phase: HeaderPhase }) {
    const meta = (() => {
        switch (phase) {
            case "pre-game":
                return {
                    label: "Waiting on seeker",
                    cls: "text-muted-foreground",
                    Icon: Timer,
                };
            case "hiding":
                return {
                    label: "Hiding period",
                    cls: "text-primary",
                    Icon: Timer,
                };
            case "grace":
                return {
                    label: "Pick a zone — grace",
                    cls: "text-destructive",
                    Icon: Timer,
                };
            case "forfeit":
                return {
                    label: "Forfeited",
                    cls: "text-destructive",
                    Icon: Flag,
                };
            case "seeking":
                return {
                    label: "On the run",
                    cls: "text-foreground",
                    Icon: Sparkles,
                };
            case "endgame":
                return {
                    label: "Endgame — locked down",
                    cls: "text-yellow-400",
                    Icon: Flag,
                };
            case "over":
                return {
                    label: "Round over",
                    cls: "text-muted-foreground",
                    Icon: Trophy,
                };
        }
    })();

    return (
        <div
            className={cn(
                "flex items-center gap-1.5 text-[10px] uppercase",
                "font-poppins font-bold tracking-[0.18em]",
                meta.cls,
            )}
        >
            <meta.Icon className="w-3 h-3" />
            <span className="truncate">{meta.label}</span>
        </div>
    );
}

function TimerDisplay({
    phase,
    remainingMs,
    graceRemainingMs,
    hiddenElapsedMs,
    endgameOn,
}: {
    phase: HeaderPhase;
    remainingMs: number;
    graceRemainingMs: number;
    hiddenElapsedMs: number;
    endgameOn: boolean;
}) {
    const baseCls =
        "font-poppins font-black tabular-nums leading-none text-3xl";

    switch (phase) {
        case "pre-game":
            return (
                <div className="text-base text-muted-foreground leading-tight">
                    Seeker hasn&apos;t started yet
                </div>
            );
        case "hiding":
            return (
                <div className={cn(baseCls, "text-primary")}>
                    {formatTimeRemaining(remainingMs)}
                </div>
            );
        case "grace":
            return (
                <div className={cn(baseCls, "text-destructive animate-pulse")}>
                    {formatTimeRemaining(graceRemainingMs)}
                </div>
            );
        case "forfeit":
            return (
                <div className={cn(baseCls, "text-destructive")}>
                    Round lost
                </div>
            );
        case "seeking":
            return (
                <div
                    className={cn(
                        baseCls,
                        endgameOn ? "text-yellow-400" : "text-foreground",
                    )}
                >
                    {formatTimeRemaining(hiddenElapsedMs)}
                </div>
            );
        case "endgame":
            return (
                <div className={cn(baseCls, "text-yellow-400")}>
                    {formatTimeRemaining(hiddenElapsedMs)}
                </div>
            );
        case "over":
            return (
                <div className={cn(baseCls, "text-muted-foreground")}>
                    {formatTimeRemaining(hiddenElapsedMs)}
                </div>
            );
    }
}

export default HiderTimeHeader;
