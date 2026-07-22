import * as turf from "@turf/turf";
import { Loader2, MapPin, Ruler } from "lucide-react";
import osmtogeojson from "osmtogeojson";
import { useEffect, useRef, useState } from "react";

import { mapGeoLocation, polyGeoJSON } from "@/lib/context";
import { fetchPrewarmedRailStationElements } from "@/lib/journey/stations";
import { cn } from "@/lib/utils";
import { fetchCoastline, LOCATION_FIRST_TAG } from "@/maps/api";
import { fetchAreaCoastlineLines } from "@/maps/api/coast";
import { buildElevationField } from "@/maps/api/elevation";
import { resolvedUnits } from "@/lib/units";
import { pointInPlayArea } from "@/maps/geo-utils/playAreaIndex";
import {
    findPlacesInZone,
    findTentacleLocations,
    getOverpassData,
} from "@/maps/api/overpass";
import {
    buildHsrCountryQuery,
    buildHsrQuery,
    type FamilyKey,
    HSR_COUNTRY_CENTROIDS,
    nearestFromCache,
    prefetchCategory,
} from "@/maps/api/playAreaPrefetch";
import { CacheType } from "@/maps/api/types";
import { isFountainWaterFeature } from "@/maps/questions/measuring";
import { MAJOR_CITIES } from "@/maps/data/majorCities";
import type { APILocations } from "@/maps/schema";
import { nearestBasemapWater } from "@/maps/api/basemapWater";
import { fetchPrewarmedAreaWater } from "@/maps/api/water";

/**
 * Compact "from the seeker's point of view" preview rendered at the top of
 * the matching and measuring configure cards. Resolves the nearest place
 * of the chosen subtype around the seeker's question point and shows its
 * name (matching) plus distance (measuring) so the seeker knows exactly
 * which reference the hider is being compared against before they ship the
 * question.
 *
 * Stays silent for subtype kinds we can't or shouldn't resolve cheaply —
 * coastline, zone admin levels, custom-drawn geometries, train-line
 * comparisons, etc. For those the seeker already understands the reference
 * (or it's not a single named place).
 *
 * The lookup logic is also exposed as a hook (`useNearestReference`) so
 * the pending-answer overlay can surface the same name in its headline.
 */

export interface NearestRef {
    name: string;
    lat: number;
    lng: number;
    distanceMeters: number;
    /** v988: overrides the distance readout for reference "questions" that
     *  aren't a distance-to-a-place — e.g. sea-level shows the seeker's own
     *  elevation ("12 m above sea level") instead of a distanceMeters. */
    detail?: string;
}

export type NearestRefState =
    | { status: "idle" }
    | { status: "loading" }
    | { status: "ok"; ref: NearestRef }
    | { status: "none" }
    | { status: "error" };

type ResolvedFamily =
    | { kind: "api"; location: APILocations }
    | { kind: "airport" }
    | { kind: "coastline" }
    | { kind: "city" }
    | { kind: "brand"; wikidataId: string; brandName: string }
    | { kind: "rail-station"; broad: boolean }
    | { kind: "water" }
    | { kind: "highspeed-rail" }
    | { kind: "sea-level" }
    | null;

/**
 * Map the matching/measuring `type` field to a concrete Overpass strategy.
 * Returns null only for types that aren't really "nearest place"
 * questions — admin polygons (zone, letter-zone) and user-drawn
 * custom geometry.
 */
export function resolveFamily(typeRaw: string): ResolvedFamily {
    const stripped = typeRaw.endsWith("-full")
        ? typeRaw.slice(0, -"-full".length)
        : typeRaw;
    if (stripped === "airport") return { kind: "airport" };
    if (stripped === "coastline") return { kind: "coastline" };
    if (stripped === "city" || stripped === "major-city")
        return { kind: "city" };
    if (stripped === "mcdonalds")
        return {
            kind: "brand",
            wikidataId: "Q38076",
            brandName: "McDonald's",
        };
    if (stripped === "seven11")
        return {
            kind: "brand",
            wikidataId: "Q259340",
            brandName: "7-Eleven",
        };
    // Rail-measure, same-train-line, and same-length-station all use
    // the seeker's nearest train station as the reference. The hider's
    // answer hinges on a *property* of the station (which line, what
    // platform length), but the reference *point* is the station
    // itself — same lookup either way.
    // v977: `broad` = the MEASURING rail question (rail-measure*), whose
    // rulebook definition (p206) includes light rail / halts / tram stops —
    // it uses the broadened prewarmed all-mode rail set. The MATCHING station
    // questions (same-train-line / same-length / same-first-letter) grade
    // against the NARROW `[railway=station]` set in `matchingStationBoundary`,
    // so their nearest-reference LABEL must use that same narrow set — else
    // the labelled reference (e.g. a subway platform "Malcolm X Boulevard")
    // disagrees with the station the elimination actually keyed on (a short
    // "116 Street"), making the drawn "same length" region look wrong (v970
    // regression: it broadened the label for the matching types too).
    if (
        stripped === "rail-measure" ||
        // v824: the shipped measuring subtype is "rail-measure-ordinary"
        // (see subtypes.ts); without this it resolved to null → no fast
        // nearest-distance path and no answer-view reference overlay.
        stripped.startsWith("rail-measure")
    ) {
        return { kind: "rail-station", broad: true };
    }
    if (
        stripped === "same-train-line" ||
        stripped === "same-length-station" ||
        stripped === "same-first-letter-station"
    ) {
        return { kind: "rail-station", broad: false };
    }
    if (stripped === "highspeed-measure-shinkansen")
        return { kind: "highspeed-rail" };
    // v988: sea-level's "reference" is the seeker's OWN elevation, not a
    // distance to a place — the preview shows metres/feet above/below sea
    // level (rulebook: closer to sea level = smaller |elevation|).
    if (stripped === "sea-level") return { kind: "sea-level" };
    // Named water bodies — nearest is the true closest point on any
    // shore or river/canal line (fetchNearestWater), computed from the
    // SAME full `out geom` geometry the measuring elimination buffers, so
    // the preview label agrees with the actual answer (v687). The old
    // centroid-only cache ignored rivers and measured a lake from its
    // middle — a river 1 km away lost to a pond 3 km away.
    if (stripped === "body-of-water") return { kind: "water" };
    if (stripped in LOCATION_FIRST_TAG) {
        return { kind: "api", location: stripped as APILocations };
    }
    return null;
}

/**
 * Strip the rulebook `-full` suffix and de-snake the subtype string into a
 * lowercase human-readable noun ("aquarium-full" → "aquarium",
 * "golf_course" → "golf course"). Caller can capitalise as needed.
 */
export function prettyTypeNoun(typeRaw: string): string {
    const stripped = typeRaw.endsWith("-full")
        ? typeRaw.slice(0, -"-full".length)
        : typeRaw;
    return stripped.replace(/[-_]/g, " ");
}

/** In-process cache so repeated lookups for the same coords + type are
 *  served instantly. Keyed at 4-decimal precision (~11 m) to match the
 *  geocoder cache's resolution. */
const nearestCache = new Map<string, NearestRef | null>();
const cacheKey = (
    family: NonNullable<ResolvedFamily>,
    lat: number,
    lng: number,
) => {
    let id: string;
    if (family.kind === "api") id = family.location;
    else if (family.kind === "brand") id = `brand:${family.wikidataId}`;
    else id = family.kind;
    return `${id}|${lat.toFixed(4)}|${lng.toFixed(4)}`;
};

/**
 * Reactive hook: given seeker coords + the matching/measuring subtype,
 * returns a lifecycle-tracked NearestRefState. Debounces coordinate
 * changes (600 ms) so dragging a pin doesn't fire a request per pixel,
 * and shares its result through `nearestCache`. Unsupported types
 * resolve to `{ status: "none" }`.
 */
export function useNearestReference(
    lat: number,
    lng: number,
    type: string,
): NearestRefState {
    const family = resolveFamily(type);
    const [state, setState] = useState<NearestRefState>(() => {
        if (!family) return { status: "none" };
        if (!Number.isFinite(lat) || !Number.isFinite(lng))
            return { status: "idle" };
        const cached = nearestCache.get(cacheKey(family, lat, lng));
        if (cached === undefined) return { status: "loading" };
        if (cached === null) return { status: "none" };
        return { status: "ok", ref: cached };
    });

    // Debounce coordinate changes so dragging the pin doesn't trigger an
    // Overpass call every pixel. Only refetch once the seeker stops moving
    // for ~600ms.
    const reqIdRef = useRef(0);
    useEffect(() => {
        if (!family) {
            setState({ status: "none" });
            return;
        }
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

        const key = cacheKey(family, lat, lng);
        const cached = nearestCache.get(key);
        if (cached !== undefined) {
            setState(cached ? { status: "ok", ref: cached } : { status: "none" });
            return;
        }

        const myReqId = ++reqIdRef.current;
        setState({ status: "loading" });

        const debounce = window.setTimeout(async () => {
            try {
                const ref = await fetchNearest(family, lat, lng);
                nearestCache.set(key, ref ?? null);
                if (reqIdRef.current !== myReqId) return; // stale
                setState(
                    ref ? { status: "ok", ref } : { status: "none" },
                );
            } catch (e) {
                if (reqIdRef.current !== myReqId) return;
                console.warn("useNearestReference failed:", e);
                setState({ status: "error" });
            }
        }, 600);
        return () => window.clearTimeout(debounce);
    }, [family?.kind, (family as any)?.location, lat, lng]);

    return state;
}

export function NearestReferencePreview({
    lat,
    lng,
    type,
    mode,
    state: sharedState,
}: {
    lat: number;
    lng: number;
    type: string;
    mode: "matching" | "measuring";
    /** v477: when the parent already runs `useNearestReference` (so the
     *  card map and this header share ONE lookup and can't disagree),
     *  pass its result here. The internal hook is then neutralised
     *  (called with empty args → no fetch) to keep hook order stable. */
    state?: NearestRefState;
}) {
    const ownState = useNearestReference(
        sharedState ? 0 : lat,
        sharedState ? 0 : lng,
        sharedState ? "" : type,
    );
    const state = sharedState ?? ownState;
    if (state.status === "none") return null;

    return (
        <div
            className={cn(
                "mx-2 mb-2 mt-1 rounded-sm border border-border bg-secondary/40",
                "px-3 py-2 flex items-start gap-2",
            )}
            data-testid="nearest-reference-preview"
        >
            <MapPin className="w-3.5 h-3.5 text-primary mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1 text-xs">
                <div className="text-[10px] uppercase tracking-[0.14em] font-poppins font-semibold text-muted-foreground">
                    Your nearest reference
                </div>
                {(state.status === "loading" || state.status === "idle") && (
                    <div className="flex items-center gap-1.5 mt-0.5 text-muted-foreground italic">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        Looking up…
                    </div>
                )}
                {state.status === "error" && (
                    <div className="mt-0.5 text-muted-foreground italic">
                        Couldn&apos;t fetch nearest place — try again later.
                    </div>
                )}
                {state.status === "ok" && (
                    <div className="mt-0.5 flex items-center flex-wrap gap-x-2 gap-y-0.5">
                        <span className="font-inter-tight font-bold text-foreground">
                            {state.ref.name}
                        </span>
                        {mode === "measuring" &&
                            (state.ref.detail ? (
                                // v988: a non-distance reference (sea-level →
                                // the seeker's own elevation) carries its own
                                // readout in `detail`.
                                <span className="inline-flex items-center gap-1 text-muted-foreground tabular-nums">
                                    <Ruler className="w-3 h-3" />
                                    {state.ref.detail}
                                </span>
                            ) : (
                                <span className="inline-flex items-center gap-1 text-muted-foreground tabular-nums">
                                    <Ruler className="w-3 h-3" />
                                    {formatDistance(state.ref.distanceMeters)}
                                </span>
                            ))}
                    </div>
                )}
            </div>
        </div>
    );
}

/**
 * Try the play-area-wide prefetch cache for families that support
 * it. Returns the resolved nearest, or null when the family isn't
 * cacheable, the prefetch hasn't landed, or the play area is empty
 * of that family. Caller falls back to the legacy radius-walking
 * path on null.
 *
 * Skipping the cache on `coastline`, `city`, and `highspeed-rail`
 * is deliberate: those use either a local GeoJSON (coastline) or a
 * world-spanning radius walk (cities are sparse, high-speed rail
 * is global by nature) — neither benefits from a play-area-scoped
 * cache.
 */
async function tryCacheNearest(
    family: NonNullable<ResolvedFamily>,
    lat: number,
    lng: number,
): Promise<NearestRef | null> {
    const key: FamilyKey | null =
        family.kind === "api"
            ? `api:${family.location}`
            : family.kind === "airport"
              ? "airport"
              : family.kind === "rail-station"
                ? "rail-station"
                : family.kind === "water"
                  ? "body-of-water"
                  : family.kind === "brand"
                    ? `brand:${family.wikidataId}`
                    : null;
    if (!key) return null;

    // v339: rulebook p17 — "If locations are not within a map's
    // boundaries, players must operate as if they do not exist." The
    // reference for a matching/measuring question is THE NEAREST ONE
    // INSIDE THE PLAY AREA, not the nearest globally. The play-area
    // cache (bbox + 50 km pad) holds exactly the right candidate set,
    // so the cache-first lookup IS the correct answer — even when
    // the seeker physically stands far outside the play area (e.g.
    // remote-testing). v338's "bypass cache when seeker is outside"
    // path was reverted on that basis.
    const cached = nearestFromCache(key, lat, lng);
    if (cached) return cached;

    // Cache miss — fire ONE play-area-wide query (deduped by
    // prefetchCategory). The single fetch replaces the legacy 4-step
    // radius walk that was burning through rate-limit slots.
    try {
        const features = await prefetchCategory(key);
        if (features.length === 0) return null;
        return nearestFromCache(key, lat, lng);
    } catch (e) {
        console.warn("playArea prefetch failed; falling back:", e);
        return null;
    }
}

/**
 * Rulebook p17: "If locations are not within a map's boundaries, players
 * must operate as if they do not exist." The cache path already filters
 * (nearestFromCache), but the Overpass `around:` FALLBACKS below walk a
 * radius from the seeker with no boundary awareness, so they can surface
 * a reference far outside the play area (e.g. an aquarium one city over).
 * This predicate restricts every fallback's candidate set to the loaded
 * play-area polygon. While the boundary is still loading (polyGeoJSON
 * null) we keep everything, matching nearestFromCache's behaviour.
 */
function inLoadedPlayArea(lat: number, lng: number): boolean {
    const poly = polyGeoJSON.get();
    return !poly || pointInPlayArea(poly, lng, lat);
}

export async function fetchNearest(
    family: NonNullable<ResolvedFamily>,
    lat: number,
    lng: number,
): Promise<NearestRef | null> {
    // Water bodies: compute the true nearest point on any shore or
    // river/canal line from the full `out geom` geometry (v687), NOT the
    // centroid point-cache — which ignored rivers and measured lakes from
    // their middle. This is handled first so it bypasses the centroid
    // `tryCacheNearest` path below (which would win with the wrong ref).
    if (family.kind === "water") return fetchNearestWater(lat, lng);

    // v988: sea-level shows the seeker's own elevation (no place lookup).
    if (family.kind === "sea-level") return fetchNearestSeaLevel(lat, lng);

    // v970 (rulebook audit B): rail stations include light rail / halts /
    // tram stops (rulebook p206) — the SAME prewarmed rail set the
    // measuring elimination buffers, so the label agrees with the cut.
    // Handled before the centroid cache below, which only holds the bare
    // `railway=station` family and would win with a farther heavy station.
    if (family.kind === "rail-station" && family.broad) {
        try {
            const rail = await fetchPrewarmedRailStationElements();
            if (rail && rail.length > 0) {
                const ref = pickNearestNamed(
                    rail as Parameters<typeof pickNearestNamed>[0],
                    lat,
                    lng,
                );
                if (ref) return ref;
            }
        } catch {
            // fall through to the cache / around-radius paths
        }
    }

    // Play-area-wide cache short-circuit. One Overpass call per
    // category per play area instead of N around-radius walks per
    // seeker tap — this is what makes a quick burst of matching
    // questions survive the public mirrors' rate limit.
    const fromCache = await tryCacheNearest(family, lat, lng);
    if (fromCache) return fromCache;

    if (family.kind === "airport") {
        const data = await findPlacesInZone(
            '["aeroway"="aerodrome"]["iata"]',
            undefined,
        );
        return pickNearestNamed(data.elements ?? [], lat, lng);
    }
    if (family.kind === "coastline") return fetchNearestCoastline(lat, lng);
    if (family.kind === "city") return fetchNearestMajorCity(lat, lng);
    if (family.kind === "brand")
        return fetchNearestBrand(
            lat,
            lng,
            family.wikidataId,
            family.brandName,
        );
    if (family.kind === "rail-station") return fetchNearestRailStation(lat, lng);
    if (family.kind === "highspeed-rail")
        return fetchNearestHighspeedRail(lat, lng);
    // (water is handled at the top of fetchNearest)

    // `api` case fallback — the play-area cache didn't have it (or
    // failed), so walk an Overpass radius from the seeker as the last
    // resort. Matches the historical `nearestToQuestion` behavior.
    let radius = 30;
    while (radius <= 240) {
        const fc = await findTentacleLocations(
            {
                lat,
                lng,
                radius,
                unit: "miles",
                location: false,
                locationType: family.location,
                drag: false,
                color: "black",
                collapsed: false,
            },
            "",
        );
        // Drop anything outside the play area before picking the nearest
        // — otherwise a closer out-of-bounds instance wins over a valid
        // in-area one (the aquarium-one-city-over bug).
        const inArea = {
            ...fc,
            features: fc.features.filter((f: any) => {
                const c = f.geometry?.coordinates as
                    | [number, number]
                    | undefined;
                return c ? inLoadedPlayArea(c[1], c[0]) : false;
            }),
        };
        if (inArea.features.length > 0) {
            const questionPoint = turf.point([lng, lat]);
            const nearest = turf.nearestPoint(questionPoint, inArea as any);
            const distanceMeters = turf.distance(questionPoint, nearest as any, {
                units: "meters",
            });
            const name =
                ((nearest.properties as any)?.name as string | undefined) ??
                "Unknown";
            const coords = (nearest.geometry as any).coordinates as [
                number,
                number,
            ];
            return {
                name,
                lat: coords[1],
                lng: coords[0],
                distanceMeters,
            };
        }
        radius += 30;
    }
    return null;
}

/**
 * Nearest point on the world coastline. Uses the Natural Earth 1:50m
 * coastline (`public/coastline50.geojson`, ~3.9 MB) loaded once and
 * cached forever in the PERMANENT_CACHE — then scans every line
 * feature with `turf.nearestPointOnLine` to find the exact closest
 * point. Pure client-side after the first download: no Overpass round
 * trip, no progressive radius walk, no "all mirrors timed out" for
 * inland seekers whose nearest coast is 200+ km away. (The previous
 * Overpass impl would pull every coastline within 300 km of the
 * seeker, which for someone in central Sweden meant the entire
 * Swedish coast + Norway + Baltic — easily megabytes per query,
 * which is exactly why every public mirror was 429ing.)
 *
 * The resolution trade-off is the dataset's ~1:50m simplification:
 * fjords and small bays get smoothed, so the returned point may be
 * ~1-5 km off the true OSM coast. Fine for a km-precision question
 * like "are you closer to the coast than me".
 */
const coastlineCache: { fc: GeoJSON.FeatureCollection | null } = { fc: null };

/**
 * v988: sea-level "nearest reference" — the seeker's OWN elevation from the
 * prewarmed Terrarium DEM (the same source the sea-level elimination isobands),
 * formatted in the player's units. `detail` carries the readout so the preview
 * shows "12 m above sea level" instead of a meaningless distance.
 */
async function fetchNearestSeaLevel(
    lat: number,
    lng: number,
): Promise<NearestRef | null> {
    try {
        const pad = 0.02;
        const field = await buildElevationField([
            lng - pad,
            lat - pad,
            lng + pad,
            lat + pad,
        ]);
        if (!field) return null;
        const elevM = field.sample(lng, lat);
        if (elevM == null || !Number.isFinite(elevM)) return null;
        const imperial = resolvedUnits.get() === "imperial";
        const value = imperial ? elevM * 3.28084 : elevM;
        const unit = imperial ? "ft" : "m";
        const abs = Math.round(Math.abs(value));
        const detail =
            Math.round(value) === 0
                ? "at sea level"
                : `${abs} ${unit} ${value > 0 ? "above" : "below"} sea level`;
        return { name: "Sea level", lat, lng, distanceMeters: 0, detail };
    } catch {
        return null;
    }
}

async function fetchNearestCoastline(
    lat: number,
    lng: number,
): Promise<NearestRef | null> {
    const target = turf.point([lng, lat]);
    let best: {
        lat: number;
        lng: number;
        distanceMeters: number;
    } | null = null;

    // v778/v1008: the DETAILED per-city OSM coastline (prewarmed R2 → live
    // play-area Overpass) so the label agrees with the elimination, which uses
    // the same per-city coast. Falls back to the bundled 1:50m coastline when
    // per-city coast is unavailable. (The v1001 basemap-ocean source was
    // reverted along with the rest of the basemap-water elimination changes.)
    let scanFeatures: GeoJSON.Feature[] | null = null;
    {
        try {
            const perCity = await fetchAreaCoastlineLines();
            if (perCity && perCity.length > 0) {
                scanFeatures = perCity as unknown as GeoJSON.Feature[];
            }
        } catch {
            /* fall through to the bundled coastline */
        }
    }

    if (!scanFeatures) {
        if (!coastlineCache.fc) {
            try {
                coastlineCache.fc =
                    (await fetchCoastline()) as GeoJSON.FeatureCollection;
            } catch (e) {
                console.warn("coastline50.geojson load failed:", e);
                return null;
            }
        }
        scanFeatures = coastlineCache.fc.features;
    }

    for (const feature of scanFeatures) {
        const g = feature.geometry;
        if (!g) continue;
        // Natural Earth ships both LineString and MultiLineString.
        const lines: GeoJSON.LineString[] =
            g.type === "LineString"
                ? [g]
                : g.type === "MultiLineString"
                  ? (g.coordinates as GeoJSON.Position[][]).map(
                        (coords) => ({
                            type: "LineString",
                            coordinates: coords,
                        }),
                    )
                  : [];
        for (const line of lines) {
            if (line.coordinates.length < 2) continue;
            try {
                const nearest = turf.nearestPointOnLine(
                    line as GeoJSON.Feature<GeoJSON.LineString> | GeoJSON.LineString,
                    target,
                );
                const d = turf.distance(target, nearest, {
                    units: "meters",
                });
                if (!best || d < best.distanceMeters) {
                    const coords = nearest.geometry.coordinates as [
                        number,
                        number,
                    ];
                    best = {
                        lat: coords[1],
                        lng: coords[0],
                        distanceMeters: d,
                    };
                }
            } catch {
                /* skip malformed feature */
            }
        }
    }
    return best ? { name: "Coastline", ...best } : null;
}

/**
 * Nearest named body of water — the TRUE closest point on any lake/
 * reservoir shore OR named river/canal centreline (v687). Reads the SAME
 * full `out geom` geometry the measuring elimination buffers
 * (`fetchPrewarmedAreaWater` first — served from R2 for a warm city —
 * falling back to the live poly query), so the preview label agrees with
 * the actual answer.
 *
 * The old path used the `natural=water` centroid point-cache, which had
 * two bugs the seeker could see: rivers (mapped as `waterway` LINES) were
 * absent entirely, and a lake was measured from its middle — so a river
 * 1 km away lost to a pond 3 km away named "Public Park". Here every water
 * feature is reduced to line geometry (polygon boundary via
 * `polygonToLine`, or the line itself) and scanned with
 * `turf.nearestPointOnLine`, exactly like the coastline fetcher.
 *
 * NOT culled to the play-area polygon — matching the elimination, which
 * buffers the padded-bbox water set (a shore just outside the boundary is
 * still the nearest body of water, rulebook p17).
 *
 * v702: also considers the SEA (coastline), matching the elimination — OSM
 * tags the open sea / large bays as `natural=coastline`, not `natural=water`,
 * so a coastal metro's nearest "water" would otherwise skip the bay for a far
 * inland lake. Only counts coast within the same play-area frame the
 * elimination clips to (a 3° pad), so an inland city doesn't show a distant
 * coast.
 */
export async function fetchNearestWater(
    lat: number,
    lng: number,
): Promise<NearestRef | null> {
    // v998.2: prefer the BASEMAP `water` layer — the SAME source the
    // body-of-water elimination buffers — so the label distance and the overlay
    // agree by construction (both read `getBasemapWaterPolys`). Falls back to
    // the OSM path below only when no map has captured the basemap water yet.
    const bmw = nearestBasemapWater(lat, lng);
    if (bmw) return bmw;
    let data: { elements?: unknown[] } | null = await fetchPrewarmedAreaWater();
    if (!data) {
        try {
            data = await findPlacesInZone(
                // Byte-identical to WATER_FILTERS / measuring.ts fallback.
                '["natural"="water"]["name"]["water"!~"pond|basin|pool|fountain|wastewater|moat|tank|ditch"]',
                undefined,
                "nwr",
                "geom",
                // v690: NO `["name"]` on the line filter (unnamed river/
                // canal segments count); byte-identical to WATER_FILTERS.
                ['["waterway"~"^(river|canal)$"]'],
                60,
                /* silent */ true,
            );
        } catch (e) {
            console.warn("fetchNearestWater live fallback failed:", e);
            return null;
        }
    }
    const fc = osmtogeojson(data as never) as GeoJSON.FeatureCollection;
    const target = turf.point([lng, lat]);
    let best: NearestRef | null = null;
    for (const feature of fc.features) {
        const g = feature.geometry;
        if (!g) continue;
        const props = (feature.properties ?? {}) as Record<string, string>;
        const name = props["name:en"] ?? props["name"];
        if (!name) continue;
        // v933: a fountain mis-tagged `natural=water` isn't a body of water —
        // skip it so the label agrees with the elimination (both drop it).
        if (isFountainWaterFeature(feature)) continue;
        // Flatten multi-geometry, then reduce each part to line geometry.
        let parts: GeoJSON.Feature[];
        try {
            parts = turf.flatten(feature as never).features;
        } catch {
            parts = [feature];
        }
        for (const part of parts) {
            const pg = part.geometry;
            if (!pg) continue;
            let line:
                | GeoJSON.Feature<GeoJSON.LineString | GeoJSON.MultiLineString>
                | GeoJSON.LineString
                | GeoJSON.MultiLineString
                | null = null;
            if (pg.type === "LineString" || pg.type === "MultiLineString") {
                line = pg;
            } else if (pg.type === "Polygon") {
                try {
                    line = turf.polygonToLine(
                        part as GeoJSON.Feature<GeoJSON.Polygon>,
                    ) as GeoJSON.Feature<
                        GeoJSON.LineString | GeoJSON.MultiLineString
                    >;
                } catch {
                    line = null;
                }
            }
            if (!line) continue;
            try {
                const nearest = turf.nearestPointOnLine(line as never, target);
                const d = turf.distance(target, nearest, { units: "meters" });
                if (!best || d < best.distanceMeters) {
                    const coords = nearest.geometry.coordinates as [
                        number,
                        number,
                    ];
                    best = {
                        name,
                        lat: coords[1],
                        lng: coords[0],
                        distanceMeters: d,
                    };
                }
            } catch {
                /* skip malformed part */
            }
        }
    }
    // v702: fold in the SEA, gated to the play-area frame (3° pad, matching
    // the elimination's clipLinesToBbox). Without this a coastal metro's
    // nearest body of water skipped the bay/sea (coastline, not natural=water)
    // and pointed at a far inland lake — the "reference outside the play area"
    // + "in-water marked further" bug.
    try {
        const coast = await fetchNearestCoastline(lat, lng);
        if (coast) {
            const poly = polyGeoJSON.get();
            const bb = poly ? turf.bbox(poly) : null;
            const inFrame =
                !bb ||
                (coast.lng >= bb[0] - 3 &&
                    coast.lng <= bb[2] + 3 &&
                    coast.lat >= bb[1] - 3 &&
                    coast.lat <= bb[3] + 3);
            if (inFrame && (!best || coast.distanceMeters < best.distanceMeters)) {
                // For BODY-OF-WATER the coast fold-in is the shore of ANY water
                // — the sea, a bay, OR a tidal river bank (OSM tags e.g. the
                // Hudson's banks `natural=coastline`). Calling that "Coastline"
                // is wrong (a river isn't a coastline, rulebook p218), so label
                // it the neutral "Shoreline" here. (The dedicated `coastline`
                // subtype keeps `fetchNearestCoastline`'s "Coastline" name.)
                best = { ...coast, name: "Shoreline" };
            }
        }
    } catch {
        /* no coast / load failed — keep the water best */
    }
    return best;
}

/**
 * Nearest major city (1M+ population). Resolved entirely client-side
 * from the bundled `MAJOR_CITIES` list (Natural Earth, ~500 cities) —
 * no Overpass round trip. The nearest million-plus city is almost
 * always far outside the play area, so the old outward radius walk
 * (200 → 800 → 2000 km `node[place=city]` queries) was both heavy and
 * the first thing the public mirrors rate-limited. A bundled lookup
 * is instant and consistent between hider and seeker.
 */
async function fetchNearestMajorCity(
    lat: number,
    lng: number,
): Promise<NearestRef | null> {
    const target = turf.point([lng, lat]);
    let best: NearestRef | null = null;
    for (const [name, cityLat, cityLng] of MAJOR_CITIES) {
        const d = turf.distance(target, turf.point([cityLng, cityLat]), {
            units: "meters",
        });
        if (!best || d < best.distanceMeters) {
            best = { name, lat: cityLat, lng: cityLng, distanceMeters: d };
        }
    }
    return best;
}

/**
 * Nearest store of a chain brand keyed by Wikidata. Works for any
 * brand consistently tagged with `brand:wikidata=Q…` in OSM —
 * McDonald's (Q38076), 7-Eleven (Q259340), etc. Cities have dozens of
 * locations so the inner-radius pass usually wins; the outer fallback
 * covers rural seekers.
 *
 * Falls back to the brand name when the individual outlet isn't
 * separately named (some OSM entries omit `name`).
 */
async function fetchNearestBrand(
    lat: number,
    lng: number,
    wikidataId: string,
    brandName: string,
): Promise<NearestRef | null> {
    for (const km of [10, 30, 100, 300]) {
        const query = `
[out:json][timeout:60];
(
  nwr["brand:wikidata"="${wikidataId}"](around:${km * 1000},${lat},${lng});
);
out center;
`;
        const data = await getOverpassData(
            query,
            undefined,
            CacheType.ZONE_CACHE,
        );
        const elements = (data as { elements?: any[] }).elements ?? [];
        if (elements.length === 0) continue;

        const target = turf.point([lng, lat]);
        let best: NearestRef | null = null;
        for (const el of elements) {
            const elLat = el.lat ?? el.center?.lat;
            const elLon = el.lon ?? el.center?.lon;
            if (!Number.isFinite(elLat) || !Number.isFinite(elLon)) continue;
            if (!inLoadedPlayArea(elLat as number, elLon as number)) continue;
            const name =
                el.tags?.["name:en"] ?? el.tags?.["name"] ?? brandName;
            const d = turf.distance(
                target,
                turf.point([elLon as number, elLat as number]),
                { units: "meters" },
            );
            if (!best || d < best.distanceMeters) {
                best = {
                    name,
                    lat: elLat as number,
                    lng: elLon as number,
                    distanceMeters: d,
                };
            }
        }
        if (best) return best;
    }
    return null;
}

/**
 * Nearest `railway=station` node. Covers heavy/commuter rail; metro &
 * tram stations live under different tags so they won't appear here.
 */
async function fetchNearestRailStation(
    lat: number,
    lng: number,
): Promise<NearestRef | null> {
    for (const km of [10, 30, 100, 300]) {
        const query = `
[out:json][timeout:60];
node["railway"="station"](around:${km * 1000},${lat},${lng});
out;
`;
        const data = await getOverpassData(
            query,
            undefined,
            CacheType.ZONE_CACHE,
        );
        const elements = (data as { elements?: any[] }).elements ?? [];
        if (elements.length > 0) {
            const ref = pickNearestNamed(elements, lat, lng);
            if (ref) return ref;
        }
    }
    return null;
}

/**
 * Nearest point on any `highspeed=yes` railway line. OSM uses this
 * tag worldwide (Shinkansen, TGV, AVE, Eurostar, etc.) so the query
 * isn't Japan-specific — wherever the seeker is, the nearest high-
 * speed track will resolve. Returns the closest point on the line
 * via `turf.nearestPointOnLine`, same as the coastline fetcher.
 */
function nearestOnHsrWays(
    elements: any[],
    lat: number,
    lng: number,
): NearestRef | null {
    const target = turf.point([lng, lat]);
    let best: NearestRef | null = null;
    for (const way of elements) {
        const g = way.geometry as
            | Array<{ lat: number; lon: number }>
            | undefined;
        if (!g || g.length < 2) continue;
        try {
            const line = turf.lineString(g.map((p) => [p.lon, p.lat]));
            const nearest = turf.nearestPointOnLine(line, target);
            const d = turf.distance(target, nearest, { units: "meters" });
            if (!best || d < best.distanceMeters) {
                const coords = nearest.geometry.coordinates as [
                    number,
                    number,
                ];
                const nm =
                    (way.tags?.["name:en"] as string | undefined) ??
                    (way.tags?.["name"] as string | undefined) ??
                    "High-speed rail";
                best = {
                    name: nm,
                    lat: coords[1],
                    lng: coords[0],
                    distanceMeters: d,
                };
            }
        } catch {
            /* skip malformed way */
        }
    }
    return best;
}

async function fetchNearestHighspeedRail(
    lat: number,
    lng: number,
): Promise<NearestRef | null> {
    // First try the play-area COUNTRY query — same string the cron +
    // laptop warm and the preload primes, so it's usually an instant
    // R2 / in-memory cache hit covering the whole national network.
    const countryQuery = buildHsrQuery();
    let ownIso: string | null = null;
    if (countryQuery) {
        const data = await getOverpassData(
            countryQuery,
            undefined,
            CacheType.ZONE_CACHE,
        );
        const els = (data as { elements?: any[] }).elements ?? [];
        const ref = nearestOnHsrWays(els, lat, lng);
        if (ref) return ref;
        // Track own ISO so we don't retry it below.
        const cc = mapGeoLocation.get()?.properties?.countrycode;
        if (cc) ownIso = cc.toUpperCase();
    }

    // v331 cross-border fallback. The seeker's country has no HSR
    // cache hit — either it isn't a prewarmed HSR country at all
    // (Latvia, Slovenia, Iceland) or the prewarm is genuinely empty
    // (NO/FI). Instead of going straight to the upstream-hitting
    // radius walk, try the cached HSR country queries for the few
    // closest HSR countries — sorted by centroid distance. A Latvian
    // seeker resolves to Polish HSR from R2; a Slovenian seeker to
    // Austrian / Italian; an Icelander to Norwegian. All cache hits,
    // no Overpass traffic.
    const ranked = Object.entries(HSR_COUNTRY_CENTROIDS)
        .filter(([iso]) => iso !== ownIso)
        .map(([iso, c]) => ({
            iso,
            d: turf.distance(
                turf.point([lng, lat]),
                turf.point([c.lng, c.lat]),
                { units: "kilometers" },
            ),
        }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 3);
    for (const { iso } of ranked) {
        try {
            const q = buildHsrCountryQuery(iso);
            const data = await getOverpassData(
                q,
                undefined,
                CacheType.ZONE_CACHE,
            );
            const els = (data as { elements?: any[] }).elements ?? [];
            const ref = nearestOnHsrWays(els, lat, lng);
            if (ref) return ref;
        } catch {
            /* try next neighbour */
        }
    }

    // Radius-walk last resort: every cached neighbour was empty too
    // (truly remote seeker — central Australia, mid-Atlantic). The
    // around: queries aren't cacheable since the centre is the seeker's
    // exact point, but this fires for a vanishingly small slice of
    // games after the cross-border attempt above.
    for (const km of [50, 200, 500, 1500]) {
        const query = `
[out:json][timeout:60];
way["railway"="rail"]["highspeed"="yes"](around:${km * 1000},${lat},${lng});
out geom;
`;
        const data = await getOverpassData(
            query,
            undefined,
            CacheType.ZONE_CACHE,
        );
        const elements = (data as { elements?: any[] }).elements ?? [];
        if (elements.length === 0) continue;

        const target = turf.point([lng, lat]);
        let best: {
            name: string;
            lat: number;
            lng: number;
            distanceMeters: number;
        } | null = null;
        for (const way of elements) {
            const g = way.geometry as
                | Array<{ lat: number; lon: number }>
                | undefined;
            if (!g || g.length < 2) continue;
            try {
                const line = turf.lineString(g.map((p) => [p.lon, p.lat]));
                const nearest = turf.nearestPointOnLine(line, target);
                const d = turf.distance(target, nearest, {
                    units: "meters",
                });
                if (!best || d < best.distanceMeters) {
                    const coords = nearest.geometry.coordinates as [
                        number,
                        number,
                    ];
                    // Prefer the line's name (e.g. "Tōkaidō
                    // Shinkansen") when OSM provides one; otherwise
                    // fall back to a generic "High-speed rail" label.
                    const nm =
                        (way.tags?.["name:en"] as string | undefined) ??
                        (way.tags?.["name"] as string | undefined) ??
                        "High-speed rail";
                    best = {
                        name: nm,
                        lat: coords[1],
                        lng: coords[0],
                        distanceMeters: d,
                    };
                }
            } catch {
                /* skip malformed way */
            }
        }
        if (best) return best;
    }
    return null;
}

function pickNearestNamed(
    elements: Array<{
        lat?: number;
        lon?: number;
        center?: { lat: number; lon: number };
        tags?: Record<string, string>;
    }>,
    seekerLat: number,
    seekerLng: number,
): NearestRef | null {
    const seeker = turf.point([seekerLng, seekerLat]);
    let best: NearestRef | null = null;
    for (const el of elements) {
        const lat = el.lat ?? el.center?.lat;
        const lon = el.lon ?? el.center?.lon;
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        if (!inLoadedPlayArea(lat as number, lon as number)) continue;
        const name = el.tags?.["name:en"] ?? el.tags?.["name"] ?? el.tags?.["iata"];
        if (!name) continue;
        const d = turf.distance(seeker, turf.point([lon as number, lat as number]), {
            units: "meters",
        });
        if (!best || d < best.distanceMeters) {
            best = {
                name,
                lat: lat as number,
                lng: lon as number,
                distanceMeters: d,
            };
        }
    }
    return best;
}

function formatDistance(m: number): string {
    if (m < 1000) return `${Math.round(m)} m`;
    if (m < 10_000) return `${(m / 1000).toFixed(1)} km`;
    return `${Math.round(m / 1000)} km`;
}

export default NearestReferencePreview;
