import * as turf from "@turf/turf";

import {
    additionalMapGeoLocations,
    hiderMode,
    mapGeoLocation,
} from "@/lib/context";
import { haversineMeters } from "@/lib/geo";
import { safeJsonFromCachedResponse } from "@/maps/api/cache";
import { METRO_BY_RELATION_BASE } from "@/maps/api/constants";
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

const metroWarmRequested = new Set<number>();
function requestWarmMetro(relationId: number): void {
    if (metroWarmRequested.has(relationId)) return;
    metroWarmRequested.add(relationId);
    fetch(`${METRO_BY_RELATION_BASE}/${relationId}?warm=1`, {
        method: "GET",
    }).catch(() => {
        metroWarmRequested.delete(relationId);
    });
}

/**
 * Fetch the play-area metro routes, endpoint-first (v700). When the play area
 * is a single OSM relation (the common case), read the relation-id-keyed
 * `/api/metro/<id>` — the worker derives the bbox from the boundary it has in
 * R2, so a prewarmed metro entry is read under the SAME key the laptop stored
 * (no client-side land-clip drift). Falls back to the live bbox query on a
 * non-relation play area, an endpoint miss (firing a background warm), or a
 * network error. Returns `null` when there's no usable extent.
 */
async function fetchMetroRoutesData(): Promise<any> {
    const primary = mapGeoLocation.get();
    const props = primary?.properties as
        | { osm_id?: number; osm_type?: string }
        | undefined;
    const extrasAdded = additionalMapGeoLocations
        .get()
        .some((e) => e.added);
    if (
        !extrasAdded &&
        props?.osm_type === "R" &&
        typeof props.osm_id === "number" &&
        props.osm_id > 0
    ) {
        const relId = props.osm_id;
        try {
            const resp = await fetch(`${METRO_BY_RELATION_BASE}/${relId}`);
            if (resp.ok) {
                // v1225: parse with the gzip-PEELING reader, NOT plain
                // `resp.json()`. A prewarmed `/api/metro/<id>` R2 body can be
                // served gzip-tagged / double-gzipped (the v738/v739 class);
                // `resp.json()` throws on the `0x1f` magic byte, the catch
                // swallowed it, and we fell through to LIVE Overpass even for a
                // fully-prewarmed city (NYC) — the reported metro-line failure.
                // (metro was the one relation-endpoint reader missed by the
                // v1116/v1124 hardening sweep.)
                const json = (await safeJsonFromCachedResponse(resp)) as {
                    elements?: unknown[];
                } | null;
                const els = json?.elements;
                if (Array.isArray(els) && els.length > 0) return json;
                // Empty = miss/no-boundary. Warm in the background and fall
                // through to the live bbox query so the user still gets data.
                requestWarmMetro(relId);
            }
        } catch {
            /* network issue → fall through */
        }
    }
    const tuple = playAreaBboxTuple();
    if (!tuple) return null;
    return await getOverpassData(metroRoutesQuery(tuple), "Loading metro lines...");
}

/* ── Metro lines are CURVED LINES, not points (v1233) ────────────────── *
 *
 * The old approach represented each line by its CENTROID and built a Voronoi
 * over those centroids — so "which line is nearest" reflected centroid
 * proximity, not real line proximity (a curved line's nearest point can be far
 * from its centroid). We now sample points ALONG each line, tag them with the
 * line name, build a Voronoi over ALL sample points, and UNION the cells by
 * name → one region per LINE. That IS the nearest-LINE partition (it converges
 * to the exact line-Voronoi as sampling density rises). `computeMetroReachCells`
 * is the single producer used by the configure preview, the elimination
 * (adjustPerTentacle), and the draft planning overlay, so all three agree; the
 * hider's answer (hiderifyTentacles) picks the nearest sample point, whose line
 * name selects the matching region.
 */
const METRO_SAMPLE_BUDGET = 600;
const METRO_SAMPLE_MAX_PER_LINE = 24;

interface MetroLine {
    name: string;
    coords: [number, number][];
}

/** Fetch the reachable metro LINES (name + full coords) — "reachable" = the
 *  closest point on the line sits within `radius` of the seeker. */
async function fetchReachableMetroLines(
    centerLat: number,
    centerLng: number,
    radius: number,
    unit: Units,
): Promise<MetroLine[]> {
    let data: any;
    try {
        data = await fetchMetroRoutesData();
    } catch {
        return [];
    }
    if (!data) return [];
    const radiusMeters = turf.convertLength(radius, unit, "meters");
    const seen = new Set<string>();
    const lines: MetroLine[] = [];
    for (const el of data.elements ?? []) {
        if (el.type !== "relation") continue;
        const name = el.tags?.["name:en"] ?? el.tags?.name;
        if (!name || typeof name !== "string" || seen.has(name)) continue;
        const coords: [number, number][] = [];
        for (const m of el.members ?? []) {
            if (m.type !== "way" || !Array.isArray(m.geometry)) continue;
            for (const p of m.geometry) {
                if (typeof p.lat === "number" && typeof p.lon === "number") {
                    coords.push([p.lon, p.lat]);
                }
            }
        }
        if (coords.length < 2) continue;
        // Distance constraint = seeker → CLOSEST point on the line (real
        // geometry). Inline haversine — a metro line has hundreds of vertices.
        let closest = Infinity;
        for (const c of coords) {
            const d = haversineMeters(centerLat, centerLng, c[1], c[0]);
            if (d < closest) closest = d;
        }
        if (closest > radiusMeters) continue;
        seen.add(name);
        lines.push({ name, coords });
    }
    return lines;
}

/** Dense sample points ALONG each line, tagged with the line name — the seed
 *  set for the nearest-LINE Voronoi. Bounded by a global budget so a dense
 *  metro (Tokyo) stays tractable. */
function metroSamplePoints(
    lines: MetroLine[],
): GeoJSON.FeatureCollection<GeoJSON.Point> {
    const perLine = Math.min(
        METRO_SAMPLE_MAX_PER_LINE,
        Math.max(6, Math.floor(METRO_SAMPLE_BUDGET / Math.max(1, lines.length))),
    );
    const feats: GeoJSON.Feature<GeoJSON.Point>[] = [];
    for (const { name, coords } of lines) {
        const n = coords.length;
        const step = Math.max(1, Math.floor(n / perLine));
        for (let i = 0; i < n; i += step) {
            feats.push(turf.point(coords[i], { name }));
        }
        if ((n - 1) % step !== 0) {
            feats.push(turf.point(coords[n - 1], { name }));
        }
    }
    return turf.featureCollection(feats);
}

/**
 * Metro tentacle candidates as dense sample points (tagged with the line name).
 * The hider's answer (hiderifyTentacles) picks the nearest sample point → its
 * line is the nearest LINE. Exported for that grading path.
 */
export async function findMetroTentacleCandidates(
    centerLat: number,
    centerLng: number,
    radius: number,
    unit: Units,
): Promise<GeoJSON.FeatureCollection<GeoJSON.Point>> {
    const lines = await fetchReachableMetroLines(centerLat, centerLng, radius, unit);
    return metroSamplePoints(lines);
}

/** Group Voronoi cells by their site's line name and union each group into one
 *  region — the dense per-sample-point Voronoi collapses to one polygon per
 *  metro LINE. */
function unionVoronoiByName(
    voronoi: GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon>,
): Map<string, GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>> {
    const groups = new Map<
        string,
        GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>[]
    >();
    for (const f of voronoi.features) {
        const name = (f.properties as any)?.site?.properties?.name;
        if (typeof name !== "string") continue;
        const arr = groups.get(name);
        if (arr) arr.push(f);
        else groups.set(name, [f]);
    }
    const out = new Map<
        string,
        GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>
    >();
    for (const [name, group] of groups) {
        let region: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon> | null =
            group[0];
        if (group.length > 1) {
            try {
                region =
                    (safeUnion(
                        turf.featureCollection(group),
                    ) as GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>) ??
                    group[0];
            } catch {
                region = group[0];
            }
        }
        if (region) out.set(name, region);
    }
    return out;
}

/**
 * The metro reach partitioned into ONE region per LINE (nearest-line Voronoi),
 * each clipped to the reach circle. The SINGLE producer used by the configure
 * preview, the elimination, and the draft planning overlay — so all three agree.
 */
export async function computeMetroReachCells(
    centerLat: number,
    centerLng: number,
    radius: number,
    unit: Units,
): Promise<
    Array<{
        cell: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>;
        name: string;
    }>
> {
    const lines = await fetchReachableMetroLines(centerLat, centerLng, radius, unit);
    if (lines.length === 0) return [];
    let reach: GeoJSON.Feature<GeoJSON.Polygon>;
    try {
        reach = turf.circle([centerLng, centerLat], radius, {
            units: unit,
            steps: 64,
        }) as GeoJSON.Feature<GeoJSON.Polygon>;
    } catch {
        return [];
    }
    if (lines.length === 1) return [{ cell: reach, name: lines[0].name }];
    const pts = metroSamplePoints(lines);
    if (pts.features.length < 2) return [];
    let voronoi: GeoJSON.FeatureCollection<
        GeoJSON.Polygon | GeoJSON.MultiPolygon
    >;
    try {
        voronoi = geoSpatialVoronoi(pts);
    } catch {
        return [];
    }
    const regionByName = unionVoronoiByName(voronoi);
    const cells: Array<{
        cell: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>;
        name: string;
    }> = [];
    for (const [name, region] of regionByName) {
        try {
            const clipped = turf.intersect(
                turf.featureCollection([region as any, reach as any]),
            );
            if (clipped)
                cells.push({
                    cell: clipped as GeoJSON.Feature<
                        GeoJSON.Polygon | GeoJSON.MultiPolygon
                    >,
                    name,
                });
        } catch {
            /* skip this line's cell */
        }
    }
    return cells;
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

    // v1233: metro uses the nearest-LINE partition — pick the answer line's
    // region (already clipped to the reach circle) and keep it. Same producer
    // as the preview + planning overlay, so the cut matches what the seeker saw.
    if (question.locationType === "metro") {
        const cells = await computeMetroReachCells(
            question.lat,
            question.lng,
            question.radius,
            question.unit,
        );
        const answerName = (question.location as any)?.properties?.name;
        const region = cells.find((c) => c.name === answerName)?.cell;
        if (!region) return mapData;
        return turf.intersect(
            turf.featureCollection([safeUnion(mapData), region as any]),
        );
    }

    // (metro handled above)
    const rawPoints =
        question.locationType === "custom"
            ? turf.featureCollection(question.places)
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
    // v1233: metro draft overlay draws the per-LINE region boundaries (from the
    // shared nearest-line partition), not a mesh of centroid cells.
    if (question.locationType === "metro") {
        const cells = await computeMetroReachCells(
            question.lat,
            question.lng,
            question.radius,
            question.unit,
        );
        if (cells.length === 0) return null;
        const lineFeats = cells.flatMap((c) => {
            const l = turf.polygonToLine(c.cell as any);
            return l.type === "FeatureCollection" ? l.features : [l];
        });
        return turf.combine(turf.featureCollection(lineFeats as any));
    }

    // (metro handled above)
    const rawPoints =
        question.locationType === "custom"
            ? turf.featureCollection(question.places)
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
