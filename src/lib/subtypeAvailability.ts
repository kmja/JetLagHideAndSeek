import { useStore } from "@nanostores/react";
import * as turf from "@turf/turf";
import type { Feature, MultiPolygon, Polygon } from "geojson";
import osmtogeojson from "osmtogeojson";
import { useEffect, useMemo, useState } from "react";

import { adminTierToOsmLevel } from "@/lib/adminDivisions";
import { mapGeoLocation, polyGeoJSON } from "@/lib/context";
import { LOCATION_FIRST_TAG } from "@/maps/api";
import { fetchPrewarmedAreaAdmin } from "@/maps/api/adminBoundary";
import { fetchAreaCoastlineLines } from "@/maps/api/coast";
import {
    countInPlayArea,
    type FamilyKey,
    prefetchCategory,
} from "@/maps/api/playAreaPrefetch";

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

function playAreaPolygon(): Feature<Polygon | MultiPolygon> | null {
    const src = polyGeoJSON.get() as
        | Feature
        | GeoJSON.FeatureCollection
        | null;
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
        try {
            return (
                (turf.union(
                    turf.featureCollection(polys as never),
                ) as Feature<Polygon | MultiPolygon>) ?? polys[0]
            );
        } catch {
            return polys[0];
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
 */
export function useSubtypeAvailability(
    categoryId: string | null,
    values: string[],
): Record<string, SubtypeAvailability> {
    const $poly = useStore(polyGeoJSON); // re-evaluate once the boundary loads
    const [tick, setTick] = useState(0);
    const min = (categoryId && MIN_INSTANCES[categoryId]) || 0;
    const key = values.join(",");

    useEffect(() => {
        if (!min) return;
        let cancelled = false;
        const cold = new Set<FamilyKey>();
        for (const v of values) {
            const f = countableFamily(v);
            if (f && countInPlayArea(f) === null) cold.add(f);
        }
        if (cold.size === 0) return;
        Promise.all(
            Array.from(cold).map((f) => prefetchCategory(f).catch(() => {})),
        ).then(() => {
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
        if (!playAreaPolygon()) return;
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
        Promise.all(
            Array.from(levels).map(async (l) => {
                const span = await computeAdminSpan(l);
                adminSpanPending.delete(`${sig}:${l}`);
                if (span != null) adminSpanCache.set(`${sig}:${l}`, span);
            }),
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
        if (!playAreaPolygon()) return;
        const sig = areaSignature();
        if (coastPresentCache.has(sig) || coastPresentPending === sig) return;
        let cancelled = false;
        coastPresentPending = sig;
        computeCoastPresent().then((present) => {
            if (coastPresentPending === sig) coastPresentPending = null;
            if (present != null) coastPresentCache.set(sig, present);
            if (!cancelled) setTick((t) => t + 1);
        });
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, $poly]);

    return useMemo(() => {
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
            const count = fam ? countInPlayArea(fam) : null;
            out[v] = {
                available: count === null ? true : count >= min,
                count,
                min,
            };
        }
        return out;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, min, tick, $poly]);
}
