import { useEffect, useRef, useState } from "react";

/**
 * Drives a fade-in / fade-out for a MapLibre overlay so toggling it on
 * or off animates instead of popping. Returns:
 *
 *   - `render` — whether the layer should be in the tree at all. Stays
 *     true through the fade-OUT so the layer can animate down to 0
 *     before it's unmounted.
 *   - `shown`  — whether the layer should be at full opacity. Flips to
 *     true one frame AFTER mount (so a just-added layer, painted at 0,
 *     transitions UP), and to false immediately on disable (so it
 *     transitions DOWN before `render` drops).
 *
 * The actual interpolation is done by MapLibre's own paint-property
 * transition (`"<prop>-opacity-transition": { duration }`), so this hook
 * only flips two booleans per toggle — no per-frame React re-renders.
 * Pair the `duration` you pass here with the `-transition` duration in
 * the layer paint.
 *
 * No animation on first mount when `active` starts true (initial page
 * load with the overlay already enabled paints at full opacity) — the
 * fade is reserved for genuine user toggles.
 */
export function useLayerFade(
    active: boolean,
    durationMs = 280,
): { render: boolean; shown: boolean } {
    const [render, setRender] = useState(active);
    const [shown, setShown] = useState(active);
    // Track the mounted/initial state so we never animate the very first
    // paint (an overlay enabled at load shouldn't fade in).
    const firstRef = useRef(true);

    useEffect(() => {
        let raf = 0;
        let timer = 0;
        if (active) {
            setRender(true);
            if (firstRef.current) {
                // Enabled at load — show immediately, no fade.
                setShown(true);
            } else {
                // Toggled on: the layer mounts painted at 0 (shown=false);
                // flip to full on the next frame so MapLibre transitions up.
                setShown(false);
                raf = requestAnimationFrame(() => setShown(true));
            }
        } else {
            // Toggled off: transition down, then unmount once it's faded.
            setShown(false);
            if (firstRef.current) {
                setRender(false);
            } else {
                timer = window.setTimeout(() => setRender(false), durationMs);
            }
        }
        firstRef.current = false;
        return () => {
            if (raf) cancelAnimationFrame(raf);
            if (timer) window.clearTimeout(timer);
        };
    }, [active, durationMs]);

    return { render, shown };
}
