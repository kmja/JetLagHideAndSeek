import { useStore } from "@nanostores/react";
import { ChevronDown, Tent } from "lucide-react";
import { useState } from "react";

import { hidingZone } from "@/lib/context";
import { gameSize } from "@/lib/gameSetup";
import { confirmAndCommitZone } from "@/lib/hiderZoneCommit";
import { radiusForGameSize } from "@/lib/hiderRole";
import { useNow } from "@/hooks/useNow";
import { hidingPeriodEndsAt } from "@/lib/gameSetup";
import { cn } from "@/lib/utils";

import { NearbyStationsPicker, type FoundStation } from "./NearbyStationsPicker";

/**
 * On-map nudge toward committing a hiding zone (v1132) — the hider's
 * counterpart to the seeker's on-map cards. Shown at the top of
 * `HiderBackgroundMap` during the HIDING PERIOD while no zone is committed:
 *
 *   • collapsed = a "SELECT HIDING ZONE" header (the nudge), tap to expand;
 *   • expanded  = the SAME station picker the Zone drawer uses
 *     (`NearbyStationsPicker`), so the hider can commit a zone straight from
 *     the map without opening the drawer.
 *
 * Committing (or the hiding period ending) hides it — the grace-period
 * `HiderGracePrompt` owns the after-the-whistle case, so the two never
 * overlap in the top-of-map slot. (v946 removed the old on-map hint in
 * favour of the bottom-nav "Select zone" slot; this brings the on-map
 * affordance back as an expandable card, per the user's request.)
 */
export function HiderZoneNudge() {
    const $endsAt = useStore(hidingPeriodEndsAt);
    const $zone = useStore(hidingZone);
    const $gameSize = useStore(gameSize);
    const [expanded, setExpanded] = useState(false);

    // Freezes while paused, like every other timer.
    const now = useNow($endsAt !== null && $zone === null);
    // Only during the hiding period, before a zone is committed. After the
    // whistle the grace prompt takes over the same slot.
    const show = $endsAt !== null && $zone === null && now < $endsAt;
    if (!show) return null;

    const radiusMeters = radiusForGameSize($gameSize);

    return (
        <div
            className={cn(
                "fixed left-1/2 -translate-x-1/2 z-[1035]",
                "top-[calc(env(safe-area-inset-top)+4.25rem)]",
                "w-[min(94vw,26rem)] pointer-events-auto",
                "rounded-2xl border shadow-2xl overflow-hidden",
                "bg-[hsl(var(--sidebar-background))] text-[hsl(var(--sidebar-foreground))]",
                "border-[color:var(--overlay-card-border)]",
                "animate-in fade-in slide-in-from-top-2 duration-300",
            )}
        >
            <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                aria-expanded={expanded}
                className={cn(
                    "w-full flex items-center gap-3 px-4 py-3 text-left",
                    "active:scale-[0.99] transition-transform",
                )}
            >
                <span
                    className="h-11 w-11 shrink-0 flex items-center justify-center rounded-xl text-white bg-jetlag-red"
                    aria-hidden="true"
                >
                    <Tent className="h-6 w-6" strokeWidth={2.5} />
                </span>
                <span className="min-w-0 flex-1 flex flex-col leading-tight">
                    <span className="text-[11px] font-poppins font-bold uppercase tracking-[0.14em] text-muted-foreground">
                        Hiding time
                    </span>
                    <span className="font-display font-extrabold uppercase text-lg leading-none truncate">
                        Select hiding zone
                    </span>
                    {!expanded && (
                        <span className="text-xs text-muted-foreground truncate mt-0.5">
                            Tap to pick the station you're hiding near.
                        </span>
                    )}
                </span>
                <ChevronDown
                    className={cn(
                        "w-5 h-5 shrink-0 text-muted-foreground transition-transform",
                        expanded && "rotate-180",
                    )}
                    aria-hidden="true"
                />
            </button>
            {expanded && (
                <div className="max-h-[58vh] overflow-y-auto px-3 pb-3">
                    <NearbyStationsPicker
                        onPick={(s: FoundStation) => {
                            void confirmAndCommitZone(
                                { ...s, modes: [s.mode] },
                                radiusMeters,
                            ).then((committed) => {
                                if (committed) setExpanded(false);
                            });
                        }}
                    />
                </div>
            )}
        </div>
    );
}

export default HiderZoneNudge;
