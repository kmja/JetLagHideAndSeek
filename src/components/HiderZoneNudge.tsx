import { useStore } from "@nanostores/react";
import { Footprints, Tent } from "lucide-react";

import { useNow } from "@/hooks/useNow";
import { hidingZone } from "@/lib/context";
import { gameSize, hidingPeriodEndsAt } from "@/lib/gameSetup";
import { confirmAndCommitZone } from "@/lib/hiderZoneCommit";
import { radiusForGameSize } from "@/lib/hiderRole";
import { hiderInZones } from "@/lib/journey/state";
import { cn } from "@/lib/utils";

/**
 * Compact "hide here" nudge that sits next to the hiding-period timer
 * (`HiderMapTimer` renders it at the top of its stack). It reflects the zones
 * the hider is CURRENTLY STANDING IN (`hiderInZones`, from `HiderInZoneWatcher`),
 * which are ALSO subtly highlighted on the map:
 *
 *   • standing in ≥1 zone → a gold pill naming the nearest one; tapping it
 *     commits that zone (via the shared lock-in confirm), so the hider can hide
 *     right where they are in one tap;
 *   • standing in none → a muted prompt to walk to a transit station.
 *
 * Shown only during the hiding period before a zone is committed. (v1177 —
 * replaced the old big top-of-map card + inline station picker with this
 * subtle, timer-adjacent nudge + the on-map highlight.)
 */
export function HiderZoneNudge() {
    const $endsAt = useStore(hidingPeriodEndsAt);
    const $zone = useStore(hidingZone);
    const $gameSize = useStore(gameSize);
    const $inZones = useStore(hiderInZones);

    // Freezes while paused, like every other timer.
    const now = useNow($endsAt !== null && $zone === null);
    const show = $endsAt !== null && $zone === null && now < $endsAt;
    if (!show) return null;

    const radiusMeters = radiusForGameSize($gameSize);
    const nearest = $inZones[0];

    if (!nearest) {
        return (
            <div
                className={cn(
                    "flex items-center gap-2 rounded-lg px-3 py-2 shadow-md",
                    "bg-card/95 border border-border backdrop-blur-sm",
                    "max-w-[min(80vw,20rem)]",
                )}
            >
                <Footprints
                    className="h-4 w-4 shrink-0 text-muted-foreground"
                    strokeWidth={2.25}
                />
                <span className="text-xs leading-snug text-muted-foreground">
                    Walk to a transit station to start hiding.
                </span>
            </div>
        );
    }

    const more = $inZones.length - 1;
    return (
        <button
            type="button"
            onClick={() =>
                void confirmAndCommitZone(
                    {
                        name: nearest.name,
                        lat: nearest.lat,
                        lng: nearest.lng,
                        modes: nearest.modes,
                    },
                    radiusMeters,
                )
            }
            className={cn(
                "group flex items-center gap-2.5 rounded-lg pl-2.5 pr-3 py-2 shadow-md",
                "bg-[#F2C63C] text-[#1F2F3F]",
                "active:scale-[0.98] transition-transform",
                "max-w-[min(82vw,21rem)]",
            )}
            aria-label={`Hide at ${nearest.name}`}
        >
            <span
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[#1F2F3F]/12"
                aria-hidden="true"
            >
                <Tent className="h-4 w-4 text-[#1F2F3F]" strokeWidth={2.5} />
            </span>
            <span className="min-w-0 flex-1 flex flex-col text-left leading-tight">
                <span className="text-[9px] font-poppins font-bold uppercase tracking-[0.14em] text-[#1F2F3F]/65">
                    You&apos;re in a hiding zone{more > 0 ? ` · +${more}` : ""}
                </span>
                <span className="truncate text-sm font-semibold">
                    {nearest.name}
                </span>
            </span>
            <span className="shrink-0 rounded-md bg-[#1F2F3F] px-2 py-1 text-[10px] font-poppins font-bold uppercase tracking-wider text-white">
                Hide here
            </span>
        </button>
    );
}

export default HiderZoneNudge;
