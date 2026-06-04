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
 * MapLibre GL implementation flag. The seeker page renders
 * `MapV2` (MapLibre GL) by default; flip to false to fall
 * back to the original Leaflet `Map.tsx`. Defaulted on as of
 * v62 — the seeker workflow has parity (drag / click-to-edit
 * / context menu / transit routes / boundary load / question
 * elimination) and MapLibre's GPU-accelerated rendering is
 * noticeably smoother on phones. Remaining items
 * (PolygonDraw, ZoneSidebar overlay, radar sweep animation,
 * map print) are tracked in MapV2.tsx's header comment and
 * fall back to the Leaflet path with this flag flipped off.
 */
export const useMapLibre = persistentAtom<boolean>("jlhs:useMapLibre", true, {
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

