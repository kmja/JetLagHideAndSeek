/**
 * Canonical play-area boundary paint.
 *
 * The play area (and the adjacent areas folded into it) should look the
 * same wherever it's drawn — the wizard preview, the lobby preview, the
 * seeker map, and the hider map. Before v468 each of those rendered its
 * own slightly-different red (different hue, width, dashed vs solid, with
 * or without a fill), so the boundary read as a different thing in each
 * view. These constants are the single source of truth so it doesn't
 * drift again.
 *
 * Usage:
 *   - The boundary STROKE (`PLAY_AREA_COLOR` / `PLAY_AREA_LINE_WIDTH` /
 *     `PLAY_AREA_LINE_OPACITY`) is drawn in EVERY map view.
 *   - The translucent FILL (`PLAY_AREA_FILL_OPACITY`) is drawn where the
 *     play area reads as a *selection region* — the wizard / lobby
 *     previews and the added-area overlays. The in-game seeker / hider
 *     maps deliberately stay fill-free (the basemap + elimination mask
 *     carry the inside/outside cue there) and only wear the stroke.
 */
// The one brand red — identical to `--primary` / `--accent-red`
// (hsl(5 69% 55%)) so the boundary and the primary buttons are the same
// red. (Was hsl(2 70% 54%), a hair off, before the v591 colour unify.)
export const PLAY_AREA_COLOR = "hsl(5, 69%, 55%)";
export const PLAY_AREA_FILL_OPACITY = 0.15;
export const PLAY_AREA_LINE_WIDTH = 2;
export const PLAY_AREA_LINE_OPACITY = 0.9;
