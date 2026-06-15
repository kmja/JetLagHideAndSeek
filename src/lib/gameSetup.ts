import { persistentAtom } from "@nanostores/persistent";
import { atom } from "nanostores";

import { displayHidingZones } from "@/lib/context";

/**
 * Game setup state — the result of the 3-step onboarding flow that runs on
 * first load and via the "New game" action in the bottom nav.
 */

/**
 * Transit modes that meaningfully change what's available in the game.
 * Per the rulebook, walking is always permitted (so we don't list it),
 * and motor vehicles / bikes aren't part of the standard transit set —
 * the seeker needs to think in terms of public-transit-reachability.
 * Bus is technically valid but opens up far too many options to make
 * for an interesting game, so it's off by default.
 */
export type TransitMode = "bus" | "tram" | "train" | "subway" | "ferry";

export type GameSize = "small" | "medium" | "large";

/** Whether the setup wizard has been completed at least once. */
export const setupCompleted = persistentAtom<boolean>(
    "setupCompleted",
    false,
    { encode: JSON.stringify, decode: JSON.parse },
);

/**
 * Whether the user has dismissed the first-load welcome screen. The
 * welcome screen takes precedence over the setup wizard — while
 * `welcomeSeen` is false, the wizard suppresses its auto-open so the
 * two don't race.
 */
export const welcomeSeen = persistentAtom<boolean>("welcomeSeen", false, {
    encode: JSON.stringify,
    decode: JSON.parse,
});

/** The play area as a named place + coordinates. */
export const playArea = persistentAtom<{
    displayName: string;
    lat: number;
    lng: number;
} | null>("playArea", null, {
    encode: JSON.stringify,
    decode: JSON.parse,
});

/**
 * Allowed transit modes for this session. Default is train + subway —
 * the most iconic Jet Lag transit and what the YouTube series uses
 * most. Adding bus is a power-user choice because it dramatically
 * expands the search space.
 */
export const allowedTransit = persistentAtom<TransitMode[]>(
    "allowedTransit",
    ["train", "subway"],
    { encode: JSON.stringify, decode: JSON.parse },
);

/** Hiding zone size category. Per the rulebook this controls both the
 *  geographic scope of the game and the length of the hiding period. */
export const gameSize = persistentAtom<GameSize>("gameSize", "medium", {
    encode: (v) => v,
    decode: (v) => v as GameSize,
});

/** Top-right map display toggles. */
export const satelliteView = persistentAtom<boolean>("satelliteView", false, {
    encode: JSON.stringify,
    decode: JSON.parse,
});
/**
 * Rail-lines overlay. Drives a single OpenRailwayMap raster tile layer
 * which renders *all* rail modes (subway, tram, train, light rail,
 * narrow gauge, monorail, funicular) bundled into one image — the tile
 * server doesn't expose a per-mode filter, so all rail modes share this
 * toggle. The original atom name is preserved for localStorage backward
 * compatibility.
 */
export const showTransitLines = persistentAtom<boolean>(
    "showTransitLines",
    false,
    { encode: JSON.stringify, decode: JSON.parse },
);

/**
 * Bus-routes overlay. Rendered via an Overpass GeoJSON fetch
 * (`route=bus` relations within the play area) — OpenRailwayMap doesn't
 * cover buses. Off by default because bus networks can be dense and the
 * fetch is slow on first run.
 */
export const showBusRoutes = persistentAtom<boolean>(
    "showBusRoutes",
    false,
    { encode: JSON.stringify, decode: JSON.parse },
);

/**
 * Ferry-routes overlay. Rendered via an Overpass GeoJSON fetch
 * (`route=ferry` relations/ways within the play area).
 */
export const showFerryRoutes = persistentAtom<boolean>(
    "showFerryRoutes",
    false,
    { encode: JSON.stringify, decode: JSON.parse },
);

/**
 * Subway-routes overlay. Independent of the general rail layer
 * (OpenRailwayMap), which bundles all rail modes into one image and
 * can't be filtered. This Overpass-fetched layer pulls
 * `route=subway` relations so you can see subway lines on their own —
 * useful in cities where the rail layer is dense with mainline tracks
 * obscuring the metro.
 */
export const showSubwayRoutes = persistentAtom<boolean>(
    "showSubwayRoutes",
    false,
    { encode: JSON.stringify, decode: JSON.parse },
);

/**
 * What to preload during the hiding period.
 *
 * Players on slow connections / pay-per-MB plans may not want the
 * full ~5-20 MB pre-warm — they'd rather defer some categories to
 * lazy fetch on tap. The wizard's Step 4 lets them pick which
 * buckets to pre-warm, and the same toggles live in
 * Settings so they can flip them mid-game (a deferred bucket can
 * still be loaded later from the Settings sheet).
 *
 * Three coarse buckets, mapping to the real fetch boundaries:
 *
 *   `map`        — play-area boundary polygon + base map tiles.
 *                  Already runs at play-area pick time (Map.tsx);
 *                  toggling this off SKIPS the on-demand tile
 *                  preload that the user kicks off via the existing
 *                  OfflineTilePreloader path. Default ON since the
 *                  boundary is a few hundred KB max.
 *   `references` — all 15 reference families
 *                  (STANDARD_REFERENCE_FAMILIES). The big bucket
 *                  — a dense city like London is 1-5 MB depending
 *                  on POI density. Default ON because every
 *                  matching/measuring question depends on it.
 *   `transit`    — the OpenRailwayMap raster overlay + HSR country
 *                  data + transit arrival times via the journey
 *                  worker. Bundled together because they're all
 *                  "transit-related extras" that some games don't
 *                  use. Default ON since most games answer at least
 *                  one HSR/transit question.
 *
 * `prefetchFamiliesInOneQuery` is the actual cost driver; the
 * other two are tiny by comparison. We expose all three to keep the
 * UI obvious — players can flip any bucket without surprise.
 */
export interface PreloadChoices {
    map: boolean;
    references: boolean;
    transit: boolean;
}
export const preloadChoices = persistentAtom<PreloadChoices>(
    "preloadChoices",
    { map: true, references: true, transit: true },
    {
        encode: JSON.stringify,
        decode: (s) => {
            try {
                const parsed = JSON.parse(s);
                return {
                    map: parsed?.map !== false,
                    references: parsed?.references !== false,
                    transit: parsed?.transit !== false,
                };
            } catch {
                return { map: true, references: true, transit: true };
            }
        },
    },
);

/**
 * Reset every map display overlay to its default OFF state. Called on
 * new game / new round / settings change so a fresh game never inherits
 * a stale overlay (e.g. a transit layer left on from a previous game).
 */
export function resetMapOverlays() {
    satelliteView.set(false);
    showTransitLines.set(false);
    showBusRoutes.set(false);
    showSubwayRoutes.set(false);
    showFerryRoutes.set(false);
    // Hiding-zones analysis overlay lives in context.ts. Plain static
    // import — there's no circular dep going the other way.
    displayHidingZones.set(false);
}

/** Volatile: is the setup wizard currently shown? */
export const setupDialogOpen = atom<boolean>(false);

/**
 * Volatile: is the seeker "More" sheet currently open? v241+ moved
 * the trigger from the bottom-nav into the new SeekerTopBar's settings
 * icon, but the sheet content itself still lives inside BottomNav for
 * now (single React tree, easy state share). The shared atom lets the
 * top bar open it without lifting the JSX.
 */
export const moreSheetOpen = atom<boolean>(false);

/**
 * Volatile per-mode loading state for the Overpass-fetched transit
 * overlays (subway / bus / ferry). The TransitRoutesOverlay component
 * writes to this whenever it kicks off or finishes a fetch; the
 * MapDisplayControls reads it to surface a spinner on the active
 * toggle and avoid showing the button as "active" before the routes
 * have actually rendered.
 *
 * Not persisted — these flags are derived from in-flight network
 * activity and should reset to `false` on every page load.
 *
 * Bound to `globalThis` so HMR re-imports of this file return the
 * same atom instance — the same pattern context.ts uses for its
 * cross-island atoms. Without this, a dev-mode HMR cycle creates a
 * fresh atom; existing subscribers stay attached to the old one and
 * never see updates from the new one, which manifests as the
 * loading spinner silently not firing.
 */
type TransitLoadingState = {
    subway: boolean;
    bus: boolean;
    ferry: boolean;
};
const __TRANSIT_LOADING_KEY = "__jlhs_transitRoutesLoading";
export const transitRoutesLoading: ReturnType<
    typeof atom<TransitLoadingState>
> = (() => {
    const g = globalThis as Record<string, unknown>;
    if (!g[__TRANSIT_LOADING_KEY]) {
        g[__TRANSIT_LOADING_KEY] = atom<TransitLoadingState>({
            subway: false,
            bus: false,
            ferry: false,
        });
    }
    return g[__TRANSIT_LOADING_KEY] as ReturnType<typeof atom<TransitLoadingState>>;
})();

/**
 * Unix timestamp (ms) at which the hiding period ends. Null when no
 * hiding period is currently running. Persisted so the timer survives
 * page reloads — a 3-hour hiding period for a Large game needs to be
 * resilient.
 */
export const hidingPeriodEndsAt = persistentAtom<number | null>(
    "hidingPeriodEndsAt",
    null,
    {
        encode: (v) => (v === null ? "" : String(v)),
        decode: (v) => (v ? Number(v) : null),
    },
);

/**
 * Hiding-period duration (minutes) waiting for the boundary load
 * to finish before the clock actually starts. Set by the wizard's
 * Finish handler; cleared by GameStartWatcher once the map is
 * actually ready, at which point hidingPeriodEndsAt gets set to
 * `now + duration * 60_000` and the GO GO GO moment fires.
 *
 * Persisted so a reload mid-load doesn't drop the pending start.
 */
export const pendingHidingDurationMin = persistentAtom<number | null>(
    "pendingHidingDurationMin",
    null,
    {
        encode: (v) => (v === null ? "" : String(v)),
        decode: (v) => (v ? Number(v) : null),
    },
);

/**
 * Unix ms when the seeker has triggered the endgame — "I'm close,
 * lock down to your final spot" per rulebook p43. The hider's UI
 * watches this and surfaces a banner the moment it flips so they
 * know to commit to a fixed location instead of moving with the
 * subway. Set by `seekerStartEndgame()`; also written by the
 * multiplayer bridge on setupChanged so guests pick up the trigger
 * from the host. Persisted so a reload mid-endgame keeps the banner
 * up (same rationale as hidingPeriodEndsAt).
 */
export const endgameStartedAt = persistentAtom<number | null>(
    "endgameStartedAt",
    null,
    {
        encode: (v) => (v === null ? "" : String(v)),
        decode: (v) => (v ? Number(v) : null),
    },
);

/**
 * Volatile celebration trigger — unix ms set the moment the hiding
 * period actually starts (after the boundary load completes). The
 * GoGoGoOverlay component watches this and shows the catchphrase
 * banner for a few seconds before clearing itself.
 *
 * Not persisted: a reload should NOT replay the banner.
 */
export const gameStartCelebrationAt = atom<number | null>(null);

/**
 * Volatile celebration trigger — unix ms set the moment the hiding
 * period CLOCK actually hits zero (either by the timer counting down
 * or by the hider tapping End hiding early). The SeekingStartOverlay
 * watches this and shows the "seeking phase starts NOW" banner for a
 * few seconds before clearing itself. Both seeker and hider see it
 * because it's the round's other major beat.
 *
 * Not persisted: a reload should NOT replay the banner.
 */
export const seekingStartCelebrationAt = atom<number | null>(null);

/**
 * Persistent record of the `hidingPeriodEndsAt` value we already
 * fired the seeking-start celebration for. Stops the watcher from
 * re-firing across reloads or React strict-mode re-renders. Cleared
 * (set to null) by startNewRound/Game so the next round can fire
 * cleanly.
 */
export const seekingStartFiredFor = persistentAtom<number | null>(
    "jlhs:seekingStartFiredFor",
    null,
    {
        encode: (v) => (v === null ? "" : String(v)),
        decode: (v) => (v ? Number(v) : null),
    },
);

/**
 * Highest "seekers are closing in" warning level the hider has been
 * shown this round. 0 = none, 1 = soft warning, 2 = urgent warning.
 * Persistent so a reload doesn't replay the dialog; cleared by
 * startNewRound / startNewGame.
 */
export const closingInWarningLevel = persistentAtom<0 | 1 | 2>(
    "jlhs:closingInWarningLevel",
    0,
    {
        encode: (v) => String(v),
        decode: (v) => {
            const n = Number(v);
            return n === 1 || n === 2 ? n : 0;
        },
    },
);

/**
 * GPS position captured the moment the hiding period starts — the
 * shared departure point for both hider and all seekers. Used as the
 * travel-times anchor: "which stations could the hider reach from here
 * within the hiding-period budget?"
 *
 * Set by GameStartWatcher on the null→non-null transition of
 * hidingPeriodEndsAt. Cleared by startNewRound / startNewGame.
 */
export const gameStartPosition = persistentAtom<{
    lat: number;
    lng: number;
} | null>("jlhs:gameStartPosition", null, {
    encode: (v) => (v === null ? "" : JSON.stringify(v)),
    decode: (v) => {
        try {
            return v ? JSON.parse(v) : null;
        } catch {
            return null;
        }
    },
});

/** Hiding period duration in minutes, per the rulebook (image 2). */
export const HIDING_PERIOD_MINUTES: Record<GameSize, number> = {
    small: 30,
    medium: 60,
    large: 180,
};

/**
 * Rulebook copy for each size, used in step 3 of the setup wizard.
 * Verbatim from the printed rulebook so seekers/hiders recognise it.
 */
export const SIZE_DESCRIPTIONS: Record<
    GameSize,
    { spans: string; lasts: string; examples: string }
> = {
    small: {
        spans: "A single town, small city, or portion of a large city",
        lasts: "4-8 hours",
        examples: "Lower Manhattan; Winston-Salem, NC",
    },
    medium: {
        spans: "A major city, metro area, or region",
        lasts: "about 1 day",
        examples: "Hong Kong; New York City; Greater London, UK",
    },
    large: {
        spans: "A large region, an entire country, or several small countries",
        lasts: "2 to 4 days",
        examples: "Switzerland; Japan; New England, US",
    },
};

/** Human-readable labels for each transit mode. */
export const TRANSIT_LABELS: Record<TransitMode, string> = {
    bus: "Bus",
    tram: "Tram",
    train: "Train",
    subway: "Subway",
    ferry: "Ferry",
};

/** Format milliseconds-remaining as MM:SS (or H:MM:SS over an hour). */
export function formatTimeRemaining(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n: number) => String(n).padStart(2, "0");
    if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
    return `${pad(m)}:${pad(s)}`;
}
