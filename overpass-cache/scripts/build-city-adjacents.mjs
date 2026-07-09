/**
 * OFFLINE GENERATOR — a FIXED transit-reach adjacent set per curated city.
 *
 * The wizard's live adjacency (`playAreaExtensions.ts`) picks neighbours by
 * ADMIN adjacency + a bbox transit flag. Topic 2 replaced that idea with
 * TRANSIT REACH: "everywhere the city's subway / light-rail / commuter-train /
 * tram / ferry / bus network actually runs" → the municipalities those stops
 * land in. That logic was prototyped + eyeballed city-by-city in the in-app
 * `/debug/adjacency` tool (`src/maps/api/transitReach.ts`).
 *
 * Rather than run that heavy selection at wizard time, we PRECOMPUTE it here,
 * ONCE, offline, and bake the result — a fixed `adjacentRelationIds: number[]`
 * — onto each city in `world-cities.json`. The worker then caches exactly those
 * relations and the wizard READS the stored set (no runtime Overpass, no
 * runtime selection). This script IS the generator; the debug tool stays the
 * review surface. It is a faithful node port of `findTransitReachCandidates` +
 * its helpers (kept in sync BY HAND — same coupling as `build-world-cities.mjs`
 * porting `rankPlayAreaResults`).
 *
 * Defaults mirror the settings validated in the debug tool (radius 40 km, all
 * six game transit modes, primary's own admin level, min 2 stops, area cap 10×
 * the primary, min density 0.2 stops/km², contiguous-only). All overridable.
 *
 * Usage (run on a machine that can reach Overpass — CI/sandbox egress blocks
 * it):
 *   node scripts/build-city-adjacents.mjs [--limit N] [--only <name|relId,…>]
 *        [--skip-existing] [--radius 40] [--level auto|6|7|8]
 *        [--kinds subway,light_rail,commuter,tram,ferry,bus]
 *        [--min-stops 2] [--max-area-ratio 10] [--min-density 0.2]
 *        [--no-contiguous] [--concurrency 4] [--delay-ms 600]
 *        [--out world-cities.json] [--email you@example.com]
 *
 *   --limit N          process the first N cities in the file (population
 *                      order). Omit = all.
 *   --only <list>      process ONLY these cities (comma list of names or
 *                      relation ids), e.g. --only Helsinki,913067.
 *   --skip-existing    skip cities that already carry adjacentRelationIds
 *                      (resume a partial run without recomputing).
 *   --level auto|N     candidate admin_level. auto = the primary's own level
 *                      (default). A coarser N (6 county / 7 / 8 city) yields
 *                      fewer, larger adjacents.
 *   --kinds <list>     transit modes to follow. Default = all six.
 *   --min-stops N      drop candidates with < N reached stops (default 2).
 *   --max-area-ratio X drop candidates bigger than X× the primary — a
 *                      country-agnostic "not a whole province" cap (default 10).
 *   --min-density D    drop candidates below D stops/km² — a sparse region is a
 *                      poor hiding area (default 0.2).
 *   --no-contiguous    keep isolated reached districts (default: contiguous
 *                      blob touching the primary only).
 *   --concurrency N    parallel candidate-boundary fetches (default 4).
 *   --delay-ms N       pause between cities to be polite to Overpass (600).
 *   --out FILE         output file (default world-cities.json, in place).
 *
 * Writes each processed entry's `adjacentRelationIds` (sorted, deduped). The
 * file is otherwise preserved (merge, not replace).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
    area,
    booleanIntersects,
    booleanPointInPolygon,
    intersect,
} from "@turf/turf";
import osmtogeojson from "osmtogeojson";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..");

// ── args ──────────────────────────────────────────────────────────────
function arg(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    if (i === -1) return fallback;
    const next = process.argv[i + 1];
    if (!next || next.startsWith("--")) return true; // boolean flag
    return next;
}
const LIMIT = arg("limit", false) ? parseInt(arg("limit"), 10) : Infinity;
const ONLY = arg("only", false)
    ? String(arg("only"))
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean)
    : null;
const SKIP_EXISTING = !!arg("skip-existing", false);
const RADIUS_KM = parseFloat(arg("radius", "40")) || 40;
const LEVEL = String(arg("level", "auto"));
const KINDS = String(
    arg("kinds", "subway,light_rail,commuter,tram,ferry,bus"),
)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const MIN_STOPS = parseInt(arg("min-stops", "2"), 10);
const MAX_AREA_RATIO = parseFloat(arg("max-area-ratio", "10")) || 10;
const MIN_DENSITY = parseFloat(arg("min-density", "0.2"));
const CONTIGUOUS = !arg("no-contiguous", false);
const CONCURRENCY = parseInt(arg("concurrency", "4"), 10) || 4;
const DELAY_MS = parseInt(arg("delay-ms", "600"), 10);
const OUT = resolve(PKG_ROOT, String(arg("out", "world-cities.json")));
const EMAIL = String(arg("email", "worldcities@example.com"));
const UA = `JetLagHideAndSeek-adjacents/1.0 (${EMAIL})`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Overpass ──────────────────────────────────────────────────────────
const OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.osm.ch/api/interpreter",
];
let endpointIdx = 0;

async function overpass(query, tries = 4) {
    let lastErr;
    for (let attempt = 0; attempt < tries; attempt++) {
        const url = OVERPASS_ENDPOINTS[endpointIdx % OVERPASS_ENDPOINTS.length];
        try {
            const res = await fetch(url, {
                method: "POST",
                headers: {
                    "User-Agent": UA,
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                body: "data=" + encodeURIComponent(query),
            });
            const text = await res.text();
            if (!res.ok) throw new Error(`Overpass ${res.status}`);
            // Soft-failure ("remark: runtime error … timed out") — retry on a
            // different mirror rather than treat the empty/truncated body as
            // real (same sniff as the client's overpassAbort.ts).
            if (/"remark":\s*"[^"]*(?:timed out|out of memory)/i.test(text)) {
                throw new Error("Overpass soft-timeout (remark)");
            }
            return JSON.parse(text);
        } catch (e) {
            lastErr = e;
            endpointIdx++; // rotate mirror
            await sleep(1500 * (attempt + 1));
        }
    }
    throw lastErr ?? new Error("Overpass failed");
}

// ── boundary polygon (out geom → osmtogeojson) ──────────────────────────
async function fetchBoundary(relationId) {
    const q = `[out:json][timeout:120];relation(${relationId});out geom;`;
    let json;
    try {
        json = await overpass(q);
    } catch {
        return null;
    }
    const elements = json?.elements;
    if (!Array.isArray(elements)) return null;
    // Ensure the relation carries boundary tags so osmtogeojson stitches
    // rings instead of emitting raw LineStrings (mirrors polygonsOsmFr.ts).
    const annotated = {
        elements: elements.map((el) =>
            el?.type === "relation" && el?.id === relationId
                ? {
                      ...el,
                      tags: {
                          type: "boundary",
                          boundary: "administrative",
                          ...(el.tags ?? {}),
                      },
                  }
                : el,
        ),
    };
    let fc;
    try {
        fc = osmtogeojson(annotated);
    } catch {
        return null;
    }
    for (const f of fc.features ?? []) {
        const g = f.geometry;
        if (g?.type === "Polygon" || g?.type === "MultiPolygon") return g;
    }
    return null;
}

async function fetchAdminLevel(relationId) {
    const q = `[out:json][timeout:60];relation(${relationId});out tags;`;
    try {
        const json = await overpass(q);
        const rel = (json.elements ?? []).find((e) => e.type === "relation");
        return rel?.tags?.admin_level ?? null;
    } catch {
        return null;
    }
}

// ── transit-reach queries (ported from transitReach.ts) ─────────────────
function buildRailNetworkStopsQuery(lat, lng, radiusKm, kinds) {
    const r = Math.round(radiusKm * 1000);
    const around = `(around:${r},${lat},${lng})`;
    const sel = [];
    if (kinds.includes("subway"))
        sel.push(`relation["route"="subway"]${around};`);
    if (kinds.includes("light_rail"))
        sel.push(`relation["route"="light_rail"]${around};`);
    if (kinds.includes("tram")) sel.push(`relation["route"="tram"]${around};`);
    if (kinds.includes("ferry"))
        sel.push(`relation["route"="ferry"]${around};`);
    if (kinds.includes("bus")) sel.push(`relation["route"="bus"]${around};`);
    if (kinds.includes("commuter"))
        sel.push(
            `relation["route"="train"]["service"!~"^(long_distance|high_speed|night|car|car_shuttle)$"]${around};`,
        );
    return `
[out:json][timeout:120];
(
${sel.join("\n")}
)->.routes;
node(r.routes);
out;
`;
}

function buildAdjacentAdminQuery(adminLevel, lat, lng, radiusKm) {
    return `
[out:json][timeout:60];
relation["admin_level"="${adminLevel}"]["type"="boundary"](around:${radiusKm * 1000},${lat},${lng});
out tags bb;
`;
}

function buildLocalAdminBandQuery(lat, lng, radiusKm) {
    return `
[out:json][timeout:60];
relation["admin_level"~"^[678]$"]["type"="boundary"]["boundary"="administrative"](around:${radiusKm * 1000},${lat},${lng});
out tags bb;
`;
}

async function fetchRailStops(lat, lng, radiusKm, kinds) {
    let json;
    try {
        json = await overpass(
            buildRailNetworkStopsQuery(lat, lng, radiusKm, kinds),
        );
    } catch {
        return [];
    }
    const stops = [];
    for (const el of json.elements ?? []) {
        if (el.type !== "node") continue;
        if (typeof el.lat !== "number" || typeof el.lon !== "number") continue;
        stops.push({ lat: el.lat, lon: el.lon, kind: inferStopKind(el.tags) });
    }
    return stops;
}

function inferStopKind(tags) {
    if (!tags) return "commuter";
    if (tags.station === "subway" || tags.subway === "yes") return "subway";
    if (tags.light_rail === "yes" || tags.station === "light_rail")
        return "light_rail";
    if (tags.railway === "tram_stop" || tags.tram === "yes") return "tram";
    if (tags.amenity === "ferry_terminal" || tags.ferry === "yes")
        return "ferry";
    if (tags.highway === "bus_stop" || tags.bus === "yes") return "bus";
    return "commuter";
}

async function fetchAdminCandidates(primaryLevel, lat, lng, radiusKm) {
    const isNumeric =
        typeof primaryLevel === "string" && /^\d+$/.test(primaryLevel);
    const query = isNumeric
        ? buildAdjacentAdminQuery(primaryLevel, lat, lng, radiusKm)
        : buildLocalAdminBandQuery(lat, lng, radiusKm);
    let json;
    try {
        json = await overpass(query);
    } catch {
        return [];
    }
    const out = [];
    for (const el of json.elements ?? []) {
        if (el.type !== "relation" || typeof el.id !== "number") continue;
        if (!el.bounds) continue;
        const name =
            el.tags?.name ||
            el.tags?.["name:en"] ||
            el.tags?.official_name ||
            `r${el.id}`;
        const b = el.bounds;
        const ext = [b.maxlat, b.minlon, b.minlat, b.maxlon];
        out.push({
            id: el.id,
            name,
            adminLevel: el.tags?.admin_level ?? null,
            areaKm2: bboxAreaKm2(b),
            extent: ext,
            lat: (b.minlat + b.maxlat) / 2,
            lng: (b.minlon + b.maxlon) / 2,
        });
    }
    return out;
}

// ── geometry helpers (ported) ───────────────────────────────────────────
function bboxAreaKm2(b) {
    const midLat = (b.minlat + b.maxlat) / 2;
    const latKm = Math.abs(b.maxlat - b.minlat) * 111;
    const lngKm =
        Math.abs(b.maxlon - b.minlon) * 111 * Math.cos((midLat * Math.PI) / 180);
    return latKm * lngKm * 0.55;
}

function haversineKm(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLng = ((lng2 - lng1) * Math.PI) / 180;
    const la1 = (lat1 * Math.PI) / 180;
    const la2 = (lat2 * Math.PI) / 180;
    const x =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
}

function polygonExtent(geom) {
    let minLat = Infinity,
        maxLat = -Infinity,
        minLng = Infinity,
        maxLng = -Infinity;
    const rings = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
    for (const poly of rings) {
        for (const [lng, lat] of poly[0] ?? []) {
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
            if (lng < minLng) minLng = lng;
            if (lng > maxLng) maxLng = lng;
        }
    }
    return [maxLat, minLng, minLat, maxLng];
}

function extentAreaKm2(ext) {
    const [maxLat, minLng, minLat, maxLng] = ext;
    const midLat = (minLat + maxLat) / 2;
    const latKm = Math.abs(maxLat - minLat) * 111;
    const lngKm =
        Math.abs(maxLng - minLng) * 111 * Math.cos((midLat * Math.PI) / 180);
    return latKm * lngKm * 0.55;
}

function truePolyAreaKm2(poly) {
    try {
        const m2 = area({ type: "Polygon", coordinates: poly });
        if (Number.isFinite(m2) && m2 > 0) return m2 / 1e6;
    } catch {
        /* fall through */
    }
    return extentAreaKm2(polygonExtent({ type: "Polygon", coordinates: poly }));
}

function largestComponentCentre(geom) {
    const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
    let best = polys[0] ?? [];
    let bestArea = -Infinity;
    for (const poly of polys) {
        const a = truePolyAreaKm2(poly);
        if (a > bestArea) {
            bestArea = a;
            best = poly;
        }
    }
    const [maxLat, minLng, minLat, maxLng] = polygonExtent({
        type: "Polygon",
        coordinates: best,
    });
    return { lat: (maxLat + minLat) / 2, lng: (minLng + maxLng) / 2 };
}

function bboxesNear(a, b, gapDeg = 0.03) {
    const [aN, aW, aS, aE] = a;
    const [bN, bW, bS, bE] = b;
    const lngOk = !(bW > aE + gapDeg || aW > bE + gapDeg);
    const latOk = !(bS > aN + gapDeg || aS > bN + gapDeg);
    return lngOk && latOk;
}

function dropFarExclaves(geom) {
    if (geom.type !== "MultiPolygon" || geom.coordinates.length <= 1)
        return geom;
    const parts = geom.coordinates.map((poly) => {
        const ext = polygonExtent({ type: "Polygon", coordinates: poly });
        return { poly, ext, area: truePolyAreaKm2(poly) };
    });
    const largest = parts.reduce((a, b) => (b.area > a.area ? b : a));
    const MIN_FRACTION = 0.15;
    const kept = parts.filter(
        (p) =>
            p === largest ||
            p.area >= MIN_FRACTION * largest.area ||
            bboxesNear(p.ext, largest.ext, 0.05),
    );
    if (kept.length === geom.coordinates.length) return geom;
    return { type: "MultiPolygon", coordinates: kept.map((k) => k.poly) };
}

function fillHoles(poly) {
    if (poly.type === "Polygon")
        return { type: "Polygon", coordinates: [poly.coordinates[0]] };
    return {
        type: "MultiPolygon",
        coordinates: poly.coordinates.map((p) => [p[0]]),
    };
}

function centreInside(c, k) {
    const [maxLat, minLng, minLat, maxLng] = c.extent;
    const pt = [(minLng + maxLng) / 2, (minLat + maxLat) / 2];
    if (k.polygon) {
        try {
            return booleanPointInPolygon(pt, {
                type: "Feature",
                properties: {},
                geometry: fillHoles(k.polygon),
            });
        } catch {
            /* fall through */
        }
    }
    const [kMaxLat, kMinLng, kMinLat, kMaxLng] = k.extent;
    return (
        pt[0] >= kMinLng &&
        pt[0] <= kMaxLng &&
        pt[1] >= kMinLat &&
        pt[1] <= kMaxLat
    );
}

function bboxIoU(a, b) {
    const [aN, aW, aS, aE] = a;
    const [bN, bW, bS, bE] = b;
    const iS = Math.max(aS, bS);
    const iN = Math.min(aN, bN);
    const iW = Math.max(aW, bW);
    const iE = Math.min(aE, bE);
    if (iN <= iS || iE <= iW) return 0;
    const inter = (iN - iS) * (iE - iW);
    const areaA = (aN - aS) * (aE - aW);
    const areaB = (bN - bS) * (bE - bW);
    const union = areaA + areaB - inter;
    return union > 0 ? inter / union : 0;
}

const CANDIDATE_SUFFIX_RE =
    /\b(county|kommun|comune|gemeinde|municipality|parish|borough)\b/i;

function dedupeNested(candidates) {
    const bySizeDesc = [...candidates].sort((a, b) => b.areaKm2 - a.areaKm2);
    const suffixed = (n) => CANDIDATE_SUFFIX_RE.test(n);
    const kept = [];
    for (const c of bySizeDesc) {
        const container = kept.find(
            (k) => k.areaKm2 > c.areaKm2 * 1.25 && centreInside(c, k),
        );
        if (container) continue;
        const dupeIdx = kept.findIndex(
            (k) => bboxIoU(k.extent, c.extent) >= 0.75,
        );
        if (dupeIdx !== -1) {
            const incumbent = kept[dupeIdx];
            if (suffixed(incumbent.name) && !suffixed(c.name)) {
                kept[dupeIdx] = { ...c, stopCount: incumbent.stopCount };
            }
            continue;
        }
        kept.push(c);
    }
    kept.sort((a, b) => b.stopCount - a.stopCount || a.distanceKm - b.distanceKm);
    return kept;
}

function filterContiguous(cands, primaryFeature) {
    if (cands.length === 0) return cands;
    const n = cands.length;
    const seed = cands.map((c) => {
        if (!c.polygon) return false;
        try {
            return booleanIntersects(primaryFeature, {
                type: "Feature",
                properties: {},
                geometry: c.polygon,
            });
        } catch {
            return false;
        }
    });
    const adj = Array.from({ length: n }, () => []);
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            if (bboxesNear(cands[i].extent, cands[j].extent)) {
                adj[i].push(j);
                adj[j].push(i);
            }
        }
    }
    const seen = new Set();
    const queue = [];
    for (let i = 0; i < n; i++) {
        if (seed[i]) {
            seen.add(i);
            queue.push(i);
        }
    }
    if (seen.size === 0) return cands;
    while (queue.length) {
        const u = queue.shift();
        for (const v of adj[u]) {
            if (!seen.has(v)) {
                seen.add(v);
                queue.push(v);
            }
        }
    }
    return cands.filter((_, i) => seen.has(i));
}

// ── core: transit-reach for one city ────────────────────────────────────
async function findAdjacents(city) {
    const primaryOsmId = city.relationId;
    const rawPrimary = await fetchBoundary(primaryOsmId);
    if (!rawPrimary) {
        return { ids: [], names: [], note: "no primary boundary" };
    }
    const primaryPolygon = dropFarExclaves(rawPrimary);
    const { lat, lng } = largestComponentCentre(rawPrimary);

    const primaryLevel =
        LEVEL === "auto" ? await fetchAdminLevel(primaryOsmId) : LEVEL;

    const [stops, adminCandidates] = await Promise.all([
        fetchRailStops(lat, lng, RADIUS_KM, KINDS),
        fetchAdminCandidates(primaryLevel, lat, lng, RADIUS_KM),
    ]);
    if (stops.length === 0) {
        return { ids: [], names: [], note: "0 stops (check centroid/kinds)" };
    }

    const primaryFeature = {
        type: "Feature",
        properties: {},
        geometry: primaryPolygon,
    };
    const primaryAreaKm2 = extentAreaKm2(polygonExtent(primaryPolygon));

    const mostlyInsidePrimary = (candPoly) => {
        try {
            const cand = { type: "Feature", properties: {}, geometry: candPoly };
            const inter = intersect({
                type: "FeatureCollection",
                features: [primaryFeature, cand],
            });
            if (!inter) return false;
            const candArea = area(cand);
            if (candArea <= 0) return false;
            return area(inter) / candArea > 0.9;
        } catch {
            return false;
        }
    };

    const candidates = [];
    let idx = 0;
    const runNext = async () => {
        while (idx < adminCandidates.length) {
            const cand = adminCandidates[idx++];
            if (cand.id === primaryOsmId) continue;
            const [maxLat, minLng, minLat, maxLng] = cand.extent;
            const bboxStops = stops.filter(
                (s) =>
                    s.lat >= minLat &&
                    s.lat <= maxLat &&
                    s.lon >= minLng &&
                    s.lon <= maxLng,
            );
            if (bboxStops.length === 0) continue;
            let poly = await fetchBoundary(cand.id);
            if (poly) poly = dropFarExclaves(poly);
            if (poly && mostlyInsidePrimary(poly)) continue;
            let inside = bboxStops;
            if (poly) {
                const feature = { type: "Feature", properties: {}, geometry: poly };
                inside = bboxStops.filter((s) => {
                    try {
                        return booleanPointInPolygon([s.lon, s.lat], feature);
                    } catch {
                        return false;
                    }
                });
            }
            if (inside.length === 0) continue;
            const kindSet = new Set();
            for (const s of inside) kindSet.add(s.kind);
            const cleanExt = poly ? polygonExtent(poly) : cand.extent;
            let realAreaKm2 = poly ? extentAreaKm2(cleanExt) : cand.areaKm2;
            if (poly) {
                try {
                    const a =
                        area({
                            type: "Feature",
                            properties: {},
                            geometry: poly,
                        }) / 1e6;
                    if (a > 0) realAreaKm2 = a;
                } catch {
                    /* keep bbox estimate */
                }
            }
            candidates.push({
                relationId: cand.id,
                name: cand.name,
                stopCount: inside.length,
                distanceKm: haversineKm(lat, lng, cand.lat, cand.lng),
                kinds: [...kindSet],
                areaKm2: poly ? extentAreaKm2(cleanExt) : cand.areaKm2,
                stopsPerKm2: realAreaKm2 > 0 ? inside.length / realAreaKm2 : 0,
                adminLevel: cand.adminLevel,
                extent: cleanExt,
                polygon: poly,
            });
        }
    };
    await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, adminCandidates.length) }, () =>
            runNext(),
        ),
    );

    candidates.sort(
        (a, b) => b.stopCount - a.stopCount || a.distanceKm - b.distanceKm,
    );

    // Client-side filters (min-stops / density / area cap), then dedup +
    // contiguity — exactly the debug-tool pipeline at the validated defaults.
    let sized = candidates.filter(
        (c) => c.stopCount >= MIN_STOPS && c.stopsPerKm2 >= MIN_DENSITY,
    );
    if (primaryAreaKm2 > 0) {
        sized = sized.filter((c) => c.areaKm2 <= MAX_AREA_RATIO * primaryAreaKm2);
    }
    let finalCandidates = dedupeNested(sized);
    if (CONTIGUOUS) {
        finalCandidates = filterContiguous(finalCandidates, primaryFeature);
    }

    const ids = [...new Set(finalCandidates.map((c) => c.relationId))].sort(
        (a, b) => a - b,
    );
    return { ids, names: finalCandidates.map((c) => c.name), note: null };
}

// ── driver ──────────────────────────────────────────────────────────────
function selectCities(all) {
    let list = all;
    if (ONLY) {
        list = all.filter(
            (c) =>
                ONLY.includes(String(c.relationId)) ||
                ONLY.includes((c.name ?? "").toLowerCase()),
        );
    }
    if (SKIP_EXISTING) {
        list = list.filter(
            (c) =>
                !Array.isArray(c.adjacentRelationIds) ||
                c.adjacentRelationIds.length === 0,
        );
    }
    if (Number.isFinite(LIMIT)) list = list.slice(0, LIMIT);
    return list;
}

async function main() {
    const all = JSON.parse(readFileSync(OUT, "utf8"));
    const byRel = new Map(all.map((c) => [c.relationId, c]));
    const targets = selectCities(all);
    console.log(
        `[adjacents] ${targets.length}/${all.length} cities · radius=${RADIUS_KM}km level=${LEVEL} kinds=${KINDS.join("+")} minStops=${MIN_STOPS} maxAreaRatio=${MAX_AREA_RATIO} minDensity=${MIN_DENSITY} contiguous=${CONTIGUOUS}`,
    );

    let done = 0;
    let saved = 0;
    for (const city of targets) {
        done++;
        const label = `${done}/${targets.length} ${city.name} (r${city.relationId})`;
        try {
            const { ids, names, note } = await findAdjacents(city);
            const entry = byRel.get(city.relationId);
            entry.adjacentRelationIds = ids;
            if (note) {
                console.log(`  ⚠ ${label}: ${ids.length} adjacents — ${note}`);
            } else {
                console.log(
                    `  ✓ ${label}: ${ids.length} adjacents [${names.slice(0, 8).join(", ")}${names.length > 8 ? ", …" : ""}]`,
                );
            }
            // Incremental save every 5 cities so a long run survives a crash.
            if (++saved % 5 === 0) writeFileSync(OUT, JSON.stringify(all, null, 2) + "\n");
        } catch (e) {
            console.warn(`  ✗ ${label}: ${e instanceof Error ? e.message : e}`);
        }
        await sleep(DELAY_MS);
    }

    writeFileSync(OUT, JSON.stringify(all, null, 2) + "\n");
    console.log(`[adjacents] wrote ${OUT} (${done} cities processed)`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
