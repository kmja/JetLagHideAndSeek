/**
 * Shared base-tile-layer config.
 *
 * Both the main map (`Map.tsx`) and the in-dialog mini map
 * (`InlineLocationPicker.tsx`) consume this so they look identical and
 * inherit the seeker's chosen style from `baseTileLayer`. Returns plain
 * data (URL/attribution/zoom limits) rather than JSX so this module
 * stays free of any react-leaflet import — callers wrap it in
 * `<TileLayer>` themselves.
 *
 * `"auto"` follows the UI theme (light/dark) and is the default for
 * fresh users — it makes the map match the dialogs without having to
 * touch settings. Callers pass `resolvedTheme.get()` (or the result of
 * `useStore(resolvedTheme)`) so the swap is reactive.
 */

import { resolvedTheme } from "@/lib/theme";

export interface TileLayerConfig {
    url: string;
    attribution: string;
    subdomains?: string;
    maxZoom: number;
    minZoom: number;
    noWrap?: boolean;
}

const OSM = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
const CARTO = '&copy; <a href="https://carto.com/attributions">CARTO</a>';
const THUNDER = '&copy; <a href="http://www.thunderforest.com/">Thunderforest</a>';

export function getTileLayerConfig(
    tileLayer: string,
    thunderforestApiKey: string,
): TileLayerConfig {
    // "auto" => follow the UI theme. Read once here so the rest of the
    // switch can fall through into the regular light/dark branches.
    const effective =
        tileLayer === "auto"
            ? resolvedTheme.get() === "dark"
                ? "dark"
                : "light"
            : tileLayer;
    switch (effective) {
        case "light":
            // v225: was cartocdn light_all, now OSM standard. See
            // RASTER_SOURCES in Map.tsx for the full rationale.
            return {
                url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
                attribution: `${OSM} contributors; Powered by Esri and Turf.js`,
                subdomains: "abc",
                maxZoom: 19,
                minZoom: 2,
                noWrap: true,
            };
        case "dark":
            // v225: was cartocdn dark_all. The maplibre branch darkens
            // via raster-paint properties; the Leaflet branch can't, so
            // serve the OSM-light tiles and let the dark UI absorb the
            // contrast hit. Users who want a real dark map should switch
            // to the maplibre renderer (default).
            return {
                url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
                attribution: `${OSM} contributors; Powered by Esri and Turf.js`,
                subdomains: "abc",
                maxZoom: 19,
                minZoom: 2,
                noWrap: true,
            };
        case "transport":
            if (thunderforestApiKey) {
                return {
                    url: `https://tile.thunderforest.com/transport/{z}/{x}/{y}.png?apikey=${thunderforestApiKey}`,
                    attribution: `${OSM} contributors; ${THUNDER}; Powered by Esri and Turf.js`,
                    maxZoom: 22,
                    minZoom: 2,
                    noWrap: true,
                };
            }
            // Fall through to voyager default below.
            break;
        case "neighbourhood":
            if (thunderforestApiKey) {
                return {
                    url: `https://tile.thunderforest.com/neighbourhood/{z}/{x}/{y}.png?apikey=${thunderforestApiKey}`,
                    attribution: `${OSM} contributors; ${THUNDER}; Powered by Esri and Turf.js`,
                    maxZoom: 22,
                    minZoom: 2,
                    noWrap: true,
                };
            }
            break;
        case "osmcarto":
            return {
                url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
                attribution: `${OSM} contributors; Powered by Esri and Turf.js`,
                maxZoom: 19,
                minZoom: 2,
                noWrap: true,
            };
    }

    // Voyager default — was cartocdn voyager, now OSM standard.
    return {
        url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
        attribution: `${OSM} contributors; Powered by Esri and Turf.js`,
        subdomains: "abc",
        maxZoom: 19,
        minZoom: 2,
        noWrap: true,
    };
}

/**
 * Maplibre Style for the inline preview / lobby / hider / live-positions
 * maps. v225 switched the base from CartoCDN dark_all → OSM standard
 * tiles because cartocdn.com is on Firefox Enhanced Tracking
 * Protection's blocklist AND on EasyPrivacy (Adblock Plus / uBlock
 * Origin default list), so a meaningful fraction of users had their
 * tile fetches blocked at the browser layer (0ms 503 from the SW's
 * catchHandler). OSM standard tiles aren't on any tracking blocklist.
 *
 * The dark look is reconstructed via maplibre raster paint properties
 * (lower brightness, desaturate, slight contrast bump) rather than a
 * CSS `filter: invert` on the canvas — invert would also flip every
 * overlay (boundary outlines, markers, the user's selection halo),
 * defeating the purpose. The paint approach only touches the tile
 * layer, so overlays keep their intended colours.
 *
 * Returns the maplibre Style object directly so callers can drop it
 * into `<MapGL mapStyle={…} />` without further work. Memoise at the
 * call site (useMemo) — the value is stable across renders.
 */
// Returned as `any` so callers can drop it into the maplibre `mapStyle`
// prop without importing the maplibregl types — the actual shape is a
// valid Style at runtime; the `as` casts at every call site would just
// add noise.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function darkOsmMapLibreStyle(): any {
    return {
        version: 8,
        sources: {
            osm: {
                type: "raster",
                tiles: [
                    "https://a.tile.openstreetmap.org/{z}/{x}/{y}.png",
                    "https://b.tile.openstreetmap.org/{z}/{x}/{y}.png",
                    "https://c.tile.openstreetmap.org/{z}/{x}/{y}.png",
                ],
                tileSize: 256,
                attribution:
                    '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
                maxzoom: 19,
            },
        },
        layers: [
            {
                id: "osm-base",
                type: "raster",
                source: "osm",
                paint: {
                    // Tuned to roughly match cartocdn dark_all's visual
                    // weight: ~half brightness, ~half saturation, a touch
                    // more contrast so road outlines stay legible.
                    "raster-brightness-min": 0,
                    "raster-brightness-max": 0.55,
                    "raster-saturation": -0.45,
                    "raster-contrast": 0.1,
                },
            },
        ],
    };
}
