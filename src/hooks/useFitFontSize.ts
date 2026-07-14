import { useLayoutEffect, useRef, useState } from "react";

/**
 * Shrink an element's font-size until its single-line text fits its width,
 * down to a floor. Used for the lobby city header so a long place name
 * ("Provincetown", "Frederiksberg") scales down instead of truncating,
 * while a short one keeps the big display size.
 *
 * The element must be width-constrained (e.g. `flex-1 min-w-0`) and lay its
 * text on one line (`whitespace-nowrap`, which Tailwind's `truncate`
 * provides) — then `scrollWidth` reflects the FULL text width even when
 * clipped, so we can shrink until it fits. Re-fits on text change and on
 * container resize. At the floor, normal truncation (ellipsis) takes over.
 */
export function useFitFontSize<T extends HTMLElement = HTMLElement>(
    text: string,
    {
        maxPx = 30,
        minPx = 18,
        stepPx = 1,
    }: { maxPx?: number; minPx?: number; stepPx?: number } = {},
) {
    const ref = useRef<T | null>(null);
    const [fontSize, setFontSize] = useState(maxPx);

    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const fit = () => {
            let size = maxPx;
            el.style.fontSize = `${size}px`;
            let guard = 0;
            // +1 px slack so a sub-pixel rounding difference doesn't shrink
            // a name that visually already fits.
            while (
                size > minPx &&
                el.scrollWidth > el.clientWidth + 1 &&
                guard < 128
            ) {
                size -= stepPx;
                el.style.fontSize = `${size}px`;
                guard++;
            }
            setFontSize(size);
        };
        fit();
        if (typeof ResizeObserver === "undefined") return;
        const ro = new ResizeObserver(fit);
        ro.observe(el);
        return () => ro.disconnect();
    }, [text, maxPx, minPx, stepPx]);

    return { ref, fontSize };
}
