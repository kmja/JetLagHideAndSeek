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
import { seaFromCoast as seaFromCoastViaWorker } from "@/lib/geometry/client";
import { seaFromCoastline } from "@/maps/questions/seaFromCoastline";
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
            const perCity = await fetchAreaCoastlineLines();
            let coastLines: Feature[];
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
            if (coastLines.length === 0) return [turf.multiPolygon([])];
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
                        data.elements.map((x: any) =>
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
            // All railway stations (heavy + light + metro) inside the
            // play area. Same shape as the *-full POI cases — points
            // get buffered radially by the seeker-distance arc.
            const data = await findPlacesInZone(
                '["railway"="station"]',
                undefined,
                "nwr",
                "center",
                [],
                60,
            );
            if (data.elements.length === 0) {
                return [turf.multiPolygon([])];
            }
            return [
                turf.combine(
                    turf.featureCollection(
                        data.elements.map((x: any) =>
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
            const clipped = clipLinesToBbox(bordersFC, bBox);
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
            // Overpass (cached at our worker, not bundled). A follow-up
            // could prewarm county borders per-shard to eliminate the
            // first-seeker cold fetch, but the bundle alternative isn't
            // available without OSM-derived data we'd have to host
            // ourselves.
            const features = osmtogeojson(
                await findPlacesInZone(
                    '["admin_level"="6"]["boundary"="administrative"]',
                    undefined,
                    "way",
                    "geom",
                ),
            ).features;
            if (features.length === 0) return [turf.multiPolygon([])];
            return [highSpeedBase(features)];
        }
        case "body-of-water": {
            // v625: named water bodies from OSM (rulebook p11: "any named
            // body of water … excluding pools"). Replaces the old Natural
            // Earth 1:50m lakes bundle, which only had ~411 major lakes
            // worldwide and NO rivers — so at city scale (e.g. Bucharest)
            // it found nothing. `natural=water` areas (lakes, reservoirs,
            // ponds, river-areas) come back as polygons; named rivers /
            // canals mapped as centerlines come back as lines and get the
            // same thin line-buffer as coastlines/borders. Both feed the
            // downstream seeker-distance geodesic buffer, so the cut
            // reflects real shore/bank distance, not a coarse centroid.
            // The `["name"]` filter enforces "named" and drops most pools
            // (which are leisure=swimming_pool, not natural=water anyway).
            // v687: prefer the prewarmed `/api/water/<id>` set (served from
            // R2 for a warm city, zero live Overpass) fanned over every
            // play-area relation. On any cold area it returns null and we
            // fall back to the live poly query below — then warm every area
            // so the NEXT body-of-water question is served from cache.
            const prewarmed = await fetchPrewarmedAreaWater();
            const data =
                prewarmed ??
                (await findPlacesInZone(
                    // MAJOR named water bodies only (v685) — exclude the
                    // minor/artificial `water=` subtypes that flood a dense
                    // metro; MUST stay byte-identical to the worker's
                    // `WATER_FILTERS` and `filterForFamily("body-of-water")`.
                    '["natural"="water"]["name"]["water"!~"pond|basin|pool|fountain|wastewater|moat|tank|ditch"]',
                    undefined,
                    "nwr",
                    "geom",
                    // v690: NO `["name"]` on the line filter — OSM often
                    // tags a river's name on only some of its way segments,
                    // so requiring a name per-segment left gaps where the
                    // overlay stopped following an obvious river (an unnamed
                    // `waterway=river` segment of the Sahibi near Delhi).
                    // Rivers/canals are bodies of water even unnamed; the
                    // `^(river|canal)$` type filter still excludes
                    // drains/streams/ditches. Named-only stays on the
                    // `natural=water` POLYGON filter (unnamed ponds excluded).
                    ['["waterway"~"^(river|canal)$"]'],
                    60,
                ));
            if (!prewarmed) requestWaterWarmAll();
            const fc = osmtogeojson(data);
            const polys = fc.features.filter(
                (f): f is Feature<Polygon | MultiPolygon> =>
                    (f.geometry?.type === "Polygon" ||
                        f.geometry?.type === "MultiPolygon") &&
                    // v933: drop fountains mis-tagged as `natural=water`.
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
            // v702/v770: fold in the SEA as an AREA, not just its coast. OSM
            // tags the open sea + large bays as `natural=coastline` (a SEPARATE
            // family), not `natural=water`, so a coastal metro's biggest body
            // of water is invisible to the `natural=water` query. v702 added the
            // bundled coastline as thin LINES, but buffering a line only covers
            // a band near the shore — so OPEN water beyond the seeker's distance
            // was wrongly marked "further from water", which is impossible (it
            // IS water, distance 0). Build the sea as a POLYGON instead: the
            // play-area frame MINUS the land polygons `lineToPolygon` closes the
            // 1:50m coastline into (the same land-as-truth contract
            // `same-landmass` + the `coastline` subtype use). Its whole interior
            // then counts as water. Guarded by a seeker-not-in-sea check: the
            // seeker is on land, so a valid sea polygon never contains them —
            // this rejects an inland frame (land fills it → empty/other sea) and
            // any inverted winding (land mistaken for sea) before it could paint
            // land as water. Falls back to the thin coastline band otherwise.
            try {
                const seeker = { lng: question.lng, lat: question.lat };
                let sea: Feature<Polygon | MultiPolygon> | null = null;
                // v876: keep the DETAILED per-city coast lines around so the
                // last-resort band (when seaFromCoastline fails) can reuse them
                // instead of dropping to the coarse 1:50m bundle.
                let cityCoastLines: Awaited<
                    ReturnType<typeof fetchAreaCoastlineLines>
                > = null;

                // v776: prefer the DETAILED per-city OSM coastline (prewarmed
                // `/api/coast/<id>`). OSM tags the open sea/bays as
                // `natural=coastline`, and the bundled 1:50m coastline is far
                // too coarse for a metro — NYC's harbour + tidal rivers were
                // still marked "further from water". `seaFromCoastline` nodes
                // the coastline against the frame, polygonizes, and labels
                // water by the OSM right-of-way rule; it self-guards
                // (seeker-not-in-sea, degeneracy) and returns null on any
                // failure, so we fall through to the coarse sea below. On a
                // cold coast it background-warms for next time.
                if (bBox) {
                    try {
                        // v778: shared per-city coastline fetch — prewarmed
                        // R2, then a live play-area Overpass query on a cold
                        // city (so an un-warmed coastal metro also gets the
                        // detailed sea, not just the coarse 1:50m fallback).
                        cityCoastLines = await fetchAreaCoastlineLines();
                        const lines = cityCoastLines;
                        if (lines && lines.length > 0) {
                            const frame = bBox as [
                                number,
                                number,
                                number,
                                number,
                            ];
                            // v879: run the heavy seaFromCoastline
                            // (node/polygonize/union) OFF the main thread so a
                            // dense coastal metro (NYC harbour + tidal rivers)
                            // doesn't freeze the UI. Falls back to the sync
                            // main-thread version if the worker is unavailable.
                            try {
                                sea = await seaFromCoastViaWorker(
                                    lines,
                                    frame,
                                    seeker,
                                );
                            } catch {
                                sea = seaFromCoastline(lines, frame, seeker);
                            }
                        }
                    } catch (e) {
                        console.warn(
                            "body-of-water detailed coast failed:",
                            e,
                        );
                    }
                }

                // Fallback: coarse 1:50m sea (v770) — frame MINUS the land the
                // bundled coastline closes into, guarded by seeker-not-in-sea.
                if (!sea && bBox) {
                    try {
                        const coastFC = await fetchCoastline();
                        const frame = turf.bboxPolygon(bBox as any);
                        const landRaw = turf.lineToPolygon(
                            coastFC as any,
                        ) as any;
                        const landFeatures: any[] =
                            landRaw?.type === "FeatureCollection"
                                ? landRaw.features
                                : [landRaw];
                        const landPolys = landFeatures.filter(
                            (f) =>
                                f?.geometry?.type === "Polygon" ||
                                f?.geometry?.type === "MultiPolygon",
                        );
                        if (landPolys.length > 0) {
                            const landCombined = turf.combine(
                                turf.featureCollection(landPolys as any),
                            ).features[0] as Feature<MultiPolygon>;
                            const landClipped = turf.bboxClip(
                                landCombined as any,
                                bBox as any,
                            ) as Feature<Polygon | MultiPolygon>;
                            const hasLand =
                                (landClipped?.geometry?.coordinates?.length ??
                                    0) > 0;
                            const coarse = hasLand
                                ? (turf.difference(
                                      turf.featureCollection([
                                          frame as any,
                                          landClipped as any,
                                      ]),
                                  ) as Feature<
                                      Polygon | MultiPolygon
                                  > | null)
                                : (frame as Feature<Polygon>);
                            const bad =
                                coarse == null ||
                                (() => {
                                    try {
                                        return turf.booleanPointInPolygon(
                                            turf.point([
                                                seeker.lng,
                                                seeker.lat,
                                            ]),
                                            coarse as any,
                                        );
                                    } catch {
                                        return true;
                                    }
                                })();
                            if (!bad && turf.area(coarse as any) > 0)
                                sea = coarse;
                        }
                    } catch (e) {
                        console.warn(
                            "body-of-water coarse sea failed:",
                            e,
                        );
                    }
                }

                if (sea && turf.area(sea as any) > 0) {
                    out.push(sea);
                } else {
                    // Last resort (v876): reuse the DETAILED per-city coast
                    // lines if we have them — a seaFromCoastline failure
                    // shouldn't discard the real East-River coastline and drop
                    // to the coarse 1:50m band (the coastline subtype already
                    // buffers the per-city lines directly). Only truly-empty
                    // per-city coast falls to the bundled band.
                    const coastLines =
                        cityCoastLines && cityCoastLines.length > 0
                            ? cityCoastLines
                            : clipLinesToBbox(await fetchCoastline(), bBox);
                    if (coastLines.length > 0)
                        out.push(highSpeedBase(coastLines));
                }
            } catch (e) {
                console.warn("body-of-water sea merge failed:", e);
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
    });

const bufferedDeterminer = memoize(
    async (question: MeasuringQuestion) => {
        const placeData = await determineMeasuringBoundary(question);

        if (placeData === false || placeData === undefined) return false;

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
