import * as turf from "@turf/turf";
import type {
    Feature,
    FeatureCollection,
    MultiPolygon,
    Point,
    Polygon,
} from "geojson";
import memoize from "lodash/memoize";
import uniqBy from "lodash/uniqBy";
import osmtogeojson from "osmtogeojson";
import { toast } from "react-toastify";

import {
    hiderMode,
    mapGeoJSON,
    mapGeoLocation,
    polyGeoJSON,
} from "@/lib/context";
import {
    fetchCoastline,
    findAdminBoundary,
    findPlacesInZone,
    LOCATION_FIRST_TAG,
    nearestToQuestion,
    prettifyLocation,
    trainLineNodeFinder,
} from "@/maps/api";
import { majorCityPoints } from "@/maps/data/majorCities";
import { holedMask, modifyMapData, safeUnion } from "@/maps/geo-utils";
import { geoSpatialVoronoi } from "@/maps/geo-utils";
import type {
    APILocations,
    HomeGameMatchingQuestions,
    MatchingQuestion,
} from "@/maps/schema";

/**
 * v373: how many K-nearest candidates to keep when computing the
 * matching Voronoi cell. The seeker's cell only depends on its Voronoi
 * neighbors (~6-8 on average for random-ish point distributions, more
 * for very dense regions). 30 is a safe upper bound that virtually
 * guarantees correctness while keeping the Voronoi computation
 * microseconds even in cities with 1000+ candidates. Truncating is
 * mathematically conservative: missing far-away candidates can only let
 * the cell extend further, never cut it shorter — over-inclusive
 * elimination, never a false positive.
 */
const MATCHING_KNN = 30;

export const findMatchingPlaces = async (question: MatchingQuestion) => {
    switch (question.type) {
        case "airport": {
            return uniqBy(
                (
                    await findPlacesInZone(
                        '["aeroway"="aerodrome"]["iata"]', // Only commercial airports have IATA codes,
                    )
                ).elements,
                (feature: any) => feature.tags.iata,
            ).map((x) =>
                turf.point([
                    x.center ? x.center.lon : x.lon,
                    x.center ? x.center.lat : x.lat,
                ]),
            );
        }
        case "major-city": {
            // Bundled worldwide 1M+ city list — no Overpass. Covers
            // cities outside the play area too, which the old
            // play-area-only query missed (and which are usually the
            // nearest major city anyway).
            return majorCityPoints();
        }
        case "custom-points": {
            return question.geo!;
        }
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
                    ).toLowerCase()} — Overpass returned a runtime error. Try again, or use a "Same admin division" matching question instead.`,
                );
                return [];
            }

            // v373: K-nearest clip to the seeker. Matching elimination
            // is the Voronoi cell containing the seeker — its boundary
            // is made of perpendicular bisectors with the seeker's
            // Voronoi neighbors (~6-8 in practice). The K-nearest subset
            // produces the same cell shape near the seeker, with the
            // far edges possibly EXTENDED (never cut shorter) when
            // distant candidates are dropped — so elimination is safely
            // over-inclusive. Replaces the old >=1000 toast that
            // abandoned elimination entirely on dense areas like Ottawa
            // (1103 parks).
            const seeker = turf.point([question.lng, question.lat]);
            const allPoints: Feature<Point>[] = data.elements.map((x: any) =>
                turf.point([
                    x.center ? x.center.lon : x.lon,
                    x.center ? x.center.lat : x.lat,
                ]),
            );
            if (allPoints.length <= MATCHING_KNN) return allPoints;
            return allPoints
                .map((p: Feature<Point>) => ({
                    p,
                    d: turf.distance(seeker, p, { units: "kilometers" }),
                }))
                .sort(
                    (a: { d: number }, b: { d: number }) => a.d - b.d,
                )
                .slice(0, MATCHING_KNN)
                .map(({ p }: { p: Feature<Point> }) => p);
        }
    }
    // v339: rulebook-completion matching types (same-street-or-path,
    // same-landmass, …) reach this point. They're sent to the hider and
    // answered manually; the seeker just doesn't get automatic map
    // elimination for them yet. Empty feature list = no elimination,
    // not a crash. Implementing them in turn is a follow-up.
    return [];
};

export const determineMatchingBoundary = memoize(
    async (question: MatchingQuestion) => {
        let boundary;

        switch (question.type) {
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
            case "same-first-letter-station":
            case "same-length-station":
            case "same-train-line": {
                return false;
            }
            case "custom-zone": {
                boundary = question.geo;
                break;
            }
            case "zone": {
                boundary = await findAdminBoundary(
                    question.lat,
                    question.lng,
                    question.cat.adminLevel,
                );

                if (!boundary) {
                    toast.error("No boundary found for this zone");
                    throw new Error("No boundary found");
                }
                break;
            }
            case "letter-zone": {
                const zone = await findAdminBoundary(
                    question.lat,
                    question.lng,
                    question.cat.adminLevel,
                );

                if (!zone) {
                    toast.error("No boundary found for this zone");
                    throw new Error("No boundary found");
                }

                let englishName = zone.properties?.["name:en"];

                if (!englishName) {
                    const name = zone.properties?.name;

                    if (/^[a-zA-Z]$/.test(name[0])) {
                        englishName = name;
                    } else {
                        toast.error("No English name found for this zone");
                        throw new Error("No English name");
                    }
                }

                const letter = englishName[0].toUpperCase();

                boundary = turf.featureCollection(
                    osmtogeojson(
                        await findPlacesInZone(
                            `[admin_level=${question.cat.adminLevel}]["name:en"~"^${letter}.+"]`, // Regex is faster than filtering afterward
                            `Finding zones that start with the same letter (${letter})...`,
                            "relation",
                            "geom",
                            [
                                `[admin_level=${question.cat.adminLevel}]["name"~"^${letter}.+"]`,
                            ], // Regex is faster than filtering afterward
                        ),
                    ).features.filter(
                        (x): x is Feature<Polygon | MultiPolygon> =>
                            x.geometry &&
                            (x.geometry.type === "Polygon" ||
                                x.geometry.type === "MultiPolygon"),
                    ),
                );

                // It's either simplify or crash. Technically this could be bad if someone's hiding zone was inside multiple zones, but that's unlikely.
                boundary = safeUnion(
                    turf.simplify(boundary, {
                        tolerance: 0.001,
                        highQuality: true,
                        mutate: true,
                    }),
                );

                break;
            }
            case "same-landmass": {
                // v340: rulebook p18 — "An area of land that is in one
                // piece, not broken up by a waterway." We use the
                // bundled Natural Earth 1:50m coastline (already
                // imported for the coastline measuring question) which
                // gives a global FeatureCollection of LineStrings;
                // turf.lineToPolygon closes each loop into a polygon,
                // and the polygon CONTAINING the seeker IS their
                // landmass. Same coastline-as-truth contract the
                // measuring side uses, so answers agree across both
                // question categories.
                const coastFC = await fetchCoastline();
                const polys = turf.lineToPolygon(
                    coastFC as any,
                );
                const seekerPt = turf.point([question.lng, question.lat]);
                // lineToPolygon can return either a single Polygon /
                // MultiPolygon Feature, or a FeatureCollection of
                // Polygons — both shapes need to be walked. Coerce to
                // a per-Polygon iterable.
                const collected: Feature<Polygon>[] = [];
                if ((polys as any).type === "FeatureCollection") {
                    for (const f of (polys as any).features) {
                        if (f.geometry?.type === "Polygon") collected.push(f);
                        if (f.geometry?.type === "MultiPolygon") {
                            for (const ring of f.geometry.coordinates) {
                                collected.push(turf.polygon(ring));
                            }
                        }
                    }
                } else if ((polys as any).geometry?.type === "Polygon") {
                    collected.push(polys as Feature<Polygon>);
                } else if ((polys as any).geometry?.type === "MultiPolygon") {
                    for (const ring of (
                        polys as Feature<MultiPolygon>
                    ).geometry.coordinates) {
                        collected.push(turf.polygon(ring));
                    }
                }
                for (const f of collected) {
                    if (turf.booleanPointInPolygon(seekerPt, f)) {
                        boundary = f;
                        break;
                    }
                }
                if (!boundary) {
                    toast.error(
                        "Couldn't determine your landmass — are you in a body of water?",
                    );
                    throw new Error("No landmass found");
                }
                break;
            }
            case "same-street-or-path": {
                // v340: rulebook p18 — "A street or path is considered
                // to have ended when it acquires a different name."
                // The matching boundary is the geometry of every OSM
                // way sharing the seeker's nearest-street name.
                //
                // Two-step Overpass: (1) find the nearest named highway
                // way to the seeker via a small around: query, read
                // its name; (2) fetch every way with that exact name
                // inside the play area + 50 km pad, union, return as
                // the matching polygon. Unnamed streets fall back to
                // intersection-bounded segments per rulebook, which is
                // hard to compute automatically — those return a
                // "couldn't determine" error so the seeker falls back
                // to manual map work.
                const seekerLat = question.lat;
                const seekerLng = question.lng;
                // Step 1: nearest named highway. v342: fetch GEOMETRY
                // (out geom, not out tags) so we can compute the TRUE
                // nearest by point-to-line distance rather than trusting
                // Overpass's element order — which isn't distance-sorted
                // and was the fragile bit flagged in v340.
                const nearbyQuery = `
[out:json][timeout:30];
way["highway"]["name"](around:500,${seekerLat},${seekerLng});
out geom;
`;
                const nearbyData = await (
                    await import("@/maps/api/overpass")
                ).getOverpassData(nearbyQuery);
                const seekerPt = turf.point([seekerLng, seekerLat]);
                let streetName: string | null = null;
                let bestDist = Infinity;
                for (const el of (nearbyData as { elements?: any[] })
                    .elements ?? []) {
                    const name = el?.tags?.name;
                    const geom = el?.geometry as
                        | Array<{ lat: number; lon: number }>
                        | undefined;
                    if (!name || !geom || geom.length < 2) continue;
                    try {
                        const line = turf.lineString(
                            geom.map((p) => [p.lon, p.lat]),
                        );
                        const d = turf.pointToLineDistance(seekerPt, line, {
                            units: "meters",
                        });
                        if (d < bestDist) {
                            bestDist = d;
                            streetName = name;
                        }
                    } catch {
                        /* skip malformed way */
                    }
                }
                if (!streetName) {
                    toast.error(
                        "No named street within 500 m of your location.",
                    );
                    throw new Error("No nearby street name");
                }
                // Step 2: all matching ways inside the play area.
                const wayFeatures = osmtogeojson(
                    await findPlacesInZone(
                        `["highway"]["name"="${streetName.replace(/"/g, '\\"')}"]`,
                        undefined,
                        "way",
                        "geom",
                    ),
                ).features.filter(
                    (f): f is Feature<any> =>
                        f.geometry?.type === "LineString" ||
                        f.geometry?.type === "MultiLineString",
                );
                if (wayFeatures.length === 0) {
                    toast.error(
                        `No "${streetName}" segments found in the play area.`,
                    );
                    throw new Error("No matching streets");
                }
                // Buffer the line union by a small amount so it has
                // area (matching needs a polygon boundary, not a
                // line). 25 m is wide enough to enclose typical
                // streets without overflowing into neighbours.
                const buffered = turf.buffer(
                    turf.featureCollection(wayFeatures),
                    25,
                    { units: "meters" },
                );
                if (!buffered) {
                    throw new Error("Buffer failed for street segments");
                }
                boundary = turf.combine(buffered as any).features[0];
                break;
            }
            case "airport":
            case "major-city":
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
            case "park-full":
            case "custom-points": {
                const data = await findMatchingPlaces(question);

                const voronoi = geoSpatialVoronoi(data);
                const point = turf.point([question.lng, question.lat]);

                for (const feature of voronoi.features) {
                    if (turf.booleanPointInPolygon(point, feature)) {
                        boundary = feature;
                        break;
                    }
                }
                break;
            }
        }

        return boundary;
    },
    (question: MatchingQuestion & { geo?: unknown; cat?: unknown }) =>
        JSON.stringify({
            type: question.type,
            lat: question.lat,
            lng: question.lng,
            cat: question.cat,
            geo: question.geo,
            entirety: polyGeoJSON.get()
                ? polyGeoJSON.get()
                : mapGeoLocation.get(),
        }),
);

export const adjustPerMatching = async (
    question: MatchingQuestion,
    mapData: any,
) => {
    if (mapData === null) return;

    const boundary = await determineMatchingBoundary(question);

    if (boundary === false) {
        return mapData;
    }

    return modifyMapData(mapData, boundary, question.same);
};

export const hiderifyMatching = async (question: MatchingQuestion) => {
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
            question as HomeGameMatchingQuestions,
        );
        const hiderNearest = await nearestToQuestion({
            lat: $hiderMode.latitude,
            lng: $hiderMode.longitude,
            same: true,
            type: (question as HomeGameMatchingQuestions).type,
            drag: false,
            color: "black",
            collapsed: false,
        });

        question.same =
            questionNearest.properties.name === hiderNearest.properties.name;

        return question;
    }

    if (
        question.type === "same-first-letter-station" ||
        question.type === "same-length-station" ||
        question.type === "same-train-line"
    ) {
        const hiderPoint = turf.point([
            $hiderMode.longitude,
            $hiderMode.latitude,
        ]);
        const seekerPoint = turf.point([question.lng, question.lat]);

        const places = osmtogeojson(
            await findPlacesInZone(
                "[railway=station]",
                // No loadingText — picker has its own progress UI.
                undefined,
                "node",
            ),
        ) as FeatureCollection<Point>;

        const nearestHiderTrainStation = turf.nearestPoint(hiderPoint, places);
        const nearestSeekerTrainStation = turf.nearestPoint(
            seekerPoint,
            places,
        );

        if (question.type === "same-train-line") {
            const nodes = await trainLineNodeFinder(
                nearestSeekerTrainStation.properties.id,
            );

            const hiderId = parseInt(
                nearestHiderTrainStation.properties.id.split("/")[1],
            );

            if (nodes.includes(hiderId)) {
                question.same = true;
            } else {
                question.same = false;
            }
        }

        const hiderEnglishName =
            nearestHiderTrainStation.properties["name:en"] ||
            nearestHiderTrainStation.properties.name;
        const seekerEnglishName =
            nearestSeekerTrainStation.properties["name:en"] ||
            nearestSeekerTrainStation.properties.name;

        if (!hiderEnglishName || !seekerEnglishName) {
            return question;
        }

        if (question.type === "same-first-letter-station") {
            if (
                hiderEnglishName[0].toUpperCase() ===
                seekerEnglishName[0].toUpperCase()
            ) {
                question.same = true;
            } else {
                question.same = false;
            }
        } else if (question.type === "same-length-station") {
            if (hiderEnglishName.length === seekerEnglishName.length) {
                question.lengthComparison = "same";
            } else if (hiderEnglishName.length < seekerEnglishName.length) {
                question.lengthComparison = "shorter";
            } else {
                question.lengthComparison = "longer";
            }
        }

        return question;
    }

    const $mapGeoJSON = mapGeoJSON.get();
    if ($mapGeoJSON === null) return question;

    let feature = null;

    try {
        feature = holedMask((await adjustPerMatching(question, $mapGeoJSON))!);
    } catch {
        try {
            feature = await adjustPerMatching(question, {
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
        question.same = !question.same;
    }

    return question;
};

export const matchingPlanningPolygon = async (question: MatchingQuestion) => {
    try {
        const boundary = await determineMatchingBoundary(question);

        if (boundary === false) {
            return false;
        }

        return turf.polygonToLine(boundary);
    } catch {
        return false;
    }
};
