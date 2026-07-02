import { useStore } from "@nanostores/react";
import { Loader2, Radar } from "lucide-react";
import { useState } from "react";

import { useVisibleInterval } from "@/hooks/useVisibleInterval";
import { seekerEta, seekerEtaTone } from "@/lib/journey/state";
import { cn } from "@/lib/utils";

/**
 * "How close are the seekers?" — the hider's awareness card for the
 * seeking phase.
 *
 * v634: a pure renderer of the `seekerEta` atom. The fetch + OS-alert
 * logic moved to `SeekerProximityWatcher` (always mounted during
 * seeking), so the estimate stays live and notifies on closer-transitions
 * even when this card isn't on screen (the Zone drawer is closed).
 *
 * States:
 *   - atom null / no fresh seeker broadcast → quiet placeholder.
 *   - estimating / no route → honest sub-states.
 *   - reachable → "~N min away", colour-banded by closeness.
 */
export function SeekerETACard() {
    const $eta = useStore(seekerEta);

    // Local 1 Hz tick so "~N min away" and the colour band re-evaluate as
    // the clock ticks toward the (fixed) arrival timestamp.
    const [now, setNow] = useState(() => Date.now());
    useVisibleInterval(() => setNow(Date.now()), 1000, $eta != null);

    // No committed zone / not seeking, OR no live seeker location yet:
    // render a quiet placeholder so the ETA slot is visible during seeking
    // rather than silently absent (it fills in the moment a seeker shares).
    if (!$eta || !$eta.hasSeeker) {
        return (
            <div
                className="rounded-md border border-border bg-secondary/40 px-3 py-2 flex items-start gap-2.5"
                aria-live="polite"
            >
                <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-sm bg-background/60">
                    <Radar className="h-3.5 w-3.5 text-muted-foreground" />
                </span>
                <div className="min-w-0 flex-1 leading-tight">
                    <div className="text-[10px] font-poppins font-bold uppercase tracking-[0.14em] text-muted-foreground">
                        Seekers' ETA to your station
                    </div>
                    <div className="mt-0.5 text-xs italic text-muted-foreground">
                        Waiting for a seeker to share their location…
                    </div>
                </div>
            </div>
        );
    }

    const { arrivalAt, loading } = $eta;
    const minutesAway =
        arrivalAt != null ? Math.round((arrivalAt - now) / 60_000) : null;
    const tone = seekerEtaTone(arrivalAt, now);

    return (
        <div
            className={cn(
                "rounded-md border px-3 py-2 flex items-start gap-2.5",
                tone === "comfortable" && "border-success/40 bg-success/10",
                tone === "heads-up" &&
                    "border-yellow-500/40 bg-yellow-500/10",
                tone === "imminent" &&
                    "border-orange-500/50 bg-orange-500/10",
                tone === "arrived" &&
                    "border-destructive/50 bg-destructive/10",
                tone === "unknown" && "border-border bg-secondary/40",
            )}
            aria-live="polite"
        >
            <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-sm bg-background/60">
                <Radar className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0 flex-1 leading-tight">
                <div className="text-[10px] font-poppins font-bold uppercase tracking-[0.14em] text-muted-foreground">
                    Seekers' ETA to your station
                </div>
                {loading && arrivalAt == null && (
                    <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground italic">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        Estimating…
                    </div>
                )}
                {!loading && minutesAway == null && (
                    <div className="mt-0.5 text-xs italic text-muted-foreground">
                        No transit route — couldn't estimate.
                    </div>
                )}
                {minutesAway != null && (
                    <div className="mt-0.5 text-sm font-inter-tight font-bold">
                        {minutesAway < 0 ? (
                            <>They could already be there.</>
                        ) : minutesAway === 0 ? (
                            <>Any minute now.</>
                        ) : (
                            <>~{minutesAway} min away</>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

export default SeekerETACard;
