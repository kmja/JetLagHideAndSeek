/**
 * Shared MapLibre style + PMTiles protocol setup for the Protomaps
 * basemap. Replaces the v225-v229 OSM-standard + CSS-invert-filter
 * combo with vector tiles styled to the show's "transit-first" look.
 *
 * Why vector + Protomaps:
 *   - OSM standard raster shows everything (POIs, buildings, every
 *     minor road) and we can't strip layers from a pre-rendered
 *     raster. The user asked for a basemap that looks like the Jet
 *     Lag show's — muted land, near-invisible roads, prominent
 *     colored transit lines. That's a custom style design exercise,
 *     and vector tiles let us author it.
 *   - PMTiles is a single-file binary tile format read over HTTP
 *     range requests, designed by Protomaps. No tile server, no
 *     vendor lock-in: we host the file on R2 and the client (or our
 *     Worker) seeks into it. Same operational story as the existing
 *     overpass cache — single chokepoint we own.
 *   - Stadia Maps free tier is non-commercial only; the moment this
 *     project takes any donation it becomes a commercial blocker.
 *     Self-hosted Protomaps has no per-request cost on the infra we
 *     already operate.
 *
 * `registerPMTilesProtocol()` is idempotent — safe to call at module
 * load time and again at any future entry. Without it, MapLibre's
 * `pmtiles://…` URLs throw "Unknown protocol" the first time a map
 * mounts.
 */

import { layers as protomapsLayers, namedFlavor } from "@protomaps/basemaps";
import maplibregl from "maplibre-gl";
import { Protocol } from "pmtiles";

import { PMTILES_URL, PMTILES_URL_FALLBACK } from "@/maps/api/constants";

/**
 * Resolved PMTiles source URL. Tries our worker-hosted file first;
 * if a HEAD request 404s (no file uploaded yet) we cache the
 * Protomaps public demo bucket URL for the rest of this session and
 * the maps render unmodified. The probe runs at most once per page
 * load and is async so map mount isn't blocked.
 *
 * Why we don't just always use the demo bucket: that's a third-party
 * dependency, doesn't scale to our intended traffic without their
 * permission, and disappears if Protomaps ever takes it down. Why we
 * don't fail closed when our R2 is empty: until the user uploads the
 * file (see overpass-cache/scripts/upload-pmtiles.md) the worker
 * /tiles/* route 404s, and we'd rather show a working basemap than
 * a blank screen.
 */
let resolvedPmtilesUrl: string = PMTILES_URL;
let probeFired = false;

function probePmtilesAvailability(): void {
    if (probeFired) return;
    probeFired = true;
    fetch(PMTILES_URL, { method: "HEAD" })
        .then((r) => {
            if (!r.ok) {
                console.warn(
                    `[protomaps] worker tiles route returned ${r.status}; falling back to Protomaps public demo. Upload our PMTiles file to switch back.`,
                );
                resolvedPmtilesUrl = PMTILES_URL_FALLBACK;
            }
        })
        .catch((e) => {
            console.warn(
                "[protomaps] worker tiles probe threw; falling back to demo bucket:",
                e,
            );
            resolvedPmtilesUrl = PMTILES_URL_FALLBACK;
        });
}

/** Source id used inside the maplibre style. The basemap layer
 *  definitions all reference this; keep it stable. */
const PROTOMAPS_SOURCE_ID = "protomaps";

let protocolRegistered = false;

/** Register the `pmtiles://` protocol with maplibre so style URLs of
 *  the form `pmtiles://https://…/file.pmtiles` resolve to tile data
 *  via HTTP range requests. Idempotent. */
export function registerPMTilesProtocol(): void {
    if (protocolRegistered) return;
    const protocol = new Protocol();
    maplibregl.addProtocol("pmtiles", protocol.tile);
    protocolRegistered = true;
}

/** Theme of the basemap. Maps 1:1 to one of Protomaps' shipped
 *  flavors. `light` and `dark` are the user-facing ones; the rest are
 *  available for future use. */
export type ProtomapsTheme =
    | "light"
    | "dark"
    | "grayscale"
    | "black"
    | "white";

/**
 * Build a MapLibre Style for our basemap using Protomaps' shipped
 * "flavor" + layer set. Stock for now — commit 2 will fork the layer
 * list to strip POIs/buildings and amplify the transit network.
 *
 * Pass `lang` to localise labels (defaults to English).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function protomapsMapLibreStyle(theme: ProtomapsTheme = "light"): any {
    registerPMTilesProtocol();
    probePmtilesAvailability();
    const flavor = namedFlavor(theme);
    const layers = transitFirstLayers(
        protomapsLayers(PROTOMAPS_SOURCE_ID, flavor, { lang: "en" }),
        theme,
    );
    return {
        version: 8,
        // Glyphs (font sprites). Protomaps' canonical glyph URL — we
        // could self-host these too later, but they're small (a few
        // MB total) and not in the per-tile critical path.
        glyphs:
            "https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf",
        sources: {
            [PROTOMAPS_SOURCE_ID]: {
                type: "vector",
                url: `pmtiles://${resolvedPmtilesUrl}`,
                attribution:
                    '<a href="https://protomaps.com">Protomaps</a> © <a href="https://openstreetmap.org">OpenStreetMap</a>',
            },
        },
        layers,
    };
}

/* ─────────────────── Transit-first style fork ─────────────────── *
 *
 * The reference is the Jet Lag YouTube show's NYC episodes: their
 * basemap is essentially a "clean canvas" — pale uniform land, soft
 * pastel water, near-invisible road grid — with the **transit
 * network** drawn in saturated colour as the visual hero. That makes
 * sense for the game: the gameplay is transit-based, so the player's
 * eye should snap to the transit network, not be distracted by every
 * minor street or building.
 *
 * Protomaps ships a general-purpose basemap style (71 layers). We
 * keep ~20 of them, drop the noisy categories outright, and amplify
 * rail. This function takes the stock layer list and rewrites it
 * in-place so any flavor update from Protomaps still flows through —
 * we only override what we have to.
 */

/** Stock layer ids we drop entirely. Categorised so future tweaks
 *  are obvious: clutter, landuse noise, road casings (the duplicate
 *  underlay strokes that make roads pop on the default style), and
 *  every label layer except place names. */
const DROPPED_LAYER_IDS = new Set<string>([
    // Visual clutter
    "buildings",
    "pois",
    "landcover",
    // Specialised landuse — we keep landuse_park so green spaces are
    // recognisable landmarks; everything else goes.
    "landuse_urban_green",
    "landuse_hospital",
    "landuse_industrial",
    "landuse_school",
    "landuse_beach",
    "landuse_zoo",
    "landuse_aerodrome",
    "landuse_pedestrian",
    "landuse_pier",
    "landuse_runway",
    "roads_runway",
    "roads_taxiway",
    "roads_pier",
    // Tunnels (we don't need underground road visualisation for a
    // transit-based game).
    "roads_tunnels_other_casing",
    "roads_tunnels_minor_casing",
    "roads_tunnels_link_casing",
    "roads_tunnels_major_casing",
    "roads_tunnels_highway_casing",
    "roads_tunnels_other",
    "roads_tunnels_minor",
    "roads_tunnels_link",
    "roads_tunnels_major",
    "roads_tunnels_highway",
    // Road casings (the underlay strokes that make roads visually
    // pop). Dropping them with the muted line colour below reduces
    // the road network to a barely-perceptible underlay.
    "roads_minor_service_casing",
    "roads_minor_casing",
    "roads_link_casing",
    "roads_major_casing_late",
    "roads_major_casing_early",
    "roads_highway_casing_late",
    "roads_highway_casing_early",
    // Bridges — keep their structural lines? Drop the casings, keep
    // the centerlines so a bridge still reads as connected road.
    "roads_bridges_other_casing",
    "roads_bridges_link_casing",
    "roads_bridges_minor_casing",
    "roads_bridges_major_casing",
    "roads_bridges_highway_casing",
    // Label noise — only place names survive (see KEEP list below).
    "address_label",
    "water_waterway_label",
    "earth_label_islands",
    "roads_oneway",
    "roads_labels_minor",
    "roads_labels_major",
    "roads_shields",
]);

/** Rail line colour per theme. The show uses real transit colours
 *  per line, which requires OSM `route=subway` relation data that
 *  Protomaps' stock vector tiles don't expose. As a starting point
 *  we draw all rail in a single saturated colour — a follow-up will
 *  layer OpenRailwayMap (which has the per-route colours) on top via
 *  the existing raster overlay route the app already has. */
function railColour(theme: ProtomapsTheme): string {
    switch (theme) {
        case "dark":
        case "black":
            return "#f97316"; // orange-500 — pops on dark
        case "grayscale":
        case "white":
            return "#ea580c"; // orange-600
        case "light":
        default:
            return "#dc2626"; // red-600 — matches our boundary outline
    }
}

/** Mute the road centrelines to near the land colour so they read
 *  as a subtle underlay rather than a network. Per theme so the
 *  hue tracks the background. */
function mutedRoadColour(theme: ProtomapsTheme): string {
    switch (theme) {
        case "dark":
        case "black":
            return "#2a2a2e";
        case "grayscale":
        case "white":
            return "#d4d4d8";
        case "light":
        default:
            return "#e5e5e5";
    }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function transitFirstLayers(stock: any[], theme: ProtomapsTheme): any[] {
    const out: any[] = [];
    const muted = mutedRoadColour(theme);
    const rail = railColour(theme);
    for (const layer of stock) {
        if (DROPPED_LAYER_IDS.has(layer.id)) continue;

        // Roads → mute. Drop the road centrelines to a single
        // near-background colour and trim their max width by ~60 %
        // so they're a hint rather than a network.
        if (
            layer.id === "roads_highway" ||
            layer.id === "roads_major" ||
            layer.id === "roads_minor" ||
            layer.id === "roads_minor_service" ||
            layer.id === "roads_link" ||
            layer.id === "roads_other" ||
            layer.id === "roads_bridges_highway" ||
            layer.id === "roads_bridges_major" ||
            layer.id === "roads_bridges_minor" ||
            layer.id === "roads_bridges_link" ||
            layer.id === "roads_bridges_other"
        ) {
            out.push({
                ...layer,
                paint: {
                    ...layer.paint,
                    "line-color": muted,
                    "line-opacity": 0.7,
                },
            });
            continue;
        }

        // Rail → amplify. Solid line, saturated colour, ~2.5× wider
        // than stock. The show's transit-as-hero look.
        if (layer.id === "roads_rail") {
            out.push({
                ...layer,
                paint: {
                    "line-color": rail,
                    "line-opacity": 0.95,
                    "line-width": [
                        "interpolate",
                        ["exponential", 1.6],
                        ["zoom"],
                        3,
                        0,
                        6,
                        0.6,
                        12,
                        2.0,
                        15,
                        3.2,
                        18,
                        6,
                    ],
                },
            });
            continue;
        }

        // Everything else — keep stock.
        out.push(layer);
    }
    return out;
}
