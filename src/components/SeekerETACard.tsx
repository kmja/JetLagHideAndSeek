import { useStore } from "@nanostores/react";
import { Loader2, Radar } from "lucide-react";

import { useNow } from "@/hooks/useNow";
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
    // v905: shared clock — freezes while the game is paused.
    const now = useNow($eta != null);

    const arrivalAt = $eta?.arrivalAt ?? null;
    const minutesAway =
        arrivalAt != null ? Math.round((arrivalAt - now) / 60_000) : null;

    // v799: ONLY show this section when we actually have a computed arrival
    // time. No seeker sharing yet, still estimating, or "couldn't estimate"
    // (no transit route) → render nothing rather than an empty/negative
    // slot — the hider only wants the ETA when there's a real number.
    if (minutesAway == null) return null;

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
                <div className="mt-0.5 text-sm font-inter-tight font-bold">
                    {minutesAway < 0 ? (
                        <>They could already be there.</>
                    ) : minutesAway === 0 ? (
                        <>Any minute now.</>
                    ) : (
                        <>~{minutesAway} min away</>
                    )}
                </div>
            </div>
        </div>
    );
}

export default SeekerETACard;
