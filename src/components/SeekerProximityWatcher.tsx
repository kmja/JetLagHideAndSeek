import { useStore } from "@nanostores/react";
import { useEffect, useRef } from "react";

import { hidingPeriodEndsAt } from "@/lib/gameSetup";
import { hidingZone, roundFoundAt } from "@/lib/hiderRole";
import { activeJourneyProvider } from "@/lib/journey/registry";
import {
    SEEKER_ETA_RANK,
    seekerEta,
    seekerEtaTone,
} from "@/lib/journey/state";
import { notify } from "@/lib/notifications";
import { seekerLocations } from "@/lib/multiplayer/session";

/**
 * Always-mounted hider-side watcher (renders nothing) that keeps the
 * `seekerEta` atom fresh AND fires an OS notification whenever the
 * seekers cross into a CLOSER colour band (comfortable → heads-up →
 * imminent → arrived).
 *
 * It's separate from `SeekerETACard` because the card only mounts while
 * the Zone drawer is open — but the "they're getting closer" alert is
 * most valuable exactly when the hider ISN'T looking at the app. So this
 * component lives on the hider page for the whole seeking phase, owns the
 * arrivals fetch, and publishes to `seekerEta` (the card is now a pure
 * renderer of that atom).
 *
 * Anchored at the freshest live seeker broadcast, departing now — "how
 * soon could the seekers reach my hiding-zone station from where they are
 * right now?". Only meaningful once the seekers are moving (the seeking
 * phase), so it gates on the hiding clock having elapsed.
 *
 * Anti-spam: notifications fire on a MONOTONIC-MAX rank, so each deeper
 * threshold alerts at most once per round and a jittery ETA hovering on a
 * boundary can't re-fire. The max resets when the zone changes or the
 * round ends.
 */
const STALE_THRESHOLD_MS = 60_000;
const POLL_MS = 45_000;

export function SeekerProximityWatcher() {
    const $zone = useStore(hidingZone);
    const $seekers = useStore(seekerLocations);
    const $hidingEndsAt = useStore(hidingPeriodEndsAt);
    const $foundAt = useStore(roundFoundAt);

    // Freshest seeker broadcast (ignore anything stale). The team travels
    // as one, so any recent fix is a fine anchor.
    const seeker = (() => {
        const now = Date.now();
        let best: { lat: number; lng: number; ts: number } | null = null;
        for (const s of Object.values($seekers)) {
            if (now - s.ts > STALE_THRESHOLD_MS) continue;
            if (best === null || s.ts > best.ts) {
                best = { lat: s.lat, lng: s.lng, ts: s.ts };
            }
        }
        return best;
    })();

    // Seeking = the hiding clock has elapsed and the round is still live.
    const seeking =
        $hidingEndsAt !== null &&
        $foundAt === null &&
        Date.now() >= $hidingEndsAt;

    // Highest closeness rank we've already alerted for this zone/round.
    const notifiedRankRef = useRef(0);
    // Latest arrival estimate, so the poll tick can re-evaluate the band as
    // the clock ticks toward it even without a fresh fetch.
    const arrivalRef = useRef<number | null>(null);

    // Reset the alert threshold whenever the target zone changes or the
    // round resets — a new zone is a fresh proximity story.
    const zoneKey = $zone
        ? `${$zone.stationLat.toFixed(4)},${$zone.stationLng.toFixed(4)}`
        : null;
    useEffect(() => {
        notifiedRankRef.current = 0;
        arrivalRef.current = null;
    }, [zoneKey, seeking]);

    const maybeNotify = (arrivalAt: number | null) => {
        if (arrivalAt == null) return;
        const tone = seekerEtaTone(arrivalAt, Date.now());
        const rank = SEEKER_ETA_RANK[tone];
        // Only alert from "heads-up" (rank 2) inward, and only when we
        // cross into a rank deeper than anything alerted so far.
        if (rank >= SEEKER_ETA_RANK["heads-up"] && rank > notifiedRankRef.current) {
            const minutesAway = Math.round((arrivalAt - Date.now()) / 60_000);
            const { title, body } =
                tone === "arrived"
                    ? {
                          title: "Seekers at your zone?",
                          body: "The seekers could be at your hiding zone now.",
                      }
                    : tone === "imminent"
                      ? {
                            title: "Seekers almost here",
                            body: `The seekers are about ${Math.max(0, minutesAway)} min from your zone.`,
                        }
                      : {
                            title: "Seekers closing in",
                            body: `The seekers are about ${minutesAway} min from your zone.`,
                        };
            notify({ title, body, tag: "seeker-proximity" });
        }
        notifiedRankRef.current = Math.max(notifiedRankRef.current, rank);
    };

    const seekerLat4 = seeker ? Number(seeker.lat.toFixed(4)) : null;
    const seekerLng4 = seeker ? Number(seeker.lng.toFixed(4)) : null;

    // Fetch + publish. Re-runs when seeking flips, the zone changes, or the
    // seeker moves (~11 m). A stale-signal / no-provider / no-route case
    // publishes an honest state rather than a stale number.
    useEffect(() => {
        if (!seeking || !$zone) {
            seekerEta.set(null);
            arrivalRef.current = null;
            return;
        }
        if (!seeker) {
            seekerEta.set({ arrivalAt: null, hasSeeker: false, loading: false });
            arrivalRef.current = null;
            return;
        }
        const provider = activeJourneyProvider();
        if (!provider) {
            seekerEta.set({ arrivalAt: null, hasSeeker: true, loading: false });
            return;
        }
        let cancelled = false;
        const controller = new AbortController();
        seekerEta.set({
            arrivalAt: arrivalRef.current,
            hasSeeker: true,
            loading: true,
        });
        (async () => {
            const results = await provider
                .fetchArrivals(
                    { lat: seeker.lat, lng: seeker.lng, departAt: Date.now() },
                    [
                        {
                            id: "hidingZone",
                            name: $zone.stationName,
                            lat: $zone.stationLat,
                            lng: $zone.stationLng,
                        },
                    ],
                    controller.signal,
                )
                .catch(() => []);
            if (cancelled) return;
            const r = results[0];
            const arrivalAt = r && r.arrivalAt != null ? r.arrivalAt : null;
            arrivalRef.current = arrivalAt;
            seekerEta.set({ arrivalAt, hasSeeker: true, loading: false });
            maybeNotify(arrivalAt);
        })();
        return () => {
            cancelled = true;
            controller.abort();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [seeking, zoneKey, seeker == null, seekerLat4, seekerLng4]);

    // Plain interval (NOT visibility-gated — the whole point is to alert a
    // backgrounded hider) that re-evaluates the band as the clock ticks
    // toward the arrival, and refreshes the estimate periodically. Browser
    // throttling to ~1/min while hidden is fine at minute granularity.
    useEffect(() => {
        if (!seeking || !$zone || !seeker) return;
        const id = window.setInterval(() => {
            maybeNotify(arrivalRef.current);
        }, POLL_MS);
        return () => window.clearInterval(id);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [seeking, zoneKey, seeker == null]);

    return null;
}

export default SeekerProximityWatcher;
