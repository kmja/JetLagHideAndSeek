import * as turf from "@turf/turf";
import type { Feature, MultiPolygon, Polygon } from "geojson";
import memoize from "lodash/memoize";
import uniqBy from "lodash/uniqBy";
import osmtogeojson from "osmtogeojson";
import { toast } from "react-toastify";

import {
    hiderMode,
    mapGeoJSON,
    mapGeoLocation,
    polyGeoJSON,
    trainStations,
} from "@/lib/context";
import { zoneBufferKm } from "@/lib/houseRules";
import {
    fetchBorders0Land,
    fetchBorders1States,
    fetchCoastline,
    findPlacesInZone,
    findPlacesSpecificInZone,
    apiLocationFilter,
    apiLocationMatches,
    nearestToQuestion,
    prettifyLocation,
    QuestionSpecificLocation,
} from "@/maps/api";
import { fetchAreaCoastlineLines } from "@/maps/api/coast";
import { seaLevelRegion } from "@/maps/api/elevation";
import {
    fetchPrewarmedAreaWater,
    requestWaterWarmAll,
} from "@/maps/api/water";
import { fetchPrewarmedRailStationElements } from "@/lib/journey/stations";
import { bufferAndUnion, bufferPointsUnion } from "@/lib/geometry/client";
import { filterCoastlineByStraitRule } from "@/maps/questions/coastlineStrait";
import {
    basemapCoastLines,
    basemapWaterVersion,
    getBasemapWaterPolys,
} from "@/maps/api/basemapWater";
import { majorCityPoints } from "@/maps/data/majorCities";
import {
    arcBufferToPoint,
    connectToSeparateLines,
    groupObjects,
    holedMask,
    modifyMapData,
} from "@/maps/geo-utils";
import { playAreaSignature } from "@/maps/geo-utils/playAreaIndex";
import type {
    APILocations,
    HomeGameMeasuringQuestions,
    MeasuringQuestion,
} from "@/maps/schema";

/**
 * v374: ceiling on candidate count before we skip a measuring `*-full`
 * elimination. The eliminated region is a single batched ArcGIS
 * geodesic buffer+union (one synchronous WASM call), which scales well
 * past the old 1000 cap — but it does run on the main thread, so we keep
 * a generous ceiling to stop a pathological play area (tens of thousands
 * of features) from freezing the tab. Real dense cities sit well under
 * this (Ottawa ≈ 1103 parks).
 */
const MEASURING_ELIMINATION_CAP = 5000;

/**
 * v933: a FOUNTAIN masquerading as a body of water. OSM sometimes tags a
 * fountain as `natural=water` with a fountain-y NAME but WITHOUT the
 * `water=fountain` subtag our `WATER_FILTERS` exclusion keys on — so it
 * slips through (e.g. NYC's "Madison Square Fountain"). A fountain isn't a
 * body of water (rulebook p11), and when the nearest real river is slightly
 * farther, the fountain wrongly wins as the "nearest reference," poisoning
 * the seeker-distance buffer AND the label. We drop it CLIENT-SIDE here and
 * in the nearest-water label — no `WATER_FILTERS` change (which would orphan
 * every city's cache and need an operator re-warm). Name + tiny-area gate so
 * a genuinely large lake named e.g. "Fountain Lake" is never excluded.
 */
export function isFountainWaterFeature(f: Feature): boolean {
    const props = f.properties as Record<string, unknown> | null;
    const name = (props?.["name:en"] ?? props?.["name"]) as string | undefined;
    if (!name || !/\bfountains?\b/i.test(name)) return false;
    try {
        // < ~1.2 ha — a fountain basin, never a real lake/reservoir.
        return turf.area(f as never) < 12_000;
    } catch {
        // Unmeasurable geometry + fountain-named → treat as a fountain.
        return true;
    }
}

const highSpeedBase = memoize(
    (features: Feature[]) => {
        const grouped = groupObjects(features);

        const neighbored = grouped
            .map((group) => {
                return turf.multiLineString(
                    connectToSeparateLines(
                        group
                            .filter((x) => turf.getType(x) === "LineString")
                            .map((x) => x.geometry.coordinates),
                    ),
                );
            })
            .filter((x) => x.geometry.coordinates.length > 0);

        return turf.combine(
            turf.buffer(
                turf.simplify(turf.featureCollection(neighbored), {
                    tolerance: 0.001,
                }),
                0.001,
            )!,
        ).features[0];
    },
    (features) => `${JSON.stringify(features.map((x) => x.geometry))}`,
);

/* ── v341: bundled-dataset clip helpers ───────────────────────────── *
 *
 * Used by the international-border / admin1-border / body-of-water
 * cases to prune the bundled Natural Earth FeatureCollections down to
 * just the features near the current play area's bbox BEFORE running
 * the expensive geodesic buffer. Without these, we'd buffer every
 * country border on Earth on every measuring-question render — that
 * was a noticeable hitch in early prototyping.
 *
 * The bbox is widened by ~3 degrees on each side (`pad`) so a border /
 * lake that sits just outside the play-area rectangle but is still the
 * nearest feature to the seeker stays in the candidate set.
 */
type Bbox4 = [number, number, number, number];

/** turf.bbox returns BBox which can be 4- or 6-element (with elevation).
 *  Coerce to a 4-tuple [w, s, e, n] for our planar intersection tests. */
function bbox4(b: GeoJSON.BBox | number[]): Bbox4 {
    return [b[0], b[1], b[2], b[3]];
}

function widenedBbox(b: GeoJSON.BBox | number[], pad = 3): Bbox4 {
    return [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];
}

function bboxesIntersect(a: Bbox4, b: Bbox4): boolean {
    return !(b[0] > a[2] || b[2] < a[0] || b[1] > a[3] || b[3] < a[1]);
}

function clipLinesToBbox(
    fc: GeoJSON.FeatureCollection,
    bbox: GeoJSON.BBox | number[],
): Feature[] {
    const widened = widenedBbox(bbox);
    const kept: Feature[] = [];
    for (const f of fc.features) {
        const g = f.geometry as GeoJSON.Geometry | undefined;
        if (!g) continue;
        if (g.type !== "LineString" && g.type !== "MultiLineString") continue;
        const fb = bbox4(turf.bbox(f));
        if (!bboxesIntersect(fb, widened)) continue;
        kept.push(f as Feature);
    }
    return kept;
}

const bboxExtension = (
    bBox: [number, number, number, number],
    distance: number,
): [number, number, number, number] => {
    const buffered = turf.bbox(
        turf.buffer(turf.bboxPolygon(bBox), Math.abs(distance), {
            units: "miles",
        })!,
    );

    const originalDeltaLat = bBox[3] - bBox[1];
    const originalDeltaLng = bBox[2] - bBox[0];

    return [
        buffered[0] - originalDeltaLng,
        buffered[1] - originalDeltaLat,
        buffered[2] + originalDeltaLng,
        buffered[3] + originalDeltaLat,
    ];
};

export const determineMeasuringBoundary = async (
    question: MeasuringQuestion,
) => {
    const bBox = turf.bbox(mapGeoJSON.get()!);

    // v346: manual reference-point fallback. When the seeker has tapped
    // a reference point (because the data path failed), use it directly
    // — the downstream arcBufferToPoint turns this single point into the
    // "closer than the seeker" circle, which is exactly the measuring
    // semantics. Bypasses all data fetching. (sea-level is excluded:
    // it's a contour split handled in adjustPerMeasuring, not a
    // point-buffer, so a manual point doesn't apply.)
    const manual = (question as { manualReference?: { lat: number; lng: number } })
        .manualReference;
    if (manual && question.type !== "sea-level") {
        return [turf.point([manual.lng, manual.lat])];
    }

    switch (question.type) {
        case "highspeed-measure-shinkansen": {
            const features = osmtogeojson(
                await findPlacesInZone(
                    "[highspeed=yes]",
                    // No loadingText — picker has its own progress UI.
                    undefined,
                    "nwr",
                    "geom",
                ),
            ).features;

            return [highSpeedBase(features)];
        }
        case "coastline": {
            // v778: per-city OSM coastline LINES, treated exactly like the
            // international-/admin1-border cases — the downstream
            // arcBufferToPoint buffers the coast by the seeker's distance to
            // it, giving the "closer to the coast than the seeker" region.
            // This replaces the old close-into-land-polygon + difference
            // construction, which relied on the bundled 1:50m coastline
            // (far too coarse for a metro like NYC) and only worked because
            // arcBufferToPoint's buffer collapsed to ~0. Rulebook p18: only
            // coast WITHIN the play area exists, which is exactly what the
            // per-city fetch returns. Falls back to the bundled 1:50m
            // coastline clipped to the frame when per-city coast is
            // unavailable, so nothing breaks.
            // v1001: prefer the BASEMAP ocean shoreline — the boundary of the
            // basemap `water` ocean/sea/bay polygons (`basemapCoastLines`), the
            // authoritative sea the map already draws, tile-seams dissolved and
            // frame edges dropped. Only engages when the local sea is tagged
            // ocean/sea/bay; otherwise falls through to the per-city OSM
            // coastline, then the bundled 1:50m — so it never regresses.
            const basemapCoast = basemapCoastLines(bbox4(bBox));
            let coastLines: Feature[];
            if (basemapCoast && basemapCoast.length > 0) {
                coastLines = basemapCoast as Feature[];
            } else {
                const perCity = await fetchAreaCoastlineLines();
                if (perCity && perCity.length > 0) {
                    // Flatten any MultiLineString into LineStrings so the
                    // highSpeedBase line combiner (which only groups
                    // LineStrings) keeps every segment.
                    coastLines = [];
                    for (const f of perCity) {
                        const g = f.geometry;
                        if (g?.type === "LineString") {
                            coastLines.push(f as Feature);
                        } else if (g?.type === "MultiLineString") {
                            for (const part of g.coordinates) {
                                if (part.length >= 2)
                                    coastLines.push(turf.lineString(part));
                            }
                        }
                    }
                } else {
                    coastLines = clipLinesToBbox(await fetchCoastline(), bBox);
                }
            }
            if (coastLines.length === 0) return [turf.multiPolygon([])];
            // v969 (rulebook audit A4): the 2 km strait rule — OSM coastline
            // traces every tidal channel, but the rulebook only counts coast
            // on the ocean / a great lake / water connected to them by a
            // waterway never under 2 km across. Filter the lines to the
            // qualifying shoreline via a morphological opening of the sea
            // polygon; `[]` means the area's only "coast" is narrow water
            // (no coastline exists per the rulebook), `null` means the
            // filter couldn't compute → keep the unfiltered lines.
            const qualifying = filterCoastlineByStraitRule(
                coastLines as Feature<
                    GeoJSON.LineString | GeoJSON.MultiLineString
                >[],
                bBox as [number, number, number, number],
                { lng: question.lng, lat: question.lat },
            );
            if (qualifying !== null) {
                if (qualifying.length === 0) return [turf.multiPolygon([])];
                coastLines = qualifying;
            }
            return [highSpeedBase(coastLines)];
        }
        case "airport":
            return [
                turf.combine(
                    turf.featureCollection(
                        uniqBy(
                            (
                                await findPlacesInZone(
                                    '["aeroway"="aerodrome"]["iata"]', // Only commercial airports have IATA codes,
                                )
                            ).elements,
                            (feature: any) => feature.tags.iata,
                        ).map((x: any) =>
                            turf.point([
                                x.center ? x.center.lon : x.lon,
                                x.center ? x.center.lat : x.lat,
                            ]),
                        ),
                    ),
                ).features[0],
            ];
        case "city":
            // Bundled worldwide 1M+ city list — no Overpass, and
            // includes out-of-play-area cities (usually the nearest).
            return [
                turf.combine(
                    turf.featureCollection(majorCityPoints()),
                ).features[0],
            ];
        case "aquarium-full":
        case "zoo-full":
        case "theme_park-full":
        case "peak-full":
        case "museum-full":
        case "hospital-full":
        case "cinema-full":
        case "library-full":
        case "golf_course-full":
        case "consulate-full":
        case "park-full": {
            const location = question.type.split("-full")[0] as APILocations;

            const data = await findPlacesInZone(
                apiLocationFilter(location),
                // No loadingText: the picker has its own inline
                // progress UI; toast.promise here stacks duplicates
                // when the nearest-reference preview and the main
                // map's mask both run the same query.
                undefined,
                "nwr",
                "center",
                [],
                60,
            );

            if (data.remark && data.remark.startsWith("runtime error")) {
                toast.error(
                    `Error finding ${prettifyLocation(
                        location,
                        true,
                    ).toLowerCase()} — Overpass returned a runtime error. Try again, or pick a less common place type.`,
                );
                return [turf.multiPolygon([])];
            }

            // v374: the main-map elimination is a SINGLE batched ArcGIS
            // geodesic buffer+union (arcBufferToPoint → innateArcBuffer's
            // executeMany with union:true), not the pairwise turf.union
            // this cap was originally sized for — so it scales to far more
            // than 1000. It also only runs once, on answer (draft
            // questions are skipped by drag:true), and is memoised, so a
            // brief one-time compute is fine. Cap raised 1000 → 5000 to
            // cover dense real cities (Ottawa's 1103 parks now eliminate
            // normally); the ceiling stays only to guard against a
            // pathological play area with tens of thousands of features
            // freezing the main thread on that one synchronous WASM call.
            if (data.elements.length >= MEASURING_ELIMINATION_CAP) {
                toast.warn(
                    `${data.elements.length} ${prettifyLocation(
                        location,
                        true,
                    ).toLowerCase()} in this area — too many to compute an elimination for. This question won't narrow your map; try a less common place type or a smaller play area.`,
                );
                return [turf.multiPolygon([])];
            }

            return [
                turf.combine(
                    turf.featureCollection(
                        data.elements
                            // v970 (rulebook audit B): re-check tags
                            // client-side so the cached paths' exclusions
                            // (golf driving ranges / mini golf) apply to
                            // this LIVE query too — label and cut agree.
                            .filter(
                                (x: any) =>
                                    !x.tags ||
                                    apiLocationMatches(location, x.tags),
                            )
                            .map((x: any) =>
                                turf.point([
                                    x.center ? x.center.lon : x.lon,
                                    x.center ? x.center.lat : x.lat,
                                ]),
                            ),
                    ),
                ).features[0],
            ];
        }
        /* ── v340: rulebook-completion measuring types ──────────────── *
         *
         * Each case fetches the relevant OSM features inside the play
         * area + 50 km pad (via findPlacesInZone) and returns them as
         * Feature[]. The downstream bufferedDeterminer →
         * arcBufferToPoint pipeline geodesic-buffers them by the
         * seeker-to-feature distance, exactly like coastline / airport
         * / *-full. Line-shaped queries reuse the highSpeedBase line
         * combiner; polygon queries combine directly; point queries
         * follow the *-full pattern.
         */
        case "rail-measure-ordinary": {
            // All rail stations inside the play area. Rulebook p206:
            // "Includes light and heavy rail; metros/subways count" —
            // v970 (rulebook audit B): the prewarmed all-mode station
            // union filtered to rail modes is the primary source (it
            // covers halts, tram stops and PTv2-only light rail the bare
            // `railway=station` filter misses, and is Overpass-free for
            // a warm city); the live query is the cold-area fallback,
            // broadened to station|halt|tram_stop. Same shape as the
            // *-full POI cases — points get buffered radially by the
            // seeker-distance arc.
            const prewarmedRail = await fetchPrewarmedRailStationElements();
            const elements: any[] =
                prewarmedRail ??
                ((
                    await findPlacesInZone(
                        '["railway"~"^(station|halt|tram_stop)$"]',
                        undefined,
                        "nwr",
                        "center",
                        [],
                        60,
                    )
                ).elements ??
                    []);
            if (elements.length === 0) {
                return [turf.multiPolygon([])];
            }
            return [
                turf.combine(
                    turf.featureCollection(
                        elements.map((x: any) =>
                            turf.point([
                                x.center ? x.center.lon : x.lon,
                                x.center ? x.center.lat : x.lat,
                            ]),
                        ),
                    ),
                ).features[0],
            ];
        }
        case "international-border": {
            // v341: bundled Natural Earth 1:50m admin_0 borders —
            // 760 KB static asset cached PERMANENT, zero external at
            // game time. Per-play-area clip via bboxClip so we only
            // buffer what's nearby (a 4-degree bbox is enough; a few
            // border lines in a city's frame, not the world's set).
            const bordersFC = await fetchBorders0Land();
            let clipped = clipLinesToBbox(bordersFC, bBox);
            // v970 (rulebook audit B): "Enclaves count!" (rulebook p210) —
            // the 1:50m bundle omits MICRO-enclaves (Baarle, Llívia,
            // Büsingen; Kaliningrad-scale is in it). Fold in the play
            // area's own OSM `admin_level=2` border WAYS (a poly-scoped
            // query returns just the local segments — including enclave
            // rings — not whole-country relations). Best-effort: any
            // failure keeps the bundled lines alone.
            try {
                const osm = osmtogeojson(
                    await findPlacesInZone(
                        '["boundary"="administrative"]["admin_level"="2"]',
                        undefined,
                        "way",
                        "geom",
                    ),
                ).features.filter(
                    (f) =>
                        f.geometry?.type === "LineString" ||
                        f.geometry?.type === "MultiLineString",
                );
                if (osm.length > 0) {
                    clipped = clipped.concat(osm as Feature[]);
                }
            } catch {
                /* bundled lines only */
            }
            if (clipped.length === 0) return [turf.multiPolygon([])];
            return [highSpeedBase(clipped)];
        }
        case "admin1-border": {
            // v341: bundled Natural Earth 1:50m admin_1 borders.
            // Same Tier-1 (zero external) treatment as admin_0.
            // 882 KB static asset, ~580 state/province borders globally.
            const bordersFC = await fetchBorders1States();
            const clipped = clipLinesToBbox(bordersFC, bBox);
            if (clipped.length === 0) return [turf.multiPolygon([])];
            return [highSpeedBase(clipped)];
        }
        case "admin2-border": {
            // 2nd administrative division — county / district borders,
            // typically OSM admin_level=6. Natural Earth has no global
            // dataset for this tier, so this case still goes through
            // Overpass (cached at our worker, not bundled).
            //
            // v978 FIX: query RELATIONS, not ways. A county boundary's
            // `admin_level`/`boundary` tags live on the boundary RELATION;
            // its member ways are usually untagged, so the old
            // `way["admin_level"="6"]` returned NOTHING (the "county border
            // shows no overlay" bug — matching county works because
            // findAdminBoundary fetches relations). Fetch the relations with
            // geometry, then convert each boundary POLYGON to its outline
            // LINE so the seeker-distance buffer measures distance to the
            // border, same as admin1/coastline.
            const relFeatures = osmtogeojson(
                await findPlacesInZone(
                    '["admin_level"="6"]["boundary"="administrative"]',
                    undefined,
                    "relation",
                    "geom",
                ),
            ).features;
            const lines: Feature[] = [];
            for (const f of relFeatures) {
                const g = f.geometry;
                if (!g) continue;
                if (g.type === "LineString" || g.type === "MultiLineString") {
                    lines.push(f as Feature);
                } else if (
                    g.type === "Polygon" ||
                    g.type === "MultiPolygon"
                ) {
                    try {
                        const l = turf.polygonToLine(f as any);
                        if ((l as any).type === "FeatureCollection") {
                            for (const lf of (l as any).features) lines.push(lf);
                        } else {
                            lines.push(l as Feature);
                        }
                    } catch {
                        /* skip a malformed boundary */
                    }
                }
            }
            const clipped = clipLinesToBbox(
                turf.featureCollection(lines as any),
                bBox,
            );
            if (clipped.length === 0) return [turf.multiPolygon([])];
            return [highSpeedBase(clipped)];
        }
        case "body-of-water": {
            // v998.2: body-of-water reads ONLY the basemap `water` layer — the
            // authoritative land/water map we already ship offline (Protomaps
            // assembled the ocean + bays + lakes + wide rivers as real polygons,
            // globally correct, including every shoreline as a polygon boundary).
            // We read those polygons straight off the loaded map
            // (`getBasemapWaterPolys`, captured by `basemapWater.ts`) and buffer
            // them by the seeker's nearest-water distance: buffering the real
            // water polygons gives the open sea (inside → distance 0 → closer)
            // AND the near-shore land band, and the radius = seeker → nearest
            // water is EXACTLY what the nearest-reference label shows (it reads
            // the SAME basemap water via `nearestBasemapWater`). So the overlay
            // and the label agree by construction — no separate coastline fetch,
            // no OSM `natural=water`, no `__waterArea` hack, no coastline
            // assembly / polygonize / flood-fill. The map data IS the answer.
            const basemapWater = getBasemapWaterPolys(bbox4(bBox));
            if (basemapWater && basemapWater.length > 0) {
                // v1001: SIMPLIFY each water polygon (~30 m, negligible against a
                // ≥km buffer) before it goes downstream. Raw MVT tile geometry —
                // the ocean split across dozens of tiles, tens of thousands of
                // vertices — made the buffer SLOW/HANG (the "overlay never loads"
                // + the veil timing out and revealing a bare map). Simplified, the
                // buffer is fast + robust, so the veil holds until the overlay is
                // ready then lifts with it. Keep the unsimplified poly on a
                // simplify failure rather than dropping water.
                const simplified: Feature<Polygon | MultiPolygon>[] = [];
                for (const w of basemapWater) {
                    try {
                        const s = turf.simplify(w, {
                            tolerance: 0.0003,
                            highQuality: false,
                            mutate: false,
                        }) as Feature<Polygon | MultiPolygon>;
                        simplified.push(s && s.geometry ? s : w);
                    } catch {
                        simplified.push(w);
                    }
                }
                return simplified;
            }
            // COLD FALLBACK (no map has captured the basemap water yet — rare,
            // since the configure map frames the play area and captures it before
            // the question is configured): OSM named water + rivers + per-city
            // coastline lines, buffered. Open water beyond the band reads
            // "further" until the basemap water lands — which busts the memo (the
            // `bmw` key) and recomputes. Kept so a cold area still draws SOMETHING.
            const prewarmed = await fetchPrewarmedAreaWater();
            const data =
                prewarmed ??
                (await findPlacesInZone(
                    '["natural"="water"]["name"]["water"!~"pond|basin|pool|fountain|wastewater|moat|tank|ditch"]',
                    undefined,
                    "nwr",
                    "geom",
                    ['["waterway"~"^(river|canal)$"]'],
                    60,
                ));
            if (!prewarmed) requestWaterWarmAll();
            const fc = osmtogeojson(data);
            const polys = fc.features.filter(
                (f): f is Feature<Polygon | MultiPolygon> =>
                    (f.geometry?.type === "Polygon" ||
                        f.geometry?.type === "MultiPolygon") &&
                    !isFountainWaterFeature(f),
            );
            const lines = fc.features.filter(
                (f) =>
                    f.geometry?.type === "LineString" ||
                    f.geometry?.type === "MultiLineString",
            );
            const out: Feature[] = [];
            if (polys.length > 0) {
                out.push(
                    turf.combine(turf.featureCollection(polys as any))
                        .features[0],
                );
            }
            if (lines.length > 0) {
                out.push(highSpeedBase(lines));
            }
            try {
                const cityCoastLines = await fetchAreaCoastlineLines();
                const coastLines =
                    cityCoastLines && cityCoastLines.length > 0
                        ? cityCoastLines
                        : clipLinesToBbox(await fetchCoastline(), bBox);
                if (coastLines.length > 0) out.push(highSpeedBase(coastLines));
            } catch (e) {
                console.warn("body-of-water coastline band failed:", e);
            }
            if (out.length === 0) return [turf.multiPolygon([])];
            return out;
        }
        case "sea-level": {
            // v342: handled out-of-band in adjustPerMeasuring via the
            // self-hosted elevation DEM (seaLevelRegion). It's an
            // altitude contour split, not a feature buffer, so it
            // returns false HERE (skip the buffer pipeline) and the
            // real elimination happens in adjustPerMeasuring.
            return false;
        }
        case "custom-measure":
            return turf.combine(
                turf.featureCollection((question as any).geo.features),
            ).features;
        case "aquarium":
        case "zoo":
        case "theme_park":
        case "peak":
        case "museum":
        case "hospital":
        case "cinema":
        case "library":
        case "golf_course":
        case "consulate":
        case "park":
        case "mcdonalds":
        case "seven11":
        case "rail-measure":
            return false;
    }
};

// v933: extracted so the self-evicting wrapper below can address a memo
// entry by its exact key (mirrors matching.ts's matchingBoundaryMemoKey).
const bufferedDeterminerKey = (question: MeasuringQuestion) =>
    // v376: lightweight playAreaSignature instead of stringifying the
    // whole polygon — see matching.ts memo key for the rationale.
    JSON.stringify({
        type: question.type,
        lat: question.lat,
        lng: question.lng,
        entirety: polyGeoJSON.get()
            ? playAreaSignature(polyGeoJSON.get())
            : ((mapGeoLocation.get()?.properties?.osm_id ?? "") as
                  | string
                  | number),
        geo: (question as any).geo,
        // v346: manual reference invalidates the memo so toggling it
        // recomputes the buffer from the picked point.
        manualReference: (question as any).manualReference,
        // v998: body-of-water reads the basemap `water` layer, captured off a
        // map as tiles load. Fold the capture version into the key so a compute
        // that ran before the water landed is re-run once it does (a stale
        // waterless result would otherwise stay memo-cached at this position).
        bmw:
            question.type === "body-of-water" ||
            question.type === "coastline"
                ? basemapWaterVersion.get()
                : 0,
    });

/** Collect every point coordinate if EVERY feature is a Point / MultiPoint —
 *  the POINT-reference measuring families (park / peak / rail station / any
 *  *-full POI). Returns null when the geometry has a line/polygon (coast,
 *  borders, water) that must stay on the geodesic arcgis buffer. */
function allPointCoords(feats: Feature[]): [number, number][] | null {
    const coords: [number, number][] = [];
    for (const f of feats) {
        const g = f?.geometry;
        if (!g) continue;
        if (g.type === "Point") {
            coords.push(g.coordinates as [number, number]);
        } else if (g.type === "MultiPoint") {
            for (const c of g.coordinates) coords.push(c as [number, number]);
        } else {
            return null; // a line/polygon feature — not a pure point set
        }
    }
    return coords.length > 0 ? coords : null;
}

const bufferedDeterminer = memoize(
    async (question: MeasuringQuestion) => {
        const placeData = await determineMeasuringBoundary(question);

        if (placeData === false || placeData === undefined) return false;

        // v978: POINT-reference families (park / mountain / rail station /
        // every *-full POI) buffer the SAME "union of disks of radius =
        // distance-to-nearest" region — but arcgis did it in one synchronous
        // WASM call over hundreds of point-circles, freezing the app on a
        // dense metro. Route the pure-point case through the geometry Web
        // Worker (turf circles + union, off-thread); the hider grades by
        // DISTANCE so the sub-metre turf-vs-arcgis difference never changes an
        // answer. Lines/polygons (coast, borders, water) stay on the geodesic
        // arcgis buffer. Falls back to arcgis if the worker is unavailable.
        const pointCoords = allPointCoords(placeData as Feature[]);
        if (pointCoords) {
            try {
                const merged = await bufferPointsUnion(
                    pointCoords,
                    question.lat,
                    question.lng,
                );
                return merged ?? false;
            } catch {
                /* worker unavailable — fall through to arcgis below */
            }
        }

        // v984: body-of-water is mixed geometry (ponds + rivers + the sea
        // AREA) — arcgis's buffer choked on the sea's vertices (froze the app /
        // returned null → no overlay). Buffer+union it OFF the main thread with
        // turf (`bufferAndUnion`), the same region arcgis would produce. Falls
        // back to arcgis below if the worker is unavailable or returns null.
        if (question.type === "body-of-water") {
            const feats = placeData as Feature[];
            try {
                const merged = await bufferAndUnion(
                    feats,
                    question.lat,
                    question.lng,
                );
                if (merged) return merged;
            } catch {
                /* worker unavailable / union timed out — retry below */
            }
            // v993: if the union failed (most likely a timeout on the detailed
            // sea polygon), retry WITHOUT the heavy `__waterArea` sea so a
            // sea-union timeout degrades to a partial overlay (ponds + rivers +
            // coastline-lines band) instead of NO overlay at all.
            const noSea = feats.filter(
                (f) =>
                    (f.properties as { __waterArea?: boolean })?.__waterArea !==
                    true,
            );
            if (noSea.length > 0 && noSea.length < feats.length) {
                try {
                    const merged = await bufferAndUnion(
                        noSea,
                        question.lat,
                        question.lng,
                    );
                    if (merged) return merged;
                } catch {
                    /* fall through to arcgis below */
                }
            }
        }

        // arcBufferToPoint returns null when the geometry is degenerate or the
        // geodesic buffer failed even after simplification — normalise to the
        // `false` failure contract so the self-evicting wrapper retries.
        const buffered = await arcBufferToPoint(
            turf.featureCollection(placeData as any),
            question.lat,
            question.lng,
        );
        return buffered ?? false;
    },
    bufferedDeterminerKey,
);

/**
 * v933: `bufferedDeterminer` is memoized, but a TRANSIENT failure — a
 * rate-limited Overpass water/coast fetch, or an arcgis geodesic-buffer
 * throw on a pathologically heavy geometry (NYC's full detailed coast +
 * every river) — would otherwise be cached FOREVER for that seeker
 * position: lodash caches the rejected promise / the `false` result, so
 * every retry at the same pin returns the poisoned value. That silently
 * degraded BOTH the configure preview (fell back to the misleading
 * single-point half-plane) AND the real elimination answer (buffered
 * nothing) for the rest of the game at that spot — the same
 * memoize-caches-failure trap v868 fixed for matching. This wrapper evicts
 * the memo entry whenever the result is a failure (`false`) or the promise
 * rejects, so the next call recomputes. A genuine success is still cached.
 */
async function bufferedDeterminerFresh(question: MeasuringQuestion) {
    try {
        const result = await bufferedDeterminer(question);
        if (result === false) {
            bufferedDeterminer.cache.delete(bufferedDeterminerKey(question));
        }
        return result;
    } catch (e) {
        bufferedDeterminer.cache.delete(bufferedDeterminerKey(question));
        throw e;
    }
}

/**
 * v688: the "closer" buffer for a DRAFT measuring question — the exact
 * geodesic region the elimination keeps when `hiderCloser` (everywhere
 * whose nearest reference is no further than the seeker's). Exposed so the
 * configure-card impact overlay (`questionImpact.ts`) draws the SAME region
 * the answer will carve out, instead of re-deriving it from the centroid
 * point-cache. That mattered for `body-of-water`: the point cache holds
 * `natural=water` CENTROIDS only — no rivers, and lakes measured from their
 * middle — so the overlay buffered distant pond centres and marked areas
 * far from any shore as "closer", disagreeing with both the real cut and
 * the nearest-reference label. Reuses the memoised `bufferedDeterminer`, so
 * repeated calls at a stable seeker position are free.
 */
export async function measuringDraftBuffer(
    type: string,
    lat: number,
    lng: number,
): Promise<Feature<Polygon | MultiPolygon> | null> {
    const buffer = await bufferedDeterminerFresh({
        type,
        lat,
        lng,
        hiderCloser: true,
        drag: false,
        color: "black",
        collapsed: false,
    } as unknown as MeasuringQuestion);
    return buffer === false
        ? null
        : (buffer as Feature<Polygon | MultiPolygon>);
}

// v342: memoised sea-level contour region. Keyed on seeker position +
// play area so the elevation tiles are fetched/decoded + isobanded once
// per (question, area), not on every map render. Mirrors
// bufferedDeterminer's memo discipline.
const seaLevelDeterminer = memoize(
    async (question: MeasuringQuestion) => {
        const $map = mapGeoJSON.get();
        if (!$map) return null;
        const bBox = turf.bbox($map).slice(0, 4) as [
            number,
            number,
            number,
            number,
        ];
        return seaLevelRegion(bBox, question.lng, question.lat);
    },
    (question) =>
        JSON.stringify({
            type: question.type,
            lat: question.lat,
            lng: question.lng,
            entirety: polyGeoJSON.get()
                ? playAreaSignature(polyGeoJSON.get())
                : ((mapGeoLocation.get()?.properties?.osm_id ?? "") as string | number),
        }),
);

export const adjustPerMeasuring = async (
    question: MeasuringQuestion,
    mapData: any,
) => {
    if (mapData === null) return;

    // v342: sea-level is an altitude CONTOUR split, not a
    // distance-to-feature buffer, so it bypasses the
    // bufferedDeterminer / arcBufferToPoint pipeline. seaLevelRegion
    // builds the "closer to sea level" polygon directly from the
    // self-hosted elevation DEM; modifyMapData then keeps the inside
    // (hiderCloser) or outside.
    if (question.type === "sea-level") {
        const region = await seaLevelDeterminer(question);
        if (!region) return mapData;
        return modifyMapData(
            mapData,
            region,
            question.hiderCloser,
            zoneBufferKm(),
        );
    }

    // v933: use the self-evicting wrapper so a transient water/coast fetch
    // or arcgis buffer failure doesn't get memo-cached and permanently make
    // this question "eliminate nothing" for the rest of the game — the next
    // map recompute retries.
    const buffer = await bufferedDeterminerFresh(question);

    if (buffer === false) return mapData;

    return modifyMapData(mapData, buffer, question.hiderCloser, zoneBufferKm());
};

export const hiderifyMeasuring = async (question: MeasuringQuestion) => {
    const $hiderMode = hiderMode.get();
    if ($hiderMode === false) {
        return question;
    }

    if (
        [
            "aquarium",
            "zoo",
            "theme_park",
            "peak",
            "museum",
            "hospital",
            "cinema",
            "library",
            "golf_course",
            "consulate",
            "park",
        ].includes(question.type)
    ) {
        const questionNearest = await nearestToQuestion(
            question as HomeGameMeasuringQuestions,
        );
        const hiderNearest = await nearestToQuestion({
            lat: $hiderMode.latitude,
            lng: $hiderMode.longitude,
            hiderCloser: true,
            type: (question as HomeGameMeasuringQuestions).type,
            drag: false,
            color: "black",
            collapsed: false,
        });

        // No reference found within the capped search radius (absent in-area
        // or an Overpass hiccup) — leave the verdict ungraded rather than
        // dereferencing a null. The hider can still answer manually.
        if (!questionNearest || !hiderNearest) return question;

        question.hiderCloser =
            questionNearest.properties.distanceToPoint >
            hiderNearest.properties.distanceToPoint;

        return question;
    }

    if (question.type === "rail-measure") {
        const stations = trainStations.get();

        if (stations.length === 0) {
            return question;
        }

        const location = turf.point([question.lng, question.lat]);

        const nearestTrainStation = turf.nearestPoint(
            location,
            turf.featureCollection(stations.map((x) => x.properties)),
        );

        const distance = turf.distance(location, nearestTrainStation);

        const hider = turf.point([$hiderMode.longitude, $hiderMode.latitude]);

        const hiderNearest = turf.nearestPoint(
            hider,
            turf.featureCollection(stations.map((x) => x.properties)),
        );

        const hiderDistance = turf.distance(hider, hiderNearest);

        question.hiderCloser = hiderDistance < distance;
    }

    if (question.type === "mcdonalds" || question.type === "seven11") {
        const points = await findPlacesSpecificInZone(
            question.type === "mcdonalds"
                ? QuestionSpecificLocation.McDonalds
                : QuestionSpecificLocation.Seven11,
        );

        const seeker = turf.point([question.lng, question.lat]);
        const nearest = turf.nearestPoint(seeker, points as any);

        const distance = turf.distance(seeker, nearest, {
            units: "miles",
        });

        const hider = turf.point([$hiderMode.longitude, $hiderMode.latitude]);
        const hiderNearest = turf.nearestPoint(hider, points as any);

        const hiderDistance = turf.distance(hider, hiderNearest, {
            units: "miles",
        });

        question.hiderCloser = hiderDistance < distance;
        return question;
    }

    const $mapGeoJSON = mapGeoJSON.get();
    if ($mapGeoJSON === null) return question;

    let feature = null;

    try {
        feature = holedMask((await adjustPerMeasuring(question, $mapGeoJSON))!);
    } catch {
        try {
            feature = await adjustPerMeasuring(question, {
                type: "FeatureCollection",
                features: [holedMask($mapGeoJSON)],
            });
        } catch {
            return question;
        }
    }

    if (feature === null || feature === undefined) return question;

    const hiderPoint = turf.point([$hiderMode.longitude, $hiderMode.latitude]);

    if (turf.booleanPointInPolygon(hiderPoint, feature)) {
        question.hiderCloser = !question.hiderCloser;
    }

    return question;
};

export const measuringPlanningPolygon = async (question: MeasuringQuestion) => {
    try {
        const buffered = await bufferedDeterminerFresh(question);

        if (buffered === false) return false;

        return turf.polygonToLine(buffered);
    } catch {
        return false;
    }
};
