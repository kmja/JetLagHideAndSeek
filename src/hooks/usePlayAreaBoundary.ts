import { useStore } from "@nanostores/react";
import { useEffect, useMemo, useRef } from "react";
import { toast } from "react-toastify";

import {
    additionalMapGeoLocations,
    isLoading,
    mapGeoJSON,
    mapGeoLocation,
    polyGeoJSON,
    polyGeoJSONHydrated,
} from "@/lib/context";
import { playArea } from "@/lib/gameSetup";
import { clipPolygonToLand } from "@/lib/geometry/client";
import { determineMapBoundaries } from "@/maps/api";

/**
 * Shared play-area boundary fetch for BOTH the seeker (`Map`) and hider
 * (`HiderBackgroundMap`) maps.
 *
 * Fetches the chosen play area's boundary polygon (once a real OSM
 * relation is selected and no polygon is already loaded), trims it to
 * land, and publishes it to `mapGeoJSON` + `polyGeoJSON` (the latter
 * persists it for next session). Two silent attempts with an 8 s gap —
 * a first-ever play area often misses every fast path and lands on the
 * rate-limited public mirrors; the retry usually hits something warm.
 * A single user-facing toast (toastId-deduped) fires only if BOTH
 * attempts come back empty.
 *
 * This used to be duplicated inline in each map (the hider's was a
 * thinner single-attempt copy, v394). Extracted so both maps fetch the
 * boundary identically and a fix lands once. `playArea` + `mapGeoLocation`
 * are both synced to multiplayer guests, so the gates work for the hider
 * exactly as for the seeker.
 */
export function usePlayAreaBoundary(): void {
    const $mapGeoLocation = useStore(mapGeoLocation);
    const $mapGeoJSON = useStore(mapGeoJSON);
    const $polyGeoJSON = useStore(polyGeoJSON);
    const $playArea = useStore(playArea);
    const $additional = useStore(additionalMapGeoLocations);

    // Stable signature of the ADDED adjacent areas the current boundary
    // should be built from. When this changes (the player folds in or
    // removes a neighbouring area) we must re-fetch so the boundary —
    // and therefore the playable region + hiding-zone scan — actually
    // grows to include it. Sorted so click order doesn't matter.
    const addedKey = useMemo(
        () =>
            $additional
                .filter((e) => e.added && e.location)
                .map(
                    (e) =>
                        (e.location.properties as { osm_id?: number })
                            ?.osm_id ?? 0,
                )
                .filter(Boolean)
                .sort((a, b) => a - b)
                .join(","),
        [$additional],
    );
    // The added-set the loaded boundary was built from. Null until we
    // either fetch once or adopt an already-present (cached) boundary.
    const builtFromKeyRef = useRef<string | null>(null);

    useEffect(() => {
        const props = $mapGeoLocation?.properties as
            | { osm_id?: number }
            | undefined;
        if (!($mapGeoLocation && (props?.osm_id ?? 0) > 0)) return;
        // Gate on the explicitly-picked play area so we never fetch with
        // the persistent-atom's default mapGeoLocation (Japan) during the
        // wizard's set-then-set write order.
        if (!$playArea) return;

        const haveBoundary = Boolean($mapGeoJSON || $polyGeoJSON);
        // A boundary already exists. Re-fetch ONLY if the added-adjacent
        // set changed since we built it; otherwise leave it (and adopt
        // the current set as the baseline on first sight of a persisted
        // boundary, so a plain reload doesn't needlessly recompute).
        if (haveBoundary) {
            if (builtFromKeyRef.current === null) {
                builtFromKeyRef.current = addedKey;
                return;
            }
            if (builtFromKeyRef.current === addedKey) return;
        }

        let cancelled = false;
        (async () => {
            // Wait for persistent-cache hydration before deciding we have
            // no boundary on disk. Race a 3 s timeout so a stuck Cache API
            // (iOS PWA bug) can't block the fetch forever.
            if (!polyGeoJSONHydrated.get()) {
                // Capture the subscription + timer so BOTH are cleaned up
                // after the race regardless of which side won. The old code
                // only unsubscribed inside the (v) branch, so when the 3 s
                // timeout won first the subscriber stayed attached forever
                // (a leak on every stuck-hydration mount).
                let resolveHydrated!: () => void;
                const hydrated = new Promise<void>((resolve) => {
                    resolveHydrated = resolve;
                });
                const unsub = polyGeoJSONHydrated.subscribe((v) => {
                    if (v) resolveHydrated();
                });
                let timerId = 0;
                const timeout = new Promise<void>((resolve) => {
                    timerId = window.setTimeout(resolve, 3000);
                });
                await Promise.race([hydrated, timeout]);
                unsub();
                if (timerId) clearTimeout(timerId);
                if (cancelled) return;
                if (mapGeoJSON.get() || polyGeoJSON.get()) return;
            }
            if (isLoading.get()) return;
            isLoading.set(true);

            // Two attempts, 8 s apart. The user-facing failure toast only
            // fires after BOTH come back empty (per-fetch toasts are
            // suppressed so this is the only voice).
            let boundary:
                | Awaited<ReturnType<typeof determineMapBoundaries>>
                | null = null;
            for (let attempt = 1; attempt <= 2; attempt++) {
                try {
                    boundary = await determineMapBoundaries();
                } catch (e) {
                    console.warn(
                        `determineMapBoundaries attempt ${attempt} failed:`,
                        e,
                    );
                    boundary = null;
                }
                if (cancelled) return;
                if (boundary?.features?.length) break;
                if (attempt < 2) {
                    console.debug(
                        "[boundary] attempt 1 returned nothing — retrying in 8 s",
                    );
                    await new Promise((r) => setTimeout(r, 8000));
                    if (cancelled) return;
                }
            }

            try {
                const hadFeatures = Boolean(boundary?.features?.length);
                if (!hadFeatures && !cancelled) {
                    toast.error(
                        "Couldn't load the play-area boundary. The mirrors are busy — try again in a minute.",
                        { toastId: "boundary-load-error" },
                    );
                }
                if (boundary) {
                    // Trim the legal boundary to actual land before
                    // publishing — OSM admin boundaries include coastal
                    // waters that would otherwise look playable. Best-effort:
                    // a failed clip publishes the raw polygon.
                    const f = (boundary.features?.[0] as unknown as {
                        geometry?: unknown;
                    }) ?? null;
                    let clipped = boundary;
                    if (f && f.geometry) {
                        try {
                            const c = await clipPolygonToLand(
                                f as never,
                            );
                            if (c) {
                                clipped = {
                                    type: "FeatureCollection",
                                    features: [c],
                                } as never;
                            }
                        } catch (e) {
                            console.warn(
                                "clipPolygonToLand failed; using raw boundary",
                                e,
                            );
                        }
                    }
                    if (cancelled) return;
                    // Record the added-set this boundary was built from so
                    // we don't re-fetch until it next changes.
                    builtFromKeyRef.current = addedKey;
                    mapGeoJSON.set(clipped);
                    polyGeoJSON.set(clipped);
                }
            } catch (e) {
                console.warn("determineMapBoundaries failed:", e);
            } finally {
                if (!cancelled) isLoading.set(false);
            }
        })();

        return () => {
            cancelled = true;
            // Clear the gate so the next run isn't silently skipped by the
            // isLoading early-return after a mid-flight cancel.
            isLoading.set(false);
        };
    }, [$mapGeoLocation?.properties, $mapGeoJSON, $polyGeoJSON, $playArea, addedKey]);
}
