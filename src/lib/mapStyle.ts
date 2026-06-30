import type {
    LayerSpecification,
    StyleSpecification,
} from "maplibre-gl";

import { protomapsMapLibreStyle } from "@/lib/protomapsStyle";

/**
 * Shared basemap-style builder used by BOTH the main seeker/hider map
 * (`Map.tsx`) and the static question-preview mini-map
 * (`QuestionOutcomeMap.tsx`). Keeping it in one place means the preview's
 * base ALWAYS matches the main map — same light/dark Protomaps flavor,
 * same Thunderforest raster, and crucially the same **satellite overlay**.
 * (Previously the preview hard-coded the bare Protomaps style, so in dark
 * mode with satellite on it looked much darker than the real map.)
 */

export const SATELLITE_SOURCE = {
    tiles: [
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    ],
    attribution: "Imagery &copy; Esri",
};

export function thunderforestSource(
    flavor: "transport" | "neighbourhood",
    key: string,
) {
    return {
        tiles: [
            `https://tile.thunderforest.com/${flavor}/{z}/{x}/{y}.png?apikey=${key}`,
        ],
        attribution:
            '&copy; <a href="http://www.thunderforest.com/">Thunderforest</a>',
    };
}

export function buildStyle(
    baseKey: string,
    withSatellite: boolean,
    thunderforestKey: string,
    resolvedThemeMode: "light" | "dark" = "dark",
): StyleSpecification {
    // v230+: the "auto"/"light"/"dark"/"voyager"/"osm" keys all
    // resolve to the Protomaps vector basemap with our transit-first
    // style. Theme follows the UI ("auto") or the explicit pick.
    // Thunderforest keys (transport/neighbourhood) are still served
    // as raster, since the user provided an API key specifically for
    // those styles and overriding them with Protomaps would defeat
    // the purpose.
    const effectiveKey =
        baseKey === "auto"
            ? resolvedThemeMode === "dark"
                ? "dark"
                : "light"
            : baseKey;

    let base: StyleSpecification;
    if (
        (effectiveKey === "transport" || effectiveKey === "neighbourhood") &&
        thunderforestKey
    ) {
        const tf = thunderforestSource(effectiveKey, thunderforestKey);
        base = {
            version: 8,
            sources: {
                base: {
                    type: "raster",
                    tiles: tf.tiles,
                    tileSize: 256,
                    attribution: tf.attribution,
                },
            },
            layers: [{ id: "base", type: "raster", source: "base" }],
        };
    } else {
        // Protomaps vector basemap. The style ships a flat sources +
        // layers shape that we can extend with the satellite overlay
        // below — it just goes on top.
        base = protomapsMapLibreStyle(
            effectiveKey === "dark" ? "dark" : "light",
        ) as StyleSpecification;
    }

    const sources: StyleSpecification["sources"] = {
        ...base.sources,
    };
    const layers: LayerSpecification[] = [...base.layers];

    if (withSatellite) {
        sources.satellite = {
            type: "raster",
            tiles: SATELLITE_SOURCE.tiles,
            tileSize: 256,
            attribution: SATELLITE_SOURCE.attribution,
        };
        layers.push({
            id: "satellite",
            type: "raster",
            source: "satellite",
            paint: { "raster-opacity": 0.7 },
        });
    }

    return {
        version: 8,
        glyphs: base.glyphs,
        sources,
        layers,
    };
}
