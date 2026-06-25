import { useRef } from "react";
import type { ReactNode } from "react";

import { useLayerFade } from "@/hooks/useLayerFade";

/**
 * Wraps a MapLibre overlay (a `<Source>` + its `<Layer>`s) so toggling
 * it fades in / out instead of popping. Handles three things the bare
 * conditional render couldn't:
 *
 *   1. Keeps the layers mounted through the fade-OUT (via `useLayerFade`)
 *      so they can animate down to 0 before unmounting.
 *   2. Retains the LAST non-null `data` during the fade-out, so an
 *      overlay whose data atom clears the instant it's toggled off still
 *      has something to render while it fades.
 *   3. Hands the render-prop a `shown` boolean — set each layer's
 *      `*-opacity` to its target when `shown`, else 0, and add the
 *      matching `"*-opacity-transition": { duration }` so MapLibre does
 *      the interpolation.
 *
 * Always mount this in the map tree (don't gate it on the toggle) so it
 * can own the enter/exit animation; pass the toggle as `active`.
 */
export function FadeOverlay<T>({
    active,
    data,
    durationMs = 280,
    children,
}: {
    /** The overlay's on/off toggle. */
    active: boolean;
    /** The overlay's data (FeatureCollection, etc). Retained across a
     *  fade-out so the layer has something to paint while it fades. */
    data: T | null | undefined;
    durationMs?: number;
    /** Render the Source/Layer subtree. `shown` is the opacity target
     *  flag; multiply or switch each layer's opacity on it. */
    children: (data: T, shown: boolean) => ReactNode;
}) {
    const { render, shown } = useLayerFade(active && data != null, durationMs);
    const lastData = useRef<T | null>(data ?? null);
    if (data != null) lastData.current = data;
    if (!render || lastData.current == null) return null;
    return <>{children(lastData.current, shown)}</>;
}

export default FadeOverlay;
