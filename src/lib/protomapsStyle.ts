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
 * "flavor" + layer set, curated (POIs + rail dropped — see
 * curatedBasemapLayers). Pass `lang` to localise labels.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function protomapsMapLibreStyle(theme: ProtomapsTheme = "light"): any {
    registerPMTilesProtocol();
    probePmtilesAvailability();
    const flavor = namedFlavor(theme);
    const layers = curatedBasemapLayers(
        protomapsLayers(PROTOMAPS_SOURCE_ID, flavor, { lang: "en" }),
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

/* ─────────────────── Basemap style curation ─────────────────── *
 *
 * Protomaps ships a clean, general-purpose 71-layer basemap. We keep
 * almost all of it and drop just two categories:
 *
 *   - POIs: shop/amenity icons. They clutter the map AND collide
 *     visually with the question markers the app draws on top (a
 *     stray "museum" POI next to our own museum reference pin is
 *     confusing). The overpass-cached reference data is the source
 *     of truth for those.
 *   - Rail (`roads_rail`): transit lines are surfaced by the app's
 *     dedicated map-overlay toggle (OpenRailwayMap raster), so baking
 *     them into the base is redundant and can't be turned off.
 *
 * Everything else — roads with casings, labels, buildings, landcover,
 * landuse, water — renders at full Protomaps detail. (v240 walked
 * back the v231 "transit-first" fork, which over-stripped the style:
 * it dropped landcover + muted roads to near-invisible, so a large
 * rural play area at low zoom rendered as bare dark earth with
 * nothing on it — visible as the "empty" wizard + lobby previews.)
 *
 * Pure filter on the stock layer list, so any future flavor or layer
 * addition from @protomaps/basemaps flows through untouched.
 */
const DROPPED_LAYER_IDS = new Set<string>(["pois", "roads_rail"]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function curatedBasemapLayers(stock: any[]): any[] {
    return stock.filter((layer) => !DROPPED_LAYER_IDS.has(layer.id));
}
