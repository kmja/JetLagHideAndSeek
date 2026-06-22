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
 * Shadow FC for the hider's reach overlay — the same shape the
 * seeker's `travelTimesFC` carries, but written by
 * `HiderReachOverlay` from the hider's live GPS during the hiding
 * period. Renders as map markers in `HiderBackgroundMap` so the hider
 * can survey every candidate hiding zone they could feasibly reach
 * before the whistle blows.
 *
 * Same feature shape as `travelTimesFC` so the rendering Source/Layer
 * can be lifted into a reusable bit later if the seeker overlay's
 * styling diverges. Null when off / pre-fetch / no candidates.
 */
export const hiderReachFC = atom<GeoJSON.FeatureCollection<
    GeoJSON.Point,
    {
        stopId: string;
        name?: string;
        arrivalLabel: string;
        /** Minutes between the seeker's earliest possible arrival at
         *  this station (from gameStartPosition, departing at the
         *  whistle) and the whistle itself. Positive = the hider has
         *  that many minutes of safety at this station before the
         *  seekers can reach it; zero/negative = the seekers can be
         *  there at or before the hider. Intentionally OMITTED (not
         *  set) when the seeker arrivals haven't resolved or aren't
         *  available — MapLibre expressions can't compare a `get`
         *  result against a JSON null literal, so the layer falls back
         *  to a `has` check and paints the dot plain "reachable" cyan
         *  until the number lands. The hider map uses this to triage
         *  candidate hiding zones: a station that's technically
         *  reachable but trivially reachable for seekers too is a bad
         *  strategic pick, and the colour reflects that without
         *  forcing the hider to do the math themselves. */
        safetyMinutes?: number;
    }
> | null>(null);

/* ─────────────────────── Seeker trip planner ─────────────────────── */

/** Volatile open/closed state for the seeker's trip-planner drawer.
 *  Not persisted — closing the app resets it. */
export const seekerTripPlannerOpen = atom<boolean>(false);

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
} | null>(null);
