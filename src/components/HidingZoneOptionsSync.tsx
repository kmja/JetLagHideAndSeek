import { useStore } from "@nanostores/react";
import { useEffect } from "react";

import {
    displayHidingZonesOptions,
    hidingZonesAutoFromTransit,
} from "@/lib/context";
import { allowedTransit, hidingZoneFiltersFor } from "@/lib/gameSetup";

/**
 * Keeps `displayHidingZonesOptions` in sync with the game's
 * `allowedTransit` set whenever the user hasn't manually customised
 * the option list. This makes "which transit modes can we ride"
 * doubly meaningful — it also controls the candidate hiding-station
 * pool, which is the lever players use to keep dense-bus cities
 * (Stockholm-scale) tractable.
 *
 * Pure state machine — renders nothing. Mounted once at the top of
 * SeekerPage and HiderPage so it runs for any device that owns the
 * options atom (this is per-device persistent state).
 */
export function HidingZoneOptionsSync() {
    const $allowed = useStore(allowedTransit);
    const $auto = useStore(hidingZonesAutoFromTransit);

    useEffect(() => {
        if (!$auto) return;
        const desired = hidingZoneFiltersFor($allowed);
        // Fall back to the conventional `[railway=station]` if the
        // allowed-transit set is empty — never leave the user with no
        // candidate stations at all (the hiding-zone effect bails on
        // an empty option list and the overlay silently paints nothing).
        const next = desired.length > 0 ? desired : ["[railway=station]"];
        const current = displayHidingZonesOptions.get();
        if (current.length === next.length && current.every((v, i) => v === next[i])) {
            return;
        }
        displayHidingZonesOptions.set(next);
    }, [$auto, $allowed]);

    return null;
}

export default HidingZoneOptionsSync;
