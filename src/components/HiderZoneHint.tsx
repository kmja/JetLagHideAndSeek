import { useStore } from "@nanostores/react";
import { convertLength } from "@turf/turf";
import { ChevronDown, Tent } from "lucide-react";
import { useState } from "react";

import {
    NearbyStationsPicker,
    type FoundStation,
} from "@/components/NearbyStationsPicker";
import { hidingRadius, hidingRadiusUnits } from "@/lib/context";
import { hidingPeriodEndsAt } from "@/lib/gameSetup";
import { hidingZone } from "@/lib/hiderRole";
import { confirmAndCommitZone } from "@/lib/hiderZoneCommit";
import { useVisibleInterval } from "@/hooks/useVisibleInterval";
import { cn } from "@/lib/utils";

/**
 * On-map hint for the hider during the hiding period (v787): a top-of-map
 * overlay that MIRRORS the Zone drawer's picker — "the zones you're in" +
 * a Select button each — so the hider doesn't have to open the drawer to see
 * and commit a zone. Shown only while the hiding period is running AND no zone
 * is committed yet (once committed there's nothing to pick); collapsible so it
 * never blocks the map. Selecting runs the SAME confirm-and-commit flow as the
 * drawer (`confirmAndCommitZone`), so the two can't drift.
 *
 * Mounted inside `HiderBackgroundMap` so `absolute top-…` positions it over the
 * map. The map behind stays interactive (tap a zone directly still works).
 */
export function HiderZoneHint() {
    const $endsAt = useStore(hidingPeriodEndsAt);
    const $zone = useStore(hidingZone);
    const $radius = useStore(hidingRadius);
    const $units = useStore(hidingRadiusUnits);
    const [collapsed, setCollapsed] = useState(false);
    const [now, setNow] = useState(() => Date.now());
    useVisibleInterval(() => setNow(Date.now()), 1000, $endsAt !== null);

    const radiusMeters = Math.round(
        convertLength($radius, $units, "meters"),
    );

    // Only during the hiding period, and only until a zone is committed.
    if ($endsAt === null || now >= $endsAt || $zone !== null) return null;

    return (
        <div className="absolute top-3 left-1/2 z-[500] w-[min(94vw,26rem)] -translate-x-1/2 px-2">
            <div className="overflow-hidden rounded-xl border bg-background/95 shadow-lg backdrop-blur">
                <button
                    type="button"
                    onClick={() => setCollapsed((c) => !c)}
                    aria-expanded={!collapsed}
                    className="flex w-full items-center gap-3 px-4 py-3.5 text-left"
                >
                    <Tent className="h-6 w-6 shrink-0 text-primary" />
                    <span className="flex-1 text-lg font-bold leading-tight tracking-tight">
                        Select a station to hide near
                    </span>
                    <ChevronDown
                        className={cn(
                            "h-5 w-5 shrink-0 text-muted-foreground transition-transform",
                            collapsed && "-rotate-90",
                        )}
                    />
                </button>
                {!collapsed && (
                    <div className="max-h-[45vh] overflow-y-auto px-2 pb-2">
                        <NearbyStationsPicker
                            onPick={(s: FoundStation) =>
                                void confirmAndCommitZone(s, radiusMeters)
                            }
                        />
                    </div>
                )}
            </div>
        </div>
    );
}

export default HiderZoneHint;
