import { gameSize, HIDING_PERIOD_MINUTES, hidingPeriodEndsAt, playArea } from "@/lib/gameSetup";
import { getSubtypes } from "@/lib/subtypes";
import { LOCATION_FIRST_TAG } from "@/maps/api";
import { findPlacesInZone } from "@/maps/api/overpass";
import {
    type FamilyKey,
    prefetchCategory,
} from "@/maps/api/playAreaPrefetch";

/**
 * Warm the Overpass cache for every question type a seeker is likely
 * to ask. Fires during the hiding period (when seekers can't ask
 * anything anyway) so the queries land in the cache layers before
 * they're actually needed:
 *
 *   - Cloudflare edge + R2 (the jlhs-overpass-cache worker)
 *   - The seeker's own browser Cache API (via cacheFetch)
 *
 * Result: when the hiding period ends and seekers start asking
 * questions, every matching / measuring query is a cache hit —
 * effectively zero latency and zero load on the public Overpass
 * mirrors. No more "all mirrors timed out" cascades when ten seekers
 * pile onto the same play area.
 *
 * What gets warmed (only what's relevant for the current game size):
 *
 *   - Airports (commercial, with IATA)
 *   - Major cities (1M+ population)
 *   - High-speed rail
 *   - Train stations
 *   - For Small / Medium games: every -full subtype (aquarium, zoo,
 *     theme park, mountain, museum, hospital, cinema, library, golf
 *     course, foreign consulate, park)
 *
 * Coastline is NOT here — v144 made that a fully client-side lookup
 * over the bundled Natural Earth dataset, no Overpass round trip.
 *
 * Concurrency: requests run with a small in-flight cap. Overpass
 * mirrors are happy with a steady trickle; what they hate is twenty
 * simultaneous heavy queries from a single client. The worker's own
 * mirror-race logic still applies per request.
 *
 * Cancellation: if the play area changes mid-preload (host edited
 * the wizard), the in-flight gen is invalidated and the next call
 * starts fresh.
 */

const PRELOAD_CONCURRENCY = 2;

let currentGen = 0;

interface PreloadJob {
    label: string;
    run: () => Promise<unknown>;
}

function buildJobs(): PreloadJob[] {
    const size = gameSize.get();
    const jobs: PreloadJob[] = [];

    // Airports + major cities — always available, both modes.
    // All jobs pass silent=true so a failing R2 cache worker or a
    // rate-limited mirror doesn't splatter the user with the
    // "Could not load data from Overpass" toast during the hiding
    // period — this is a background warm-up, not a user-initiated
    // query, and on-demand calls have their own toast path.
    jobs.push({
        label: "airports",
        // Route through prefetchCategory (NOT a raw findPlacesInZone)
        // so the hiding-period warm-up populates the EXACT same
        // in-memory + R2 cache keys the tap-time nearest-reference
        // lookup reads. Previously the preloader fetched a
        // differently-shaped query than the reference preview ever
        // issued, so it warmed a key nothing asked for — which is
        // why reference points never resolved instantly.
        run: () => prefetchCategory("airport"),
    });
    // NB: no "major cities" warm-up here anymore — the nearest
    // major-city reference now resolves client-side from the bundled
    // MAJOR_CITIES list (no Overpass), so there's nothing to preload.
    // High-speed rail (measuring "highspeed-measure-shinkansen") —
    // small/medium only per rulebook (`highspeed=yes` worldwide).
    if (size !== "large") {
        jobs.push({
            label: "high-speed rail",
            run: () =>
                findPlacesInZone(
                    "[highspeed=yes]",
                    undefined,
                    "nwr",
                    "geom",
                    [],
                    0,
                    true,
                ),
        });
    }
    // Train stations — used by the matching same-train-line family.
    jobs.push({
        label: "train stations",
        run: () => prefetchCategory("rail-station"),
    });
    // Subtype-specific *-full queries (Small + Medium games only).
    if (size !== "large") {
        // Both matching and measuring share the same *-full subtype
        // list, so iterate one and dedupe.
        const seen = new Set<string>();
        for (const cat of ["matching", "measuring"] as const) {
            const subs = getSubtypes(cat, size);
            for (const s of subs ?? []) {
                if (!s.value.endsWith("-full")) continue;
                const location = s.value.slice(0, -"-full".length);
                if (seen.has(location)) continue;
                seen.add(location);
                const tag = (
                    LOCATION_FIRST_TAG as Record<string, string | undefined>
                )[location];
                if (!tag) continue;
                jobs.push({
                    label: s.label.toLowerCase(),
                    // Same key-sharing rationale as airports above:
                    // go through prefetchCategory so this warms the
                    // `api:<location>` cache the configure-dialog
                    // reference lookup reads at tap time.
                    run: () =>
                        prefetchCategory(`api:${location}` as FamilyKey),
                });
            }
        }
    }

    return jobs;
}

async function runWithConcurrency(
    jobs: PreloadJob[],
    concurrency: number,
    gen: number,
): Promise<void> {
    let next = 0;
    const workers = Array.from({ length: concurrency }, async () => {
        while (gen === currentGen) {
            const idx = next++;
            if (idx >= jobs.length) return;
            const job = jobs[idx];
            try {
                await job.run();
                if (gen !== currentGen) return;
                console.debug(`[preload] ${job.label} ✓`);
            } catch (e) {
                // Silent — preload is best-effort. The on-demand call
                // path still works exactly the same if a job failed.
                console.debug(`[preload] ${job.label} failed (best-effort):`, e);
            }
        }
    });
    await Promise.all(workers);
}

/**
 * Kick off the preload pass for the current play area. Idempotent
 * within a gen — calling it twice during the same hiding period is a
 * no-op for already-completed jobs (cacheFetch dedupes via the
 * in-flight map, and any already-cached job returns instantly).
 *
 * Best-effort and silent: never toasts, never throws. Logs at debug
 * so DevTools can show progress when wanted.
 */
export function preloadCommonQuestionData(): void {
    if (!playArea.get()) return;
    const gen = ++currentGen;
    const jobs = buildJobs();
    if (jobs.length === 0) return;
    console.debug(
        `[preload] warming ${jobs.length} Overpass queries during hiding period`,
    );
    void runWithConcurrency(jobs, PRELOAD_CONCURRENCY, gen);
}

/**
 * Whether a hiding period is currently active (for the hooking site
 * in GameStartWatcher).
 */
export function isHidingPeriodActive(): boolean {
    const endsAt = hidingPeriodEndsAt.get();
    if (endsAt === null) return false;
    return endsAt - Date.now() > 0;
}

/**
 * How long the active hiding period has left (ms), or 0 if none.
 * Capped at HIDING_PERIOD_MINUTES so a wonky clock can't return
 * something silly.
 */
export function hidingPeriodRemainingMs(): number {
    const endsAt = hidingPeriodEndsAt.get();
    if (endsAt === null) return 0;
    const remaining = endsAt - Date.now();
    if (remaining <= 0) return 0;
    const cap = HIDING_PERIOD_MINUTES[gameSize.get()] * 60_000;
    return Math.min(remaining, cap);
}
