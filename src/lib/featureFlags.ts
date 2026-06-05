import { persistentAtom } from "@nanostores/persistent";
import { atom } from "nanostores";
import type { MapRef } from "react-map-gl/maplibre";

/**
 * Live MapLibre map ref, published by MapV2 once the map is
 * mounted. Volatile (per-mount), not persisted. The Leaflet-
 * shaped facade most call sites use lives at
 * `mapContext` in @/lib/context — same value, different
 * surface (see lib/mapShim.ts).
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
