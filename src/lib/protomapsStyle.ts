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

/**
 * Public URL of the PMTiles file. Initial value uses Protomaps' own
 * public demo bucket so the pipeline works without our R2 being
 * populated. Commit 4 will swap to our self-hosted file once the
 * Worker route + R2 upload land. The demo file is the worldwide
 * basemap at z0-15 — large (~50 GB seek window) but PMTiles only
 * pulls the bytes for tiles actually viewed, so the visible cost
 * per session is tiny.
 */
const PROTOMAPS_PMTILES_URL =
    "https://demo-bucket.protomaps.com/v4.pmtiles";

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
    const flavor = namedFlavor(theme);
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
                url: `pmtiles://${PROTOMAPS_PMTILES_URL}`,
                attribution:
                    '<a href="https://protomaps.com">Protomaps</a> © <a href="https://openstreetmap.org">OpenStreetMap</a>',
            },
        },
        layers: protomapsLayers(PROTOMAPS_SOURCE_ID, flavor, { lang: "en" }),
    };
}
