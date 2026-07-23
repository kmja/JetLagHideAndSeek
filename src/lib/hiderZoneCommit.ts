
import { appConfirm } from "@/lib/confirm";
import {
    hidingPeriodEndsAt,
    type TransitMode,
    zoneLockedCallout,
} from "@/lib/gameSetup";
import { hidingZone } from "@/lib/hiderRole";

export interface ZoneStation {
    lat: number;
    lng: number;
    name?: string;
    /** Transit modes serving this station, stored on the committed zone. */
    modes?: TransitMode[];
}

/**
 * Confirm-and-commit a hiding zone from a picked station — the shared flow
 * behind the Zone drawer's nearby-stations picker and a direct map tap, so
 * every commit path runs the same lock-in confirm.
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
        modes: station.modes,
    });

    // Still in the hiding period → surface the on-map callout by the timer
    // so the hider can end early (or keep going) from where that action is.
    if (
        hidingPeriodEndsAt.get() !== null &&
        (hidingPeriodEndsAt.get() ?? 0) > Date.now()
    ) {
        zoneLockedCallout.set(true);
    }

    // v946: the "get notified" ask moved to the hiding-period-END moment
    // (SeekingStartWatcher) — "you'll get the first question soon" — which is
    // when questions actually start and mirrors the seeker's post-first-
    // question prompt. Committing a zone can happen well before that, so
    // prompting here consumed the one-shot too early.
    return true;
}
