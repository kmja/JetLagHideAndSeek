import { useStore } from "@nanostores/react";
import { convertLength } from "@turf/turf";
import { Loader2, Timer } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
    hidingRadius,
    hidingRadiusUnits,
    lastKnownPosition,
} from "@/lib/context";
import {
    allowedTransit,
    formatTimeRemaining,
    hidingPeriodEndsAt,
    TRANSIT_ICONS,
} from "@/lib/gameSetup";
import { haversineMeters } from "@/lib/geo";
import { hidingZone, ZONE_GRACE_MS } from "@/lib/hiderRole";
import { confirmAndCommitZone } from "@/lib/hiderZoneCommit";
import {
    type AreaStation,
    fetchAreaStations,
} from "@/lib/journey/stations";
import { cn } from "@/lib/utils";

/** How far the hider must move (m) before we recompute the closest zone. */
const REFRESH_DEADBAND_M = 25;

/**
 * v879: prominent TOP-of-map grace-period prompt for the hider. When the
 * hiding period has ended but no zone is committed yet, the rulebook gives a
 * short grace window (`ZONE_GRACE_MS`) to lock one in. This replaces the small
 * bottom-corner "PICK A ZONE — GRACE" box (removed from `HiderMapTimer`) with a
 * big, urgent, centred top card that ALSO surfaces the single most relevant
 * zone to commit: the one the hider is standing INSIDE (if any), else the
 * CLOSEST zone — tappable to lock in via the shared `confirmAndCommitZone`.
 */
export function HiderGracePrompt() {
    const $endsAt = useStore(hidingPeriodEndsAt);
    const $zone = useStore(hidingZone);
    const $gps = useStore(lastKnownPosition);
    const $allowed = useStore(allowedTransit);
    const $hidingRadius = useStore(hidingRadius);
    const $hidingRadiusUnits = useStore(hidingRadiusUnits);
    const radiusMeters = Math.round(
        convertLength($hidingRadius, $hidingRadiusUnits, "meters"),
    );

    const [now, setNow] = useState(() => Date.now());
    const graceEndsAt = $endsAt !== null ? $endsAt + ZONE_GRACE_MS : null;
    const inGrace =
        $endsAt !== null &&
        $zone === null &&
        graceEndsAt !== null &&
        now >= $endsAt &&
        now < graceEndsAt;

    useEffect(() => {
        if (!inGrace) return;
        const id = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(id);
    }, [inGrace]);

    // The single most relevant zone: the one the hider is INSIDE (distance
    // within the hiding radius) or, failing that, the CLOSEST candidate zone.
    // `fetchAreaStations` returns every zone sorted by distance from the GPS,
    // so [0] is the nearest and its `distanceMeters` decides "inside".
    const [closest, setClosest] = useState<{
        station: AreaStation;
        inside: boolean;
    } | null>(null);
    const [loading, setLoading] = useState(false);
    const lastRef = useRef<{ lat: number; lng: number } | null>(null);
    useEffect(() => {
        if (!inGrace || !$gps) return;
        const last = lastRef.current;
        if (
            last &&
            closest &&
            haversineMeters(last.lat, last.lng, $gps.lat, $gps.lng) <
                REFRESH_DEADBAND_M
        ) {
            return;
        }
        lastRef.current = { lat: $gps.lat, lng: $gps.lng };
        let cancelled = false;
        setLoading(true);
        fetchAreaStations($gps.lat, $gps.lng, { allowed: $allowed })
            .then((list) => {
                if (cancelled) return;
                const s = list[0];
                setClosest(
                    s
                        ? { station: s, inside: s.distanceMeters <= radiusMeters }
                        : null,
                );
            })
            .catch(() => {
                /* leave the last result; the countdown still shows */
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [inGrace, $gps?.lat, $gps?.lng, $allowed, radiusMeters]);

    const [committing, setCommitting] = useState(false);
    const commit = () => {
        if (!closest || committing) return;
        setCommitting(true);
        void confirmAndCommitZone(
            {
                lat: closest.station.lat,
                lng: closest.station.lng,
                name: closest.station.name,
            },
            radiusMeters,
        ).finally(() => setCommitting(false));
    };

    if (!inGrace) return null;
    const graceRemainingMs = graceEndsAt ? Math.max(0, graceEndsAt - now) : 0;

    return (
        <div
            className={cn(
                "fixed left-1/2 -translate-x-1/2 z-[1035]",
                "top-[calc(env(safe-area-inset-top)+4.25rem)]",
                "w-[min(94vw,460px)]",
                "rounded-2xl shadow-2xl overflow-hidden",
                "bg-destructive text-destructive-foreground",
                "animate-in fade-in slide-in-from-top-2 duration-300",
            )}
            role="status"
            aria-live="assertive"
        >
            {/* Big countdown header */}
            <div className="flex items-center gap-3 px-4 pt-3 pb-2 animate-pulse">
                <Timer className="w-9 h-9 shrink-0" strokeWidth={2.5} />
                <div className="flex flex-col leading-none gap-1 min-w-0">
                    <span className="text-[11px] font-poppins font-extrabold uppercase tracking-[0.14em]">
                        Pick a zone — grace period
                    </span>
                    <span className="font-inter-tight font-black tabular-nums text-4xl leading-none">
                        {formatTimeRemaining(graceRemainingMs)}
                    </span>
                </div>
            </div>

            {/* Closest / containing zone — one-tap commit. */}
            <div className="bg-background/95 text-foreground px-3 py-3">
                {loading && !closest ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground px-1 py-2">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Finding the nearest hiding zone…
                    </div>
                ) : closest ? (
                    <div className="flex items-center gap-3">
                        <span className="inline-flex items-center justify-center w-11 h-11 rounded-md shrink-0 bg-primary/20">
                            {(() => {
                                const Icon = TRANSIT_ICONS[closest.station.mode];
                                return (
                                    <Icon className="w-5 h-5 text-primary" />
                                );
                            })()}
                        </span>
                        <div className="min-w-0 flex-1">
                            <div className="text-[10px] uppercase tracking-[0.14em] font-poppins font-bold text-muted-foreground">
                                {closest.inside
                                    ? "You're in this zone"
                                    : `Closest zone · ${Math.round(closest.station.distanceMeters)} m`}
                            </div>
                            <div className="text-base font-inter-tight font-bold leading-tight truncate">
                                {closest.station.name}
                            </div>
                        </div>
                        <Button
                            size="sm"
                            onClick={commit}
                            disabled={committing}
                            className="shrink-0"
                        >
                            {committing ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                                "Lock in"
                            )}
                        </Button>
                    </div>
                ) : (
                    <div className="text-sm text-muted-foreground px-1 py-2">
                        No hiding zone found nearby — open the Zone drawer to
                        pick one on the map.
                    </div>
                )}
            </div>
        </div>
    );
}

export default HiderGracePrompt;
