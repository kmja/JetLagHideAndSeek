import { useStore } from "@nanostores/react";
import { useEffect } from "react";

import {
    gameStartCelebrationAt,
    gameStartFiredFor,
    gameStartPosition,
    hidingPeriodEndsAt,
} from "@/lib/gameSetup";
import { playerRole } from "@/lib/hiderRole";
import { requestStationWarmAll } from "@/lib/journey/stations";
import { preloadDuringHidingPeriod } from "@/lib/preload";

/**
 * A hiding period that's genuinely STARTING is minutes in the future (the
 * shortest rulebook period is 30 min); one that's ended/ending sits at ≈now.
 * This margin is the secondary start-vs-end discriminator, robust to a bit
 * of cross-device clock skew.
 */
const START_LEAD_MARGIN_MS = 60_000;

/**
 * Mount-only watcher. Opens the GoGoGoOverlay celebration the
 * moment the hiding period actually starts — i.e. when
 * `hidingPeriodEndsAt` transitions from null to a non-null
 * timestamp. That single trigger covers both:
 *
 *  - Host devices, where the GameLobbyDialog's Start button sets
 *    hidingPeriodEndsAt directly.
 *  - Guest devices, where the host's setupChanged push propagates
 *    a freshly-set hidingPeriodEndsAt over the multiplayer
 *    transport, which then writes the local atom.
 *
 * We only react to null→non-null transitions, never to mid-game
 * updates (e.g. peers refreshing the timer), so the celebration
 * doesn't pop back up after the user dismissed it.
 *
 * Also captures the device's GPS at game start and stores it as
 * `gameStartPosition` — the shared departure point used by the
 * travel-times overlay to compute which stations the hider could
 * reach during the hiding period.
 *
 * Mounted on both /index.astro (seeker) and /h.astro (hider) so
 * the celebration appears whichever side is loaded.
 */
export function GameStartWatcher() {
    const $endsAt = useStore(hidingPeriodEndsAt);
    const $firedFor = useStore(gameStartFiredFor);

    useEffect(() => {
        // v245: switched from a useRef-based "was it null on the
        // previous render" to a persistent dedupe atom keyed on the
        // actual endsAt value. The ref approach re-fired the GoGoGo
        // overlay whenever a multiplayer snapshot wrote hidingPeriod
        // EndsAt through a null bounce (autohost self-heal, lobby
        // reopen). Persistent dedupe survives both that bounce and a
        // full reload, and roundActions clears it to null at every
        // new round so the next game still gets the celebration.
        if ($endsAt === null) return;
        // v820: a non-finite (NaN) clock must NEVER drive the celebration.
        // Without this guard the overlay could re-fire every render/tick.
        if (!Number.isFinite($endsAt)) return;
        // v935: fire the start flourish at most ONCE per round. `gameStart
        // FiredFor` is cleared to null at every round/game start (resetShared
        // RoundState / startNewRound, applied on the guest via the
        // `roundStarted` handler), so a NON-null value means "already
        // celebrated this round." This replaces the old value-keyed dedupe
        // (`$firedFor === $endsAt`), which only suppressed the SAME
        // timestamp and so REPLAYED GO-GO-GO on the seeker for every
        // mid-round value CHANGE: the hider ending the hiding period early
        // (sets endsAt to ~now — the reported bug), a pause/resume shifting
        // the deadline forward, and a reconnect snapshot. Keyed on "have we
        // fired this round" it's immune to all of them, and still celebrates
        // each NEW round because the round reset nulls it first.
        if ($firedFor !== null) return;
        // Belt-and-braces: only celebrate a period genuinely STARTING (well
        // in the future), never one at/near now — a hair of cross-device
        // clock skew must not let an end-early (endsAt ≈ now) that somehow
        // reaches here before the round-reset be mistaken for a start. Real
        // hiding periods are >= 30 min, so a 1-min margin separates them
        // cleanly with no dependency on clock sync between devices.
        if ($endsAt <= Date.now() + START_LEAD_MARGIN_MS) return;
        // Claim the fire BEFORE any side effects so a paired mount
        // on the other route (e.g. SeekerPage + HiderPage both up
        // in one tab) doesn't double-fire on the same value.
        gameStartFiredFor.set($endsAt);
        if (gameStartCelebrationAt.get() === null) {
            gameStartCelebrationAt.set(Date.now());
        }
        // Capture GPS as the travel-times departure anchor. Non-
        // blocking: if the user denies location, the overlay simply
        // won't activate (it gates on gameStartPosition being set).
        if (typeof navigator !== "undefined" && navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(
                (pos) =>
                    gameStartPosition.set({
                        lat: pos.coords.latitude,
                        lng: pos.coords.longitude,
                    }),
                () => {
                    /* denied or unavailable — travel times won't have an anchor */
                },
                { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 },
            );
        }
        // Hiding period just started — seekers can't ask questions
        // yet, so this is the ideal window to warm the Overpass cache
        // for every matching/measuring query they're likely to ask.
        // Skip on the hider's device: they don't ask questions, and
        // running the same fetches on every device just multiplies
        // load on the mirrors for no gain.
        if (playerRole.get() !== "hider") {
            preloadDuringHidingPeriod();
        }
        // Proactively warm the whole play-area station union (primary +
        // every added adjacent area) into R2 now, at the START of the
        // hiding period — so the hider's "Hiding zones" overlay (and the
        // zone-containment lookups) serve from the prewarm endpoint rather
        // than a heavy combined live poly query that soft-times-out on a
        // dense multi-area metro. Added areas usually aren't curated, so
        // without this the first overlay load in e.g. Vancouver + North
        // Van + Burnaby falls straight to the timing-out live query.
        // Fire-and-forget + deduped; the long hiding period gives the
        // warms ample time to land.
        requestStationWarmAll();
    }, [$endsAt, $firedFor]);

    return null;
}

export default GameStartWatcher;
