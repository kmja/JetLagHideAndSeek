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
 * maps. v225 originally switched from CartoCDN dark_all → OSM standard
 * tiles after confirming both Firefox ETP and Adblock Plus EasyPrivacy
 * block `basemaps.cartocdn.com` at request time.
 *
 * v227: the dark look is no longer reconstructed via maplibre raster
 * paint properties — instead we ship the OSM tiles unmodified here and
 * apply openstreetmap.org's own dark-mode CSS filter at the map
 * container level (see the `osm-dark-tiles` rule in globals.css).
 * That's the exact filter osm.org runs in production
 * (`invert(100%) hue-rotate(180deg) brightness(95%) contrast(90%)`,
 * PR openstreetmap-website#5325, merged Nov 2024). The math leaves
 * saturated colours (the red boundary outline, blue water) close to
 * the original while inverting greys — so labels stay readable
 * light-on-dark and we don't need any per-layer paint tuning.
 *
 * Callers that don't want the dark filter (e.g. a satellite view)
 * simply omit the `osm-dark-tiles` class on the map container.
 */
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
            { id: "osm-base", type: "raster", source: "osm" },
        ],
    };
}
