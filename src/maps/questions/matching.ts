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
    apiLocationFilter,
    nearestToQuestion,
    prettifyLocation,
    trainLineNodeFinder,
} from "@/maps/api";
import { fetchAreaLandPolygons } from "@/maps/api/coast";
import { majorCityPoints } from "@/maps/data/majorCities";
import { holedMask, modifyMapData, safeUnion } from "@/maps/geo-utils";
import { geoSpatialVoronoi } from "@/maps/geo-utils";
import { playAreaSignature } from "@/maps/geo-utils/playAreaIndex";
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

/** English-preferred station name (matches the hider-grading logic). */
function stationName(f: Feature<Point>): string | null {
    const p = f.properties as Record<string, unknown> | undefined;
    return ((p?.["name:en"] as string) || (p?.name as string) || null) ?? null;
}

/**
 * Seeker-side elimination for the three station-property matching types
 * (v625): "same train line", "same first letter", "same station-name
 * length". The region is the union of the Voronoi cells of every station
 * that shares the relevant property with the seeker's nearest station —
 * i.e. everywhere whose nearest station matches. Uses the same station
 * set + line lookup the HIDER grades with, so the map cut agrees with the
 * yes/no answer. Returns `false` (no cut) when the data is missing.
 *
 * For "length", the answer is 3-way (`lengthComparison`): the matching
 * set is stations with an equal / shorter / longer name than the
 * seeker's, per the hider's answer (defaults to "same" for the pre-answer
 * planning preview).
 */
async function matchingStationBoundary(
    question: MatchingQuestion,
    mode: "line" | "first-letter" | "length",
): Promise<Feature<Polygon | MultiPolygon> | false> {
    const stations = osmtogeojson(
        await findPlacesInZone("[railway=station]", undefined, "node"),
    ) as FeatureCollection<Point>;
    if (stations.features.length === 0) return false;

    const seekerPoint = turf.point([question.lng, question.lat]);
    const nearest = turf.nearestPoint(seekerPoint, stations);

    let matching: Feature<Point>[];
    if (mode === "line") {
        const ids = new Set<number>(
            await trainLineNodeFinder(nearest.properties.id as string),
        );
        const nearestNum = parseInt(
            String(nearest.properties.id).split("/")[1],
        );
        if (Number.isFinite(nearestNum)) ids.add(nearestNum);
        matching = stations.features.filter((s) => {
            const num = parseInt(String(s.properties?.id ?? "").split("/")[1]);
            return Number.isFinite(num) && ids.has(num);
        });
    } else {
        const name = stationName(nearest);
        if (!name) return false;
        if (mode === "first-letter") {
            const letter = name[0].toUpperCase();
            matching = stations.features.filter((s) => {
                const n = stationName(s);
                return n ? n[0].toUpperCase() === letter : false;
            });
        } else {
            const len = name.length;
            const cmp = question.lengthComparison ?? "same";
            matching = stations.features.filter((s) => {
                const n = stationName(s);
                if (!n) return false;
                if (cmp === "same") return n.length === len;
                if (cmp === "shorter") return n.length < len;
                return n.length > len;
            });
        }
    }
    if (matching.length === 0) return false;

    // Voronoi over ALL stations so the cell boundaries are correct; keep
    // only the cells belonging to the matching stations, then union.
    //
    // A Voronoi cell always contains its OWN site and no other site (cells
    // partition space), so "some matching station lies inside this cell" is
    // exactly "this cell's site is a matching station". That lets us keep
    // cells by a Set lookup on the site's stable key instead of the old
    // O(cells x matching) `booleanPointInPolygon` per pair — O(n) instead of
    // O(n^2), and more robust at cell boundaries. `properties.site` is the
    // original input feature (the same field ZoneSidebar reads).
    const siteKey = (f: {
        properties?: { id?: unknown };
        geometry?: { coordinates?: number[] };
    }): string => {
        const id = f?.properties?.id;
        if (id != null) return `id:${String(id)}`;
        const c = f?.geometry?.coordinates;
        return c ? `c:${c[0]},${c[1]}` : "";
    };
    const matchingKeys = new Set(
        matching.map((s) => siteKey(s as unknown as { properties?: { id?: unknown } })),
    );
    const cells = geoSpatialVoronoi(stations);
    const sameCells = cells.features.filter((cell) => {
        const site = (cell as unknown as { properties?: { site?: unknown } })
            .properties?.site as
            | { properties?: { id?: unknown }; geometry?: { coordinates?: number[] } }
            | undefined;
        return site ? matchingKeys.has(siteKey(site)) : false;
    });
    if (sameCells.length === 0) return false;
    return safeUnion(
        turf.featureCollection(sameCells as any),
    ) as Feature<Polygon | MultiPolygon>;
}

export const determineMatchingBoundary = memoize(
    async (question: MatchingQuestion) => {
        let boundary;
        // v840: when called for the CONFIGURE-dialog draft preview
        // (`matchingDraftRegion`), suppress the user-facing error toasts +
        // throws and return `undefined` instead, so a cold/failed lookup
        // silently draws no overlay rather than spamming toasts while the
        // seeker is still positioning the pin. The real elimination call
        // (silent unset) keeps its error feedback. `silent` is in the memo
        // key below, so the two are separate cache entries.
        const silent = (question as { silent?: boolean }).silent === true;

        switch (question.type) {
            // Legacy home-game POI matching types (not in the subtype
            // picker — Small/Medium use the `-full` Voronoi variants,
            // which ARE eliminated). Kept hider-graded for save-game
            // compat; no seeker cut.
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
            case "park": {
                return false;
            }
            case "same-train-line": {
                const b = await matchingStationBoundary(question, "line");
                if (b === false) return false;
                boundary = b;
                break;
            }
            case "same-first-letter-station": {
                const b = await matchingStationBoundary(
                    question,
                    "first-letter",
                );
                if (b === false) return false;
                boundary = b;
                break;
            }
            case "same-length-station": {
                const b = await matchingStationBoundary(question, "length");
                if (b === false) return false;
                boundary = b;
                break;
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
                    if (silent) return undefined;
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
                    if (silent) return undefined;
                    toast.error("No boundary found for this zone");
                    throw new Error("No boundary found");
                }

                let englishName = zone.properties?.["name:en"];

                if (!englishName) {
                    const name = zone.properties?.name;

                    if (/^[a-zA-Z]$/.test(name[0])) {
                        englishName = name;
                    } else {
                        if (silent) return undefined;
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
                // piece, not broken up by a waterway." The polygon
                // CONTAINING the seeker IS their landmass; whether the
                // hider falls in the same polygon is the answer. Same
                // coastline-as-truth contract the `coastline` measuring
                // side uses, so answers agree across both categories.
                //
                // v778: prefer PER-CITY OSM land — the play-area frame
                // MINUS the sea built from detailed OSM coastline
                // (`fetchAreaLandPolygons`), which resolves NYC's East
                // River / harbour that the coarse 1:50m coastline smears
                // over. Falls back to closing the bundled 1:50m coastline
                // into global land polygons where per-city coast is
                // unavailable or degenerate, so nothing breaks.
                const seekerPt = turf.point([question.lng, question.lat]);
                const collected: Feature<Polygon>[] = [];

                const pushParts = (
                    poly: Feature<Polygon | MultiPolygon>,
                ) => {
                    if (poly.geometry.type === "Polygon") {
                        collected.push(poly as Feature<Polygon>);
                    } else {
                        for (const ring of (poly as Feature<MultiPolygon>)
                            .geometry.coordinates) {
                            collected.push(turf.polygon(ring));
                        }
                    }
                };

                const areaLand = await fetchAreaLandPolygons({
                    lat: question.lat,
                    lng: question.lng,
                });
                if (areaLand) {
                    pushParts(areaLand);
                } else {
                    // Fallback: bundled 1:50m coastline closed into land.
                    const coastFC = await fetchCoastline();
                    const polys = turf.lineToPolygon(coastFC as any);
                    if ((polys as any).type === "FeatureCollection") {
                        for (const f of (polys as any).features) {
                            if (f.geometry?.type === "Polygon")
                                collected.push(f);
                            if (f.geometry?.type === "MultiPolygon") {
                                for (const ring of f.geometry.coordinates) {
                                    collected.push(turf.polygon(ring));
                                }
                            }
                        }
                    } else if ((polys as any).geometry?.type === "Polygon") {
                        collected.push(polys as Feature<Polygon>);
                    } else if (
                        (polys as any).geometry?.type === "MultiPolygon"
                    ) {
                        for (const ring of (polys as Feature<MultiPolygon>)
                            .geometry.coordinates) {
                            collected.push(turf.polygon(ring));
                        }
                    }
                }
                for (const f of collected) {
                    if (turf.booleanPointInPolygon(seekerPt, f)) {
                        boundary = f;
                        break;
                    }
                }
                if (!boundary) {
                    if (silent) return undefined;
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
                    if (silent) return undefined;
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
                    if (silent) return undefined;
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
    matchingBoundaryMemoKey,
);

/**
 * Memo key for `determineMatchingBoundary`. Extracted (v868) so
 * `matchingDraftRegion` can EVICT a failed silent-draft entry — see the note
 * there. v376: was serialising the whole polyGeoJSON FeatureCollection
 * (hundreds of KB) into the key on every lookup; `playAreaSignature` is a
 * stable few-byte string per FeatureCollection identity (WeakMap-cached).
 */
function matchingBoundaryMemoKey(
    question: MatchingQuestion & { geo?: unknown; cat?: unknown },
): string {
    return JSON.stringify({
        type: question.type,
        lat: question.lat,
        lng: question.lng,
        cat: question.cat,
        geo: question.geo,
        // same-length-station's boundary depends on the hider's 3-way answer
        // (equal / shorter / longer), so it must invalidate the memo when the
        // answer lands.
        lengthComparison: question.lengthComparison,
        // v840: the silent draft-preview call is a SEPARATE memo entry from
        // the real elimination call (which must keep its toast/throw on
        // failure), so they can't share a cached undefined.
        silent: (question as { silent?: boolean }).silent === true,
        entirety: polyGeoJSON.get()
            ? playAreaSignature(polyGeoJSON.get())
            : ((mapGeoLocation.get()?.properties?.osm_id ?? "") as
                  | string
                  | number),
    });
}

/**
 * v840: the "same/yes" region for a DRAFT matching question — the exact
 * polygon the elimination KEEPS when the hider matches — exposed so the
 * configure-dialog impact overlay (`questionImpact.ts`) draws the SAME
 * region the answer will carve out, for the AREA/line matching types that
 * aren't a plain point set (admin zone / letter-zone, same-landmass,
 * same-length/-train-line/-street). Runs `determineMatchingBoundary` in
 * `silent` mode so a cold/failed lookup draws nothing instead of toasting.
 * Returns null on any failure OR for the point/POI types (`false`), whose
 * overlay is the Voronoi cell drawn by the point path. Normalises a
 * FeatureCollection result (letter-zone) to one polygon.
 */
export async function matchingDraftRegion(
    question: MatchingQuestion,
): Promise<Feature<Polygon | MultiPolygon> | null> {
    const silentQuestion = {
        ...question,
        drag: false,
        silent: true,
    } as unknown as MatchingQuestion;
    try {
        const boundary = await determineMatchingBoundary(silentQuestion);
        // A silent draft that FAILED resolves `undefined` (a heavy/cold
        // lookup that threw its guards — e.g. NYC same-landmass). lodash
        // memoize pins that resolved-undefined promise, so every reopen at
        // the same pin returned undefined → no overlay ever drew (the
        // "empty preview on reopen" bug). Evict the failed entry so the next
        // open recomputes once the coast/geometry warms. `false` is a VALID
        // stable result (point/POI types have no region) — keep it cached.
        if (boundary === undefined) {
            try {
                (
                    determineMatchingBoundary as unknown as {
                        cache: { delete: (k: string) => void };
                    }
                ).cache.delete(matchingBoundaryMemoKey(silentQuestion as never));
            } catch {
                /* cache shape changed — non-fatal */
            }
        }
        if (!boundary || boundary === true) return null;
        if ((boundary as Feature).type === "Feature") {
            const g = (boundary as Feature).geometry;
            if (g && (g.type === "Polygon" || g.type === "MultiPolygon")) {
                return boundary as Feature<Polygon | MultiPolygon>;
            }
            return null;
        }
        // FeatureCollection (letter-zone) → union to one polygon.
        if ((boundary as FeatureCollection).type === "FeatureCollection") {
            const polys = (boundary as FeatureCollection).features.filter(
                (f): f is Feature<Polygon | MultiPolygon> =>
                    !!f.geometry &&
                    (f.geometry.type === "Polygon" ||
                        f.geometry.type === "MultiPolygon"),
            );
            if (polys.length === 0) return null;
            if (polys.length === 1) return polys[0];
            try {
                return (
                    (safeUnion(
                        turf.featureCollection(polys),
                    ) as Feature<Polygon | MultiPolygon>) ?? polys[0]
                );
            } catch {
                return polys[0];
            }
        }
        return null;
    } catch {
        return null;
    }
}

export const adjustPerMatching = async (
    question: MatchingQuestion,
    mapData: any,
) => {
    if (mapData === null) return;

    const boundary = await determineMatchingBoundary(question);

    if (boundary === false) {
        return mapData;
    }

    // same-length-station is a 3-way comparison: the boundary already
    // encodes the answer (cells whose station name is equal / shorter /
    // longer than the seeker's), so we always KEEP that region rather than
    // toggling on `question.same`. Every other type is a binary same/
    // different match driven by `question.same`.
    const within =
        question.type === "same-length-station" ? true : question.same;

    return modifyMapData(mapData, boundary, within);
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

        // No reference found within the capped search radius (absent in-area
        // or an Overpass hiccup) — leave the verdict ungraded rather than
        // dereferencing a null. The hider can still answer manually.
        if (!questionNearest || !hiderNearest) return question;

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
