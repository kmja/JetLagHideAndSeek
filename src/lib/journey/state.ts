/**
 * Journey-overlay state. Atoms only; the fetching + rendering glue
 * lives in `components/TravelTimesOverlay.tsx` (seeker side) and
 * `components/HiderReachOverlay.tsx` (hider side).
 */

import { persistentAtom } from "@nanostores/persistent";
import { atom } from "nanostores";

/** Whether the Travel Times overlay is currently rendered. */
export const showTravelTimes = persistentAtom<boolean>(
    "jlhs:showTravelTimes",
    false,
    {
        encode: (v) => (v ? "true" : "false"),
        decode: (v) => v === "true",
    },
);

/**
 * Overlay shadow atom — TravelTimesOverlay writes the rendered
 * station FeatureCollection (with arrival-time props baked in) here,
 * and Map.tsx renders it as a symbol Source/Layer pair. Same shadow-
 * atom pattern hiding-zones uses. Null when the overlay is off OR
 * before the first fetch completes.
 *
 * Each feature is a Point with these properties:
 *   - stopId  (string)
 *   - name    (string | undefined)
 *   - arrivalLabel (string) — "HH:MM" for reachable stations, "" while
 *     the API is still loading (optimistic pre-fetch step).
 *
 * Only stations reachable before hidingPeriodEndsAt are included
 * in the final (post-fetch) set.
 */
export const travelTimesFC = atom<GeoJSON.FeatureCollection<
    GeoJSON.Point,
    {
        stopId: string;
        name?: string;
        arrivalLabel: string;
        /** True once the journey-arrivals API has confirmed the hider
         *  could reach this station before `hidingPeriodEndsAt`. Map.tsx
         *  colours dots green (reachable) vs red (not), so the seeker
         *  can scan candidate zones at a glance instead of reading
         *  every label. */
        reachable: boolean;
        /** True before the API has returned for this station — the dot
         *  is rendered but its reachability isn't known yet, so the
         *  layer paints it in a neutral pending color. */
        pending: boolean;
    }
> | null>(null);

/* ─────────────────────── Hider reach overlay ─────────────────────── */

/**
 * Whether the hider's reach overlay is currently rendered. Mirrors
 * the seeker's `showTravelTimes` toggle but with a hider-side key so
 * the two roles' UI states are independent (a player switching roles
 * mid-game doesn't import the other side's overlay preference).
 */
export const showHiderReach = persistentAtom<boolean>(
    "jlhs:showHiderReach",
    false,
    {
        encode: (v) => (v ? "true" : "false"),
        decode: (v) => v === "true",
    },
);

/**
 * Shadow FC for the hider's "Hiding zones" overlay — every candidate
 * hiding-zone station in the play area, written by `HiderReachOverlay`
 * from an area-wide station scan and rendered by `HiderBackgroundMap`
 * as name-labeled dots.
 *
 * v643: reachability was REMOVED from the overlay. It used to fan out a
 * per-station journey-arrivals fetch to colour-code reachable vs
 * out-of-reach, but that round-trip made the overlay slow and flaky.
 * The overlay now mirrors the seeker's `hiding-zones-*` layers exactly —
 * plain station dots + name labels, no per-station timing. Whether a
 * SINGLE tapped zone is reachable before the whistle is now an on-demand
 * check in `StationTransitCard` (one zone at a time), where the trip is
 * already being planned.
 *
 * Mixed-geometry FC (matching the seeker's `hidingZonesGeoJSON`): the
 * station centre POINTS (`{ stopId, name? }`) PLUS a single `safeUnion`-ed
 * extent POLYGON of every station's hiding-radius circle, so the hider's
 * overlay shows the same faint unioned fill + envelope the seeker sees.
 * Null when off / pre-fetch / no candidates.
 */
export const hiderReachFC = atom<GeoJSON.FeatureCollection | null>(null);

/* ───────────────── Seeker proximity (hider's ETA) ───────────────── */

/**
 * Latest "how soon could the seekers reach my zone" estimate, owned by
 * `SeekerProximityWatcher` (always mounted on the hider page during
 * seeking) and read by `SeekerETACard` for display. Centralised here so
 * the card is a pure renderer and the watcher can fire OS notifications
 * on closer-transitions even while the Zone drawer is closed.
 *
 *   - `null` — not applicable (no committed zone, or not seeking yet).
 *   - `hasSeeker: false` — zone committed but no fresh seeker broadcast.
 *   - `arrivalAt: null` (hasSeeker true) — couldn't estimate (no route /
 *     provider / upstream miss).
 */
export const seekerEta = atom<{
    arrivalAt: number | null;
    hasSeeker: boolean;
    loading: boolean;
} | null>(null);

export type SeekerEtaTone =
    | "unknown"
    | "comfortable"
    | "heads-up"
    | "imminent"
    | "arrived";

/**
 * Colour-coded closeness band for a seeker ETA, matching `SeekerETACard`:
 *   ≥ 15 min → comfortable · 5–14 → heads-up · 0–4 → imminent · < 0 →
 *   arrived. `null` arrival → unknown.
 */
export function seekerEtaTone(
    arrivalAt: number | null,
    now: number,
): SeekerEtaTone {
    if (arrivalAt == null) return "unknown";
    const minutesAway = Math.round((arrivalAt - now) / 60_000);
    if (minutesAway >= 15) return "comfortable";
    if (minutesAway >= 5) return "heads-up";
    if (minutesAway >= 0) return "imminent";
    return "arrived";
}

/** Closeness rank — higher = closer. The proximity watcher notifies when
 *  the band crosses into a NEW deeper rank (monotonic max), so each
 *  threshold alerts at most once per round and boundary jitter can't spam. */
export const SEEKER_ETA_RANK: Record<SeekerEtaTone, number> = {
    unknown: 0,
    comfortable: 1,
    "heads-up": 2,
    imminent: 3,
    arrived: 4,
};

/* ─────────────────────── Seeker trip planner ─────────────────────── */

/** Volatile open/closed state for the seeker's trip-planner drawer.
 *  Not persisted — closing the app resets it. */
export const seekerTripPlannerOpen = atom<boolean>(false);

/**
 * Shadow FC for the active planned trip's route, drawn on the map as a
 * coloured per-leg line + labelled step points. Written by whichever
 * trip planner is active (seeker drawer or hider trip-plan card) from
 * `journeyToRouteFC`, cleared when no plan is showing. Same shadow-atom
 * pattern the other overlays use; the seeker `Map` and hider
 * `HiderBackgroundMap` render it via `TripRouteLayers`.
 */
export const tripRouteFC = atom<GeoJSON.FeatureCollection | null>(null);

/* ─────────────────── Map-first station selection ─────────────────── */

/**
 * The station/zone the user tapped on the map, or null when nothing is
 * selected. Trip planning in this game almost always STARTS from the
 * map — a hider exploring where to hide, or a seeker scanning the
 * remaining candidate zones to see whether (and how) the hider could
 * have reached one — so a map tap on a station is the primary entry
 * point, not the search box.
 *
 * Set by Map.tsx's click handler (querying the hiding-zone / travel-
 * time feature under the tap); consumed by `StationTransitCard`, which
 * plans a trip TO this station from the role-appropriate origin
 * (seeker → game-start position = "could the hider get here?"; hider →
 * live GPS = "can I get here?") and renders it. Volatile.
 */
export const selectedMapStation = atom<{
    lat: number;
    lng: number;
    name?: string;
    /** Transit modes serving this station (subway/tram/train/bus/ferry/…),
     *  aggregated across the merged OSM nodes. */
    modes?: string[];
} | null>(null);
