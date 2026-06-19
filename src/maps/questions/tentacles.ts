import * as turf from "@turf/turf";

import { hiderMode } from "@/lib/context";
import { referenceExtent } from "@/maps/api/playAreaPrefetch";
import { findTentacleLocations, getOverpassData } from "@/maps/api";
import { arcBuffer, safeUnion } from "@/maps/geo-utils";
import { geoSpatialVoronoi } from "@/maps/geo-utils";
import type { TentacleQuestion, Units } from "@/maps/schema";

/* ── Metro Lines tentacle (v343) ─────────────────────────────────── *
 *
 * Rulebook p38: "Metro Lines Within 25 km — These will be drawn as
 * colored lines in Google Maps." Each line is a tentacle the hider
 * might be near; the question resolves to a line NAME, same shape as
 * a zoo/museum/etc. answer.
 *
 * Data path:
 *   1. Fetch every `relation[route=subway][name]` inside the play-area
 *      bbox (NOT seeker-anchored). The query goes through our worker
 *      cache, and the bbox is stable per play area — one query covers
 *      every metro-tentacle question asked in that play area, and the
 *      laptop can prewarm it per curated city.
 *   2. For each route, compute a single representative point (the
 *      route's centroid over all member-way vertices) and tag it with
 *      the route's name. This makes metro lines drop straight into
 *      the existing Voronoi pipeline (point-based) without needing a
 *      true line-Voronoi.
 *   3. Filter the candidate points to those within `radius` of the
 *      seeker (the question's distance constraint).
 *
 * The centroid-as-representative is an approximation — Voronoi cells
 * reflect route centroids rather than true line proximity, so for a
 * long curved line the cell might shade slightly off where the line
 * itself runs. For the tentacle UX (which line is closest) this is
 * indistinguishable in practice on city-scale play areas; for
 * larger metros where it matters, the seeker still answers correctly
 * because the FETCH side (hider→nearest-route) measures real line
 * geometry below.
 */
const METRO_BBOX_PAD_KM = 5;

function playAreaBboxTuple(): string | null {
    // v357: same canonical-extent contract as the reference / transit
    // queries — the laptop's `processMetroRoutes` keys off the same
    // boundary-derived extent, so the R2 lookup matches.
    const extent = referenceExtent();
    if (!extent) return null;
    // Photon extent shape: [maxLat, minLng, minLat, maxLng].
    const [maxLat, minLng, minLat, maxLng] = extent;
    const latPad = METRO_BBOX_PAD_KM / 111;
    const midLat = (maxLat + minLat) / 2;
    const lngPad =
        METRO_BBOX_PAD_KM / (111 * Math.cos((midLat * Math.PI) / 180));
    const s = (minLat - latPad).toFixed(3);
    const w = (minLng - lngPad).toFixed(3);
    const n = (maxLat + latPad).toFixed(3);
    const e = (maxLng + lngPad).toFixed(3);
    return `${s},${w},${n},${e}`;
}

/** Byte-stable query string for play-area metro routes. Must match the
 *  laptop prewarmer (overpass-cache/scripts/laptop-prewarm.mjs metro
 *  prewarm) byte-for-byte so the R2 cache hits. */
function metroRoutesQuery(bboxTuple: string): string {
    return `\n[out:json][timeout:180][bbox:${bboxTuple}];\nrelation["route"="subway"]["name"];\nout tags geom;\n`;
}

/**
 * Fetch metro-line tentacle candidates as a FeatureCollection of
 * representative points (one per route), filtered to those whose
 * closest point on the line sits within `radius` of the seeker.
 */
async function findMetroTentacleCandidates(
    centerLat: number,
    centerLng: number,
    radius: number,
    unit: Units,
): Promise<GeoJSON.FeatureCollection<GeoJSON.Point>> {
    const tuple = playAreaBboxTuple();
    if (!tuple) return turf.featureCollection([]);
    const query = metroRoutesQuery(tuple);
    let data: any;
    try {
        data = await getOverpassData(query, "Loading metro lines...");
    } catch {
        return turf.featureCollection([]);
    }
    const seeker = turf.point([centerLng, centerLat]);
    const seen = new Set<string>();
    const candidates: GeoJSON.Feature<GeoJSON.Point>[] = [];
    for (const el of data.elements ?? []) {
        if (el.type !== "relation") continue;
        const name = el.tags?.["name:en"] ?? el.tags?.name;
        if (!name || typeof name !== "string") continue;
        if (seen.has(name)) continue;
        // Collect all member-way vertices for centroid + distance.
        const coords: [number, number][] = [];
        for (const m of el.members ?? []) {
            if (m.type !== "way" || !Array.isArray(m.geometry)) continue;
            for (const p of m.geometry) {
                if (
                    typeof p.lat === "number" &&
                    typeof p.lon === "number"
                ) {
                    coords.push([p.lon, p.lat]);
                }
            }
        }
        if (coords.length < 2) continue;
        // Distance constraint = seeker → CLOSEST point on the line.
        // Real geometry, not centroid — the centroid is only used as
        // the Voronoi seed below.
        let closestDistance = Infinity;
        for (const c of coords) {
            const d = turf.distance(seeker, turf.point(c), { units: unit });
            if (d < closestDistance) closestDistance = d;
        }
        if (closestDistance > radius) continue;
        // Centroid as Voronoi seed. multiPoint avoids the LineString-
        // closed-loop assumption of turf.centroid for lines.
        const centroid = turf.centroid(turf.multiPoint(coords));
        seen.add(name);
        candidates.push(
            turf.point(centroid.geometry.coordinates as [number, number], {
                name,
            }),
        );
    }
    return turf.featureCollection(candidates);
}

const filterPointsWithinRadius = (
    points: any,
    centerLng: number,
    centerLat: number,
    radius: number,
    unit: Units,
) => {
    if (
        centerLng === null ||
        centerLat === null ||
        radius === undefined ||
        radius === null
    ) {
        return points;
    }
    const center = turf.point([centerLng, centerLat]);

    return turf.featureCollection(
        points.features.filter((feature: any) => {
            const coords =
                feature?.geometry?.coordinates ??
                (feature?.properties?.lon && feature?.properties?.lat
                    ? [feature.properties.lon, feature.properties.lat]
                    : null);

            if (!coords) return false;

            const pt = turf.point(coords);
            const dist = turf.distance(center, pt, { units: unit });
            return dist <= radius;
        }),
    );
};

export const adjustPerTentacle = async (
    question: TentacleQuestion,
    mapData: any,
) => {
    if (mapData === null) return;
    if (question.location === false) {
        throw new Error("Must have a location");
    }

    const rawPoints =
        question.locationType === "custom"
            ? turf.featureCollection(question.places)
            : question.locationType === "metro"
              ? await findMetroTentacleCandidates(
                    question.lat,
                    question.lng,
                    question.radius,
                    question.unit,
                )
              : await findTentacleLocations(question);

    const points =
        question.locationType === "custom"
            ? filterPointsWithinRadius(
                  rawPoints,
                  question.lng,
                  question.lat,
                  question.radius,
                  question.unit,
              )
            : rawPoints;

    const voronoi = geoSpatialVoronoi(points);

    const correctPolygon = voronoi.features.find((feature: any) => {
        if (!question.location) return false;
        return (
            feature.properties.site.properties.name ===
            question.location.properties.name
        );
    });
    if (!correctPolygon) {
        return mapData;
    }

    const circle = await arcBuffer(
        turf.featureCollection([turf.point([question.lng, question.lat])]),
        question.radius,
        question.unit,
    );

    return turf.intersect(
        turf.featureCollection([safeUnion(mapData), correctPolygon, circle]),
    );
};

export const hiderifyTentacles = async (question: TentacleQuestion) => {
    const $hiderMode = hiderMode.get();
    if ($hiderMode === false) {
        return question;
    }

    const rawPoints =
        question.locationType === "custom"
            ? turf.featureCollection(question.places)
            : question.locationType === "metro"
              ? await findMetroTentacleCandidates(
                    question.lat,
                    question.lng,
                    question.radius,
                    question.unit,
                )
              : await findTentacleLocations(question);

    const points =
        question.locationType === "custom"
            ? filterPointsWithinRadius(
                  rawPoints,
                  question.lng,
                  question.lat,
                  question.radius,
                  question.unit,
              )
            : rawPoints;

    const voronoi = geoSpatialVoronoi(points);

    const hider = turf.point([$hiderMode.longitude, $hiderMode.latitude]);
    const location = turf.point([question.lng, question.lat]);

    if (
        turf.distance(hider, location, { units: question.unit }) >
        question.radius
    ) {
        question.location = false;
        return question;
    }

    let correctLocation: any = null;

    const correctPolygon = voronoi.features.find(
        (feature: any, index: number) => {
            const pointIn =
                turf.booleanPointInPolygon(hider, feature.geometry) || false;

            if (pointIn) {
                correctLocation = points.features[index];
            }
            return pointIn;
        },
    );

    if (!correctPolygon) {
        return question;
    }

    question.location = correctLocation!;
    return question;
};

export const tentaclesPlanningPolygon = async (question: TentacleQuestion) => {
    const rawPoints =
        question.locationType === "custom"
            ? turf.featureCollection(question.places)
            : question.locationType === "metro"
              ? await findMetroTentacleCandidates(
                    question.lat,
                    question.lng,
                    question.radius,
                    question.unit,
                )
              : await findTentacleLocations(question);

    const points =
        question.locationType === "custom"
            ? filterPointsWithinRadius(
                  rawPoints,
                  question.lng,
                  question.lat,
                  question.radius,
                  question.unit,
              )
            : rawPoints;

    const voronoi = geoSpatialVoronoi(points);
    const circle = await arcBuffer(
        turf.featureCollection([turf.point([question.lng, question.lat])]),
        question.radius,
        question.unit,
    );

    const interiorVoronoi = voronoi.features
        .map((feature) =>
            turf.intersect(turf.featureCollection([feature, circle])),
        )
        .filter((feature) => feature !== null);

    return turf.combine(
        turf.featureCollection(
            interiorVoronoi
                .map((x: any) => turf.polygonToLine(x))
                .flatMap((line) =>
                    line.type === "FeatureCollection" ? line.features : [line],
                ),
        ),
    );
};
