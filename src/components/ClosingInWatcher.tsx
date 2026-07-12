import { useStore } from "@nanostores/react";
import * as turf from "@turf/turf";
import { useEffect, useRef } from "react";
import { toast } from "react-toastify";

import {
    closingInWarningLevel,
    type GameSize,
    gameSize,
    hidingPeriodEndsAt,
} from "@/lib/gameSetup";
import { hidingZone } from "@/lib/hiderRole";
import { seekerLocations } from "@/lib/multiplayer/session";
import { notify } from "@/lib/notifications";

/**
 * Watches the live seeker-position feed and warns the hider when
 * seekers are closing in. Two thresholds per game size:
 *
 *   - level 1 ("CLOSING IN"): they're nearby, head to a hiding spot
 *     and stop wandering.
 *   - level 2 ("VERY CLOSE"): commit to your exact spot now.
 *
 * Distances scale with game-area size so the level-1 warning fires
 * with enough lead time to actually act on it.
 *
 * Idempotency: each level only fires once per round. `closingInWarning
 * Level` records the highest level we've crossed; we never go
 * backwards inside a round (a seeker pulling away doesn't replay the
 * "CLOSING IN" warning the next time they approach).
 *
 * Fires three surfaces simultaneously, mirroring the hiding-period-end
 * pattern:
 *   - toast.warning (red, persistent until tapped)
 *   - notify() — OS notification for backgrounded tabs
 *   - confirm-style modal? Skipped — these are passive warnings, not
 *     decisions. Just toast + push.
 */

const THRESHOLDS_M: Record<GameSize, { warn: number; urgent: number }> = {
    small: { warn: 2_000, urgent: 1_000 },
    medium: { warn: 10_000, urgent: 5_000 },
    large: { warn: 50_000, urgent: 20_000 },
};

export function ClosingInWatcher() {
    const $size = useStore(gameSize);
    const $zone = useStore(hidingZone);
    const $seekers = useStore(seekerLocations);
    const $level = useStore(closingInWarningLevel);
    const $endsAt = useStore(hidingPeriodEndsAt);

    // v789: the seekers' nearest distance to the zone at the FIRST seeking-phase
    // evaluation — the baseline. A warning only fires when the seekers cross a
    // threshold from OUTSIDE it (i.e. they genuinely CLOSE IN during ongoing
    // seeking), not when they merely start the seeking phase already within
    // range — which used to dogpile the hiding→seeking transition with a
    // "Seekers within X km" toast the moment the whistle blew.
    const baselineNearestKmRef = useRef<number | null>(null);
    const zoneKey = $zone
        ? `${$zone.stationLat.toFixed(4)},${$zone.stationLng.toFixed(4)}`
        : null;
    useEffect(() => {
        // New zone / new hiding clock → fresh proximity story.
        baselineNearestKmRef.current = null;
    }, [zoneKey, $endsAt]);

    useEffect(() => {
        // Pre-game / pre-zone / past-urgent — nothing to do.
        if (!$zone) return;
        if ($level >= 2) return;
        // Only warn during the seeking phase. While the hiding period
        // is still ticking, seekers are en route to their hiding spot
        // and proximity is meaningless (they all start co-located
        // with the hider).
        if ($endsAt === null) return;
        if (Date.now() < $endsAt) return;

        const seekers = Object.values($seekers);
        if (seekers.length === 0) return;

        const target = turf.point([$zone.stationLng, $zone.stationLat]);
        let nearestKm = Infinity;
        for (const s of seekers) {
            const d = turf.distance(
                target,
                turf.point([s.lng, s.lat]),
                { units: "kilometers" },
            );
            if (d < nearestKm) nearestKm = d;
        }
        if (!Number.isFinite(nearestKm)) return;
        const nearestM = nearestKm * 1000;

        // Establish the baseline on the first seeking-phase evaluation. On that
        // first pass no warning fires (a level only fires when the baseline was
        // OUTSIDE that level's threshold), so an already-close start is silent.
        if (baselineNearestKmRef.current === null) {
            baselineNearestKmRef.current = nearestKm;
        }
        const baselineM = baselineNearestKmRef.current * 1000;

        const t = THRESHOLDS_M[$size];

        if ($level < 2 && nearestM <= t.urgent && baselineM > t.urgent) {
            // URGENT — commit to the final spot.
            closingInWarningLevel.set(2);
            const km = nearestKm.toFixed(1);
            toast.error(
                `Seekers within ${km} km — commit to your exact hiding spot NOW.`,
                {
                    autoClose: 8000,
                    toastId: "closing-in-urgent",
                },
            );
            notify({
                title: "Seekers very close",
                body: `Within ${km} km of your zone. Commit to your final hiding spot now.`,
                tag: "closing-in-urgent",
                whileVisible: true,
            });
            return;
        }
        if ($level < 1 && nearestM <= t.warn && baselineM > t.warn) {
            // CLOSING IN — start heading to a spot.
            closingInWarningLevel.set(1);
            const km = nearestKm.toFixed(1);
            toast.warning(
                `Seekers within ${km} km — pick a hiding spot and head there.`,
                {
                    autoClose: 6000,
                    toastId: "closing-in",
                },
            );
            notify({
                title: "Seekers closing in",
                body: `Within ${km} km of your zone. Start heading to a hiding spot.`,
                tag: "closing-in",
                whileVisible: true,
            });
        }
    }, [$zone, $seekers, $size, $level, $endsAt]);

    return null;
}

export default ClosingInWatcher;
