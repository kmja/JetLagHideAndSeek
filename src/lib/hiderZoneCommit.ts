import { toast } from "react-toastify";

import { appConfirm } from "@/lib/confirm";
import { hidingPeriodEndsAt, zoneLockedCallout } from "@/lib/gameSetup";
import { hidingZone } from "@/lib/hiderRole";

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
 * Committing is a one-way, round-defining choice, so it asks "Lock in?"
 * first — with a map preview of the zone extent. On confirm it sets
 * `hidingZone`; if the hiding period is still running it then raises the
 * on-map `zoneLockedCallout` (near the timer) instead of a second modal, so
 * the "end early / keep timer" choice lives where the timer + end action are
 * (v798 — the two stacked modals looked near-identical).
 *
 * Returns true iff the zone was committed (the confirm accepted).
 */
export async function confirmAndCommitZone(
    station: ZoneStation,
    radiusMeters: number,
): Promise<boolean> {
    const radiusLabel =
        radiusMeters >= 1000
            ? `${(radiusMeters / 1000).toFixed(radiusMeters % 1000 === 0 ? 0 : 1)} km`
            : `${radiusMeters} m`;
    const zoneName = station.name ?? "this station";
    const ok = await appConfirm({
        title: station.name
            ? `Lock in ${station.name}?`
            : "Lock in your hiding zone?",
        description: `"${zoneName}" and everywhere within its ${radiusLabel} radius becomes your hiding zone for the round — the area the seekers hunt. This cannot be undone.`,
        confirmLabel: "Lock it in",
        cancelLabel: "Cancel",
        previewZone: { lat: station.lat, lng: station.lng, radiusMeters },
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

    // Still in the hiding period → surface the on-map callout by the timer
    // so the hider can end early (or keep going) from where that action is.
    if (
        hidingPeriodEndsAt.get() !== null &&
        (hidingPeriodEndsAt.get() ?? 0) > Date.now()
    ) {
        zoneLockedCallout.set(true);
    }
    return true;
}
