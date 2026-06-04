import { persistentAtom } from "@nanostores/persistent";
import { atom } from "nanostores";
import type { MapRef } from "react-map-gl/maplibre";

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

/**
 * Live MapLibre map ref, published by MapV2 once the map is
 * mounted. Mirrors `leafletMapContext` from `@/lib/context`
 * but for the MapLibre path. Components that need
 * `.flyTo(...)` or `.fitBounds(...)` can read this when
 * useMapLibre is on. Volatile (per-mount), not persisted.
 */
export const mapLibreContext = atom<MapRef | null>(null);

/**
 * Persisted viewport so a reload doesn't snap back to the
 * default world view while we wait for mapGeoLocation to
 * settle. MapV2 writes this on movestart-end; it reads it on
 * mount to set initial view state.
 */
export const mapLibreViewport = persistentAtom<{
    latitude: number;
    longitude: number;
    zoom: number;
} | null>("jlhs:mapLibreViewport", null, {
    encode: JSON.stringify,
    decode: JSON.parse,
});

