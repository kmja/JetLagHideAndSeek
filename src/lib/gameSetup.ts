import { persistentAtom } from "@nanostores/persistent";
import {
    Bus,
    type LucideIcon,
    Ship,
    TrainFront,
    TrainFrontTunnel,
    TramFront,
} from "lucide-react";
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
 * Bus-routes overlay. Rendered via an Overpass GeoJSON fetch
 * (`route=bus` relations within the play area). Off by default because
 * bus networks can be dense and the fetch is slow on first run.
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
 * Subway-routes overlay. An Overpass-fetched layer that pulls
 * `route=subway` relations so you can see metro lines on their own,
 * distinct from the train/tram line overlays.
 */
export const showSubwayRoutes = persistentAtom<boolean>(
    "showSubwayRoutes",
    false,
    { encode: JSON.stringify, decode: JSON.parse },
);

/**
 * Train-routes overlay (v334). `route=train` relations: regional
 * commuter + intercity named services, giving train/tram users the
 * same colored-overlay treatment subway/bus/ferry already had.
 * Default off because train networks can be dense on first fetch in
 * well-mapped countries.
 */
export const showTrainRoutes = persistentAtom<boolean>(
    "showTrainRoutes",
    false,
    { encode: JSON.stringify, decode: JSON.parse },
);

/**
 * Tram-routes overlay (v334). `route=tram` relations. Sparser than
 * subway globally (~few hundred cities have a tram network) but
 * dense within them; the per-shard prewarm fits comfortably under
 * the reduce cap. Same default-off + colored-toggle pattern.
 */
export const showTramRoutes = persistentAtom<boolean>(
    "showTramRoutes",
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
 *                  Boundary already runs at play-area pick time
 *                  (Map.tsx); this bucket adds the PMTiles z11→z15
 *                  walk for the play-area bbox so zoom-ins don't
 *                  stutter mid-game. See preloadTilesForPlayArea.
 *                  Default ON since the boundary alone is a few
 *                  hundred KB; the tile walk is gated on this
 *                  toggle too.
 *   `references` — all 15 reference families
 *                  (STANDARD_REFERENCE_FAMILIES). The big bucket
 *                  — a dense city like London is 1-5 MB depending
 *                  on POI density. Default ON because every
 *                  matching/measuring question depends on it.
 *   `transit`    — per-mode route-line overlays + HSR country data +
 *                  transit arrival times via the journey worker.
 *                  Bundled together because they're all
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
 * Persisted timestamps for when each preload bucket last completed
 * successfully. Cleared on new game (play area changes, so cached data
 * is stale). Not cleared on new round — the play area is the same, the
 * Overpass / transit data is still valid.
 */
export interface PreloadBucketTimestamps {
    map: number | null;
    references: number | null;
    transit: number | null;
}
export const preloadBucketTimestamps = persistentAtom<PreloadBucketTimestamps>(
    "preloadBucketTimestamps",
    { map: null, references: null, transit: null },
    {
        encode: JSON.stringify,
        decode: (s) => {
            try {
                const p = JSON.parse(s);
                return {
                    map: typeof p?.map === "number" ? p.map : null,
                    references:
                        typeof p?.references === "number" ? p.references : null,
                    transit:
                        typeof p?.transit === "number" ? p.transit : null,
                };
            } catch {
                return { map: null, references: null, transit: null };
            }
        },
    },
);

/** Volatile: which preload buckets are currently downloading. Resets on reload. */
export const preloadBucketInFlight = atom<{
    map: boolean;
    references: boolean;
    transit: boolean;
}>({ map: false, references: false, transit: false });

/**
 * User-facing STOP for the preload (v931). Persisted so a stop survives a
 * reload. While true the orchestrator refuses to (re)start any bucket and
 * `stopPreload()` aborts the in-flight map download; `resumePreload()`
 * clears it and re-runs the enabled buckets (completed work is cache-hit,
 * so resume continues rather than restarts).
 */
export const preloadPaused = persistentAtom<boolean>("preloadPaused", false, {
    encode: (v) => (v ? "1" : ""),
    decode: (v) => v === "1",
});

/** Persisted byte sizes for each preload bucket. v368: was volatile, so
 *  after a reload the badge fell back to "Downloaded (cached)" — accurate
 *  but less informative. Now persisted alongside `preloadBucketTimestamps`
 *  so a reload of the same play area keeps the "Downloaded — 12.3 MB"
 *  detail. Wiped by the v367 play-area-change watcher in `preload.ts` in
 *  lockstep with the timestamps, so the badges stay honest across
 *  switches.
 *
 *  Tiny localStorage footprint (three numbers), so persisting them has
 *  effectively zero cost. */
type PreloadBucketBytes = {
    map: number | null;
    references: number | null;
    transit: number | null;
};
export const preloadBucketBytes = persistentAtom<PreloadBucketBytes>(
    "preloadBucketBytes",
    { map: null, references: null, transit: null },
    {
        encode: JSON.stringify,
        decode: (s) => {
            try {
                const p = JSON.parse(s);
                return {
                    map: typeof p?.map === "number" ? p.map : null,
                    references:
                        typeof p?.references === "number" ? p.references : null,
                    transit:
                        typeof p?.transit === "number" ? p.transit : null,
                };
            } catch {
                return { map: null, references: null, transit: null };
            }
        },
    },
);

/**
 * Live progress for the map bucket. The map preload walks z11→z15 and
 * issues one byte-range request per tile in the bbox (thousands for a
 * large city), so its wall-time is dominated by request latency rather
 * than raw bytes — a generic "Downloading…" with no count reads as
 * stalled (the v319 16 MB / many-minutes report). This atom is set
 * once at the start of a map preload with the planned tile total, then
 * updated as each tile completes; cleared when the run ends.
 *
 * References + transit don't get the same treatment: references is a
 * single combined Overpass query (no meaningful sub-progress), and
 * transit has only 4 sub-fetches (HSR + 3 modes) — both finish fast
 * enough that the spinner is enough signal.
 */
export interface MapPreloadProgress {
    /** Tiles completed (succeeded OR failed — what matters is "done"). */
    tilesDone: number;
    /** Total tiles planned across all in-scope zoom levels. */
    tilesTotal: number;
    /** Zoom level currently being walked. */
    currentZoom: number;
    /** Wire bytes accumulated so far (from CountingSource, or the
     *  pack download stream when phase === "pack"). */
    bytesFetched: number;
    /** Where we are in the run. "header" = PMTiles directory read
     *  before any tiles; "tiles" = the per-tile range walk; "pack" =
     *  downloading a single city tile pack (v336), in which case
     *  bytesFetched / packTotalBytes drive the bar instead of
     *  tilesDone / tilesTotal. */
    phase: "header" | "tiles" | "pack";
    /** Total pack size in bytes (Content-Length) when phase === "pack".
     *  Null when the server didn't send a length. */
    packTotalBytes?: number | null;
}
export const preloadMapProgress = atom<MapPreloadProgress | null>(null);

/**
 * Per-step detail for the Transit bucket's preload progress (v335).
 * The transit bucket fans out into multiple parallel fetches (HSR
 * country, then each route mode + the journey-arrivals warm-up); a
 * generic "Downloading…" left users staring at a spinner with no
 * idea what was happening. This atom names the active step so the
 * panel can surface "HSR network…", "Subway routes…", "Arrivals…"
 * — same shape as the map bucket's per-zoom phase string.
 */
export type TransitPreloadStep =
    | "hsr"
    | "subway"
    | "bus"
    | "ferry"
    | "train"
    | "tram"
    | "arrivals";

export interface TransitPreloadProgress {
    /** Which steps are CURRENTLY in flight. Multiple are possible —
     *  the modes fire in parallel — so the UI can join them with "+"
     *  rather than picking one to show. */
    active: TransitPreloadStep[];
    /** Steps that finished (success or error). Drives the
     *  N-of-total summary in the panel. */
    done: TransitPreloadStep[];
    /** Total steps this run will attempt; used by the UI as the
     *  denominator for "2 / 6". Set once at the start of the run. */
    total: number;
}
export const preloadTransitProgress = atom<TransitPreloadProgress | null>(
    null,
);

/**
 * Reset every map display overlay to its default OFF state. Called on
 * new game / new round / settings change so a fresh game never inherits
 * a stale overlay (e.g. a transit layer left on from a previous game).
 */
export function resetMapOverlays() {
    satelliteView.set(false);
    showBusRoutes.set(false);
    showSubwayRoutes.set(false);
    showFerryRoutes.set(false);
    showTrainRoutes.set(false);
    showTramRoutes.set(false);
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
 * Volatile: is the seeker "Map" options drawer open? v622 moved the
 * map-display toggles off the floating bottom-left chip into a
 * bottom-nav "Map" slot (mobile); this atom lets that slot open the
 * shared drawer. The floating chip stays on desktop (no bottom nav).
 */
export const mapOptionsDrawerOpen = atom<boolean>(false);

/**
 * Volatile: is the celebratory end-of-round dialog open? Auto-opened by
 * `EndOfRoundDialog` when `roundFoundAt` transitions null→number (on both
 * the seeker and hider, since both watch the same atom). v631.
 */
export const endOfRoundDialogOpen = atom<boolean>(false);

/**
 * Volatile: the HIDER's authoritative round result, synced to the room over
 * the wire on round-end (v851). The seeker can't compute the hider's Move
 * credit, late-answer debit, or in-hand time bonuses locally, so the hider
 * publishes them: `roundEndBaseMs` is the base clock and
 * `roundEndBonusPieces` is the per-card time-bonus contributions (minutes).
 * The end-of-round dialog prefers these when set (seeker); the hider's own
 * device + solo fall back to the local hand. Cleared per round.
 */
export const roundEndBaseMs = atom<number | null>(null);
export const roundEndBonusPieces = atom<number[] | null>(null);

/**
 * Volatile: the display name of the hider who just finished, SNAPSHOTTED at
 * round-end (v879). Fixes the leaderboard bug where past-round names shifted
 * to the NEXT hider: `startNewRound` used to resolve the name from the LIVE
 * roster, but by then the "New round" button had already rotated roles to the
 * incoming hider, so every stored row got the wrong name. Captured the moment
 * the round ends (before any rotation) and preferred by `startNewRound` +
 * `EndOfRoundDialog`. Cleared per round.
 */
export const roundEndHiderName = atom<string | null>(null);

/**
 * Volatile: show the on-map "zone locked in" callout near the hider's
 * timer (v798)? Set true by `confirmAndCommitZone` right after a zone is
 * committed DURING the hiding period — it replaces the old second modal
 * ("End it now / Keep timer running") with a lightweight callout that
 * points at the hiding timer (where the end-early action lives). Gated on
 * `phase === "hiding"` by the renderer, so it auto-hides once the period
 * ends; the hider dismisses it via "Keep timer running".
 */
export const zoneLockedCallout = atom<boolean>(false);

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
    train: boolean;
    tram: boolean;
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
            train: false,
            tram: false,
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
        // v820: NEVER persist / decode a non-finite clock. A corrupt
        // gameSize can make `Date.now() + minutes*60_000` evaluate to NaN
        // (minutes = HIDING_PERIOD_MINUTES[badSize] = undefined), and a
        // NaN clock is catastrophic: `NaN === NaN` is false, so BOTH the
        // GameStart and SeekingStart watchers' value-keyed dedupe can never
        // hold — they re-fire GO-GO-GO + SEEK on every render/tick forever
        // (the "three overlays thrash, map freezes" bug). Coercing NaN →
        // null here means a corrupt value reads as "no game" (→ lobby),
        // never as a frozen, un-dismissable in-game shell.
        encode: (v) =>
            v === null || !Number.isFinite(v) ? "" : String(v),
        decode: (v) => {
            if (!v) return null;
            const n = Number(v);
            return Number.isFinite(n) ? n : null;
        },
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
        // v820: same non-finite guard as hidingPeriodEndsAt — a corrupt
        // stored value must decode to null, not NaN, so it can't poison the
        // `minutes` computation that arms the clock.
        encode: (v) =>
            v === null || !Number.isFinite(v) ? "" : String(v),
        decode: (v) => {
            if (!v) return null;
            const n = Number(v);
            return Number.isFinite(n) ? n : null;
        },
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
 * Unix ms when the HIDER confirmed the seekers really are in their zone
 * (positive response to the seeker's endgame claim in `endgameStartedAt`).
 * Null while the claim is still pending or after a refute. The seeker UI
 * flips from "waiting for the hider to confirm" to "you're in the right
 * zone — find them" when this is set. Persisted alongside
 * `endgameStartedAt` so a reload keeps the resolved state.
 */
export const endgameConfirmedAt = persistentAtom<number | null>(
    "endgameConfirmedAt",
    null,
    {
        encode: (v) => (v === null ? "" : String(v)),
        decode: (v) => (v ? Number(v) : null),
    },
);

/**
 * v950 volatile — unix ms of the last DENIED endgame attempt (the server
 * validated a seeker's claim as NOT at the hider's zone). Drives a transient
 * full-screen fail animation for BOTH roles (seeker: "not the right zone";
 * hider: "endgame attempted"); the `EndgameOverlay` auto-clears it after a few
 * seconds. Not persisted — a denial is a fleeting moment.
 */
export const endgameDeniedAt = atom<number | null>(null);

/**
 * Volatile celebration trigger — unix ms set the moment the endgame is
 * ARMED (a correct claim: the server validated the seekers really are at the
 * hider's zone, or solo/offline self-confirm). Drives the big full-screen
 * `EndgameOverlay` success animation on BOTH roles. Not persisted — a
 * one-shot beat, not a state a reload should replay.
 */
export const endgameSuccessAt = atom<number | null>(null);

/** The final hiding zone the seekers correctly reached — recorded when the
 *  endgame is confirmed so the seeker map can CUT down to just this zone
 *  (spotlight the circle, dim everything else, frame the camera on it).
 *  Persisted so the focus survives a reload while the endgame is live. */
export interface EndgameZone {
    lat: number;
    lng: number;
    radiusMeters: number;
    name: string;
}
export const endgameZone = persistentAtom<EndgameZone | null>(
    "endgameZone",
    null,
    {
        encode: JSON.stringify,
        decode: (v) => {
            try {
                const z = JSON.parse(v) as EndgameZone | null;
                if (
                    z &&
                    Number.isFinite(z.lat) &&
                    Number.isFinite(z.lng) &&
                    Number.isFinite(z.radiusMeters)
                )
                    return z;
            } catch {
                /* corrupt → null */
            }
            return null;
        },
    },
);

/** Volatile — the zone a seeker just DECLARED but the server hasn't yet
 *  validated. On a correct verdict it's promoted to `endgameZone`; on a
 *  denial it's dropped. */
export const pendingEndgameZone = atom<EndgameZone | null>(null);

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
 * Volatile "the game-start flourish is playing OVER the lobby" flag
 * (v814). Set true synchronously the instant the hiding period is armed
 * from the lobby (host) or a `setupChanged` start push (guest), and
 * cleared when the GoGoGo card is dismissed. While it's true the
 * pre-game branch (SeekerPage/HiderPage) stays mounted and the lobby
 * stays open, so the 3-2-1 countdown + GO-GO-GO explosion play OVER the
 * lobby and the lobby fades away behind the deepening backdrop — instead
 * of the branch instantly swapping to the map (which flashed the seeker
 * view before the overlay appeared). Distinct from
 * `gameStartCelebrationAt` because a mid-game Move powerup ALSO re-fires
 * that celebration, and Move must NOT bounce the player back to the
 * lobby view — only the initial start sets this flag.
 */
export const gameStartOverLobby = atom<boolean>(false);

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
 * v245 sister of `seekingStartFiredFor` — dedupe key for the
 * GoGoGoOverlay's "we gotta go go go" trigger. Without this,
 * GameStartWatcher would re-pop the overlay every time a peer
 * snapshot writes the same `hidingPeriodEndsAt` value through a
 * null bounce (e.g. the lobby's autohost self-heal creates a fresh
 * room, the server snapshot wipes hidingPeriodEndsAt to null, then
 * a subsequent setupChanged restores the real value — that
 * round-trip looked like a fresh game-start to the watcher even
 * though the user had already dismissed the overlay).
 */
export const gameStartFiredFor = persistentAtom<number | null>(
    "jlhs:gameStartFiredFor",
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
 * Fresh-hiding-period granted by the Move powerup, per the printed
 * card: 10 min (S) / 20 min (M) / 60 min (L). Shorter than the initial
 * hiding period — Move re-anchors mid-round, it doesn't restart the
 * whole game.
 */
export const MOVE_PERIOD_MINUTES: Record<GameSize, number> = {
    small: 10,
    medium: 20,
    large: 60,
};

/**
 * Unix ms until which the seekers are frozen by a Move powerup (the
 * end of the fresh hiding period it grants). Null when no freeze is
 * active. The seeker UI surfaces a "seekers frozen" banner while
 * `now < seekersFrozenUntil`. Persisted so a reload mid-freeze keeps
 * the banner up; cleared each new round/game.
 */
export const seekersFrozenUntil = persistentAtom<number | null>(
    "seekersFrozenUntil",
    null,
    {
        encode: (v) => (v === null ? "" : String(v)),
        // Guard against a corrupt/NaN value ever surviving a reload — a
        // stored "NaN" decodes to NaN, which the frozen banner renders as
        // "NaN:NaN". Only a finite timestamp is a valid freeze.
        decode: (v) => {
            if (!v) return null;
            const n = Number(v);
            return Number.isFinite(n) ? n : null;
        },
    },
);

/**
 * The hider's transit-station location revealed to the seekers by a Move
 * powerup (Move: "send the seekers the location of your transit station").
 * The seeker map drops a marker at this point; null when no Move reveal is
 * active. Synced via `SetupState.revealedStation`; cleared each round.
 */
export interface RevealedStation {
    lat: number;
    lng: number;
    name?: string;
}
export const revealedStation = persistentAtom<RevealedStation | null>(
    "revealedStation",
    null,
    {
        encode: (v) => (v === null ? "" : JSON.stringify(v)),
        decode: (v) => {
            if (!v) return null;
            try {
                return JSON.parse(v) as RevealedStation;
            } catch {
                return null;
            }
        },
    },
);

/**
 * Banked hidden-time (ms) the hider accrued in earlier seeking
 * segments before re-anchoring with a Move powerup. Headline scoring
 * is `(foundAt - hidingPeriodEndsAt) + hiddenCreditMs`, so a Move
 * pauses rather than discards the time already survived. Zero in the
 * common (no-Move) case; reset each new round/game.
 */
export const hiddenCreditMs = persistentAtom<number>(
    "hiddenCreditMs",
    0,
    {
        encode: String,
        decode: (v) => Number(v) || 0,
    },
);

/**
 * Accumulated time (ms) the hider's clock was *paused* because a
 * question went unanswered past its window (rulebook p61: "the hider's
 * time is paused until the question is answered"). Headline scoring
 * subtracts this, so overdue answers don't reward the hider with the
 * stall time. Zero in the common (always-on-time) case; reset each
 * new round/game.
 */
export const hiddenDebitMs = persistentAtom<number>(
    "hiddenDebitMs",
    0,
    {
        encode: String,
        decode: (v) => Number(v) || 0,
    },
);

/* ───────────── Seekers-must-share-location pause ───────────── */

/**
 * Seekers are required to share their live location during the seeking
 * phase. `locationGraceStartedAt` is the Unix ms a seeker went STALE (null
 * when a fresh location is flowing). v940: a much more LENIENT escalation
 * replaces the old flat 5-min-to-pause — once stale, the seeker is nudged by
 * a reminder push at 5 min and again at 10 min (server-driven, so it reaches
 * a backgrounded phone), and only at 15 min — after a visible 5-min
 * countdown that starts at the 10-min mark — does the game actually pause
 * (`gamePausedForLocationAt`). Persistent so a reload mid-grace/pause doesn't
 * lose the state. Both reset each new round/game.
 */
/** A seeker location older than this counts as "not sharing". v940: 90s
 *  (was 60s). The seeker heartbeat is 30s, so this tolerates ~2 missed beats
 *  + clock skew before a seeker reads as stale — more lenient. */
export const LOCATION_SHARE_FRESH_MS = 90 * 1000;
/** First reminder push, measured from when the seeker went stale. */
export const LOCATION_REMINDER_1_MS = 5 * 60 * 1000;
/** Second reminder push + the moment the visible pause countdown begins. */
export const LOCATION_REMINDER_2_MS = 10 * 60 * 1000;
/** Total stale time before the game pauses. */
export const LOCATION_PAUSE_AFTER_MS = 15 * 60 * 1000;
/** Visible countdown window (reminder 2 → pause) = 5 min. */
export const LOCATION_COUNTDOWN_MS =
    LOCATION_PAUSE_AFTER_MS - LOCATION_REMINDER_2_MS;

export const locationGraceStartedAt = persistentAtom<number | null>(
    "locationGraceStartedAt",
    null,
    {
        encode: (v) => (v === null ? "" : String(v)),
        decode: (v) => (v ? Number(v) : null),
    },
);

/**
 * v940: the seekers are sharing location by some OTHER means (a dedicated
 * tracker), so the app's location-freshness enforcement stands down — no
 * banner, no reminder pushes, no clock pause. Synced room-wide via
 * `SetupState.locationTrackingExternal`; any participant can toggle it (the
 * banner's "we're tracking another way" dismiss). Persistent so a reload
 * mid-game keeps the choice; reset only on a brand-new GAME.
 */
export const locationTrackingExternal = persistentAtom<boolean>(
    "jlhs:locationTrackingExternal",
    false,
    {
        encode: (v) => (v ? "1" : "0"),
        decode: (v) => v === "1",
    },
);

/**
 * Unix ms the game paused because no seeker was sharing location past
 * the grace window. While set, the hider's clock is frozen — scoring
 * subtracts the in-progress pause live, and banks it into
 * `hiddenDebitMs` on resume. Null when the game is running.
 */
export const gamePausedForLocationAt = persistentAtom<number | null>(
    "gamePausedForLocationAt",
    null,
    {
        encode: (v) => (v === null ? "" : String(v)),
        decode: (v) => (v ? Number(v) : null),
    },
);

/* ─────────────────── Manual game pause (rulebook) ─────────────────── */

/**
 * Unix ms the game was MANUALLY paused (rulebook "General Tips": you can
 * always pause; all in-game timers stop; on resume everyone is where the
 * pause began). Distinct from the location-share pause
 * (`gamePausedForLocationAt`) so the two can't stomp each other, but it
 * feeds the SAME `effectiveHiddenDebitMs` scoring freeze. Null when
 * running. Reset each round via `resetSharedRoundState`.
 */
export const manualPausedAt = persistentAtom<number | null>(
    "jlhs:manualPausedAt",
    null,
    {
        encode: (v) => (v === null ? "" : String(v)),
        decode: (v) => (v ? Number(v) : null),
    },
);

/**
 * Whether the current manual pause began DURING the hiding period. On
 * resume this decides how the pause is repaid: a hiding-period pause
 * shifts `hidingPeriodEndsAt` forward (the countdown resumes where it
 * stopped); a seeking pause banks into `hiddenDebitMs` (scored time
 * freezes). Only meaningful while `manualPausedAt` is set.
 */
export const manualPauseWasHiding = persistentAtom<boolean>(
    "jlhs:manualPauseWasHiding",
    false,
    {
        encode: (v) => (v ? "1" : ""),
        decode: (v) => v === "1",
    },
);

/**
 * v942 (durability): the HIDER's scored-time ledger + pause-clock state as
 * one blob, synced to the server so it survives that hider's device dying.
 * `readRoundProgress` snapshots the six owning atoms; `applyRoundProgress`
 * adopts an inbound blob. Mirrors `readSharedDeckState`/`applySharedDeckState`.
 */
export interface RoundProgressSnapshot {
    hiddenCreditMs: number;
    hiddenDebitMs: number;
    manualPausedAt: number | null;
    manualPauseWasHiding: boolean;
    gamePausedForLocationAt: number | null;
    locationGraceStartedAt: number | null;
}

export function readRoundProgress(): RoundProgressSnapshot {
    return {
        hiddenCreditMs: hiddenCreditMs.get(),
        hiddenDebitMs: hiddenDebitMs.get(),
        manualPausedAt: manualPausedAt.get(),
        manualPauseWasHiding: manualPauseWasHiding.get(),
        gamePausedForLocationAt: gamePausedForLocationAt.get(),
        locationGraceStartedAt: locationGraceStartedAt.get(),
    };
}

export function applyRoundProgress(p: RoundProgressSnapshot): void {
    if (Number.isFinite(p.hiddenCreditMs)) hiddenCreditMs.set(p.hiddenCreditMs);
    if (Number.isFinite(p.hiddenDebitMs)) hiddenDebitMs.set(p.hiddenDebitMs);
    manualPausedAt.set(
        typeof p.manualPausedAt === "number" &&
            Number.isFinite(p.manualPausedAt)
            ? p.manualPausedAt
            : null,
    );
    manualPauseWasHiding.set(!!p.manualPauseWasHiding);
    gamePausedForLocationAt.set(
        typeof p.gamePausedForLocationAt === "number" &&
            Number.isFinite(p.gamePausedForLocationAt)
            ? p.gamePausedForLocationAt
            : null,
    );
    locationGraceStartedAt.set(
        typeof p.locationGraceStartedAt === "number" &&
            Number.isFinite(p.locationGraceStartedAt)
            ? p.locationGraceStartedAt
            : null,
    );
}

/**
 * Total ms to subtract from the hider's hidden time for clock pauses:
 * the banked `hiddenDebitMs` PLUS, while a pause (location OR manual) is
 * in progress, the live elapsed pause so the displayed/scored time
 * freezes immediately rather than only correcting on resume. `now` is
 * passed so callers can drive it from their shared 1 Hz clock. (A manual
 * pause during the hiding period repays via a `hidingPeriodEndsAt` shift
 * instead — see `resumeGame` — so its live term is harmless there: the
 * scored time is `max(0, foundAt − endsAt …)`, which is 0 pre-seeking.)
 */
export function effectiveHiddenDebitMs(now: number = Date.now()): number {
    const banked = hiddenDebitMs.get();
    const locPaused = gamePausedForLocationAt.get();
    const manPaused = manualPausedAt.get();
    const pausedAt =
        locPaused != null && manPaused != null
            ? Math.min(locPaused, manPaused)
            : (locPaused ?? manPaused);
    const live = pausedAt != null ? Math.max(0, now - pausedAt) : 0;
    return banked + live;
}

/**
 * How long the hider has to answer a question, in ms, per rulebook
 * (p5/p32): 5 minutes for everything EXCEPT photo questions, which get
 * 10 minutes in Small/Medium games and 20 minutes in Large games.
 * Single source of truth so the unanswered-countdown UIs agree.
 */
export function answerWindowMs(
    category: string,
    size: GameSize = gameSize.get(),
): number {
    if (category === "photo") {
        return (size === "large" ? 20 : 10) * 60_000;
    }
    return 5 * 60_000;
}

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

/**
 * Canonical per-mode icons — the SINGLE source of truth. Every surface
 * that shows a transit-mode glyph (mode chips, roster, journey legs,
 * map-overlay toggles, station pickers) imports from here so the same
 * mode always looks the same. The rail family is front-view for a
 * coherent, distinct set: plain front = train, front-in-tunnel =
 * subway, tram-front = tram. (`TrainTrack` — literal rails — is
 * deliberately NOT here; it represents track/rail in the abstract
 * (e.g. the setup wizard's Transit step), not a specific service.)
 */
export const TRANSIT_ICONS: Record<TransitMode, LucideIcon> = {
    bus: Bus,
    tram: TramFront,
    train: TrainFront,
    subway: TrainFrontTunnel,
    ferry: Ship,
};

/**
 * Overpass selector(s) for each transit mode's station-like features.
 * These are the filters the hiding-zone overlay unions to derive its
 * candidate stations FROM the game's `allowedTransit` set — so the
 * player-controlled "which modes can we ride" knob also doubles as the
 * "what counts as a hiding zone" knob (e.g. disallowing Bus in a
 * Stockholm game drops ~6 000 bus-stop zones from the map).
 *
 * Selectors are intentionally narrow per mode (no Frankenstein
 * railway-station-AND-bus-stop union per mode) so unions across multi-
 * mode selections produce a sensible result. The strings are passed
 * unchanged to `findPlacesInZone` and concatenated into one Overpass
 * `nwr…` block.
 */
export const HIDING_ZONE_FILTERS_BY_MODE: Record<TransitMode, string[]> = {
    // Heavy rail + commuter rail platforms.
    train: ["[railway=station][subway!=yes]", "[railway=halt]"],
    // Underground / metro stops. `subway=yes` flag is how OSM tags
    // metro stations sharing a node with mainline rail.
    subway: ["[railway=station][subway=yes]", "[station=subway]"],
    // Light-rail / streetcar / tram stops. `railway=tram_stop` is the classic
    // tag; the PTv2 platform selector catches networks that map tram stops
    // ONLY as `public_transport=platform` + `tram=yes` (same gap as bus). Safe
    // to include — a tram stop is typically a single platform, so unlike heavy
    // rail it won't explode a multi-platform station into per-platform zones.
    tram: [
        "[railway=tram_stop]",
        "[railway=halt][light_rail=yes]",
        "[public_transport=platform][tram=yes]",
    ],
    // Bus stops — the big one (Stockholm-scale games can omit this to
    // keep the station count tractable). `highway=bus_stop` is the classic
    // tag, but a lot of the world (Nairobi's matatu network, and PTv2
    // networks generally) maps bus stops ONLY as `public_transport=platform`
    // + `bus=yes` with no `highway=bus_stop`, so without the second selector
    // those cities show zero bus hiding zones even with a dense bus overlay.
    bus: ["[highway=bus_stop]", "[public_transport=platform][bus=yes]"],
    // Ferry terminals + ferry-platform PT nodes. `ferry=yes` is the
    // documented PTv2 flag; `platform=ferry` is a non-standard variant kept
    // for the rare city that used it (harmless if it matches nothing).
    ferry: [
        "[amenity=ferry_terminal]",
        "[public_transport=platform][ferry=yes]",
        "[public_transport=platform][platform=ferry]",
    ],
};

/**
 * Derive the hiding-zone Overpass filter list from a set of allowed
 * transit modes. Deduplicated; preserves the per-mode order so the
 * highest-priority selector (typically railway=station, the
 * conventional "main" station) lands first in the array — that matters
 * because `findPlacesInZone` uses options[0] as the primary filter and
 * options[1:] as the alternative-union list.
 */
export function hidingZoneFiltersFor(modes: TransitMode[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const m of modes) {
        for (const f of HIDING_ZONE_FILTERS_BY_MODE[m] ?? []) {
            if (seen.has(f)) continue;
            seen.add(f);
            out.push(f);
        }
    }
    return out;
}

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
