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
 * v241 fallback design (replaces the v233 fire-and-forget probe):
 * the resolved PMTiles URL lives in a nanostore `pmtilesUrl`. Any
 * map consumer should `useStore(pmtilesUrl)` and rebuild its style
 * when it changes. Two things flip the URL to the demo bucket:
 *   1. The module-load HEAD probe against our worker URL.
 *   2. `recordPmtilesError()` called by any consumer that hears a
 *      maplibre tile / source / glyph error mentioning pmtiles.
 * On a healthy upload neither fires and we self-host. On a bad
 * upload the user sees a sub-second flicker, then a working map
 * from the public demo bucket instead of a silently-empty canvas.
 */

import { layers as protomapsLayers, namedFlavor } from "@protomaps/basemaps";
import maplibregl from "maplibre-gl";
import { atom } from "nanostores";
import { Protocol } from "pmtiles";

import {
    MAP_ASSET_BASE,
    PMTILES_URL,
    PMTILES_URL_FALLBACK,
} from "@/maps/api/constants";
import {
    activeTilePackId,
    MERGE_SCHEME,
    registerMergeProtocol,
} from "@/lib/tilePack";

/**
 * Resolved PMTiles source URL — a nanostore so map components can
 * `useStore()` it and rebuild their styles when the URL flips to the
 * fallback bucket. Start with our worker URL; the probe and error
 * recorder below flip it to the demo bucket on failure.
 */
export const pmtilesUrl = atom<string>(PMTILES_URL);

let probeFired = false;

function probePmtilesAvailability(): void {
    if (probeFired) return;
    probeFired = true;
    fetch(PMTILES_URL, { method: "HEAD" })
        .then((r) => {
            if (!r.ok) {
                recordPmtilesError(`HEAD probe returned ${r.status}`);
            } else {
                console.info(
                    `[protomaps] using self-hosted basemap at ${PMTILES_URL}`,
                );
            }
        })
        .catch((e) => {
            recordPmtilesError(`HEAD probe threw: ${e}`);
        });
}

/**
 * Flip to the Protomaps public demo bucket and warn loudly. Idempotent —
 * after the first fallback further errors are silently absorbed (the
 * demo bucket is the last resort; if it's also broken there's no
 * remaining URL to switch to, and re-logging on every failed tile
 * would just spam the console).
 */
export function recordPmtilesError(reason: string): void {
    if (pmtilesUrl.get() === PMTILES_URL_FALLBACK) return;
    console.warn(
        `[protomaps] tile load failure (${reason}); falling back to proxied demo bucket. ` +
            "Re-upload basemap.pmtiles to R2 (see overpass-cache/scripts/upload-pmtiles.md) to restore self-hosting.",
    );
    pmtilesUrl.set(PMTILES_URL_FALLBACK);
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
 *
 * Reads the URL from `pmtilesUrl.get()` at call time, so consumers
 * that rebuild on `useStore(pmtilesUrl)` change pick up the fallback
 * URL without a page reload.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function protomapsMapLibreStyle(theme: ProtomapsTheme = "light"): any {
    registerPMTilesProtocol();
    registerMergeProtocol();
    probePmtilesAvailability();
    const flavor = namedFlavor(theme);
    const layers = curatedBasemapLayers(
        protomapsLayers(PROTOMAPS_SOURCE_ID, flavor, { lang: "en" }),
    );
    const url = pmtilesUrl.get();
    // v336: when a city tile pack is active, route the basemap source
    // through the merge protocol (pack-first, master-fallback). With no
    // pack the plain `pmtiles://` path is byte-identical to before — so
    // the default render path for non-curated cities is untouched.
    const sourceUrl =
        activeTilePackId.get() !== null
            ? `${MERGE_SCHEME}://${url}`
            : `pmtiles://${url}`;
    return {
        version: 8,
        // Glyphs (label fonts). v349: proxied through our worker
        // (MAP_ASSET_BASE → /api/mapasset/...) which R2-caches them
        // from protomaps.github.io. Self-hosted like the basemap tiles;
        // no external dependency at game time. The fonts are global, so
        // R2 fills once and serves every player.
        glyphs: `${MAP_ASSET_BASE}/fonts/{fontstack}/{range}.pbf`,
        // v327: image sprites — `generic_shield-{N}char` PNG icons the
        // basemaps layer set references for highway shields. Without
        // them MapLibre logs 'styleimagemissing' and renders road
        // numbers as plain text. v349: also proxied through the worker
        // (was a direct protomaps.github.io hit). Theme-keyed: the dark
        // variant ships dark shields with light text.
        sprite: `${MAP_ASSET_BASE}/sprites/v4/${theme === "dark" ? "dark" : "light"}`,
        sources: {
            [PROTOMAPS_SOURCE_ID]: {
                type: "vector",
                url: sourceUrl,
                attribution:
                    '<a href="https://protomaps.com">Protomaps</a> © <a href="https://openstreetmap.org">OpenStreetMap</a>',
            },
        },
        layers,
    };
}

/**
 * Hand-off for a maplibre `error` event listener. Inspects the event
 * for the signature of a PMTiles fetch failure and flips to the
 * fallback bucket if it sees one. Safe to call on every error event
 * — non-pmtiles errors are ignored.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function handleMapLibreError(evt: any): void {
    const msg =
        (evt && (evt.error?.message ?? evt.message ?? String(evt))) || "";
    const url = (evt && (evt.sourceId || evt.tile?.tileID || "")) + "";
    if (
        typeof msg === "string" &&
        (msg.toLowerCase().includes("pmtiles") ||
            msg.includes(PMTILES_URL) ||
            url.includes("pmtiles"))
    ) {
        recordPmtilesError(msg);
    }
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
