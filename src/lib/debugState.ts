import { persistentAtom } from "@nanostores/persistent";
import { atom } from "nanostores";

export const debugPanelOpen = atom(false);

/**
 * When true, the debug launcher buttons (header `DebugLaunchButton` +
 * the floating chip in `DebugPhaseControls`) render INVISIBLE but stay
 * clickable — for clean demo screenshots without losing debug access.
 * Toggled from inside the debug panel; persisted so it survives reloads.
 * The panel itself is unaffected (it only shows when opened).
 */
export const debugLauncherHidden = persistentAtom<boolean>(
    "jlhs:debugLauncherHidden",
    false,
    { encode: JSON.stringify, decode: JSON.parse },
);

/**
 * Max characters for a hiding-zone station LABEL on the map before it's
 * abbreviated + truncated (v835). Names are first suffix-abbreviated
 * (Street → St, …); if still longer than this they're cut with an ellipsis.
 * 0 disables truncation (abbreviation only). Default 12; exposed as a debug
 * slider so the value can be tuned live. Persisted.
 */
export const stationLabelMaxChars = persistentAtom<number>(
    "jlhs:stationLabelMaxChars",
    12,
    {
        encode: String,
        decode: (v) => {
            const n = parseInt(v, 10);
            return Number.isFinite(n) ? n : 12;
        },
    },
);
