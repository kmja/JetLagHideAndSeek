/**
 * Shared base-tile-layer config.
 *
 * Both the main map (`Map.tsx`) and the in-dialog mini map
 * (`InlineLocationPicker.tsx`) consume this so they look identical and
 * inherit the seeker's chosen style from `baseTileLayer`. Returns plain
 * data (URL/attribution/zoom limits) rather than JSX so this module
 * stays free of any react-leaflet import — callers wrap it in
 * `<TileLayer>` themselves.
 */

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
    switch (tileLayer) {
        case "light":
            return {
                url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
                attribution: `${OSM} contributors; ${CARTO}; Powered by Esri and Turf.js`,
                subdomains: "abcd",
                maxZoom: 20,
                minZoom: 2,
                noWrap: true,
            };
        case "dark":
            return {
                url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
                attribution: `${OSM} contributors; ${CARTO}; Powered by Esri and Turf.js`,
                subdomains: "abcd",
                maxZoom: 20,
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

    // Voyager default.
    return {
        url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
        attribution: `${OSM} contributors; ${CARTO}; Powered by Esri and Turf.js`,
        subdomains: "abcd",
        maxZoom: 20,
        minZoom: 2,
        noWrap: true,
    };
}
