import { useStore } from "@nanostores/react";
import { Flag, Plus, Sparkles, Timer, Trophy } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "react-toastify";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import { useVisibleInterval } from "@/hooks/useVisibleInterval";
import { lastKnownPosition } from "@/lib/context";
import {
    endgameStartedAt,
    formatTimeRemaining,
    hidingPeriodEndsAt,
} from "@/lib/gameSetup";
import {
    addScoutedSpot,
    hiderForfeited,
    hidingSpot,
    hidingZone,
    roundFoundAt,
    roundLog,
    ZONE_GRACE_MS,
} from "@/lib/hiderRole";
import { cn } from "@/lib/utils";

/**
 * Great-circle distance in metres. Used to gate the "Mark spot"
 * button on whether the hider's GPS is inside their committed
 * hiding zone. Inlined here rather than importing turf so the
 * header doesn't pull a multi-hundred-KB geo lib on a route
 * where MapLibre already paid that cost.
 */
function metersBetween(
    lat1: number,
    lng1: number,
    lat2: number,
    lng2: number,
): number {
    const R = 6371000;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) *
            Math.cos(toRad(lat2)) *
            Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

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
    const $gps = useStore(lastKnownPosition);

    // Mark-spot popover state. v313 moves the button into the
    // header (was a floating yellow FAB on the map); it only
    // appears when the hider has committed a zone AND their GPS is
    // physically inside that zone. Outside the zone — or before a
    // zone is committed — the action is meaningless, so we hide it
    // entirely rather than disabling it.
    const [markPopoverOpen, setMarkPopoverOpen] = useState(false);
    const [draftLabel, setDraftLabel] = useState("");
    const [pinningSpot, setPinningSpot] = useState(false);

    const insideZone =
        $hidingZone !== null &&
        $gps !== null &&
        metersBetween(
            $gps.lat,
            $gps.lng,
            $hidingZone.stationLat,
            $hidingZone.stationLng,
        ) <= $hidingZone.radiusMeters;

    // v318: rolling "time to beat" — longest hide so far this
    // game. Surfaced beneath the live countdown / elapsed timer so
    // the hider knows what they're racing against. Hidden in the
    // first round and pre-game where there's nothing to compare to.
    const $roundLog = useStore(roundLog);
    const timeToBeatMs = useMemo(() => {
        if ($roundLog.length === 0) return null;
        return Math.max(...$roundLog.map((r) => r.hidingMs));
    }, [$roundLog]);

    const handleSaveMark = () => {
        if (typeof navigator === "undefined" || !navigator.geolocation) {
            toast.error("Location access isn't available on this device.");
            return;
        }
        setPinningSpot(true);
        const label = draftLabel.trim() || undefined;
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                addScoutedSpot({
                    lat: pos.coords.latitude,
                    lng: pos.coords.longitude,
                    label,
                });
                setPinningSpot(false);
                setDraftLabel("");
                setMarkPopoverOpen(false);
                toast.success("Potential hiding spot marked.", {
                    autoClose: 1500,
                });
            },
            (err) => {
                setPinningSpot(false);
                toast.error(
                    err.code === err.PERMISSION_DENIED
                        ? "Allow location access to mark spots."
                        : "Couldn't read your location — try again.",
                );
            },
            { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 },
        );
    };

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
                // v462: flow row directly below HiderTopBar (was a
                // `fixed` overlay positioned by a magic top offset).
                "shrink-0 z-[1040]",
                "bg-background/95 backdrop-blur-sm border-b border-border",
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
                    {/* v318: "time to beat" hint — longest hide
                        recorded in earlier rounds of this game.
                        Only shown during phases where the hider is
                        actively racing the clock; pre-game / round-
                        over surfaces don't benefit from it. */}
                    {timeToBeatMs !== null &&
                        (phase === "seeking" ||
                            phase === "endgame" ||
                            phase === "hiding") && (
                            <div className="text-[10px] uppercase tracking-[0.14em] font-poppins font-semibold text-muted-foreground tabular-nums mt-0.5">
                                Time to beat:{" "}
                                <span className="text-foreground">
                                    {formatTimeRemaining(timeToBeatMs)}
                                </span>
                            </div>
                        )}
                </div>
                {insideZone && (
                    <Popover
                        open={markPopoverOpen}
                        onOpenChange={(o) => {
                            setMarkPopoverOpen(o);
                            if (!o) setDraftLabel("");
                        }}
                    >
                        <PopoverTrigger asChild>
                            <Button
                                type="button"
                                size="sm"
                                className="shrink-0 gap-1"
                                title="Mark potential hiding spot at your current location"
                            >
                                <Plus
                                    className="w-3.5 h-3.5"
                                    strokeWidth={3}
                                />
                                Mark spot
                            </Button>
                        </PopoverTrigger>
                        <PopoverContent
                            align="end"
                            side="bottom"
                            className="w-[280px] p-3 bg-card border-2 border-border shadow-xl space-y-3"
                        >
                            <div className="space-y-1">
                                <div className="text-[10px] uppercase tracking-[0.16em] font-poppins font-bold text-muted-foreground">
                                    Mark potential hiding spot
                                </div>
                                <p className="text-[11px] text-muted-foreground leading-snug">
                                    Saves your current location with a
                                    short description you can find later
                                    in the Zone drawer.
                                </p>
                            </div>
                            <Input
                                value={draftLabel}
                                onChange={(e) => setDraftLabel(e.target.value)}
                                placeholder="e.g. bench behind the library"
                                maxLength={40}
                                className="text-sm"
                                autoFocus
                                onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                        e.preventDefault();
                                        handleSaveMark();
                                    }
                                }}
                            />
                            <div className="flex items-stretch gap-2">
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    onClick={() => {
                                        setMarkPopoverOpen(false);
                                        setDraftLabel("");
                                    }}
                                    className="flex-1"
                                >
                                    Cancel
                                </Button>
                                <Button
                                    type="button"
                                    onClick={handleSaveMark}
                                    disabled={pinningSpot}
                                    size="sm"
                                    className="flex-1 gap-1"
                                >
                                    <Plus
                                        className="w-3.5 h-3.5"
                                        strokeWidth={3}
                                    />
                                    {pinningSpot ? "Locating…" : "Save here"}
                                </Button>
                            </div>
                        </PopoverContent>
                    </Popover>
                )}
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
