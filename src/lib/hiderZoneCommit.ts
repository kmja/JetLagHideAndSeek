import { toast } from "react-toastify";

import { appConfirm } from "@/lib/confirm";
import { hidingPeriodEndsAt } from "@/lib/gameSetup";
import { hidingZone } from "@/lib/hiderRole";
import { endHidingPeriodEarly } from "@/lib/roundActions";

export interface ZoneStation {
    lat: number;
    lng: number;
    name?: string;
}

/**
 * Confirm-and-commit a hiding zone from a picked station — the shared flow
 * behind BOTH the Zone drawer's nearby-stations picker and the on-map zone
 * hint (`HiderZoneHint`), so they can never drift.
 *
 * Committing is a one-way, round-defining choice, so it asks "Lock in?" first;
 * on confirm it sets `hidingZone` and then offers the rulebook shortcut to end
 * the hiding period early (skipped once the whistle has already blown).
 *
 * Returns true iff the zone was committed (the first confirm accepted).
 */
export async function confirmAndCommitZone(
    station: ZoneStation,
    radiusMeters: number,
): Promise<boolean> {
    const ok = await appConfirm({
        title: "Lock in your hiding zone?",
        description: `Set "${station.name ?? "this station"}" as your hiding zone for this round? Your actual hiding spot must stay within its radius, and this is what the seekers will be trying to find.`,
        confirmLabel: "Lock it in",
        cancelLabel: "Cancel",
    });
    if (!ok) return false;

    hidingZone.set({
        stationName: station.name || "Hiding zone",
        stationLat: station.lat,
        stationLng: station.lng,
        radiusMeters,
        committedAt: Date.now(),
    });
    toast.success("Hiding zone committed.", { autoClose: 2000 });

    if (
        hidingPeriodEndsAt.get() !== null &&
        (hidingPeriodEndsAt.get() ?? 0) > Date.now()
    ) {
        const radiusLabel =
            radiusMeters >= 1000
                ? `${(radiusMeters / 1000).toFixed(radiusMeters % 1000 === 0 ? 0 : 1)} km`
                : `${radiusMeters} m`;
        const zoneName = station.name ?? "your station";
        const end = await appConfirm({
            // v788: name the zone that was just locked in so the hider has a
            // clear confirmation of their choice.
            title: `Hiding zone locked in: ${zoneName}`,
            description: `Your hiding zone is "${zoneName}" — the ${radiusLabel} radius around it, and what the seekers will be hunting. End the hiding period early and alert them now, or keep the timer running for a bit more time in your spot?`,
            confirmLabel: "End it now",
            cancelLabel: "Keep timer running",
        });
        if (end) {
            endHidingPeriodEarly();
            toast.success(
                "Hiding period ended — seekers can start asking.",
                { autoClose: 2500 },
            );
        }
    }
    return true;
}
