import * as turf from "@turf/turf";
import { Loader2, MapPin, Ruler } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import { LOCATION_FIRST_TAG } from "@/maps/api";
import {
    findPlacesInZone,
    findTentacleLocations,
    getOverpassData,
} from "@/maps/api/overpass";
import { CacheType } from "@/maps/api/types";
import type { APILocations } from "@/maps/schema";

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
    | { kind: "rail-station" }
    | { kind: "highspeed-rail" }
    | null;

/**
 * Map the matching/measuring `type` field to a concrete Overpass strategy.
 * Returns null only for types that aren't really "nearest place"
 * questions — admin polygons (zone, letter-zone) and user-drawn
 * custom geometry.
 */
function resolveFamily(typeRaw: string): ResolvedFamily {
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
    if (
        stripped === "rail-measure" ||
        stripped === "same-train-line" ||
        stripped === "same-length-station"
    ) {
        return { kind: "rail-station" };
    }
    if (stripped === "highspeed-measure-shinkansen")
        return { kind: "highspeed-rail" };
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
}: {
    lat: number;
    lng: number;
    type: string;
    mode: "matching" | "measuring";
}) {
    const state = useNearestReference(lat, lng, type);
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
                        {mode === "measuring" && (
                            <span className="inline-flex items-center gap-1 text-muted-foreground tabular-nums">
                                <Ruler className="w-3 h-3" />
                                {formatDistance(state.ref.distanceMeters)}
                            </span>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

async function fetchNearest(
    family: NonNullable<ResolvedFamily>,
    lat: number,
    lng: number,
): Promise<NearestRef | null> {
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

    // `api` case — tentacle-style fetch around the seeker's question
    // point. Radius grows in 30-mile steps until we find something or
    // hit the cap; matches `nearestToQuestion` in overpass.ts.
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
        if (fc.features.length > 0) {
            const questionPoint = turf.point([lng, lat]);
            const nearest = turf.nearestPoint(questionPoint, fc as any);
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
 * Nearest point on any `natural=coastline` way around the seeker. Uses
 * `turf.nearestPointOnLine` per way so the returned reference is the
 * actual closest point on the coast (not just the closest tagged node).
 * Inland radii expand to 800 km so even landlocked seekers get a
 * reference if there's any reachable coast within continental range.
 */
async function fetchNearestCoastline(
    lat: number,
    lng: number,
): Promise<NearestRef | null> {
    for (const km of [30, 100, 300, 800]) {
        const query = `
[out:json][timeout:60];
way["natural"="coastline"](around:${km * 1000},${lat},${lng});
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
                const line = turf.lineString(
                    g.map((p) => [p.lon, p.lat]),
                );
                const nearest = turf.nearestPointOnLine(line, target);
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
                /* skip malformed way */
            }
        }
        if (best) {
            return { name: "Coastline", ...best };
        }
    }
    return null;
}

/**
 * Nearest `place=city` with a 1M+ population (matches the rulebook's
 * "major city" definition). Radius grows wider than the brand fetcher
 * because major cities are sparse — at most a couple dozen exist per
 * country.
 */
async function fetchNearestMajorCity(
    lat: number,
    lng: number,
): Promise<NearestRef | null> {
    for (const km of [200, 800, 2000]) {
        const query = `
[out:json][timeout:60];
node[place=city]["population"~"^[1-9]+[0-9]{6}$"](around:${km * 1000},${lat},${lng});
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
async function fetchNearestHighspeedRail(
    lat: number,
    lng: number,
): Promise<NearestRef | null> {
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
