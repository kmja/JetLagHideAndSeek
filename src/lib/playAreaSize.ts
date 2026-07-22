import type { GameSize, TransitMode } from "@/lib/gameSetup";
import type { OpenStreetMap } from "@/maps/api";
import { fetchExactAreaKm2 } from "@/maps/api/boundaryArea";

/**
 * Pure play-area size + transit helpers, shared by the setup wizard
 * (`SetupPage`), the edit-settings dialog (`GameSetupDialog`), the
 * search-result list, and the settings preload estimate
 * (`AppSettingsDrawer`). Extracted from `GameSetupDialog` (v761) so the
 * eager settings drawer can measure the committed play area WITHOUT
 * pulling the lazy setup dialog into its bundle.
 */

/**
 * Empirical bbox→polygon fill factor.
 *
 * Photon only exposes a feature's lat/lng bounding box, not its actual
 * boundary geometry, so we can't measure the real area without an extra
 * round-trip. But the bbox systematically overshoots: real OSM admin
 * regions fill 40–70% of their bbox on average — coastlines, fjords,
 * mountain backdrops, and plain irregular borders eat the rest. 0.55 is
 * the rough median across a sample of cities/counties (Berlin ~0.60,
 * Greater London ~0.70, Manhattan ~0.40, Norway ~0.20). Borderline picks
 * bias toward the smaller, faster size. (The wizard now REFINES this with
 * the exact boundary area via `exactTotalAreaKm2` once it's warm; the
 * estimate is the instant seed + the fallback for non-relation results.)
 */
export const BBOX_FILL_FACTOR = 0.55;

/**
 * Rulebook (p9) area→game-size bands:
 *   - Small:  25 – 250 km²    (town / small city / portion of a metro)
 *   - Medium: 250 – 2,500 km² (major city / metro / region)
 *   - Large:  2,500+ km²      (large region / country / multiple)
 */
export function sizeForAreaKm2(km2: number | null): GameSize | null {
    if (km2 === null) return null;
    if (km2 < 250) return "small";
    if (km2 < 2500) return "medium";
    return "large";
}

/**
 * Polygon-area estimate for a Photon OSM feature, in km². Returns null
 * when the feature has no usable extent. The extent is stored as
 * `[maxLat, minLng, minLat, maxLng]` (geocode.ts swaps Photon's native
 * ordering). Flat-earth `Δlat * Δlng·cos(midLat) * 111²`, scaled by
 * `BBOX_FILL_FACTOR`.
 */
export function estimateAreaKm2(feature: OpenStreetMap): number | null {
    const extent = feature.properties.extent;
    if (!extent || extent.length < 4) return null;
    const [maxLat, minLng, minLat, maxLng] = extent;
    if (
        typeof maxLat !== "number" ||
        typeof minLat !== "number" ||
        typeof minLng !== "number" ||
        typeof maxLng !== "number"
    ) {
        return null;
    }
    const midLat = (maxLat + minLat) / 2;
    const latSpanKm = Math.abs(maxLat - minLat) * 111;
    const lngSpanKm =
        Math.abs(maxLng - minLng) * 111 * Math.cos((midLat * Math.PI) / 180);
    const bboxAreaKm2 = latSpanKm * lngSpanKm;
    const areaKm2 = bboxAreaKm2 * BBOX_FILL_FACTOR;
    if (!Number.isFinite(areaKm2) || areaKm2 <= 0) return null;
    return areaKm2;
}

/** Recommended game size for a single feature, from its bbox estimate. */
export function inferGameSize(feature: OpenStreetMap): GameSize | null {
    return sizeForAreaKm2(estimateAreaKm2(feature));
}

/**
 * Short human-readable area label like "~120 km²" or "~7,700 km²"
 * derived from the bbox-adjusted polygon estimate. Returns null if the
 * feature has no usable extent.
 */
export function formatAreaLabel(feature: OpenStreetMap): string | null {
    const km2 = estimateAreaKm2(feature);
    if (km2 === null) return null;
    let rounded: number;
    if (km2 < 100) rounded = Math.round(km2);
    else if (km2 < 1000) rounded = Math.round(km2 / 10) * 10;
    else rounded = Math.round(km2 / 100) * 100;
    return `~${rounded.toLocaleString("en-US")} km²`;
}

/**
 * Total play-area size estimate INCLUDING any added adjacent areas, so
 * the recommended game size / download estimate reflects what the players
 * will actually cover — not just the primary municipality. Sums the
 * primary's bbox estimate with each adjacent's (same heuristic).
 */
export function estimateTotalAreaKm2(
    primary: OpenStreetMap | null,
    adjacents: Array<{ location?: OpenStreetMap | null }>,
): number | null {
    if (!primary) return null;
    let total = estimateAreaKm2(primary) ?? 0;
    for (const a of adjacents) {
        if (a?.location) total += estimateAreaKm2(a.location) ?? 0;
    }
    return total > 0 ? total : null;
}

/**
 * EXACT total play-area size (km²) — primary + every added adjacent —
 * measured from each area's real OSM relation boundary (already warmed by
 * `PlayAreaPreviewMap`) via `turf.area`, with the bbox estimate as a
 * per-piece fallback when a relation's geometry isn't available (a
 * non-relation Photon result, or a boundary that hasn't resolved yet).
 * The wizard seeds size synchronously from `estimateTotalAreaKm2` then
 * refines it with this once the boundaries are in.
 */
export async function exactTotalAreaKm2(
    primary: OpenStreetMap | null,
    adjacents: Array<{ location?: OpenStreetMap | null }>,
): Promise<number | null> {
    if (!primary) return null;
    const features: OpenStreetMap[] = [primary];
    for (const a of adjacents) if (a?.location) features.push(a.location);
    let total = 0;
    let any = false;
    for (const f of features) {
        const props = f.properties as { osm_id?: number; osm_type?: string };
        let km2: number | null = null;
        if (props.osm_type === "R" && props.osm_id) {
            km2 = await fetchExactAreaKm2(props.osm_id);
        }
        if (km2 === null) km2 = estimateAreaKm2(f); // bbox fallback
        if (km2 !== null) {
            total += km2;
            any = true;
        }
    }
    return any && total > 0 ? total : null;
}

/** Per-mode station counts for a play area (from the prewarmed station
 *  field), used to default the allowed-transit set to what actually exists. */
export type TransitCounts = Record<TransitMode, number>;

/**
 * A train-station count at or above this in the play area is taken as a
 * heavy rail network — either genuine commuter rail, or (commonly) a
 * subway/metro whose stops are tagged `railway=station`/`train` rather
 * than `subway`. Either way it's a rail-dense metro where the bus is too
 * slow/noisy to be a useful default. Tunable.
 */
export const TRAIN_HEAVY_STATION_COUNT = 12;

/**
 * Size-only fallback for the allowed transit set when we have no station
 * data for the area (a cold/un-prewarmed city or a custom polygon). Larger
 * areas lean on rail; the bus is dropped for Medium/Large:
 *   - Small  → bus + tram
 *   - Medium → tram + subway + train
 *   - Large  → tram + subway + train + ferry
 */
export function inferTransitModes(size: GameSize): TransitMode[] {
    if (size === "small") return ["bus", "tram"];
    if (size === "medium") return ["tram", "train", "subway"];
    return ["tram", "train", "subway", "ferry"];
}

/**
 * Default allowed transit modes for a play area (walking is always
 * implicit). PRESENCE-AWARE (v1098): now that starred cities are
 * prewarmed, we default to the modes that ACTUALLY have stops in the area
 * (from `detectAreaTransitCounts`), instead of guessing purely from game
 * size. Policy:
 *   - Every rail mode present (subway / train / tram) is defaulted ON —
 *     that's the metro's backbone.
 *   - Ferry ON only if ferry stops actually exist (kills the landlocked
 *     "ferry on" default).
 *   - BUS is the judgment call, driven by rail DENSITY, not size: a subway
 *     — or a train network big enough (`TRAIN_HEAVY_STATION_COUNT`) that
 *     it's likely a subway tagged as `train` — marks a rail-dense metro
 *     where bus would be too much, so bus is dropped. In a rail-light area
 *     (no subway, few/no trains) the bus IS the backbone and stays on.
 *   - No station data at all → the size-only `inferTransitModes` fallback.
 * A seeded/edited game keeps its saved set; this only feeds the wizard's
 * auto-default, and the player can still toggle any mode by hand.
 */
export function defaultTransitModes(
    size: GameSize,
    counts: TransitCounts | null,
): TransitMode[] {
    if (!counts) return inferTransitModes(size);
    const total =
        counts.subway + counts.train + counts.tram + counts.bus + counts.ferry;
    if (total === 0) return inferTransitModes(size); // no usable data → guess

    const has = (m: TransitMode) => counts[m] > 0;
    const heavyRail =
        has("subway") || counts.train >= TRAIN_HEAVY_STATION_COUNT;

    const modes: TransitMode[] = [];
    if (has("subway")) modes.push("subway");
    if (has("train")) modes.push("train");
    if (has("tram")) modes.push("tram");
    if (has("ferry")) modes.push("ferry");
    // Bus only where the area isn't a rail-dense metro.
    if (has("bus") && !heavyRail) modes.push("bus");

    // Degenerate safety (unreachable when total > 0): always leave a mode on.
    if (modes.length === 0) {
        if (has("bus")) modes.push("bus");
        else return inferTransitModes(size);
    }
    return modes;
}

/**
 * Play-area OSM relation ids — primary first, then each added adjacent
 * area that's a relation — from the wizard's DRAFT feature + adjacents
 * (the committed-atom `playAreaRelationIdsAll` in stations.ts can't be
 * used pre-commit). Feeds `detectAreaTransitCounts`; `ids[0]` is the
 * primary. Includes any adjacent with a relation location, mirroring how
 * `estimateTotalAreaKm2` counts them.
 */
export function playAreaRelationIds(
    primary: OpenStreetMap | null,
    adjacents: Array<{ location?: OpenStreetMap | null }>,
): number[] {
    const rid = (f?: OpenStreetMap | null): number | null => {
        const p = f?.properties as
            | { osm_id?: number; osm_type?: string }
            | undefined;
        return p?.osm_type === "R" &&
            typeof p.osm_id === "number" &&
            p.osm_id > 0
            ? p.osm_id
            : null;
    };
    const ids: number[] = [];
    const pid = rid(primary);
    if (pid !== null) ids.push(pid);
    for (const a of adjacents) {
        const id = rid(a?.location);
        if (id !== null && !ids.includes(id)) ids.push(id);
    }
    return ids;
}

/** Order-insensitive transit-mode set comparison. */
export function sameModes(a: TransitMode[], b: TransitMode[]): boolean {
    return (
        a.length === b.length &&
        [...a].sort().join(",") === [...b].sort().join(",")
    );
}
