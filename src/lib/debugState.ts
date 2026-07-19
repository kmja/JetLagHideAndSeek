import { persistentAtom } from "@nanostores/persistent";
import { atom } from "nanostores";

export const debugPanelOpen = atom(false);

/**
 * When true, the debug launcher buttons (header `DebugLaunchButton` +
 * the floating chip in `DebugPhaseControls`) render INVISIBLE but stay
 * clickable — for clean demo screenshots without losing debug access.
 * Toggled from inside the debug panel; persisted so it survives reloads.
 * The panel itself is unaffected (it only shows when opened).
 *
 * v882: defaults to TRUE — the debug panel is now a hidden gesture (5 quick
 * taps on the top-centre wordmark, `useDebugSecretTap`), so the visible
 * launchers are off by default and the panel isn't trivially discoverable.
 */
export const debugLauncherHidden = persistentAtom<boolean>(
    "jlhs:debugLauncherHidden",
    true,
    { encode: JSON.stringify, decode: JSON.parse },
);

/**
 * Max characters for a hiding-zone station LABEL on the map before it's
 * abbreviated + truncated (v835). Names are first suffix-abbreviated
 * (Street → St, …); if still longer than this they're cut with an ellipsis.
 * 0 disables truncation (abbreviation only). Default 15; exposed as a debug
 * slider so the value can be tuned live. Persisted.
 */
export const stationLabelMaxChars = persistentAtom<number>(
    "jlhs:stationLabelMaxChars",
    15,
    {
        encode: String,
        decode: (v) => {
            const n = parseInt(v, 10);
            return Number.isFinite(n) ? n : 15;
        },
    },
);

/**
 * v1009: last body-of-water elimination diagnostic (volatile, in-memory).
 *
 * The body-of-water configure overlay reads the basemap `water` layer and
 * buffers it. When it shows NO overlay, we can't tell from a screenshot
 * WHICH stage failed — the capture (no basemap water yet), the cold OSM
 * fallback (empty fetch), or the buffer (turf/arcgis returned null on dense
 * geometry). This atom holds a one-line summary of the LAST body-of-water
 * compute (source, feature/vertex counts, buffer outcome), surfaced in the
 * debug panel so an on-device tester can read back the exact failing stage
 * instead of us guessing. Set from `measuring.ts`, displayed in
 * `DebugPhaseControls`. Also `console.warn`ed with the `[bow]` tag.
 */
export const lastBodyOfWaterDiag = atom<string>("");
