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
import { fetchPrewarmedAreaAdmin } from "@/maps/api/adminBoundary";
import { fetchAreaCoastlineLines } from "@/maps/api/coast";
import { seaLevelRegion } from "@/maps/api/elevation";
import {
    fetchPrewarmedAreaWater,
    requestWaterWarmAll,
} from "@/maps/api/water";
import { fetchPrewarmedRailStationElements } from "@/lib/journey/stations";
import {
    bufferAndUnion,
    bufferPointsUnion,
    bufferWaterGrid,
} from "@/lib/geometry/client";
import { filterCoastlineByStraitRule } from "@/maps/questions/coastlineStrait";
import {
    basemapWaterVersion,
    getDissolvedBasemapSea,
    getDissolvedBasemapWater,
    hasBasemapWater,
} from "@/maps/api/basemapWater";
import { lastBodyOfWaterDiag } from "@/lib/debugState";
import { majorCityPoints } from "@/maps/data/majorCities";
import {
    arcBufferToPoint,
    connectToSeparateLines,
    groupObjects,
    holedMask,
    modifyMapData,
} from "@/maps/geo-utils";
import {
    playAreaSignature,
    pointInPlayArea,
} from "@/maps/geo-utils/playAreaIndex";
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

/**
 * v1141: how finely to GEOGRAPHICALLY CHUNK the body-of-water buffer, by
 * play-area bbox AREA (deg²). A single city fits `bufferAndUnion` fine (grid 1
 * = no chunking); NYC + several adjacents (~0.3–0.6 deg²) needs the field split
 * into cells so no single turf call sees the whole dense water field and times
 * out on a weak mobile CPU. Device-independent (the actual "works on PC, not
 * Android" lever) — the split is driven by geography, not `hardwareConcurrency`
 * (modern Android reports 8 throttled cores and never flags as low-end).
 */
function waterGridSize(b: Bbox4): number {
    const areaDeg2 = Math.max(0, (b[2] - b[0]) * (b[3] - b[1]));
    if (areaDeg2 < 0.05) return 1; // single city — no chunking
    if (areaDeg2 < 0.15) return 2;
    if (areaDeg2 < 0.3) return 3;
    if (areaDeg2 < 0.5) return 4;
    if (areaDeg2 < 0.8) return 5;
    return 6;
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
            // v1011: prefer the basemap SEA polygons (Protomaps `kind` =
            // ocean/sea/bay) — the SAME source body-of-water uses — buffered via
            // the union-first `bufferAndUnion` path. "Closer to the coast" =
            // closer to the sea, so buffering the sea AREA by the seeker's
            // distance to it gives the coast band. This REPLACES the per-city
            // OSM coastline + `seaFromCoastline` strait-rule path, which FROZE
            // the app for a second or two and often produced no overlay (the
            // reported bug). Protomaps already tags the open sea as
            // ocean/sea/bay and narrow tidal channels separately, so the
            // sea-kind filter IS the 2 km strait rule by construction. Routed
            // through `bufferAndUnion` in `bufferedDeterminer` like
            // body-of-water. Cold fallback (no basemap sea captured): the OSM
            // coastline lines + strait rule below.
            const sea = await getDissolvedBasemapSea(bbox4(bBox));
            if (sea && sea.length > 0) {
                // eslint-disable-next-line no-console
                console.log(`[coast] using dissolved basemap sea: ${sea.length}`);
                return sea;
            }
            // eslint-disable-next-line no-console
            console.log("[coast] no basemap sea → OSM coastline fallback");
            const perCity = await fetchAreaCoastlineLines();
            let coastLines: Feature[];
            if (perCity && perCity.length > 0) {
                // Flatten any MultiLineString into LineStrings so the
                // highSpeedBase line combiner (which only groups LineStrings)
                // keeps every segment.
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

            // v1131: restrict the elimination reference set to features
            // INSIDE the play-area polygon (rulebook p17 — only in-area
            // locations are in play). The reference cache / findPlacesInZone
            // fast path is keyed on a 50 km-PADDED bbox, so `data.elements`
            // includes out-of-area POIs (a NJ golf course NW of an NYC play
            // area). The configure PREVIEW already filters candidates to the
            // play area (`inAreaCandidates`, questionImpact), so the
            // elimination MUST match it or the drawn overlay disagrees with
            // the answer — the reported "the math takes into account a
            // location outside the play area". Falls through to the
            // unfiltered set while the polygon is still loading.
            const golfPoly = polyGeoJSON.get();
            const golfPts = data.elements
                // v970 (rulebook audit B): re-check tags client-side so the
                // cached paths' exclusions (golf driving ranges / mini golf)
                // apply to this LIVE query too — label and cut agree.
                .filter(
                    (x: any) =>
                        !x.tags || apiLocationMatches(location, x.tags),
                )
                .map((x: any) => ({
                    lng: x.center ? x.center.lon : x.lon,
                    lat: x.center ? x.center.lat : x.lat,
                }))
                .filter(
                    (c: { lng: number; lat: number }) =>
                        !golfPoly ||
                        pointInPlayArea(golfPoly as any, c.lng, c.lat),
                );
            if (golfPts.length === 0) return [turf.multiPolygon([])];
            return [
                turf.combine(
                    turf.featureCollection(
                        golfPts.map((c: { lng: number; lat: number }) =>
                            turf.point([c.lng, c.lat]),
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
            //
            // v1131: read the PREWARMED admin geometry first (the SAME
            // relation-id-keyed `/api/admin/<id>/6` data the matching county
            // question uses), so a warm city is Overpass-free — the live
            // `findPlacesInZone` poly query got rate-limited in a dense
            // metro WITH added adjacents (NYC), so the measuring county
            // border drew nothing while matching county — which reads the
            // prewarmed data — showed a clean overlay (the reported bug).
            // Falls back to the live relation query on a cold area.
            const prewarmedAdmin = await fetchPrewarmedAreaAdmin(6);
            const relFeatures = osmtogeojson(
                prewarmedAdmin ??
                    (await findPlacesInZone(
                        '["admin_level"="6"]["boundary"="administrative"]',
                        undefined,
                        "relation",
                        "geom",
                    )),
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
            // v1012: return the DISSOLVED basemap water — the captured
            // tile-pieces unioned into their real bodies ONCE per water-version
            // (cached, off-thread), so the downstream buffer works on ONE small
            // shape instead of re-unioning 100+ pieces on every call (which
            // piled up in the worker and intermittently timed out — the "ok →
            // threw → arcgis" trail). Falls back to the RAW pieces if the
            // dissolve failed, then to the cold OSM path if nothing was captured.
            // eslint-disable-next-line no-console
            console.log("[bow] determineMeasuringBoundary body-of-water ENTER");
            const dissolvedWater = await getDissolvedBasemapWater(bbox4(bBox));
            // eslint-disable-next-line no-console
            console.log(
                `[bow] dissolvedWater=${dissolvedWater ? dissolvedWater.length : "null"}`,
            );
            if (dissolvedWater && dissolvedWater.length > 0) {
                return dissolvedWater;
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

// v1009/v1011: on-device diagnostics for the basemap-water measuring questions
// (body-of-water + coastline). When an overlay is empty / slow we need to know
// WHICH stage produced nothing — the basemap-water capture, the cold OSM
// fallback, or the buffer. Summarise the geometry going into the buffer + the
// outcome into `lastBodyOfWaterDiag` (shown in the debug panel) and
// `console.log`/`warn` with a per-type tag (`[bow]` / `[coast]`), so the PC
// console shows the full trail. Cheap — runs once per configure.
function countVertices(g: GeoJSON.Geometry | undefined): number {
    if (!g) return 0;
    let n = 0;
    const walk = (c: unknown): void => {
        if (!Array.isArray(c)) return;
        if (typeof c[0] === "number") {
            n++;
            return;
        }
        for (const x of c) walk(x);
    };
    if ("coordinates" in g) walk((g as { coordinates: unknown }).coordinates);
    return n;
}
let waterDiagPrefix = "";
let waterDiagTag = "bow";
function reportWaterQuestionDiag(
    kind: "body-of-water" | "coastline",
    feats: Feature[],
    source: string,
): void {
    let polys = 0;
    let lines = 0;
    let verts = 0;
    for (const f of feats) {
        const t = f.geometry?.type;
        if (t === "Polygon" || t === "MultiPolygon") polys++;
        else if (t === "LineString" || t === "MultiLineString") lines++;
        verts += countVertices(f.geometry);
    }
    waterDiagTag = kind === "coastline" ? "coast" : "bow";
    waterDiagPrefix = `${waterDiagTag}: src=${source} feats=${feats.length} (poly=${polys} line=${lines}) verts=${verts}`;
    // eslint-disable-next-line no-console
    console.log(`[${waterDiagTag}] input ${waterDiagPrefix}`);
}
function reportWaterQuestionResult(outcome: string): void {
    const msg = `${waterDiagPrefix} → ${outcome}`;
    lastBodyOfWaterDiag.set(msg);
    // eslint-disable-next-line no-console
    console.warn(`[${waterDiagTag}] ${msg}`);
}

const bufferedDeterminer = memoize(
    async (question: MeasuringQuestion) => {
        const placeData = await determineMeasuringBoundary(question);
        const isWaterQ =
            question.type === "body-of-water" ||
            question.type === "coastline";
        if (
            isWaterQ &&
            (placeData === false ||
                placeData === undefined ||
                (Array.isArray(placeData) && placeData.length === 0))
        ) {
            reportWaterQuestionDiag(
                question.type as "body-of-water" | "coastline",
                [],
                "cold-osm",
            );
            reportWaterQuestionResult("determineMeasuringBoundary EMPTY");
        }

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
        // v1132: extend this OFF-THREAD path to EVERY non-point measuring-geom
        // (the coastline/border/HSR LINE families too, not just water). arcgis's
        // geodesic buffer on a dense metro's boundary LINES (NYC's county /
        // coastline outlines, tens of thousands of vertices) was the shared
        // "effect runs but the overlay never resolves" hang — county / coastline
        // buffer never returned. `bufferAndUnion` runs turf off-thread + self-
        // heals a wedged worker, so the overlay actually lands; arcgis stays the
        // fallback below.
        const nonPointGeom = (placeData as Feature[]).some(
            (f) =>
                f?.geometry?.type === "LineString" ||
                f?.geometry?.type === "MultiLineString" ||
                f?.geometry?.type === "Polygon" ||
                f?.geometry?.type === "MultiPolygon",
        );
        if (isWaterQ || nonPointGeom) {
            const feats = placeData as Feature[];
            // v1009/v1011: body-of-water AND coastline both buffer basemap water
            // (whole water vs sea-only) through the union-first worker path.
            // Diagnose which stage fails when the overlay is empty. (Water-only:
            // the border/HSR line families share this path since v1132 but keep
            // their own diagnostics out of the body-of-water panel line.)
            if (isWaterQ && feats.length > 0) {
                reportWaterQuestionDiag(
                    question.type as "body-of-water" | "coastline",
                    feats,
                    hasBasemapWater() ? "basemap-water" : "cold-osm",
                );
            }
            // v1141: for a WATER question over a LARGE play area (NYC + adjacents),
            // buffering the whole dense water field at once times out even
            // off-thread. GEOGRAPHIC CHUNKING splits the bbox into a grid and
            // buffers each cell's local water independently, at full detail, then
            // unions the cells — the user prefers a slow detailed overlay to a
            // fast coarse one. The grid size scales with the bbox area; a small
            // single-city area gets grid 1 (≈ the plain `bufferAndUnion` path, no
            // wasted chunking overhead), so this only kicks in when needed. Falls
            // through to `bufferAndUnion` if the grid path returns null / throws.
            if (isWaterQ && feats.length > 0) {
                const $map = mapGeoJSON.get();
                const grid = $map ? waterGridSize(bbox4(turf.bbox($map))) : 1;
                if (grid >= 2) {
                    try {
                        const gridded = await bufferWaterGrid(
                            feats,
                            bbox4(turf.bbox($map!)),
                            question.lat,
                            question.lng,
                            grid,
                        );
                        if (gridded) {
                            reportWaterQuestionResult(
                                `bufferWaterGrid ok (${grid}x${grid})`,
                            );
                            return gridded;
                        }
                        reportWaterQuestionResult("bufferWaterGrid → null");
                    } catch {
                        reportWaterQuestionResult("bufferWaterGrid threw");
                        /* fall through to bufferAndUnion below */
                    }
                }
            }
            try {
                const merged = await bufferAndUnion(
                    feats,
                    question.lat,
                    question.lng,
                );
                if (merged) {
                    if (isWaterQ) reportWaterQuestionResult("bufferAndUnion ok");
                    return merged;
                }
                if (isWaterQ) reportWaterQuestionResult("bufferAndUnion → null");
            } catch {
                if (isWaterQ) reportWaterQuestionResult("bufferAndUnion threw");
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
        if (isWaterQ) {
            reportWaterQuestionResult(
                buffered ? "arcgis ok" : "arcgis → null (NO OVERLAY)",
            );
        }
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
