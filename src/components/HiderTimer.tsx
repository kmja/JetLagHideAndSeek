import { useStore } from "@nanostores/react";
import { Flag, Timer } from "lucide-react";
import { useState } from "react";

import { useVisibleInterval } from "@/hooks/useVisibleInterval";
import {
    formatTimeRemaining,
    gameSize,
    HIDING_PERIOD_MINUTES,
    hidingPeriodEndsAt,
    setupCompleted,
} from "@/lib/gameSetup";
import { cn } from "@/lib/utils";

/**
 * Always-visible hider timer for seekers (top-left, above the map).
 *
 * Two phases derived from `hidingPeriodEndsAt`:
 *
 *   - **Hiding period** (now < hidingPeriodEndsAt): MM:SS countdown.
 *     The hider is en route to their hiding zone; seekers can't ask
 *     questions yet. An "End hiding period · Start seeking" button
 *     appears right below the badge so the seeker can short-circuit
 *     the wait once the hider signals they're settled — same action
 *     as the Settings drawer's button, just one tap away.
 *
 *   - **Hidden so far** (now >= hidingPeriodEndsAt): elapsed time the
 *     hider has been "seekable but uncaught" — this is the round's
 *     score in the making. Counts in primary red, with seconds. No
 *     action button in this phase; closing the round is the seeker's
 *     "Mark hider found" button in the Settings drawer.
 *
 * The badge itself is read-only — the only interactive control is the
 * conditional end-hiding button.
 */
export function HiderTimer() {
    const $endsAt = useStore(hidingPeriodEndsAt);
    const $setupCompleted = useStore(setupCompleted);
    const $gameSize = useStore(gameSize);

    // Tick every second whenever the timer is meaningful, but
    // pause while the tab is hidden so the CPU isn't woken on
    // locked phones.
    const [now, setNow] = useState(() => Date.now());
    useVisibleInterval(
        () => setNow(Date.now()),
        1000,
        Boolean($endsAt && $setupCompleted),
    );

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

    const handleEndHidingPeriod = () => {
        // Snap the end-timestamp to now instead of clearing it — the
        // HiderTimer uses `hidingPeriodEndsAt` as the *anchor* for the
        // elapsed counter once we transition to the seeking phase,
        // and the BottomNav timer + scoring math both expect it to
        // remain set. Guarded: if it's somehow already in the past,
        // do nothing so we don't reset the elapsed anchor.
        const existing = hidingPeriodEndsAt.get();
        if (existing !== null && existing <= Date.now()) return;
        hidingPeriodEndsAt.set(Date.now());
    };

    return (
        <div className="flex flex-col items-start gap-1.5">
            <div
                role="status"
                aria-live="polite"
                aria-label={`${phaseLabel}: ${display}`}
                title={`${phaseLabel}: ${display}`}
                className={cn(
                    "flex items-center gap-2 px-3 py-1.5 rounded-md",
                    "bg-background/95 backdrop-blur-md border-2 border-primary",
                    "shadow-md",
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
            </div>

            {inHidingPeriod && (
                <button
                    type="button"
                    onClick={handleEndHidingPeriod}
                    title="End the hiding period and start the seeking phase"
                    className={cn(
                        "flex items-center justify-center gap-1.5 w-full",
                        "px-2.5 py-1.5 rounded-md",
                        "bg-primary text-primary-foreground",
                        "hover:bg-primary/90 active:bg-primary/80",
                        "border-2 border-primary shadow-md",
                        "transition-colors",
                        "text-[10px] font-poppins font-bold uppercase tracking-wider",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    )}
                >
                    <Flag className="w-3 h-3" strokeWidth={2.5} />
                    End hiding · Start seeking
                </button>
            )}
        </div>
    );
}

export default HiderTimer;
