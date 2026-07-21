import type { CSSProperties, ElementType, ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Shared seeker / hider viewport shell.
 *
 * Both routes are the same shape: a full-height flex COLUMN of
 *
 *   header (flow)  →  map area (flex-1)  →  footer (flow)
 *
 * with the chrome sitting ABOVE and BELOW the map rather than overlaid
 * on it (v462/v463). The map area is the important shared invariant —
 * `relative flex-1 min-h-0`:
 *
 *   - `relative` so map-anchored controls/overlays (passed as children)
 *     position against it,
 *   - `flex-1 min-h-0` so it fills the gap between header and footer,
 *   - and — critically — it gives the map a DEFINITE-height containing
 *     block. A bare `flex-1` item reports a computed height of `auto`,
 *     so a map filling it with `height: 100%` collapses to 0 (the v465
 *     blank-map bug). Children fill it via `absolute inset-0`, whose
 *     box is sized from the insets and so always has a real height.
 *
 * Callers own the ROOT positioning/height because they differ: the
 * seeker is a flex child of the sidebar row (`flex-grow h-full`), and the
 * SeekerPage in-game wrapper is `fixed inset-0` with `h-full` down the
 * SidebarProvider chain — v1071. Earlier this shell sized itself with
 * `h-svh`/`h-dvh`, but BOTH viewport units can compute SHORTER than the real
 * screen on iOS standalone (Safari PWA), leaving the page background as an
 * empty strip below the nav; a fixed inset fills the actual standalone
 * viewport (the same reason the hider shell is `fixed inset-0`). They also
 * differ in chrome (one vs two
 * header rows) and in whether they reserve bottom space (the hider's
 * HiderHandFan peek strip) — hence the `style` passthrough.
 */
export function AppShell({
    as = "div",
    className,
    style,
    header,
    footer,
    mapAreaId,
    mapAreaClassName,
    children,
}: {
    /** Root element — `main` for the seeker (semantic + sidebar-row
     *  flex child), `div` for the hider. */
    as?: ElementType;
    /** Root positioning / height / background classes (caller-specific;
     *  see the note above on why this isn't baked in). */
    className?: string;
    /** Root inline style — e.g. the hider's bottom padding that reserves
     *  the hand-fan peek strip. */
    style?: CSSProperties;
    /** Flow row(s) above the map. */
    header?: ReactNode;
    /** Flow row(s) below the map. */
    footer?: ReactNode;
    /** Optional id on the map-area box. */
    mapAreaId?: string;
    mapAreaClassName?: string;
    /** The map plus its absolutely-positioned controls / overlays. */
    children: ReactNode;
}) {
    const Root = as;
    return (
        <Root
            className={cn("flex flex-col min-h-0 group", className)}
            style={style}
        >
            {header}
            <div
                id={mapAreaId}
                className={cn("relative flex-1 min-h-0", mapAreaClassName)}
            >
                {children}
            </div>
            {footer}
        </Root>
    );
}

export default AppShell;
