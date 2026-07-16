import { useStore } from "@nanostores/react";
import { Ban, Flag, Hourglass, Plus, Timer, X } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "react-toastify";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import { useNow } from "@/hooks/useNow";
import { lastKnownPosition } from "@/lib/context";
import {
    endgameStartedAt,
    formatTimeRemaining,
    gameSize,
    hidingPeriodEndsAt,
    zoneLockedCallout,
} from "@/lib/gameSetup";
import { tallyTimeBonusMinutes } from "@/lib/hiderDeck";
import {
    addScoutedSpot,
    hiderForfeited,
    hiderHand,
    hidingSpot,
    hidingZone,
    roundFoundAt,
    roundLog,
    ZONE_GRACE_MS,
} from "@/lib/hiderRole";
import { endHidingPeriodEarly } from "@/lib/roundActions";
import { cn } from "@/lib/utils";

/**
 * Floating hider timer card — the hider's counterpart to the seeker's
 * `HiderTimer` (v633). Same Jet-Lag-show visual language and layout:
 *
 *   • hiding  — golden "HIDING TIME REMAINING" box, bottom-LEFT.
 *   • grace   — red urgent "PICK A ZONE" box, bottom-LEFT (pulses).
 *   • seeking / endgame — white "HIDDEN FOR" box with a red accent
 *     edge + the gold "time to beat" leaderboard row, bottom-RIGHT.
 *     (endgame swaps the eyebrow + accent to yellow for "stay still".)
 *   • forfeit — red "ROUND LOST" box, bottom-LEFT.
 *   • pre-game — muted "waiting on seeker" box, bottom-LEFT.
 *
 * The card positions ITSELF against the map edge (bottom-left while
 * hiding, bottom-right once seeking) so the map's nav controls can dodge
 * to the opposite corner — exactly like the seeker surface. The
 * hider-only "Mark spot" affordance (was in the old HiderTimeHeader row)
 * stacks ABOVE the card whenever the hider's GPS is inside their
 * committed zone.
 *
 * Replaces the old `HiderTimeHeader` flow-row so the hider map matches
 * the seeker map: brand header on top, a floating timer card on the map.
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

type HiderPhase =
    | "pre-game"
    | "hiding"
    | "grace"
    | "forfeit"
    | "seeking"
    | "endgame"
    | "over";

export function HiderMapTimer() {
    const $hidingEndsAt = useStore(hidingPeriodEndsAt);
    const $endgameStartedAt = useStore(endgameStartedAt);
    const $foundAt = useStore(roundFoundAt);
    const $hidingZone = useStore(hidingZone);
    const $hidingSpot = useStore(hidingSpot);
    const $forfeited = useStore(hiderForfeited);
    const $gps = useStore(lastKnownPosition);
    // In-hand time-bonus total the hider is holding — shown as an add-on to
    // the timer so they see the credit their held cards will add at round end
    // (v908).
    const $hand = useStore(hiderHand);
    const $gameSize = useStore(gameSize);
    const inHandBonusMin = tallyTimeBonusMinutes($hand, $gameSize);
    const $roundLog = useStore(roundLog);
    const $zoneCallout = useStore(zoneLockedCallout);

    const [markPopoverOpen, setMarkPopoverOpen] = useState(false);
    const [draftLabel, setDraftLabel] = useState("");
    const [pinningSpot, setPinningSpot] = useState(false);

    // v905: shared clock so the countdown FREEZES while the game is paused.
    const now = useNow($hidingEndsAt !== null && $foundAt === null);

    const inHidingPeriod = $hidingEndsAt !== null && now < $hidingEndsAt;
    const remainingMs = $hidingEndsAt ? Math.max(0, $hidingEndsAt - now) : 0;
    const graceEndsAt = $hidingEndsAt ? $hidingEndsAt + ZONE_GRACE_MS : null;
    const inGraceWindow =
        $hidingEndsAt !== null &&
        !inHidingPeriod &&
        $hidingZone === null &&
        graceEndsAt !== null &&
        now < graceEndsAt;
    const elapsedAnchor = $foundAt ?? now;
    const hiddenElapsedMs = $hidingEndsAt
        ? Math.max(0, elapsedAnchor - $hidingEndsAt)
        : 0;
    const roundOver = $foundAt !== null;

    // v879: the NEXT time to overtake — the smallest past-round time that is
    // still LONGER than the hider's current hidden time. Shown ABOVE the live
    // clock so the hider sees the target they're about to pass (not the
    // unreachable 1st-place time). Its rank = one better than the live time's.
    // Null once the hider is already leading (no time above them).
    const nextToBeat = useMemo(() => {
        const above = $roundLog
            .filter((r) => r.hidingMs > hiddenElapsedMs)
            .sort((a, b) => a.hidingMs - b.hidingMs)[0];
        if (!above) return null;
        const rank =
            [hiddenElapsedMs, ...$roundLog.map((r) => r.hidingMs)].filter(
                (t) => t > above.hidingMs,
            ).length + 1;
        return { hidingMs: above.hidingMs, name: above.hiderName, rank };
    }, [$roundLog, hiddenElapsedMs]);

    const insideZone =
        $hidingZone !== null &&
        $gps !== null &&
        metersBetween(
            $gps.lat,
            $gps.lng,
            $hidingZone.stationLat,
            $hidingZone.stationLng,
        ) <= $hidingZone.radiusMeters;

    const phase: HiderPhase = (() => {
        if (!$hidingEndsAt) return "pre-game";
        if ($forfeited) return "forfeit";
        if (roundOver) return "over";
        if (inHidingPeriod) return "hiding";
        if (inGraceWindow) return "grace";
        if ($hidingSpot) return "endgame";
        return "seeking";
    })();

    // Left while setting up / hiding (matches the seeker's yellow box);
    // right once seeking so it clears the follow-me/reset controls, which
    // dodge to the opposite corner.
    const anchorLeft =
        phase === "pre-game" ||
        phase === "hiding" ||
        phase === "grace" ||
        phase === "forfeit";

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

    return (
        <div
            className={cn(
                "absolute z-[1030] bottom-2 md:bottom-3",
                "flex flex-col gap-2",
                anchorLeft
                    ? "left-2 md:left-4 items-start"
                    : "right-2 md:right-4 items-end",
            )}
        >
            {/* Mark-spot — hider-only, stacks above the timer when the
                hider's GPS is inside their committed zone (seeking /
                endgame). */}
            {insideZone && !roundOver && (
                <Popover
                    open={markPopoverOpen}
                    onOpenChange={(o) => {
                        setMarkPopoverOpen(o);
                        if (!o) setDraftLabel("");
                    }}
                >
                    <PopoverTrigger asChild>
                        <button
                            type="button"
                            title="Mark potential hiding spot at your current location"
                            className={cn(
                                "flex items-center justify-center gap-1.5",
                                "px-2.5 py-1.5 rounded-md shadow-md",
                                "bg-primary text-primary-foreground border-2 border-primary",
                                "hover:bg-primary/90 active:bg-primary/80 transition-colors",
                                "text-[10px] font-poppins font-bold uppercase tracking-wider",
                                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            )}
                        >
                            <Plus className="w-3 h-3" strokeWidth={3} />
                            Mark spot
                        </button>
                    </PopoverTrigger>
                    <PopoverContent
                        align={anchorLeft ? "start" : "end"}
                        side="top"
                        className="w-[280px] p-3 bg-card border-2 border-border shadow-xl space-y-3"
                    >
                        <div className="space-y-1">
                            <div className="text-[10px] uppercase tracking-[0.16em] font-poppins font-bold text-muted-foreground">
                                Mark potential hiding spot
                            </div>
                            <p className="text-[11px] text-muted-foreground leading-snug">
                                Saves your current location with a short
                                description you can find later in the Zone
                                drawer.
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
                                <Plus className="w-3.5 h-3.5" strokeWidth={3} />
                                {pinningSpot ? "Locating…" : "Save here"}
                            </Button>
                        </div>
                    </PopoverContent>
                </Popover>
            )}

            {/* Zone-locked callout (v798) — replaces the old second modal.
                Appears ABOVE the timer after committing a zone, pointing down
                at it, with the same end-early / keep-running choice living
                where the timer + end action are. Auto-hides once hiding ends
                (phase gate); "Keep timer running" dismisses it. */}
            {phase === "hiding" &&
                $hidingZone !== null &&
                $zoneCallout && (
                    <div className="relative w-[min(80vw,20rem)] rounded-xl border-2 border-border bg-card p-3 shadow-xl">
                        <div className="mb-1">
                            <span className="text-[11px] font-poppins font-extrabold uppercase tracking-[0.12em] text-foreground">
                                Zone locked in
                            </span>
                        </div>
                        <p className="mb-2.5 text-[12px] leading-snug text-muted-foreground">
                            <span className="font-semibold text-foreground">
                                {$hidingZone.stationName}
                            </span>{" "}
                            is set. You can let the seekers know, or keep the
                            timer running to give yourself more time.
                        </p>
                        <div className="flex items-stretch gap-2">
                            <Button
                                type="button"
                                size="sm"
                                onClick={() => {
                                    zoneLockedCallout.set(false);
                                    endHidingPeriodEarly();
                                }}
                                className="flex-1 gap-1.5"
                            >
                                <Flag className="h-3.5 w-3.5" strokeWidth={2.5} />
                                End timer
                            </Button>
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => zoneLockedCallout.set(false)}
                                className="flex-1 gap-1.5"
                            >
                                <X className="h-3.5 w-3.5" strokeWidth={2.5} />
                                Keep timer
                            </Button>
                        </div>
                        {/* Downward caret pointing at the timer below. */}
                        <span
                            className={cn(
                                "absolute -bottom-1.5 h-3 w-3 rotate-45 border-b-2 border-r-2 border-border bg-card",
                                anchorLeft ? "left-6" : "right-6",
                            )}
                            aria-hidden="true"
                        />
                    </div>
                )}

            {/* pre-game — muted placeholder box. */}
            {phase === "pre-game" && (
                <div className="flex items-center gap-3 rounded-xl pl-3 pr-5 py-2 shadow-lg bg-card border-2 border-border">
                    <Timer
                        className="w-7 h-7 shrink-0 text-muted-foreground"
                        strokeWidth={2.5}
                    />
                    <div className="flex flex-col leading-none gap-1">
                        <span className="text-[10px] font-poppins font-extrabold uppercase tracking-[0.12em] text-muted-foreground">
                            Waiting on seeker
                        </span>
                        <span className="text-sm text-foreground leading-tight">
                            Timer starts on setup
                        </span>
                    </div>
                </div>
            )}

            {/* hiding — golden "HIDING TIME REMAINING" box (seeker parity). */}
            {phase === "hiding" && (
                <div
                    role="status"
                    aria-live="polite"
                    aria-label={`Hiding time remaining: ${formatTimeRemaining(remainingMs)}`}
                    className="flex items-center gap-3 rounded-xl pl-3 pr-5 py-2 shadow-lg bg-[#F2C63C]"
                >
                    <Timer
                        className="w-8 h-8 shrink-0 text-[#1F2F3F]"
                        strokeWidth={2.5}
                    />
                    <div className="flex flex-col leading-none gap-1">
                        <span className="text-[10px] font-poppins font-extrabold uppercase tracking-[0.12em] text-[#1F2F3F]">
                            Hiding time remaining
                        </span>
                        <span className="font-inter-tight font-black tabular-nums text-3xl leading-none text-[#1F2F3F]">
                            {formatTimeRemaining(remainingMs)}
                            {inHandBonusMin > 0 && (
                                <span
                                    className="ml-1.5 inline-flex items-center gap-0.5 rounded-full bg-[#1F2F3F]/15 px-1.5 py-0.5 text-[10px] font-poppins font-bold text-[#1F2F3F] align-middle"
                                    title={`+${inHandBonusMin} min from time-bonus cards in your hand`}
                                >
                                    <Hourglass className="w-2.5 h-2.5" />+
                                    {inHandBonusMin}m
                                </span>
                            )}
                        </span>
                    </div>
                </div>
            )}

            {/* v803: the navy on-map "End hiding early" button was removed —
                the end-timer action lives in the Zone drawer (below the timer)
                and in the just-committed callout above, so a third copy on the
                map was redundant. */}

            {/* grace — the "pick a zone" prompt moved to a BIG top-of-map card
                (v879, `HiderGracePrompt`) that also lists the closest zone, so
                the small corner box here was removed. */}

            {/* forfeit — red "ROUND LOST" stamp. */}
            {phase === "forfeit" && (
                <div className="flex items-center gap-3 rounded-xl pl-3 pr-5 py-2 shadow-lg bg-destructive">
                    <Ban
                        className="w-7 h-7 shrink-0 text-destructive-foreground"
                        strokeWidth={2.5}
                    />
                    <div className="flex flex-col leading-none gap-1">
                        <span className="text-[10px] font-poppins font-extrabold uppercase tracking-[0.12em] text-destructive-foreground">
                            Forfeited
                        </span>
                        <span className="font-inter-tight font-black uppercase text-xl leading-none text-destructive-foreground">
                            Round lost
                        </span>
                    </div>
                </div>
            )}

            {/* seeking / endgame / over — the NEXT time to overtake sits
                ABOVE the white "HIDDEN FOR" box (v879): a leaderboard row
                (rank + hider name + time) for the nearest longer past hide,
                so the hider sees the target they're about to pass rather than
                the unreachable 1st-place time. Drops out once they lead. */}
            {(phase === "seeking" ||
                phase === "endgame" ||
                phase === "over") && (
                <>
                    {nextToBeat !== null && phase !== "over" && (
                        <div
                            className="flex items-stretch rounded-xl overflow-hidden shadow-lg"
                            title={`Next to beat: ${nextToBeat.name} — ${formatTimeRemaining(nextToBeat.hidingMs)}`}
                        >
                            <div
                                className="flex items-center px-2.5"
                                style={{
                                    background:
                                        nextToBeat.rank === 1
                                            ? "#F2C63C"
                                            : nextToBeat.rank === 2
                                              ? "#B8BDC7"
                                              : nextToBeat.rank === 3
                                                ? "#CF8B4B"
                                                : "#9AA1AD",
                                }}
                            >
                                <span
                                    className={cn(
                                        "font-inter-tight font-black text-sm leading-none",
                                        nextToBeat.rank === 3
                                            ? "text-white"
                                            : "text-[#1F2F3F]",
                                    )}
                                >
                                    {nextToBeat.rank}
                                    <span className="text-[9px] align-super">
                                        {nextToBeat.rank === 1
                                            ? "st"
                                            : nextToBeat.rank === 2
                                              ? "nd"
                                              : nextToBeat.rank === 3
                                                ? "rd"
                                                : "th"}
                                    </span>
                                </span>
                            </div>
                            <div
                                className="flex flex-col justify-center px-3 py-1.5 leading-none"
                                style={{
                                    background:
                                        nextToBeat.rank === 1
                                            ? "#F2C63C"
                                            : nextToBeat.rank === 2
                                              ? "#D6DAE1"
                                              : nextToBeat.rank === 3
                                                ? "#E4B98D"
                                                : "#E6E8EC",
                                }}
                            >
                                <span className="block max-w-[9rem] truncate text-[9px] font-poppins font-extrabold uppercase tracking-[0.12em] text-[#1F2F3F]/60 leading-none mb-0.5">
                                    {nextToBeat.name}
                                </span>
                                <span className="font-inter-tight font-black tabular-nums text-lg leading-none text-[#1F2F3F]">
                                    {formatTimeRemaining(nextToBeat.hidingMs)}
                                </span>
                            </div>
                        </div>
                    )}
                    <div
                        role="status"
                        aria-live="polite"
                        aria-label={`Hidden for: ${formatTimeRemaining(hiddenElapsedMs)}`}
                        className="relative overflow-hidden rounded-xl shadow-lg bg-white pl-4 pr-7 py-2"
                    >
                        <span className="block text-[9px] font-poppins font-extrabold uppercase tracking-[0.14em] text-[#1F2F3F]/55 leading-none mb-0.5">
                            {phase === "endgame"
                                ? "Endgame · stay still"
                                : phase === "over"
                                  ? "Round over"
                                  : "Hidden for"}
                        </span>
                        <span
                            className={cn(
                                "font-inter-tight font-black tabular-nums text-3xl leading-none",
                                phase === "endgame"
                                    ? "text-[#B8860B]"
                                    : "text-jetlag",
                            )}
                        >
                            {formatTimeRemaining(hiddenElapsedMs)}
                        </span>
                        {inHandBonusMin > 0 && (
                            <span
                                className="ml-1.5 inline-flex items-center gap-0.5 rounded-full bg-[hsl(var(--accent-yellow))]/25 px-1.5 py-0.5 text-[10px] font-poppins font-bold text-[#8a6d0b] align-middle"
                                title={`+${inHandBonusMin} min from time-bonus cards in your hand`}
                            >
                                <Hourglass className="w-2.5 h-2.5" />+
                                {inHandBonusMin}m
                            </span>
                        )}
                        <span
                            className={cn(
                                "absolute inset-y-0 right-0 w-2.5",
                                phase === "endgame"
                                    ? "bg-[#F2C63C]"
                                    : "bg-primary",
                            )}
                            aria-hidden
                        />
                    </div>
                </>
            )}
        </div>
    );
}

export default HiderMapTimer;
