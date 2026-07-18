import { useStore } from "@nanostores/react";
import * as turf from "@turf/turf";
import { useEffect, useRef } from "react";
import { toast } from "react-toastify";

import { polyGeoJSON } from "@/lib/context";
import { closingInWarningLevel, hidingPeriodEndsAt } from "@/lib/gameSetup";
import { hidingZone } from "@/lib/hiderRole";
import { seekerLocations } from "@/lib/multiplayer/session";
import { notify } from "@/lib/notifications";

/**
 * Warns the hider when the seekers are closing in — but only when it's
 * genuinely meaningful (v953). Two levels per round:
 *
 *   - level 1 ("CLOSING IN"): head to a hiding spot, stop wandering.
 *   - level 2 ("VERY CLOSE"): commit to your exact spot now.
 *
 * The thresholds are DYNAMIC, not fixed by game size:
 *   - scaled to how far the seekers were at the START of seeking (the
 *     baseline) — a warning means "they've closed most of the gap", so it
 *     lands at the right moment whether they started 2 km or 30 km away;
 *   - floored relative to the PLAY-AREA size (its bbox diagonal), so a big
 *     area still gives lead time and a tiny one doesn't fire at absurdly
 *     short range.
 *
 * And it only fires when the nearest seeker is APPROACHING FAST — the closing
 * SPEED toward the zone must exceed `FAST_CLOSING_KMH`. Seekers strolling
 * around who merely drift across the threshold don't trip it (that's not
 * "closing in"); a train / car bearing down does. GPS jitter is filtered by
 * only sampling speed over a ≥ `SAMPLE_MIN_MS` window.
 *
 * Idempotency: each level fires once per round (`closingInWarningLevel`, never
 * goes backwards). Foreground surfaces only (toast + notify); a BACKGROUNDED
 * hider is covered by the server's alarm-driven push.
 */

/** Effective closing speed toward the zone (km/h) required to count as
 *  "closing in" — clearly faster than a brisk walk (~5 km/h). */
const FAST_CLOSING_KMH = 12;
/** Only recompute closing speed over at least this window, so GPS jitter on a
 *  near-stationary seeker can't fake a fast approach. */
const SAMPLE_MIN_MS = 15_000;

interface Sample {
    distKm: number;
    ts: number;
}

export function ClosingInWatcher() {
    const $zone = useStore(hidingZone);
    const $seekers = useStore(seekerLocations);
    const $level = useStore(closingInWarningLevel);
    const $endsAt = useStore(hidingPeriodEndsAt);
    const $poly = useStore(polyGeoJSON);

    // Nearest seeker distance at the first seeking-phase eval — the baseline.
    const baselineKmRef = useRef<number | null>(null);
    // Per-seeker last distance sample, for closing-speed (velocity) gating.
    const sampleRef = useRef<Map<string, Sample>>(new Map());

    const zoneKey = $zone
        ? `${$zone.stationLat.toFixed(4)},${$zone.stationLng.toFixed(4)}`
        : null;
    useEffect(() => {
        // New zone / new hiding clock → fresh proximity story.
        baselineKmRef.current = null;
        sampleRef.current = new Map();
    }, [zoneKey, $endsAt]);

    // Play-area scale (bbox diagonal, km) — drives the threshold floors so a
    // big area warns earlier and a small one doesn't require absurd nearness.
    const areaScaleKm = (() => {
        try {
            if (!$poly || $poly.features.length === 0) return null;
            const [minX, minY, maxX, maxY] = turf.bbox($poly);
            const diag = turf.distance(
                turf.point([minX, minY]),
                turf.point([maxX, maxY]),
                { units: "kilometers" },
            );
            return Number.isFinite(diag) && diag > 0 ? diag : null;
        } catch {
            return null;
        }
    })();

    useEffect(() => {
        if (!$zone) return;
        if ($level >= 2) return;
        // Only during seeking (proximity is meaningless while everyone's still
        // co-located during the hiding period).
        if ($endsAt === null || Date.now() < $endsAt) return;

        const seekers = Object.entries($seekers);
        if (seekers.length === 0) return;

        const target = turf.point([$zone.stationLng, $zone.stationLat]);
        const now = Date.now();
        let nearestKm = Infinity;
        let nearestClosingKmh = 0;
        for (const [id, s] of seekers) {
            const distKm = turf.distance(target, turf.point([s.lng, s.lat]), {
                units: "kilometers",
            });
            if (!Number.isFinite(distKm)) continue;
            // Closing speed vs this seeker's last sample (≥ SAMPLE_MIN_MS old).
            const prev = sampleRef.current.get(id);
            if (prev && now - prev.ts >= SAMPLE_MIN_MS) {
                const dtH = (now - prev.ts) / 3_600_000;
                const closingKmh = (prev.distKm - distKm) / dtH; // + = approaching
                sampleRef.current.set(id, { distKm, ts: now });
                if (distKm < nearestKm) {
                    nearestKm = distKm;
                    nearestClosingKmh = closingKmh;
                }
            } else {
                if (!prev) sampleRef.current.set(id, { distKm, ts: now });
                if (distKm < nearestKm) {
                    nearestKm = distKm;
                    // No fresh sample yet → treat as not-yet-known (0), so a
                    // just-appeared seeker doesn't trip a warning until we've
                    // measured a real closing rate.
                    nearestClosingKmh = 0;
                }
            }
        }
        if (!Number.isFinite(nearestKm)) return;

        // Baseline on the first seeking-phase eval (no warning fires yet).
        if (baselineKmRef.current === null) {
            baselineKmRef.current = nearestKm;
            return;
        }
        const baselineKm = baselineKmRef.current;

        // Dynamic thresholds: a fraction of the starting gap, floored to the
        // play-area scale so lead time is sensible at any scale.
        const scale = areaScaleKm ?? Math.max(baselineKm, 2);
        const warnFloor = Math.max(0.6, scale * 0.12);
        const urgentFloor = Math.max(0.3, scale * 0.05);
        const warnKm = Math.max(warnFloor, baselineKm * 0.5);
        const urgentKm = Math.min(
            warnKm - 0.05,
            Math.max(urgentFloor, baselineKm * 0.2),
        );

        // Velocity gate: only a genuinely FAST approach counts.
        const closingFast = nearestClosingKmh >= FAST_CLOSING_KMH;
        if (!closingFast) return;

        const km = nearestKm.toFixed(1);
        if ($level < 2 && nearestKm <= urgentKm) {
            closingInWarningLevel.set(2);
            toast.error(
                `Seekers closing in fast — within ${km} km. Commit to your exact hiding spot NOW.`,
                { autoClose: 8000, toastId: "closing-in-urgent" },
            );
            notify({
                title: "Seekers very close",
                body: `Closing in fast — within ${km} km of your zone. Commit to your final spot now.`,
                tag: "closing-in-urgent",
                whileVisible: true,
            });
            return;
        }
        if ($level < 1 && nearestKm <= warnKm) {
            closingInWarningLevel.set(1);
            toast.warning(
                `Seekers closing in fast — within ${km} km. Pick a hiding spot and head there.`,
                { autoClose: 6000, toastId: "closing-in" },
            );
            notify({
                title: "Seekers closing in",
                body: `Closing in fast — within ${km} km of your zone. Start heading to a hiding spot.`,
                tag: "closing-in",
                whileVisible: true,
            });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [$zone, $seekers, $level, $endsAt, areaScaleKm]);

    return null;
}

export default ClosingInWatcher;
