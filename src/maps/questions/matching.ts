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
    findTrainLineGeometry,
    apiLocationFilter,
    apiLocationMatches,
    nearestToQuestion,
    prettifyLocation,
    trainLineNodeFinder,
} from "@/maps/api";
import { hidingZone } from "@/lib/hiderRole";
import {
    basemapLandParts,
    ensureBasemapWaterForArea,
} from "@/maps/api/basemapWater";
import { fetchAreaLandPolygons } from "@/maps/api/coast";
import {
    fetchPrewarmedAreaStreets,
    requestStreetsWarmAll,
} from "@/maps/api/streets";
import { seaFromCoastline } from "@/maps/questions/seaFromCoastline";
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
            // v970 (rulebook audit B): re-check tags client-side so the
            // exclusions the cached paths apply (golf driving ranges /
            // mini golf) also apply to this LIVE query's results — the
            // label and the cut must agree. Tagless elements pass (the
            // server filter already matched them).
            const allPoints: Feature<Point>[] = data.elements
                .filter(
                    (x: any) => !x.tags || apiLocationMatches(location, x.tags),
                )
                .map((x: any) =>
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

/** A nearby highway way from the street-question step-1 fetch — geometry
 *  latlons + the parallel OSM node-id array (`out geom` returns both). */
interface NearbyWay {
    id: number;
    geom: Array<{ lat: number; lon: number }>;
    nodes: number[];
}

/**
 * v970 (rulebook audit B): the UNNAMED street/path case — "If the street or
 * path is unnamed, it is considered to start or end wherever it has an
 * intersection" (rulebook p162). The matching region is the segment of the
 * seeker's nearest (unnamed) way between the two intersections bracketing
 * their nearest point on it; the way's own endpoints always count as
 * boundaries. Intersections = the way's nodes shared with any OTHER highway
 * way (OSM ways share nodes where they physically cross), fetched with a
 * targeted `way(id) → node(w) → way(bn)` query. Returns the 25 m-buffered
 * segment polygon, or null on any failure (the caller errors out like the
 * old behaviour). Approximation: a same-road continuation split into a
 * different OSM way at a non-intersection also terminates the segment —
 * conservative, and rare for the short unnamed service ways this covers.
 */
/**
 * The pure core of `unnamedStreetSegmentBoundary`: given the seeker's nearest
 * unnamed way + a set of OTHER highway way-elements (each with a `nodes` id
 * array), compute the intersection-bracketed segment around the seeker's
 * nearest point and return its 25 m buffer. No network — the caller supplies
 * the other ways (either from a targeted live query or, v991, from the ONE
 * cacheable all-highways area fetch). Returns null on any degeneracy.
 */
function unnamedSegmentFromElements(
    way: NearbyWay,
    seekerPt: Feature<Point>,
    otherWayElements: Array<{ type?: string; id?: number; nodes?: number[] }>,
): Feature<any> | null {
    try {
        if (way.geom.length < 2 || way.nodes.length !== way.geom.length) {
            return null;
        }
        const otherNodeIds = new Set<number>();
        for (const el of otherWayElements) {
            if (el?.type !== "way" || el.id === way.id) continue;
            for (const n of el.nodes ?? []) otherNodeIds.add(n);
        }
        // Boundary vertex indices: the endpoints + every shared node.
        const boundaryIdx: number[] = [];
        for (let i = 0; i < way.nodes.length; i++) {
            if (
                i === 0 ||
                i === way.nodes.length - 1 ||
                otherNodeIds.has(way.nodes[i])
            ) {
                boundaryIdx.push(i);
            }
        }
        const line = turf.lineString(way.geom.map((p) => [p.lon, p.lat]));
        const snapped = turf.nearestPointOnLine(line, seekerPt);
        const segIdx = (snapped.properties?.index as number) ?? 0;
        // The segment spans from the last boundary at-or-before the
        // seeker's nearest way segment to the first boundary after it.
        let lo = 0;
        let hi = way.geom.length - 1;
        for (const b of boundaryIdx) {
            if (b <= segIdx && b > lo) lo = b;
            if (b >= segIdx + 1 && b < hi) hi = b;
        }
        if (hi <= lo) return null;
        const seg = way.geom.slice(lo, hi + 1).map((p) => [p.lon, p.lat]);
        if (seg.length < 2) return null;
        const buffered = turf.buffer(turf.lineString(seg), 25, {
            units: "meters",
        });
        return (buffered as Feature<any>) ?? null;
    } catch {
        return null;
    }
}

/** English-preferred station name (matches the hider-grading logic). */
function stationName(f: Feature<Point>): string | null {
    const p = f.properties as Record<string, unknown> | undefined;
    return ((p?.["name:en"] as string) || (p?.name as string) || null) ?? null;
}

/** v966: a candidate station coincides with one of the picked route's stops
 *  when it's within this distance — the route lists stop_position/platform
 *  nodes that sit a little off the `railway=station` node. */
const STATION_STOP_MATCH_M = 150;

/** True if a coordinate coincides with one of the route's stops (within
 *  STATION_STOP_MATCH_M). Shared by the seeker elimination and the hider
 *  grade so the map cut agrees with the answer. */
function coordIsRouteStop(
    lng: number,
    lat: number,
    stops: { lat: number; lng: number }[],
): boolean {
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return false;
    const pt = turf.point([lng, lat]);
    return stops.some(
        (s) =>
            turf.distance(pt, turf.point([s.lng, s.lat]), {
                units: "meters",
            }) <= STATION_STOP_MATCH_M,
    );
}

/** True if `station` is one of the route's stops. */
function stationIsRouteStop(
    station: Feature<Point>,
    stops: { lat: number; lng: number }[],
): boolean {
    const c = station.geometry?.coordinates;
    if (!c) return false;
    return coordIsRouteStop(c[0], c[1], stops);
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
 * For "length" (v879) the answer is BINARY (`same`), like every other
 * matching type: the matching set is stations whose name length EQUALS
 * the seeker's nearest, and `adjustPerMatching` keeps/complements that
 * region per the hider's yes/no answer.
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
        // v966: the answer is "is the hider's station a stop on the ROUTE the
        // seekers are riding?" — so the matching set is every candidate
        // station that is one of the picked route's stops (within
        // STATION_STOP_MATCH_M, bridging the station node vs the route's
        // stop_position/platform node). No route picked → nothing to cut.
        const stops = question.transitRoute?.stops ?? [];
        if (stops.length === 0) return false;
        matching = stations.features.filter((s) =>
            stationIsRouteStop(s, stops),
        );
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
            // v879: station-name length is a BINARY matching question
            // ("same" / "different"), like every other matching type — the
            // boundary is the answer-independent union of the cells of every
            // station whose name length EQUALS the seeker's nearest, and
            // `adjustPerMatching` keeps or complements it per the yes/no answer.
            const len = name.length;
            matching = stations.features.filter((s) => {
                const n = stationName(s);
                return n ? n.length === len : false;
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

/**
 * v877: the rail LINE(s) the pin's NEAREST station sits on — for DRAWING on
 * the same-train-line configure preview (which otherwise shows only the
 * station dot). Mirrors `matchingStationBoundary`'s nearest-station lookup,
 * then fetches the line geometry via `findTrainLineGeometry` (the same
 * name/name:en/network query the grading uses, so the drawn line matches).
 * Returns [] on any failure — nothing drawn, never throws.
 */
export async function trainLineForPoint(
    lat: number,
    lng: number,
): Promise<GeoJSON.Feature[]> {
    try {
        const stations = osmtogeojson(
            await findPlacesInZone("[railway=station]", undefined, "node"),
        ) as FeatureCollection<Point>;
        if (stations.features.length === 0) return [];
        const nearest = turf.nearestPoint(turf.point([lng, lat]), stations);
        const id = nearest.properties?.id as string | undefined;
        if (!id) return [];
        return await findTrainLineGeometry(id);
    } catch {
        return [];
    }
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

                // v1001: prefer the BASEMAP's own land/water — the play-area
                // frame minus the basemap `water` layer, split into landmasses
                // (`basemapLandParts`). This is the authoritative land/water the
                // map already draws (the same source body-of-water uses), so
                // NYC's East River / harbour correctly split the boroughs — no
                // fragile OSM `natural=coastline` assembly (`seaFromCoastline`)
                // and no risk of the global-continent fallback. Falls through to
                // the per-city OSM land + the frame-bounded coarse land below
                // when no map has captured the basemap water yet.
                let usedBasemapLand = false;
                try {
                    const frameB = turf.bbox(mapGeoJSON.get()!);
                    const frameBb: [number, number, number, number] = [
                        frameB[0],
                        frameB[1],
                        frameB[2],
                        frameB[3],
                    ];
                    // v1002: deterministically read the basemap water from the
                    // pmtiles before deriving the land (no map/idle race).
                    await ensureBasemapWaterForArea(frameBb);
                    const landParts = basemapLandParts(frameBb);
                    if (landParts && landParts.length > 0) {
                        for (const p of landParts) collected.push(p);
                        usedBasemapLand = true;
                    }
                } catch {
                    /* fall through to the OSM path */
                }

                const areaLand = usedBasemapLand
                    ? null
                    : await fetchAreaLandPolygons({
                          lat: question.lat,
                          lng: question.lng,
                      });
                if (usedBasemapLand) {
                    /* already populated `collected` from the basemap */
                } else if (areaLand) {
                    pushParts(areaLand);
                } else {
                    // Fallback: fetchAreaLandPolygons failed (per-city coast
                    // unavailable / degenerate). The OLD fallback closed the
                    // bundled 1:50m coastline GLOBALLY, which yields whole
                    // CONTINENTS — a Manhattan seeker got all of the Americas
                    // as "one landmass" (37M km²), so EVERY hider matched:
                    // strictly worse than no answer. Instead build a
                    // FRAME-BOUNDED coarse land — clip the bundled coastline to
                    // the play-area frame and close it against the frame (the
                    // same construction as the body-of-water coarse ocean).
                    // Coarse (may not resolve a narrow strait like the East
                    // River), but bounded to the play area, never a continent.
                    try {
                        const b = turf.bbox(mapGeoJSON.get()!);
                        const frameBbox: [number, number, number, number] = [
                            b[0],
                            b[1],
                            b[2],
                            b[3],
                        ];
                        const coastFC = await fetchCoastline();
                        const pad = 3;
                        const near = (
                            coastFC.features as Feature[]
                        ).filter((f) => {
                            const g = f.geometry;
                            if (
                                !g ||
                                (g.type !== "LineString" &&
                                    g.type !== "MultiLineString")
                            )
                                return false;
                            const fb = turf.bbox(f);
                            return !(
                                fb[0] > frameBbox[2] + pad ||
                                fb[2] < frameBbox[0] - pad ||
                                fb[1] > frameBbox[3] + pad ||
                                fb[3] < frameBbox[1] - pad
                            );
                        }) as Feature<
                            GeoJSON.LineString | GeoJSON.MultiLineString
                        >[];
                        const sea = seaFromCoastline(near, frameBbox, {
                            lng: question.lng,
                            lat: question.lat,
                        });
                        const frame = turf.bboxPolygon(frameBbox);
                        if (sea) {
                            const land = turf.difference(
                                turf.featureCollection([
                                    frame as Feature<Polygon>,
                                    sea as Feature<Polygon | MultiPolygon>,
                                ]),
                            );
                            if (land)
                                pushParts(
                                    land as Feature<Polygon | MultiPolygon>,
                                );
                            else pushParts(frame as Feature<Polygon>);
                        } else {
                            // No sea inside the frame → the whole play area is
                            // one landmass (a reasonable degraded answer).
                            pushParts(frame as Feature<Polygon>);
                        }
                    } catch {
                        /* leave `collected` empty → the no-landmass error
                           below, which is honest (better than a continent). */
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
                // v969 (rulebook audit A3): the ENCLAVE rule — "If the hider
                // is on a landmass that is entirely surrounded by the landmass
                // the seekers are on, it counts as a match" (rulebook p174).
                // An island in a lake inside the seeker's landmass is a
                // separate polygon, so plain containment graded it "no". Drop
                // the seeker polygon's interior rings (lake holes): anything
                // inside those holes — enclave islands included — now falls
                // inside the boundary, which is exactly the surrounded rule.
                // (The filled water itself is harmless in the kept region: a
                // hiding zone is never in a lake.)
                try {
                    const coords = (boundary as Feature<Polygon>).geometry;
                    if (
                        coords?.type === "Polygon" &&
                        coords.coordinates.length > 1
                    ) {
                        boundary = turf.polygon([coords.coordinates[0]]);
                    }
                } catch {
                    /* keep the holed boundary — strictly worse but valid */
                }
                break;
            }
            case "same-street-or-path": {
                // v340: rulebook p18 — "A street or path is considered
                // to have ended when it acquires a different name."
                // The matching boundary is the geometry of every OSM
                // way sharing the seeker's nearest-street name.
                //
                // v991 — RELIABILITY over speed. The old design fired a
                // position-keyed `way["highway"](around:500,lat,lng)` query
                // for step 1, which embeds the exact coords → a unique query
                // string → guaranteed R2 cache MISS → LIVE Overpass on EVERY
                // same-street question (the rate-limit-and-fail risk the user
                // flagged; same anti-pattern as v640's `around:GPS`). Now the
                // WHOLE question is computed CLIENT-SIDE from ONE CACHEABLE
                // area fetch: `findPlacesInZone("[highway]")` is a poly-scoped
                // query the worker caches in R2, so a warm play area serves
                // every same-street question Overpass-free. Nearest way (named
                // OR unnamed), same-name union, and the unnamed
                // intersection-to-intersection segment (rulebook p162) all come
                // from that single fetch — no per-question live query.
                const seekerLat = question.lat;
                const seekerLng = question.lng;
                const seekerPt = turf.point([seekerLng, seekerLat]);

                const findNearest = (
                    els: any[],
                ): {
                    streetName: string | null;
                    nearestWay: NearbyWay | null;
                    bestDist: number;
                } => {
                    let streetName: string | null = null;
                    let nearestWay: NearbyWay | null = null;
                    let bestDist = Infinity;
                    for (const el of els) {
                        const geom = el?.geometry as
                            | Array<{ lat: number; lon: number }>
                            | undefined;
                        if (!geom || geom.length < 2) continue;
                        try {
                            const line = turf.lineString(
                                geom.map((p) => [p.lon, p.lat]),
                            );
                            const d = turf.pointToLineDistance(seekerPt, line, {
                                units: "meters",
                            });
                            if (d < bestDist) {
                                bestDist = d;
                                streetName = el?.tags?.name ?? null;
                                nearestWay = {
                                    id: el.id as number,
                                    geom,
                                    nodes: (el.nodes as number[]) ?? [],
                                };
                            }
                        } catch {
                            /* skip malformed way */
                        }
                    }
                    return { streetName, nearestWay, bestDist };
                };

                // v992: PREWARMED named-highway set first (R2, Overpass-free).
                // The common case — the seeker is near a named street — is
                // served entirely from cache: find the nearest named street +
                // union every way sharing its name. Only used when a named
                // street is genuinely NEAR (else the seeker may be on an
                // UNNAMED way the named-only set can't see → fall to the live
                // all-highways path below, which detects unnamed ways).
                const NEAR_NAMED_STREET_M = 120;
                try {
                    const prewarmed = await fetchPrewarmedAreaStreets();
                    if (prewarmed && prewarmed.length > 0) {
                        const near = findNearest(prewarmed);
                        if (
                            near.streetName &&
                            near.nearestWay &&
                            near.bestDist <= NEAR_NAMED_STREET_M
                        ) {
                            const wayFeatures = osmtogeojson({
                                elements: prewarmed.filter(
                                    (el) => el?.tags?.name === near.streetName,
                                ),
                            } as never).features.filter(
                                (f): f is Feature<any> =>
                                    f.geometry?.type === "LineString" ||
                                    f.geometry?.type === "MultiLineString",
                            );
                            if (wayFeatures.length > 0) {
                                const buffered = turf.buffer(
                                    turf.featureCollection(wayFeatures),
                                    25,
                                    { units: "meters" },
                                );
                                if (buffered) {
                                    boundary = turf.combine(
                                        buffered as any,
                                    ).features[0];
                                    break;
                                }
                            }
                        }
                    }
                } catch {
                    /* prewarm miss / error — fall through to the live path */
                }

                // ONE cacheable live fetch: every highway way in the play area,
                // with geometry + node ids (`out geom`). Poly-scoped →
                // worker → R2, so it's served from cache after the first fetch
                // (and we warm the prewarm endpoint so the NEXT game skips
                // even this). Covers named AND unnamed nearest.
                requestStreetsWarmAll();
                const rawHighways = await findPlacesInZone(
                    '["highway"]',
                    undefined,
                    "way",
                    "geom",
                );
                const elements = (
                    (rawHighways as { elements?: any[] }).elements ?? []
                ).filter(
                    (el) =>
                        el?.type === "way" &&
                        Array.isArray(el.geometry) &&
                        el.geometry.length >= 2,
                );

                let { streetName, nearestWay } = findNearest(elements);
                // Other highway ways used for unnamed-segment intersection
                // detection — the SAME cached set (no extra query).
                let otherWays: any[] = elements;

                // Degenerate fallback ONLY (the cache query returned nothing
                // — a huge/failed area): the old small live `around:500`
                // query, so an uncurated/failed area still works. This is the
                // rare path, not the per-question default.
                if (!nearestWay) {
                    const nearbyData = await (
                        await import("@/maps/api/overpass")
                    ).getOverpassData(`
[out:json][timeout:30];
way["highway"](around:500,${seekerLat},${seekerLng});
out geom;
`);
                    const liveEls = (
                        (nearbyData as { elements?: any[] }).elements ?? []
                    ).filter(
                        (el) =>
                            el?.type === "way" &&
                            Array.isArray(el.geometry) &&
                            el.geometry.length >= 2,
                    );
                    ({ streetName, nearestWay } = findNearest(liveEls));
                    otherWays = liveEls;
                }

                if (!nearestWay) {
                    if (silent) return undefined;
                    toast.error("No street or path found near your location.");
                    throw new Error("No nearby street");
                }
                if (!streetName) {
                    // Unnamed way: the matching region is the segment of
                    // THIS way between the intersections bracketing the
                    // seeker's nearest point (way endpoints count as
                    // boundaries too), buffered like the named case —
                    // computed from the SAME cached highway set.
                    const segBoundary = unnamedSegmentFromElements(
                        nearestWay,
                        seekerPt,
                        otherWays,
                    );
                    if (!segBoundary) {
                        if (silent) return undefined;
                        toast.error(
                            "Couldn't determine the unnamed street's intersection-to-intersection segment.",
                        );
                        throw new Error("Unnamed street segment failed");
                    }
                    boundary = segBoundary;
                    break;
                }
                // Every way sharing the nearest street's name — filtered from
                // the SAME cached fetch (no per-name live query).
                const wayFeatures = osmtogeojson({
                    elements: otherWays.filter(
                        (el) => el?.tags?.name === streetName,
                    ),
                } as never).features.filter(
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
        // v879: same-length-station is now BINARY — its boundary (stations of
        // equal name length) is answer-independent, so `lengthComparison` no
        // longer belongs in the key; `adjustPerMatching` handles the yes/no.
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

    // v879: every matching type (same-length-station included) is a binary
    // same/different match — the boundary is the answer-independent "same"
    // region and `question.same` decides whether we KEEP it or its complement.
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
            // v966: "yes" iff the hider's COMMITTED hiding-zone station is a
            // STOP on the route the seekers are riding (baked onto the
            // question by the seeker's route picker). Grading against the
            // committed zone — not a re-derived nearest station — matches what
            // the hider actually declared. Falls back to the nearest station
            // when no zone is committed (e.g. solo testing pre-commit). No
            // route → leave the manual answer.
            const stops = question.transitRoute?.stops ?? [];
            if (stops.length > 0) {
                const zone = hidingZone.get();
                question.same = zone
                    ? coordIsRouteStop(
                          zone.stationLng,
                          zone.stationLat,
                          stops,
                      )
                    : stationIsRouteStop(
                          nearestHiderTrainStation as Feature<Point>,
                          stops,
                      );
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
            // v879: binary — the seeker's nearest station name is the SAME
            // length as the hider's, or it isn't.
            question.same =
                hiderEnglishName.length === seekerEnglishName.length;
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
