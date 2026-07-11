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
