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
import { useNow } from "@/hooks/useNow";
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
    // v905: shared clock — freezes while the game is paused.
    const now = useNow($endsAt !== null);

    const radiusMeters = Math.round(
        convertLength($radius, $units, "meters"),
    );

    // Only during the hiding period, and only until a zone is committed.
    if ($endsAt === null || now >= $endsAt || $zone !== null) return null;

    return (
        <div className="absolute top-3 left-1/2 z-[500] w-[min(94vw,26rem)] -translate-x-1/2 px-2">
            <div className="overflow-hidden rounded-xl border bg-background/95 shadow-xl backdrop-blur">
                {/* Header styled like the app's on-map overlay cards
                    (`QuestionOverlayCard`): a solid brand-colour icon BLOCK on
                    the left + a bold uppercase label — so it reads as part of
                    the same overlay system, not a stray notification pill. */}
                <button
                    type="button"
                    onClick={() => setCollapsed((c) => !c)}
                    aria-expanded={!collapsed}
                    className="flex w-full items-stretch text-left"
                >
                    <span
                        className="flex w-12 shrink-0 items-center justify-center bg-primary text-primary-foreground"
                        aria-hidden="true"
                    >
                        <Tent className="h-5 w-5" strokeWidth={2.25} />
                    </span>
                    <span className="flex min-w-0 flex-1 items-center gap-2 px-3 py-3">
                        <span className="flex-1 text-base font-extrabold uppercase leading-tight tracking-tight text-foreground">
                            Select a station to hide near
                        </span>
                        <ChevronDown
                            className={cn(
                                "h-5 w-5 shrink-0 text-muted-foreground transition-transform",
                                collapsed && "-rotate-90",
                            )}
                        />
                    </span>
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
