/**
 * Shared, user-friendly toast messages (v1135).
 *
 * Consolidates the ~20 near-duplicate copy/share/data-load error strings that
 * had accreted across the app into a handful of canonical messages, so the
 * user sees ONE consistent wording per failure kind (and we change it in one
 * place). The technical Overpass wording ("all mirrors timed out or
 * rate-limited") is deliberately hidden behind a plain "couldn't load, wait a
 * moment" — the mechanism is meaningless to a player.
 */

/** Generic map-data load failure — replaces the technical Overpass / "mirrors
 *  timed out or rate-limited" messages. */
export const DATA_LOAD_ERROR =
    "Couldn't load map data right now. Please wait a moment and try again.";

/** Copy-to-clipboard failure. */
export const COPY_FAILED = "Couldn't copy. Try again.";

/** Share (OS share sheet) failure. */
export const SHARE_FAILED = "Couldn't share. Try again.";

/** No English-language name available for a boundary/zone. */
export const NO_ENGLISH_NAME =
    "This area has no English name, so this question can't be asked here.";

/** Clipboard held nothing usable as a preset. */
export const NO_PRESET_ON_CLIPBOARD = "No valid preset found on the clipboard.";
