import { useStore } from "@nanostores/react";
import { Timer } from "lucide-react";
import { useEffect, useState } from "react";

import {
    formatTimeRemaining,
    gameSize,
    hidingPeriodEndsAt,
    HIDING_PERIOD_MINUTES,
    setupCompleted,
    setupDialogOpen,
} from "@/lib/gameSetup";
import { cn } from "@/lib/utils";

/**
 * Always-visible hider timer for seekers (top-left, above the map).
 *
 * Two phases derived from `hidingPeriodEndsAt`:
 *
 *   - **Hiding period** (now < hidingPeriodEndsAt): MM:SS countdown.
 *     The hider is en route to their hiding zone; seekers can't ask
 *     questions yet. Counts in red.
 *
 *   - **Hidden so far** (now >= hidingPeriodEndsAt): elapsed time the
 *     hider has been "seekable but uncaught" — this is the round's
 *     score in the making. Counts in primary red, with seconds. The
 *     rulebook (p7) says the timer freezes when the hider is found
 *     (within 2 m + spotted); we don't have a found-button yet, so
 *     the timer keeps ticking until the seeker manually starts a new
 *     game or ends the hiding period via the Settings drawer.
 *
 * Tapping the badge opens the game-settings drawer (same target as
 * the Settings bottom-nav button). Hidden entirely until setup is
 * complete and a hiding-period end time exists.
 */
export function HiderTimer() {
    const $endsAt = useStore(hidingPeriodEndsAt);
    const $setupCompleted = useStore(setupCompleted);
    const $gameSize = useStore(gameSize);

    // Tick every second whenever the timer is meaningful. Cheap enough
    // since the only side effect is a `setNow` that re-renders this
    // small component.
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!$endsAt || !$setupCompleted) return;
        const id = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(id);
    }, [$endsAt, $setupCompleted]);

    if (!$setupCompleted || !$endsAt) return null;

    const inHidingPeriod = now < $endsAt;
    const phaseLabel = inHidingPeriod ? "Hiding period" : "Hidden for";

    let display: string;
    if (inHidingPeriod) {
        display = formatTimeRemaining($endsAt - now);
    } else {
        // Elapsed since hiding period ended.
        const elapsedMs = now - $endsAt;
        const total = Math.floor(elapsedMs / 1000);
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        const pad = (n: number) => String(n).padStart(2, "0");
        display = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
    }

    // Round duration label (for context — "of 60 min" while counting down).
    const totalMinutes = HIDING_PERIOD_MINUTES[$gameSize];

    return (
        <button
            type="button"
            onClick={() => setupDialogOpen.set(true)}
            aria-label={`${phaseLabel}: ${display}. Tap to open game settings.`}
            title={`${phaseLabel}: ${display}`}
            className={cn(
                "flex items-center gap-2 px-3 py-1.5 rounded-md",
                "bg-background/95 backdrop-blur-md border-2 border-primary",
                "shadow-md hover:bg-accent transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            )}
        >
            <Timer className="w-4 h-4 text-primary shrink-0" />
            <div className="flex flex-col items-start leading-none gap-0.5">
                <span className="text-[9px] font-inter-tight font-bold uppercase tracking-[0.15em] text-muted-foreground">
                    {phaseLabel}
                </span>
                <span className="font-inter-tight italic font-black tabular-nums text-base text-primary leading-none">
                    {display}
                    {inHidingPeriod && (
                        <span className="ml-1 text-[9px] not-italic font-bold tracking-wider text-muted-foreground">
                            / {totalMinutes}m
                        </span>
                    )}
                </span>
            </div>
        </button>
    );
}

export default HiderTimer;
