import { useCallback, useEffect, useState } from "react";

/**
 * Tracks whether a react-map-gl map view has fully painted every layer
 * it needs before we reveal it to the user. "Ready" means:
 *
 *   - the style finished loading (`onLoad`), AND
 *   - the map has reached `idle` at least once — maplibre fires `idle`
 *     when there are no camera transitions in flight AND every tile for
 *     the current viewport has loaded and rendered, AND
 *   - the caller's own data is in (`dataReady`) — e.g. the boundary
 *     polygon has arrived, reference markers are present, etc.
 *
 * `resetKey` lets the caller force a re-wait: pass a value that changes
 * whenever the underlying data the map must show changes (typically the
 * boundary FeatureCollection's identity). When it changes we drop the
 * `idle` latch so the veil re-shows until the map settles on the new
 * data — without this, a map that went idle on the bare basemap would
 * report "ready" before the boundary's tiles ever painted.
 *
 * The readiness is LATCHED: once revealed we stay revealed. The main
 * gameplay map must not re-veil every time the seeker adds a question
 * or pans — the gate is a one-time "don't show a half-built map",
 * not a permanent shutter.
 *
 * `revealTimeoutMs` is a safety hatch. Tiles can stall (slow CDN, a
 * serving hiccup, or the Firefox range-abort bug we're chasing) and we
 * never want the veil pinned forever, hiding a map the user could still
 * pan. After this long we force-reveal and flag `timedOut` so the
 * caller can show a subtle "map is slow" hint instead of a dead
 * spinner.
 */
export function useMapTilesReady(opts: {
    /** Caller's combined non-tile readiness (boundary present, …). */
    dataReady: boolean;
    /** Changes when the map must re-wait for a fresh settle. */
    resetKey?: unknown;
    /** Force-reveal after this long even if never idle. Default 12 s. */
    revealTimeoutMs?: number;
}) {
    const { dataReady, resetKey, revealTimeoutMs = 12_000 } = opts;

    const [styleLoaded, setStyleLoaded] = useState(false);
    const [idle, setIdle] = useState(false);
    const [timedOut, setTimedOut] = useState(false);
    const [revealed, setRevealed] = useState(false);

    // New data → wait for the next settle (unless we've already
    // committed to revealed — we never re-veil a map that's been shown).
    useEffect(() => {
        if (revealed) return;
        setIdle(false);
        setTimedOut(false);
        // resetKey intentionally drives this; `revealed` is read but is
        // a latch we don't want to re-arm on.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [resetKey]);

    // Safety reveal timer — re-armed whenever we go back to waiting.
    useEffect(() => {
        if (revealed) return;
        const t = window.setTimeout(() => setTimedOut(true), revealTimeoutMs);
        return () => window.clearTimeout(t);
    }, [revealed, resetKey, revealTimeoutMs]);

    const tilesReady = styleLoaded && idle;

    // Latch revealed once everything's in (or we timed out waiting).
    useEffect(() => {
        if (revealed) return;
        if ((tilesReady && dataReady) || timedOut) setRevealed(true);
    }, [revealed, tilesReady, dataReady, timedOut]);

    const onLoad = useCallback(() => setStyleLoaded(true), []);
    const onIdle = useCallback(() => setIdle(true), []);

    return {
        /** Latched: true once the map may be shown to the user. */
        revealed,
        /** Convenience inverse — render the veil while this is true. */
        showVeil: !revealed,
        /** We force-revealed before tiles settled (stall / slow CDN). */
        timedOut,
        /** Wire to `<MapGL onLoad>`. */
        onLoad,
        /** Wire to `<MapGL onIdle>`. */
        onIdle,
    };
}
