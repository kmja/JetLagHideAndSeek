import { useStore } from "@nanostores/react";
import { useEffect } from "react";

import {
    displayHidingZonesOptions,
    hidingZonesAutoFromTransit,
} from "@/lib/context";
import {
    allowedTransit,
    hidingZoneFiltersFor,
    type TransitMode,
} from "@/lib/gameSetup";

/** Every mode's station selectors, used to recognise which entries in a
 *  custom option list are transit-mode filters (so we can prune the ones
 *  whose mode is no longer allowed without touching non-mode picks). */
const ALL_MODES: TransitMode[] = ["bus", "tram", "train", "subway", "ferry"];

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
        const current = displayHidingZonesOptions.get();
        const same = (next: string[]) =>
            current.length === next.length &&
            current.every((v, i) => v === next[i]);

        if ($auto) {
            const desired = hidingZoneFiltersFor($allowed);
            // Fall back to the conventional `[railway=station]` if the
            // allowed-transit set is empty — never leave the user with no
            // candidate stations at all (the hiding-zone effect bails on
            // an empty option list and the overlay silently paints nothing).
            const next = desired.length > 0 ? desired : ["[railway=station]"];
            if (!same(next)) displayHidingZonesOptions.set(next);
            return;
        }

        // Custom selection (auto-tracking off): we DON'T re-add modes the
        // user removed, but we DO prune station filters for modes the game
        // no longer allows — you can't hide at, say, a bus stop once bus is
        // banned, so leaving those zones on the map was a bug (turning bus
        // off in settings left every bus-stop zone showing). Only mode
        // filters get pruned; any non-mode custom pick is left untouched.
        const allModeFilters = new Set(hidingZoneFiltersFor(ALL_MODES));
        const allowedFilters = new Set(hidingZoneFiltersFor($allowed));
        const pruned = current.filter(
            (f) => !allModeFilters.has(f) || allowedFilters.has(f),
        );
        // v822: NEVER leave an empty candidate pool, even in custom mode.
        // These two atoms are persistent across games, so a stuck
        // `auto=false` + `options=[]` from a past session (a cleared
        // MultiSelect, an imported game with no zoneOptions) survived into a
        // fresh game and made "Hiding zones" error with "At least one place
        // type must be selected" on every toggle. An empty custom list is
        // never useful — self-heal to the allowed-transit default (or the
        // conventional station filter) so the overlay always has something to
        // draw. A real custom pick (non-empty) is still left untouched.
        const next =
            pruned.length > 0
                ? pruned
                : hidingZoneFiltersFor($allowed).length > 0
                  ? hidingZoneFiltersFor($allowed)
                  : ["[railway=station]"];
        if (!same(next)) displayHidingZonesOptions.set(next);
    }, [$auto, $allowed]);

    return null;
}

export default HidingZoneOptionsSync;
