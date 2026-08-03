import * as turf from "@turf/turf";

import {
    additionalMapGeoLocations,
    hiderMode,
    mapGeoLocation,
} from "@/lib/context";
import { lastMetroDiag } from "@/lib/debugState";
import { haversineMeters } from "@/lib/geo";
import { metroReachCellsViaWorker } from "@/lib/geometry/client";
import {
    computeMetroReachCellsFromLines,
    type MetroLine,
    type MetroReachCell,
    type MetroReachResult,
} from "@/maps/questions/metroReach";
import { safeJsonFromCachedResponse } from "@/maps/api/cache";
import { METRO_BY_RELATION_BASE } from "@/maps/api/constants";
import { referenceExtent } from "@/maps/api/playAreaPrefetch";
import { fetchSubwayRouteRelations } from "@/maps/api/transitRoutes";
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
 *  worker (`metroRoutesQuery` in overpass-cache/src/index.ts) AND the laptop
 *  prewarmer byte-for-byte so the R2 cache hits.
 *
 *  This reads line NAMES + relation ids only (`out tags geom` → no members, so
 *  no geometry — that's fine). The metro tentacle sources the LINE GEOMETRY
 *  from the prewarmed transit subway shard instead (v1236,
 *  `fetchSubwayRouteRelations`), joined to these names by relation id — so we
 *  never needed member geometry here and this query is UNCHANGED (no cache
 *  orphan / re-warm). */
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
                // Names only — the metro endpoint carries the line names +
                // relation ids (no geometry; geometry comes from the transit
                // shard, joined by id). Non-empty = usable.
                if (Array.isArray(els) && els.length > 0) return json;
                // Empty = miss/no-boundary. Warm in the background and fall
                // through to the live bbox query so the user still gets names.
                requestWarmMetro(relId);
            }
        } catch {
            /* network issue → fall through */
        }
    }
    const tuple = playAreaBboxTuple();
    if (!tuple) return null;
    return await getOverpassData(metroRoutesQuery(tuple));
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
// v1263: the pure metro Voronoi geometry (sampling / partition / union) moved to
// `metroReach.ts` so it can run in the geometry Web Worker (off the main thread —
// it was a multi-second block for a dense metro that stuttered the configure
// dialog). This file keeps the FETCH + the diagnostic-atom write.

/** OSM `colour` → a MapLibre-usable colour string, else undefined. Accepts hex
 *  (`#FF6319` / `FF6319`) and passes through CSS colour names verbatim. */
function normalizeLineColor(c: unknown): string | undefined {
    if (typeof c !== "string") return undefined;
    const s = c.trim();
    if (!s) return undefined;
    if (/^#?[0-9a-fA-F]{6}$/.test(s)) return s.startsWith("#") ? s : `#${s}`;
    if (/^#?[0-9a-fA-F]{3}$/.test(s)) return s.startsWith("#") ? s : `#${s}`;
    return s; // named colour ("red") / rgb() — MapLibre accepts CSS colours
}

/** v1254/v1255: fold express variants into their base service. NYC tags the
 *  express service with the diamond notation — the SAME line as its local (`6`
 *  vs `<6>`): same track, same colour, drawn as ONE line in Google Maps (the
 *  rulebook's reference standard). OSM encodes that diamond variously — ASCII
 *  `<6>` or the actual diamond glyph (◇/◆/♦) — so strip all of those forms.
 *
 *  Deliberately NOT more aggressive: this is the ONLY safe cross-network fold.
 *  Line grouping is already by `ref`, and almost every network gives one line a
 *  single `ref` across its direction/branch/terminal relations (so those are
 *  already merged). The things that LOOK like mergeable variants are genuinely
 *  DISTINCT lines that must not be merged — Paris `3bis`/`7bis` (separate short
 *  lines), Berlin `S41`/`S42` (the two Ringbahn directions), `S1`/`S2`, RER
 *  branch refs — so we do not touch digits, `bis`, or branch suffixes. */
function normalizeMetroLabel(s: string): string {
    return s.replace(/[<>◇◆♦]/g, "").trim();
}

/** The line LABEL for a route relation — prefer the short `ref` ("A", "1", "L")
 *  so all of a line's direction/variant relations GROUP into ONE line, instead
 *  of splitting on variant-specific names ("A: Inwood – Far Rockaway"). Falls
 *  back to the name where no ref is tagged. From `labelById` (join by id, shard
 *  path) or the element's own tags (live path). */
function metroLabelOf(
    el: any,
    labelById: Map<number, string>,
): string | undefined {
    if (typeof el.id === "number") {
        const l = labelById.get(el.id);
        if (l) return normalizeMetroLabel(l);
    }
    const raw =
        (typeof el.tags?.ref === "string" ? el.tags.ref : undefined) ??
        (typeof el.tags?.["name:en"] === "string"
            ? el.tags["name:en"]
            : undefined) ??
        (typeof el.tags?.name === "string" ? el.tags.name : undefined);
    return typeof raw === "string" ? normalizeMetroLabel(raw) : undefined;
}

/** Build per-LINE coords (grouped by label/`ref`) from route-relation elements,
 *  reach-filtered. Label + colour come from `labelById`/`colorById` (shard path,
 *  join by id) or the element's own tags (live path). Coords merge by label — a
 *  line's directions/variants share a ref. Returns the lines + counts. */
function extractMetroLines(
    elements: any[],
    labelById: Map<number, string>,
    colorById: Map<number, string>,
    centerLat: number,
    centerLng: number,
    radiusMeters: number,
): { lines: MetroLine[]; rels: number; withGeom: number; outOfRange: number } {
    const coordsByName = new Map<string, [number, number][]>();
    const segmentsByName = new Map<string, [number, number][][]>();
    const colorByName = new Map<string, string>();
    let rels = 0;
    let withGeom = 0;
    for (const el of elements) {
        if (el?.type !== "relation") continue;
        rels++;
        const name = metroLabelOf(el, labelById);
        if (!name) continue;
        const color =
            (typeof el.id === "number" ? colorById.get(el.id) : undefined) ??
            normalizeLineColor(el.tags?.colour ?? el.tags?.color);
        if (color && !colorByName.has(name)) colorByName.set(name, color);
        const coords: [number, number][] = []; // flat — sampling + reach filter
        const segments: [number, number][][] = []; // per-way — drawing
        for (const m of el.members ?? []) {
            if (m?.type !== "way" || !Array.isArray(m.geometry)) continue;
            const seg: [number, number][] = [];
            for (const p of m.geometry) {
                if (typeof p.lat === "number" && typeof p.lon === "number") {
                    const pt: [number, number] = [p.lon, p.lat];
                    coords.push(pt);
                    seg.push(pt);
                }
            }
            if (seg.length >= 2) segments.push(seg);
        }
        if (coords.length < 2) continue;
        withGeom++;
        const arr = coordsByName.get(name);
        if (arr) arr.push(...coords);
        else coordsByName.set(name, coords);
        const segArr = segmentsByName.get(name);
        if (segArr) segArr.push(...segments);
        else segmentsByName.set(name, segments);
    }
    const lines: MetroLine[] = [];
    let outOfRange = 0;
    for (const [name, coords] of coordsByName) {
        let closest = Infinity;
        for (const c of coords) {
            const d = haversineMeters(centerLat, centerLng, c[1], c[0]);
            if (d < closest) closest = d;
        }
        if (closest > radiusMeters) {
            outOfRange++;
            continue;
        }
        lines.push({
            name,
            coords,
            segments: segmentsByName.get(name) ?? [],
            color: colorByName.get(name),
        });
    }
    return { lines, rels, withGeom, outOfRange };
}

/**
 * Fetch the reachable metro LINES (name + full coords) — "reachable" = the
 * closest point on the line sits within `radius` of the seeker.
 *
 * Line GEOMETRY sources, in order (v1236/v1237):
 *   1. The prewarmed transit SUBWAY shard (`fetchSubwayRouteRelations` →
 *      `out skel geom`, relation id → member geometry), JOINED to the metro
 *      endpoint's line NAMES by relation id. Cached for a warm city → no live
 *      query. (The metro endpoint itself is `out tags geom` = names only, no
 *      members, so it can't supply geometry.)
 *   2. If the shard is empty/sparse for this area (the NYC case — the US subway
 *      transit shard wasn't warmed, so it yielded 1 relation), fall back to a
 *      LIVE `relation[route=subway][name]; out geom;` query, which returns
 *      names + geometry together. It's cached by the interpreter after first
 *      use (a normal cold fetch, NOT a prewarm re-warm) and uses a DIFFERENT
 *      query key than `/api/metro`, so it never orphans that cache.
 */
async function fetchReachableMetroLines(
    centerLat: number,
    centerLng: number,
    radius: number,
    unit: Units,
): Promise<MetroLine[]> {
    const radiusMeters = turf.convertLength(radius, unit, "meters");

    // Metro endpoint: relation id → line LABEL (`ref` preferred so variants
    // group into one line) + colour. No geometry (out tags geom).
    let metroData: any;
    try {
        metroData = await fetchMetroRoutesData();
    } catch {
        metroData = null;
    }
    const labelById = new Map<number, string>();
    const colorById = new Map<number, string>();
    for (const el of metroData?.elements ?? []) {
        if (el?.type !== "relation" || typeof el.id !== "number") continue;
        const label = el.tags?.ref ?? el.tags?.["name:en"] ?? el.tags?.name;
        if (typeof label === "string" && label) labelById.set(el.id, label);
        const color = normalizeLineColor(el.tags?.colour ?? el.tags?.color);
        if (color) colorById.set(el.id, color);
    }

    // 1. Cached transit subway shard, joined to the labels by relation id.
    let shardRels: any[] = [];
    try {
        shardRels = await fetchSubwayRouteRelations();
    } catch {
        shardRels = [];
    }
    let res = extractMetroLines(
        shardRels,
        labelById,
        colorById,
        centerLat,
        centerLng,
        radiusMeters,
    );
    let src = "shard";

    // 2. Live `out geom` fallback when the shard has no usable geometry.
    if (res.lines.length === 0) {
        src = "live";
        const tuple = playAreaBboxTuple();
        if (tuple) {
            let live: any = null;
            try {
                live = await getOverpassData(
                    `\n[out:json][timeout:180][bbox:${tuple}];\nrelation["route"="subway"]["name"];\nout geom;\n`,
                );
            } catch {
                live = null;
            }
            if (live?.elements) {
                res = extractMetroLines(
                    live.elements,
                    labelById,
                    colorById,
                    centerLat,
                    centerLng,
                    radiusMeters,
                );
            }
        }
    }

    setMetroDiag(
        `labels=${labelById.size} src=${src} shardRel=${shardRels.length} rels=${res.rels} withGeom=${res.withGeom} outOfRange=${res.outOfRange} lines=${res.lines.length}`,
    );
    return res.lines;
}

let lastMetroDiagBase = "";
function setMetroDiag(msg: string): void {
    lastMetroDiagBase = msg;
    try {
        lastMetroDiag.set(msg);
        // eslint-disable-next-line no-console
        console.log(`[metro] ${msg}`);
    } catch {
        /* atom set can't fail meaningfully */
    }
}

/**
 * The metro reach partitioned into ONE region per LINE (nearest-line Voronoi),
 * each clipped to the reach circle, PLUS the reachable lines' geometry. The
 * SINGLE producer used by the configure preview, the elimination, and the draft
 * planning overlay — so all three agree.
 *
 * v1263: the heavy geometry (sampling + Voronoi + per-line union) runs in the
 * geometry Web Worker (`computeMetroReachCellsFromLines`) so it never stutters
 * the configure-dialog loading animation — with a synchronous main-thread
 * fallback if the worker is unavailable. This function does the FETCH + writes
 * the diagnostic atom.
 */
// v1264: memoise the last compute. The configure-dialog impact effect re-runs on
// GPS jitter / re-render, firing computeMetroReachCells 3–4× for essentially the
// same position — each a multi-second worker union. Cache the Promise keyed by
// rounded (lat,lng,radius,unit) (~11 m) so those duplicates share ONE compute.
let metroCacheKey = "";
let metroCachePromise: Promise<MetroReachResult> | null = null;

export async function computeMetroReachCells(
    centerLat: number,
    centerLng: number,
    radius: number,
    unit: Units,
): Promise<MetroReachResult> {
    const key = `${centerLat.toFixed(4)},${centerLng.toFixed(4)},${radius},${unit}`;
    if (key === metroCacheKey && metroCachePromise) return metroCachePromise;
    metroCacheKey = key;
    const promise = (async (): Promise<MetroReachResult> => {
        const lines = await fetchReachableMetroLines(
            centerLat,
            centerLng,
            radius,
            unit,
        );
        if (lines.length === 0) return { cells: [], lines: [] };
        let out: { result: MetroReachResult; diag: string } | null = null;
        try {
            out = await metroReachCellsViaWorker<{
                result: MetroReachResult;
                diag: string;
            }>({ lines, centerLat, centerLng, radius, unit });
        } catch {
            // Worker unavailable / errored — compute on the main thread
            // (correctness never depends on the worker existing, only smoothness).
            out = computeMetroReachCellsFromLines(
                lines,
                centerLat,
                centerLng,
                radius,
                unit,
            );
        }
        setMetroDiag(`${lastMetroDiagBase} | ${out.diag}`);
        return out.result;
    })();
    // On failure, drop the cache so a retry recomputes instead of re-throwing.
    metroCachePromise = promise.catch((e) => {
        if (metroCacheKey === key) {
            metroCacheKey = "";
            metroCachePromise = null;
        }
        throw e;
    });
    return metroCachePromise;
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
        const { cells } = await computeMetroReachCells(
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

    // v1244: metro uses the SAME turf.voronoi partition as the preview +
    // elimination (computeMetroReachCells) — find the region containing the
    // hider and answer with its line name, so the answer matches the drawn cut.
    if (question.locationType === "metro") {
        const hider = turf.point([$hiderMode.longitude, $hiderMode.latitude]);
        const location = turf.point([question.lng, question.lat]);
        if (
            turf.distance(hider, location, { units: question.unit }) >
            question.radius
        ) {
            question.location = false;
            return question;
        }
        const { cells } = await computeMetroReachCells(
            question.lat,
            question.lng,
            question.radius,
            question.unit,
        );
        let foundName: string | null = null;
        for (const c of cells) {
            try {
                if (turf.booleanPointInPolygon(hider, c.cell as any)) {
                    foundName = c.name;
                    break;
                }
            } catch {
                /* skip malformed cell */
            }
        }
        // v1247: the hider is within reach of the metro network, so they're
        // always in SOME line's region — but a thin union/clip boundary sliver
        // can leave a point in no cell. Snap to the nearest cell instead of
        // answering "none in range" (which would eliminate the hider's real
        // location), so the answer always matches a drawn region.
        if (!foundName && cells.length > 0) {
            let best = Infinity;
            for (const c of cells) {
                try {
                    const line = turf.polygonToLine(c.cell as any);
                    const d = turf.pointToLineDistance(hider, line as any, {
                        units: "meters",
                    });
                    if (d < best) {
                        best = d;
                        foundName = c.name;
                    }
                } catch {
                    /* skip malformed cell */
                }
            }
        }
        if (!foundName) {
            question.location = false;
            return question;
        }
        question.location = turf.point(
            [$hiderMode.longitude, $hiderMode.latitude],
            { name: foundName },
        ) as any;
        return question;
    }

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
        const { cells } = await computeMetroReachCells(
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
