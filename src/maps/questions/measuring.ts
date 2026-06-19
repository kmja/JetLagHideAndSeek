import * as turf from "@turf/turf";
import type { Feature, MultiPolygon } from "geojson";
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
import {
    fetchBorders0Land,
    fetchBorders1States,
    fetchCoastline,
    fetchLakes,
    findPlacesInZone,
    findPlacesSpecificInZone,
    LOCATION_FIRST_TAG,
    nearestToQuestion,
    prettifyLocation,
    QuestionSpecificLocation,
} from "@/maps/api";
import { majorCityPoints } from "@/maps/data/majorCities";
import {
    arcBufferToPoint,
    connectToSeparateLines,
    groupObjects,
    holedMask,
    modifyMapData,
} from "@/maps/geo-utils";
import type {
    APILocations,
    HomeGameMeasuringQuestions,
    MeasuringQuestion,
} from "@/maps/schema";

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

function clipPolygonsToBbox(
    fc: GeoJSON.FeatureCollection,
    bbox: GeoJSON.BBox | number[],
    predicate?: (f: GeoJSON.Feature) => boolean,
): Feature[] {
    const widened = widenedBbox(bbox);
    const kept: Feature[] = [];
    for (const f of fc.features) {
        if (predicate && !predicate(f)) continue;
        const g = f.geometry as GeoJSON.Geometry | undefined;
        if (!g) continue;
        if (g.type !== "Polygon" && g.type !== "MultiPolygon") continue;
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
            const coastline = turf.lineToPolygon(
                await fetchCoastline(),
            ) as Feature<MultiPolygon>;

            const distanceToCoastline = turf.pointToPolygonDistance(
                turf.point([question.lng, question.lat]),
                coastline,
                {
                    units: "miles",
                    method: "geodesic",
                },
            );

            return [
                turf.difference(
                    turf.featureCollection([
                        turf.bboxPolygon(bBox),
                        turf.buffer(
                            turf.bboxClip(
                                coastline,
                                bBox
                                    ? bboxExtension(
                                          bBox as any,
                                          distanceToCoastline,
                                      )
                                    : [-180, -90, 180, 90],
                            ),
                            distanceToCoastline,
                            {
                                units: "miles",
                                steps: 64,
                            },
                        )!,
                    ]),
                )!,
            ];
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
                `[${LOCATION_FIRST_TAG[location]}=${location}]`,
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
                    ).toLowerCase()}. Please enable hiding zone mode and switch to the Large Game variation of this question.`,
                );
                return [turf.multiPolygon([])];
            }

            if (data.elements.length >= 1000) {
                toast.error(
                    `Too many ${prettifyLocation(
                        location,
                        true,
                    ).toLowerCase()} found (${data.elements.length}). Please enable hiding zone mode and switch to the Large Game variation of this question.`,
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
            // v341: bundled Natural Earth 1:50m lakes — 411 named lake
            // polygons globally, already shipped as `lakes50.geojson`.
            // Zero-external like the borders cases. Caveat documented
            // in fetchLakes: rivers / bays / channels aren't in this
            // dataset, so the seeker-side cut is conservatively narrow.
            // The hider answers from their own mapping app per the
            // rulebook, so a hider near a named bay still answers
            // correctly even though we didn't auto-cut for that body.
            const lakesFC = await fetchLakes();
            // Filter to NAMED bodies (rulebook excludes unnamed) and
            // to those touching the play-area bbox so we don't buffer
            // every lake on Earth.
            const polys = clipPolygonsToBbox(
                lakesFC,
                bBox,
                (f) => Boolean(f.properties?.name),
            );
            if (polys.length === 0) return [turf.multiPolygon([])];
            return [
                turf.combine(turf.featureCollection(polys as any))
                    .features[0],
            ];
        }
        case "sea-level": {
            // Rulebook p25: "A player's altitude. Use your phone's
            // compass." This is answered manually by the hider — no
            // automatic map elimination is possible without per-pixel
            // elevation data (which we don't bundle, and live-querying
            // an elevation API per cell would be prohibitive). Falls
            // through to the false branch below.
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

const bufferedDeterminer = memoize(
    async (question: MeasuringQuestion) => {
        const placeData = await determineMeasuringBoundary(question);

        if (placeData === false || placeData === undefined) return false;

        return arcBufferToPoint(
            turf.featureCollection(placeData as any),
            question.lat,
            question.lng,
        );
    },
    (question) =>
        JSON.stringify({
            type: question.type,
            lat: question.lat,
            lng: question.lng,
            entirety: polyGeoJSON.get()
                ? polyGeoJSON.get()
                : mapGeoLocation.get(),
            geo: (question as any).geo,
        }),
);

export const adjustPerMeasuring = async (
    question: MeasuringQuestion,
    mapData: any,
) => {
    if (mapData === null) return;

    const buffer = await bufferedDeterminer(question);

    if (buffer === false) return mapData;

    return modifyMapData(mapData, buffer, question.hiderCloser);
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
        const buffered = await bufferedDeterminer(question);

        if (buffered === false) return false;

        return turf.polygonToLine(buffered);
    } catch {
        return false;
    }
};
