import { useStore } from "@nanostores/react";
import { Flag, Footprints, Timer } from "lucide-react";
import { useState } from "react";
import { toast } from "react-toastify";

import { useVisibleInterval } from "@/hooks/useVisibleInterval";
import { shareFoundLink } from "@/lib/foundShare";
import {
    endgameStartedAt,
    formatTimeRemaining,
    hidingPeriodEndsAt,
    setupCompleted,
} from "@/lib/gameSetup";
import { roundFoundAt } from "@/lib/hiderRole";
import { seekerMarkFound, seekerStartEndgame } from "@/lib/multiplayer/store";
import { cn } from "@/lib/utils";

/**
 * Always-visible hider timer for seekers (top-left, above the map).
 *
 * Two phases derived from `hidingPeriodEndsAt`:
 *
 *   - **Hiding period** (now < hidingPeriodEndsAt): MM:SS countdown.
 *     The hider is en route to their hiding zone; seekers can't ask
 *     questions yet. Display-only — only the hider can end the
 *     hiding period early (from their own HiderHome; the debug panel
 *     keeps it for testing).
 *
 *   - **Hidden so far** (now >= hidingPeriodEndsAt): elapsed time the
 *     hider has been "seekable but uncaught" — this is the round's
 *     score in the making. Counts in primary red, with seconds.
 */
export function HiderTimer() {
    const $endsAt = useStore(hidingPeriodEndsAt);
    const $setupCompleted = useStore(setupCompleted);
    const $endgameStartedAt = useStore(endgameStartedAt);
    const $foundAt = useStore(roundFoundAt);

    const handleTriggerEndgame = () => {
        if (
            !confirm(
                "Trigger endgame? The hider sees a banner asking them to lock down to a final spot. Only do this when you're closing in.",
            )
        ) {
            return;
        }
        seekerStartEndgame();
        toast.success("Endgame triggered — hider notified.", {
            autoClose: 2500,
        });
    };

    const handleMarkFound = () => {
        const ts = Date.now();
        roundFoundAt.set(ts);
        // Mirror through multiplayer; no-op when offline.
        seekerMarkFound(ts);
        void shareFoundLink(ts);
    };

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
                    </span>
                </div>
            </div>

            {/* Round-end action surface. Three exclusive states once
                the hiding period is over (and only then — seekers
                can't trigger the endgame or mark the hider found
                while the hider is still en route):
                  1. Endgame not armed yet → "Trigger endgame" button
                     (the rulebook step before the physical find).
                  2. Endgame armed, not found yet → "Endgame armed"
                     badge + "Mark hider found" button.
                  3. Already found → render nothing; the FoundSummary
                     recap card lives in the Settings sheet.
                Moved here from BottomNav's settings sheet so the
                seeker doesn't have to dig through Settings during the
                most time-sensitive moment of the game. */}
            {!inHidingPeriod && !$foundAt && (
                <>
                    {$endgameStartedAt === null ? (
                        <button
                            type="button"
                            onClick={handleTriggerEndgame}
                            title="Trigger endgame — tell the hider to lock to a final spot"
                            className={cn(
                                "flex items-center justify-center gap-1.5 w-full",
                                "px-2.5 py-1.5 rounded-md",
                                "bg-yellow-500/15 border-2 border-yellow-500/60",
                                "text-yellow-300 hover:bg-yellow-500/25 active:bg-yellow-500/30",
                                "transition-colors shadow-md",
                                "text-[10px] font-poppins font-bold uppercase tracking-wider",
                                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            )}
                        >
                            <Flag className="w-3 h-3" strokeWidth={2.5} />
                            Trigger endgame
                        </button>
                    ) : (
                        <>
                            <div
                                className={cn(
                                    "flex items-center gap-1.5",
                                    "px-2 py-1 rounded-md",
                                    "bg-yellow-500/15 border-2 border-yellow-500/70",
                                    "text-yellow-300",
                                )}
                                title="Endgame triggered — the hider has been told to lock to a final spot."
                            >
                                <Flag className="w-3 h-3" strokeWidth={2.5} />
                                <span className="text-[9px] font-poppins font-bold uppercase tracking-[0.15em]">
                                    Endgame armed
                                </span>
                            </div>
                            <button
                                type="button"
                                onClick={handleMarkFound}
                                title="Mark hider found — freeze the score and share the round-end link"
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
                                <Footprints className="w-3 h-3" strokeWidth={2.5} />
                                Mark hider found
                            </button>
                        </>
                    )}
                </>
            )}
        </div>
    );
}

export default HiderTimer;
