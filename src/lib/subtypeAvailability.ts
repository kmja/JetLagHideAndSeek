import { useStore } from "@nanostores/react";
import * as turf from "@turf/turf";
import type { Feature, MultiPolygon, Polygon } from "geojson";
import osmtogeojson from "osmtogeojson";
import { useEffect, useMemo, useState } from "react";

import { adminTierToOsmLevel } from "@/lib/adminDivisions";
import { mapGeoLocation, polyGeoJSON } from "@/lib/context";
import { lastSubtypePickerDiag } from "@/lib/debugState";
import { LOCATION_FIRST_TAG } from "@/maps/api";
import { fetchPrewarmedAreaAdmin } from "@/maps/api/adminBoundary";
import { fetchAreaCoastlineLines } from "@/maps/api/coast";
import {
    fetchBorders0Land,
    fetchBorders1States,
    getOverpassData,
} from "@/maps/api/overpass";
import {
    buildHsrQuery,
    countAtLeastInPlayArea,
    type FamilyKey,
    getCachedCategory,
    prefetchCategory,
} from "@/maps/api/playAreaPrefetch";
import { CacheType } from "@/maps/api/types";

/**
 * Minimum number of in-play-area reference instances for a subtype's
 * question to be worth asking:
 *
 *   - matching ("is your nearest ___ the same as mine?") and tentacles
 *     ("which ___ are you nearest to?") are trivial / pointless with
 *     fewer than TWO references — with one, everyone shares it; with
 *     none, there's nothing to match. So they need >= 2.
 *   - measuring ("are you closer to ___ than me?") still works against a
 *     single reference (it's a distance comparison), so it only needs
 *     >= 1; with zero there's nothing to measure to.
 *
 * Categories absent from this map (photo, radius, thermometer) are never
 * gated on instance counts.
 */
const MIN_INSTANCES: Record<string, number> = {
    matching: 2,
    tentacles: 2,
    measuring: 1,
};

/* v1158 DIAGNOSTIC: per-compute wall-clock timings for the last subtype-picker
 * open, accumulated here and folded into `lastSubtypePickerDiag` by the longtask
 * observer. Reset when a picker opens (categoryId changes). */
const subtypeTimings: string[] = [];
async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const t0 = typeof performance !== "undefined" ? performance.now() : 0;
    try {
        return await fn();
    } finally {
        const ms =
            typeof performance !== "undefined"
                ? Math.round(performance.now() - t0)
                : 0;
        subtypeTimings.push(`${label}=${ms}ms`);
    }
}

/**
 * The prefetch family a subtype's reference count can be read from, or
 * null for subtypes whose instances we can't cheaply count — admin
 * divisions / borders, coastline, sea level, transit-line / name-length,
 * landmass, metro lines, and every photo subtype. Those are never
 * auto-disabled. Mirrors the countable branches of `resolveFamily`
 * (NearestReferencePreview / questionImpact) without importing a
 * component into this lib module.
 */
function countableFamily(value: string): FamilyKey | null {
    const stripped = value.replace(/-full$/, "");
    if (stripped === "airport") return "airport";
    if (stripped === "rail-station") return "rail-station";
    if (stripped in LOCATION_FIRST_TAG) {
        return `api:${stripped}` as FamilyKey;
    }
    return null;
}

/* ────────────────── Admin-division span gating (v841) ──────────────── *
 *
 * A "Same <admin division>" matching question can only narrow the map when
 * the play area spans >= 2 DISTINCT regions at that level. In NYC, "Same
 * state" (all of NYC is inside New York State) narrows nothing — everyone
 * shares it — so it's disabled; "Same county" (the 5 boroughs) splits the
 * area, so it's kept. We measure the span by sampling interior points of
 * the play area and counting how many distinct admin regions contain them,
 * reading the PREWARMED admin geometry only (no live Overpass). A cold /
 * unknown span always stays AVAILABLE — we never wrongly hide a question.
 */
// Keyed by `${areaSignature}:${level}` so switching play areas never serves
// another city's span.
const adminSpanCache = new Map<string, number>();
const adminSpanPending = new Set<string>();

/** A stable per-play-area key (primary relation id, else a coarse bbox) so
 *  the admin-span cache is invalidated when the play area changes. */
function areaSignature(): string {
    const p = mapGeoLocation.get()?.properties as
        | { osm_id?: number }
        | undefined;
    if (p?.osm_id) return `r${p.osm_id}`;
    const poly = playAreaPolygon();
    if (!poly) return "none";
    try {
        return (turf.bbox(poly) as number[]).map((n) => n.toFixed(2)).join(",");
    } catch {
        return "none";
    }
}

/** The OSM admin_level a picker `admin-N` tile maps to for the current
 *  play area's country, or null for a non-admin value. */
function adminOsmLevel(value: string): number | null {
    const m = /^admin-([1-4])$/.exec(value);
    if (!m) return null;
    const tier = parseInt(m[1], 10) as 1 | 2 | 3 | 4;
    const iso = (
        mapGeoLocation.get()?.properties as
            | { countrycode?: string }
            | undefined
    )?.countrycode;
    return adminTierToOsmLevel(iso, tier);
}

// v1158: MEMOISE the unioned play-area polygon by the `polyGeoJSON` atom's
// object reference. This function was called as an UN-cached guard in the
// admin-span AND coast effects (+ inside computeAdminSpan / computeBorderPresent)
// and its `turf.union` over a multi-area play area (NYC + adjacents = several
// detailed county boundaries) is ~1 s EACH — so opening a matching/measuring
// subtype picker ran the union 2-4× and blocked the main thread ~2 s (the
// measured `block=[2139] no computes`: the union runs BEFORE the timed computes,
// which then early-return on a cached span, so it never showed as a "compute").
// The union result only changes when `polyGeoJSON` changes (a stable atom ref),
// so ref-equality caching makes it run at most once per play-area change and
// every guard/consumer reuses it.
let playAreaPolyCache: {
    src: unknown;
    poly: Feature<Polygon | MultiPolygon> | null;
} | null = null;

function playAreaPolygon(): Feature<Polygon | MultiPolygon> | null {
    const src = polyGeoJSON.get() as
        | Feature
        | GeoJSON.FeatureCollection
        | null;
    if (playAreaPolyCache && playAreaPolyCache.src === src) {
        return playAreaPolyCache.poly;
    }
    const poly = computePlayAreaPolygon(src);
    playAreaPolyCache = { src, poly };
    return poly;
}

/** Cheap "is there a play-area polygon at all" check for effect GUARDS — avoids
 *  triggering the expensive `turf.union` in `playAreaPolygon()` just to decide
 *  whether to bail (the effects then early-return on a cached span / no gated
 *  values without ever needing the unioned geometry). */
function hasPlayAreaPolygon(): boolean {
    const src = polyGeoJSON.get() as
        | Feature
        | GeoJSON.FeatureCollection
        | null;
    if (!src) return false;
    const isPoly = (g: GeoJSON.Geometry | null | undefined) =>
        !!g && (g.type === "Polygon" || g.type === "MultiPolygon");
    if (src.type === "Feature") return isPoly(src.geometry);
    if (src.type === "FeatureCollection")
        return src.features.some((f) => isPoly(f.geometry));
    return false;
}

function computePlayAreaPolygon(
    src: Feature | GeoJSON.FeatureCollection | null,
): Feature<Polygon | MultiPolygon> | null {
    if (!src) return null;
    if (src.type === "Feature") {
        const g = src.geometry;
        return g && (g.type === "Polygon" || g.type === "MultiPolygon")
            ? (src as Feature<Polygon | MultiPolygon>)
            : null;
    }
    if (src.type === "FeatureCollection") {
        const polys = src.features.filter(
            (f): f is Feature<Polygon | MultiPolygon> =>
                !!f.geometry &&
                (f.geometry.type === "Polygon" ||
                    f.geometry.type === "MultiPolygon"),
        );
        if (polys.length === 0) return null;
        if (polys.length === 1) return polys[0];
        // v1158: time the (now once-per-area) union so the debug readout
        // confirms the cache killed the repeated ~1 s cost.
        const t0 = typeof performance !== "undefined" ? performance.now() : 0;
        try {
            return (
                (turf.union(
                    turf.featureCollection(polys as never),
                ) as Feature<Polygon | MultiPolygon>) ?? polys[0]
            );
        } catch {
            return polys[0];
        } finally {
            const ms =
                typeof performance !== "undefined"
                    ? Math.round(performance.now() - t0)
                    : 0;
            if (ms >= 5) subtypeTimings.push(`playAreaUnion(${polys.length})=${ms}ms`);
        }
    }
    return null;
}

/** How many distinct admin regions at `level` the play area spans, or null
 *  when it can't be determined (cold prewarm cache / no boundary). */
async function computeAdminSpan(level: number): Promise<number | null> {
    const area = playAreaPolygon();
    if (!area) return null;
    const data = await fetchPrewarmedAreaAdmin(level);
    if (!data) return null; // not warmed yet — stay unknown (available)
    const geo = osmtogeojson({ elements: data.elements as never });
    const regions = geo.features.filter(
        (f): f is Feature<Polygon | MultiPolygon> =>
            !!f.geometry &&
            (f.geometry.type === "Polygon" ||
                f.geometry.type === "MultiPolygon"),
    );
    if (regions.length <= 1) return regions.length; // 0 or 1 → can't split
    // Sample interior points of the play area; count distinct regions that
    // contain a sample. Robust against a region merely touching the padded
    // bbox (which a whole-play-area intersection test would over-count).
    const bb = turf.bbox(area) as [number, number, number, number];
    const dim = Math.max(bb[2] - bb[0], bb[3] - bb[1]);
    const cell = Math.max(dim / 8, 1e-4);
    let grid;
    try {
        grid = turf.pointGrid(bb, cell, { units: "degrees" });
    } catch {
        return null;
    }
    const seen = new Set<string | number>();
    for (const pt of grid.features) {
        try {
            if (!turf.booleanPointInPolygon(pt, area)) continue;
        } catch {
            continue;
        }
        for (let i = 0; i < regions.length; i++) {
            try {
                if (turf.booleanPointInPolygon(pt, regions[i])) {
                    seen.add(regions[i].id ?? `#${i}`);
                    break;
                }
            } catch {
                /* skip malformed region */
            }
        }
    }
    // `seen.size` is the true span: how many distinct regions at this level
    // actually contain play-area interior points. A result of 0 means NO
    // region of this level covers the play area — e.g. NYC (admin_level 5,
    // boroughs level 6) has NO admin_level=8 municipalities inside it, so a
    // level-8 bbox query returns only NJ/Westchester towns that touch the
    // padded bbox but contain no NYC point. That's span 0 → the question
    // can't cut the map → disabled. (The old `: regions.length` fallback
    // wrongly reported those touch-the-bbox regions as spanning the area,
    // so "City / Town (OSM 8)" stayed enabled in NYC — the reported bug.)
    return seen.size;
}

/* ────────────────── Coast-presence gating (v842) ──────────────────── *
 *
 * Two more "can't cut the play area" cases, both keyed on ONE signal — is
 * there any coastline within the play area?
 *   - `coastline` (measuring "closer/further to the coast"): with NO coast
 *     in the area there's nothing to measure distance to → useless.
 *   - `same-landmass` (matching): the landmass split is built from the SEA
 *     (coastline); with no coast the whole area is one landmass → "same"
 *     is always true → useless. (A coastal-but-single-landmass area like LA
 *     stays available — we only disable the unambiguous inland case, never
 *     over-hiding.)
 * Uses the SAME per-city coastline fetch the elimination uses; a null
 * (fetch failed / not warmed) result stays AVAILABLE so we never wrongly
 * hide a coastal city's question. Keyed by play-area signature.
 */
const coastPresentCache = new Map<string, boolean>();
let coastPresentPending: string | null = null;
const COAST_GATED = new Set(["coastline", "same-landmass"]);

async function computeCoastPresent(): Promise<boolean | null> {
    try {
        const lines = await fetchAreaCoastlineLines();
        if (lines === null) return null; // fetch failed → unknown (available)
        return lines.length > 0;
    } catch {
        return null;
    }
}

/* ─────────── Reference-in-area gating for line references (v869) ─────────── *
 *
 * Two more measuring "closer/further to a ___" types whose reference must be
 * INSIDE the play area (rulebook p17), else the question can't cut the map —
 * it just buffers the WHOLE area as "closer" (the NYC reports: nearest
 * high-speed line 5000 km away in England; nearest international border ~500 km
 * away in Canada). Same safe presence-gate shape as coast: a null (unknown /
 * fetch failed) stays AVAILABLE so a valid city's question is never wrongly
 * hidden. Keyed by play-area signature.
 *   - high-speed rail: play-area-clipped Overpass `[highspeed=yes]` — the SAME
 *     query the elimination uses, so the gate matches reality (NYC → none).
 *   - international border: the bundled Natural Earth admin_0 border lines,
 *     tested against the play-area bbox (cheap, no network at game time).
 */
const HSR_GATED = new Set(["highspeed-measure-shinkansen"]);
const BORDER0_GATED = new Set(["international-border"]);
// v978: state border (admin1-border) gets the SAME presence gate — NYC is
// entirely inside New York State, so no state border crosses the play area
// and the question can't cut the map (the repeated report). The measuring
// elimination uses `fetchBorders1States` (Natural Earth admin_1 lines).
const BORDER1_GATED = new Set(["admin1-border"]);
const linePresentCache = new Map<string, boolean>();
const linePresentPending = new Set<string>();

/* v1197: per-gate "settled" markers — the compute FINISHED for this key (whether
 * it cached a value OR resolved to null/unknown). The subtype picker runs a
 * loading animation until every gate relevant to the OPEN subtype set is settled,
 * so a tile's disabled state is never applied AFTER the tile is already visible
 * (the reported flicker). A cache hit implies settled; these also cover the
 * null-result computes that don't cache. */
const coastSettled = new Set<string>(); // sig
const lineSettled = new Set<string>(); // `${sig}:${v}`
const adminSpanSettled = new Set<string>(); // `${sig}:${lvl}`
const warmSettled = new Set<FamilyKey>(); // fam (getCachedCategory is the real
// signal; this additionally marks a warm ATTEMPT, so a family that failed to warm
// [stays cold forever] still counts as settled and can't hang the loading state).

async function computeHsrPresent(): Promise<boolean | null> {
    // v1131: don't rely on a LIVE `[highspeed=yes]` poly query — in a dense
    // metro WITH added adjacents (NYC) it gets rate-limited and throws →
    // null → the gate stays AVAILABLE and the HSR question is never disabled
    // even though there's no HSR for thousands of km (the reported bug). Use
    // the SAME cached country HSR data the elimination + nearest-reference
    // read: `buildHsrQuery()` is null unless the play area's country is a
    // prewarmed HSR country, so a non-HSR country (the US) is a definitive
    // "no HSR here" → DISABLE, no network at all. If it IS an HSR country,
    // read the cached (R2-hit) national network and test whether any line
    // actually crosses the play-area polygon.
    const query = buildHsrQuery();
    if (!query) return false; // country has no HSR network → disable
    const area = playAreaPolygon();
    if (!area) return null;
    try {
        const data = await getOverpassData(query, undefined, CacheType.ZONE_CACHE);
        const geo = osmtogeojson(data as never);
        const frame = turf.bboxPolygon(
            turf.bbox(area) as [number, number, number, number],
        );
        for (const f of geo.features) {
            try {
                if (!turf.booleanIntersects(f, frame)) continue;
                if (turf.booleanIntersects(f as never, area as never))
                    return true;
            } catch {
                /* skip a malformed HSR line */
            }
        }
        return false;
    } catch {
        return null;
    }
}

// v978: a border reference only "exists" for the question when it actually
// crosses the play-area POLYGON (rulebook p17) — NOT merely its bbox. NYC's
// bbox spans the Hudson and clips the NY-NJ state border + the US coastline,
// but neither enters NYC's land polygon, so the state/international-border
// questions can't cut the map and must be disabled. Tests the border LINES
// against the polygon (with a bbox pre-filter so we only geometry-test the
// handful of nearby lines). null = fetch failed / unknown → stays available.
async function computeBorderPresent(
    fetchFn: () => Promise<GeoJSON.FeatureCollection>,
): Promise<boolean | null> {
    const area = playAreaPolygon();
    if (!area) return null;
    try {
        const fc = await fetchFn();
        const frame = turf.bboxPolygon(
            turf.bbox(area) as [number, number, number, number],
        );
        for (const f of fc.features) {
            try {
                // Cheap bbox reject first, then the exact polygon test.
                if (!turf.booleanIntersects(f, frame)) continue;
                if (turf.booleanIntersects(f, area as never)) return true;
            } catch {
                /* skip a malformed border line */
            }
        }
        return false;
    } catch {
        return null;
    }
}

function computeBorder0Present(): Promise<boolean | null> {
    return computeBorderPresent(fetchBorders0Land);
}

function computeBorder1Present(): Promise<boolean | null> {
    return computeBorderPresent(fetchBorders1States);
}

export interface SubtypeAvailability {
    /** false ⇒ too few instances in the play area to be worth asking. */
    available: boolean;
    /** In-area instance count when known, else null (cache cold / the
     *  subtype isn't a countable reference family). */
    count: number | null;
    /** Minimum required for this category (0 ⇒ not gated). */
    min: number;
}

const AVAILABLE: SubtypeAvailability = {
    available: true,
    count: null,
    min: 0,
};

/**
 * Per-subtype availability for the New-question subtype picker. A subtype
 * is marked unavailable only when we KNOW its in-play-area instance count
 * and it's below the category minimum — an unknown count (cache still
 * cold, or a non-countable subtype) always stays available so we never
 * wrongly hide a valid question. Warms any cold families it needs and
 * re-renders once they land; also re-evaluates when the play-area
 * boundary finishes loading.
 *
 * Returns `{ availability, loading }`. `loading` is true while any gate relevant
 * to the open subtype set is still being computed (or the boundary hasn't loaded)
 * — the picker runs a loading animation until then, so disabled states are never
 * applied AFTER the tiles are already visible (v1197). Bounded by an 8 s backstop.
 */
export function useSubtypeAvailability(
    categoryId: string | null,
    values: string[],
): { availability: Record<string, SubtypeAvailability>; loading: boolean } {
    const $poly = useStore(polyGeoJSON); // re-evaluate once the boundary loads
    const [tick, setTick] = useState(0);
    const min = (categoryId && MIN_INSTANCES[categoryId]) || 0;
    const key = values.join(",");

    // v1197: reveal-anyway backstop so the picker's loading state can never hang
    // if the play-area boundary never loads or a gate stalls. Reset when the open
    // subtype set changes.
    const [revealAnyway, setRevealAnyway] = useState(false);
    useEffect(() => {
        setRevealAnyway(false);
        if (!categoryId) return;
        const t = window.setTimeout(() => setRevealAnyway(true), 8000);
        return () => window.clearTimeout(t);
    }, [categoryId, key]);

    // v1158 DIAGNOSTIC: the user reports the subtype-picker drawers
    // (matching/measuring/tentacle "subpages") lag on OPEN. Install a longtask
    // observer over the first ~1.8 s after this category's picker mounts — the
    // longtask API only reports main-thread tasks ≥50 ms, so an empty list means
    // there's NO JS block (the lag is layout/paint/drawer animation or
    // perception) and a non-empty list localises the block magnitude. Paired
    // with the per-compute wall-clock timings (`recordSubtypeTiming` below), so
    // the readout attributes the block. Read back in the debug panel.
    useEffect(() => {
        if (!categoryId) return;
        subtypeTimings.length = 0;
        if (typeof PerformanceObserver === "undefined") return;
        const t0 =
            typeof performance !== "undefined" ? performance.now() : 0;
        const tasks: number[] = [];
        let obs: PerformanceObserver | null = null;
        try {
            obs = new PerformanceObserver((list) => {
                for (const e of list.getEntries())
                    tasks.push(Math.round(e.duration));
            });
            obs.observe({ entryTypes: ["longtask"] });
        } catch {
            /* longtask unsupported (Firefox / Safari) */
        }
        const timer = window.setTimeout(() => {
            obs?.disconnect();
            const total = tasks.reduce((a, b) => a + b, 0);
            const span =
                typeof performance !== "undefined"
                    ? Math.round(performance.now() - t0)
                    : 0;
            const line = `open ${categoryId}: block=[${tasks.join(",")}] sum=${total}ms/${span}ms | ${subtypeTimings.join(" ") || "no computes"}`;
            lastSubtypePickerDiag.set(line);
            // eslint-disable-next-line no-console
            console.log(`[subtypeavail] ${line}`);
        }, 1800);
        return () => {
            obs?.disconnect();
            window.clearTimeout(timer);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [categoryId]);

    useEffect(() => {
        if (!min) return;
        let cancelled = false;
        const cold = new Set<FamilyKey>();
        for (const v of values) {
            const f = countableFamily(v);
            // v1159: `getCachedCategory === null` is the cold check — cheap,
            // vs. `countInPlayArea` which used to run the FULL point-in-polygon
            // count here just to detect null.
            if (f && getCachedCategory(f) === null) cold.add(f);
        }
        if (cold.size === 0) return;
        timed(`warm(${cold.size})`, () =>
            Promise.all(
                Array.from(cold).map((f) => prefetchCategory(f).catch(() => {})),
            ),
        ).then(() => {
            for (const f of cold) warmSettled.add(f);
            if (!cancelled) setTick((t) => t + 1);
        });
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, min]);

    // Admin-division span: compute how many regions the play area spans at
    // each admin `admin-N` tile's level (prewarm-only), so "Same state"-type
    // questions that can't narrow the map are disabled. Re-runs when the
    // subtype set or the boundary changes.
    useEffect(() => {
        if (!hasPlayAreaPolygon()) return;
        const sig = areaSignature();
        const levels = new Set<number>();
        for (const v of values) {
            const lvl = adminOsmLevel(v);
            const ckey = lvl != null ? `${sig}:${lvl}` : null;
            if (
                lvl != null &&
                ckey &&
                !adminSpanCache.has(ckey) &&
                !adminSpanPending.has(ckey)
            ) {
                levels.add(lvl);
            }
        }
        if (levels.size === 0) return;
        let cancelled = false;
        levels.forEach((l) => adminSpanPending.add(`${sig}:${l}`));
        timed(`admin(${levels.size})`, () =>
            Promise.all(
                Array.from(levels).map(async (l) => {
                    const span = await computeAdminSpan(l);
                    adminSpanPending.delete(`${sig}:${l}`);
                    if (span != null) adminSpanCache.set(`${sig}:${l}`, span);
                    adminSpanSettled.add(`${sig}:${l}`);
                }),
            ),
        ).then(() => {
            if (!cancelled) setTick((t) => t + 1);
        });
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, $poly]);

    // Coast presence: for the coastline / same-landmass tiles, check once
    // per play area whether any coastline exists in it (prewarm/live, with a
    // safe null=unknown). Inland → both disabled.
    useEffect(() => {
        if (!values.some((v) => COAST_GATED.has(v))) return;
        if (!hasPlayAreaPolygon()) return;
        const sig = areaSignature();
        if (coastPresentCache.has(sig) || coastPresentPending === sig) return;
        let cancelled = false;
        coastPresentPending = sig;
        timed("coast", computeCoastPresent).then((present) => {
            if (coastPresentPending === sig) coastPresentPending = null;
            if (present != null) coastPresentCache.set(sig, present);
            coastSettled.add(sig);
            if (!cancelled) setTick((t) => t + 1);
        });
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, $poly]);

    // Line-reference presence: high-speed rail + international border — check
    // once per play area whether the reference exists IN it (else the question
    // can't cut the map). Per-subtype cache key; null=unknown stays available.
    useEffect(() => {
        const gated = values.filter(
            (v) =>
                HSR_GATED.has(v) ||
                BORDER0_GATED.has(v) ||
                BORDER1_GATED.has(v),
        );
        if (gated.length === 0) return;
        if (!hasPlayAreaPolygon()) return;
        const sig = areaSignature();
        let cancelled = false;
        for (const v of gated) {
            const ckey = `${sig}:${v}`;
            if (linePresentCache.has(ckey) || linePresentPending.has(ckey)) {
                continue;
            }
            linePresentPending.add(ckey);
            const compute = HSR_GATED.has(v)
                ? computeHsrPresent
                : BORDER1_GATED.has(v)
                  ? computeBorder1Present
                  : computeBorder0Present;
            timed(`line:${v}`, compute).then((present) => {
                linePresentPending.delete(ckey);
                if (present != null) linePresentCache.set(ckey, present);
                lineSettled.add(ckey);
                if (!cancelled) setTick((t) => t + 1);
            });
        }
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, $poly]);

    // v1197: is the gate relevant to `v` SETTLED (computed for the current play
    // area — cached value OR finished-as-null)? Used to drive the picker's loading
    // animation so a tile's disabled state is never applied after it's visible.
    const gateSettled = (v: string, sig: string): boolean => {
        if (COAST_GATED.has(v))
            return coastSettled.has(sig) || coastPresentCache.has(sig);
        if (HSR_GATED.has(v) || BORDER0_GATED.has(v) || BORDER1_GATED.has(v)) {
            const ck = `${sig}:${v}`;
            return lineSettled.has(ck) || linePresentCache.has(ck);
        }
        const lvl = adminOsmLevel(v);
        if (lvl != null) {
            const ak = `${sig}:${lvl}`;
            return adminSpanSettled.has(ak) || adminSpanCache.has(ak);
        }
        if (!min) return true; // ungated category (photo)
        const fam = countableFamily(v);
        if (!fam) return true; // non-countable subtype — never gated
        return getCachedCategory(fam) !== null || warmSettled.has(fam);
    };

    const loading = useMemo(() => {
        if (!categoryId || values.length === 0) return false;
        if (revealAnyway) return false;
        // The gates can't be computed until the play-area boundary has loaded;
        // keep the loading animation running until it has, then until every gate
        // settles — so the picker reveals with correct disabled states in one shot.
        if (!hasPlayAreaPolygon()) return true;
        const sig = areaSignature();
        return !values.every((v) => gateSettled(v, sig));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, min, tick, $poly, revealAnyway]);

    const availability = useMemo(() => {
        const out: Record<string, SubtypeAvailability> = {};
        for (const v of values) {
            // Coastline / same-landmass: disabled only when we KNOW the play
            // area has no coast (inland). Unknown → available.
            if (COAST_GATED.has(v)) {
                const present = coastPresentCache.get(areaSignature());
                out[v] = {
                    available: present === undefined ? true : present,
                    count: null,
                    min: 0,
                };
                continue;
            }
            // High-speed rail / international + state border: disabled only
            // when we KNOW the reference isn't in the play area. Unknown →
            // available.
            if (
                HSR_GATED.has(v) ||
                BORDER0_GATED.has(v) ||
                BORDER1_GATED.has(v)
            ) {
                const present = linePresentCache.get(
                    `${areaSignature()}:${v}`,
                );
                out[v] = {
                    available: present === undefined ? true : present,
                    count: null,
                    min: 0,
                };
                continue;
            }
            // Admin divisions: gated on region SPAN (>= 2 to be useful),
            // not on an instance count. Unknown span → available.
            const adminLvl = adminOsmLevel(v);
            if (adminLvl != null) {
                const span = adminSpanCache.get(
                    `${areaSignature()}:${adminLvl}`,
                );
                out[v] = {
                    available: span === undefined ? true : span >= 2,
                    count: span ?? null,
                    min: 2,
                };
                continue;
            }
            if (!min) {
                out[v] = AVAILABLE;
                continue;
            }
            const fam = countableFamily(v);
            // v1159: early-exit probe (caps at `min`, cached) instead of a full
            // count — the gate only needs `>= min`, and the disabled-tile reason
            // uses the true sub-`min` count (which the loop still computes).
            const count = fam ? countAtLeastInPlayArea(fam, min) : null;
            out[v] = {
                available: count === null ? true : count >= min,
                count,
                min,
            };
        }
        return out;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, min, tick, $poly]);

    return { availability, loading };
}
