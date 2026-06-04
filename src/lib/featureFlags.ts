import { persistentAtom } from "@nanostores/persistent";

/**
 * Feature flags. Persisted in localStorage so the choice
 * survives reloads; flip from the browser console with e.g.
 *
 *     localStorage.setItem('jlhs:useMapLibre', 'true'); location.reload();
 *
 * or via the debug panel (DebugPhaseControls) when wired up
 * there. Defaults are conservative — new code paths land off
 * by default until they're at parity with the existing path.
 */

/**
 * MapLibre GL parallel-implementation flag. While true, the
 * SeekerPage renders MapV2 (MapLibre GL) instead of the
 * Leaflet Map.tsx. Set to false until MapV2 reaches feature
 * parity. Migration tracking sits in a per-feature TODO list
 * in MapV2.tsx's header comment.
 */
export const useMapLibre = persistentAtom<boolean>("jlhs:useMapLibre", false, {
    encode: (v) => (v ? "true" : "false"),
    decode: (v) => v === "true",
});
