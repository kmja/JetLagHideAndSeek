import { useStore } from "@nanostores/react";
import { useEffect, useMemo, useState } from "react";

import { polyGeoJSON } from "@/lib/context";
import { LOCATION_FIRST_TAG } from "@/maps/api";
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

    return useMemo(() => {
        const out: Record<string, SubtypeAvailability> = {};
        for (const v of values) {
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
