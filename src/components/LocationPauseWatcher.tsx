import { useStore } from "@nanostores/react";
import { useEffect } from "react";

import { useNow } from "@/hooks/useNow";
import {
    gamePausedForLocationAt,
    hiddenDebitMs,
    hidingPeriodEndsAt,
    LOCATION_SHARE_FRESH_MS,
    LOCATION_SHARE_GRACE_MS,
    locationGraceStartedAt,
} from "@/lib/gameSetup";
import { playerRole, roundFoundAt } from "@/lib/hiderRole";
import {
    multiplayerEnabled,
    seekerLocations,
    seekerSelfBroadcastAt,
} from "@/lib/multiplayer/session";

/**
 * Enforces the "seekers must share their location" rule. Mounted on
 * both pages and runs the same 5-min-grace → pause state machine, but
 * the freshness signal is role-specific:
 *
 *   - Hider (authority for the clock + score): "is ANY seeker
 *     broadcasting?" read from `seekerLocations`. The pause here
 *     freezes the hider's clock — scoring subtracts the live pause via
 *     `effectiveHiddenDebitMs` and banks it on resume.
 *   - Seeker: "am I broadcasting?" read from `seekerSelfBroadcastAt`
 *     (the seeker's own device never appears in `seekerLocations`).
 *     The pause atoms here just drive the banner so the seeker knows
 *     to turn sharing back on; they don't affect any score.
 *
 * Both arrive at the pause at ~the same moment (the seeker stops
 * broadcasting ⇒ the hider stops receiving), so the two devices stay
 * approximately in sync without an extra transport message.
 *
 * Renders nothing — pure state machine. Banner is `LocationPauseBanner`.
 * Gates to the seeking phase only.
 */
export function LocationPauseWatcher() {
    const $endsAt = useStore(hidingPeriodEndsAt);
    const $found = useStore(roundFoundAt);
    const $seekers = useStore(seekerLocations);
    const $selfBroadcast = useStore(seekerSelfBroadcastAt);
    const $role = useStore(playerRole);
    // The location-share rule only applies in an online game — solo /
    // local play has no separate seeker device to share from, so a
    // missing broadcast must NOT pause anything.
    const $mp = useStore(multiplayerEnabled);
    const isSeeker = $role === "seeker";
    // Drive the state machine off the shared 1 Hz clock so the grace
    // window + pause transitions fire even when no seeker event arrives.
    const now = useNow(true);

    useEffect(() => {
        // Only active during the seeking phase of an ONLINE game:
        // online, clock run out, hider not yet found.
        const seeking =
            $mp && $endsAt != null && now >= $endsAt && $found == null;
        if (!seeking) {
            // Outside seeking the rule is dormant. Clear any pending
            // grace, and if we were PAUSED when the round ended (found)
            // or the room closed, bank the paused span up to the found
            // time and clear — so the final score is correct and the
            // banner stops showing "paused".
            if (locationGraceStartedAt.get() != null) {
                locationGraceStartedAt.set(null);
            }
            const pausedAt = gamePausedForLocationAt.get();
            if (pausedAt != null) {
                const endpoint = $found ?? now;
                hiddenDebitMs.set(
                    hiddenDebitMs.get() + Math.max(0, endpoint - pausedAt),
                );
                gamePausedForLocationAt.set(null);
            }
            return;
        }

        const hasFresh = isSeeker
            ? $selfBroadcast != null &&
              now - $selfBroadcast <= LOCATION_SHARE_FRESH_MS
            : Object.values($seekers).some(
                  (s) => now - s.ts <= LOCATION_SHARE_FRESH_MS,
              );

        const pausedAt = gamePausedForLocationAt.get();

        if (hasFresh) {
            // A seeker is sharing. Resume if paused (bank the span),
            // and clear any pending grace.
            if (pausedAt != null) {
                hiddenDebitMs.set(
                    hiddenDebitMs.get() + Math.max(0, now - pausedAt),
                );
                gamePausedForLocationAt.set(null);
            }
            if (locationGraceStartedAt.get() != null) {
                locationGraceStartedAt.set(null);
            }
            return;
        }

        // No fresh location.
        if (pausedAt != null) return; // already paused, hold
        const graceStart = locationGraceStartedAt.get();
        if (graceStart == null) {
            locationGraceStartedAt.set(now);
            return;
        }
        if (now - graceStart >= LOCATION_SHARE_GRACE_MS) {
            // Grace expired with no location — pause.
            gamePausedForLocationAt.set(now);
            locationGraceStartedAt.set(null);
        }
    }, [now, $endsAt, $found, $seekers, $selfBroadcast, isSeeker]);

    return null;
}

export default LocationPauseWatcher;
