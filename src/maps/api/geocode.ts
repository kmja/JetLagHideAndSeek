import _ from "lodash";

import { GEOCODER_API } from "./constants";
import { convertToLatLong } from "./geo";
import type { OpenStreetMap } from "./types";

/**
 * Coarse place-type ranking used when re-sorting play-area search
 * results. Higher = more likely to be what the user means when they
 * type an unambiguous name like "Stockholm". Photon's default
 * ranking leans on Wikipedia importance, which doesn't help when
 * several Stockholms / Springfields / Birminghams share the exact
 * name — so we layer this on top.
 *
 * Values are deliberately spaced so the place-type bonus dominates
 * the area / exact-match bonuses for big admin distinctions
 * (country vs. village) but doesn't drown out the other signals
 * within the same band (city vs. town).
 */
const PLACE_TYPE_SCORE: Record<string, number> = {
    country: 1000,
    state: 800,
    region: 700,
    province: 700,
    county: 600,
    municipality: 500,
    city: 500,
    district: 450,
    borough: 400,
    town: 300,
    village: 150,
    suburb: 100,
    neighbourhood: 50,
    quarter: 50,
    hamlet: 40,
    locality: 30,
};

/**
 * Score a single Photon relation result for "this is what the user
 * actually meant to search for" relevance. Combines:
 *
 *   - Photon's own ranking (as a tie-breaker — descending position
 *     bonus), since the Wikipedia-importance signal is still useful
 *     when other dimensions are tied.
 *   - The place-type bonus above.
 *   - bbox area on a log scale, capped. Larger admin regions are
 *     more likely to be the canonical interpretation of a one-word
 *     query.
 *   - Exact-name match — when "Stockholm" lands a relation whose
 *     `name` is literally "Stockholm" (the Swedish capital, or a
 *     municipality with the same single-word name), we want that
 *     to beat "Stockholm Township" outright.
 */
function scorePlayAreaResult(
    feature: OpenStreetMap,
    originalIndex: number,
    query: string,
): number {
    const p = feature.properties;
    const name = (p.name ?? "").toLowerCase();
    const q = query.toLowerCase().trim();

    // Descending bonus so Photon's first result still gets a nudge
    // when scoring is tied — small enough not to drown out the
    // place-type / area / exactness signals.
    const photonRankBonus = 100 / (originalIndex + 1);

    const typeBonus = PLACE_TYPE_SCORE[p.osm_value ?? ""] ?? 0;

    let areaBonus = 0;
    const extent = p.extent;
    if (extent && extent.length >= 4) {
        const [maxLat, minLng, minLat, maxLng] = extent;
        if (
            typeof maxLat === "number" &&
            typeof minLat === "number" &&
            typeof minLng === "number" &&
            typeof maxLng === "number"
        ) {
            const midLat = (maxLat + minLat) / 2;
            const km2 =
                Math.abs(maxLat - minLat) *
                111 *
                Math.abs(maxLng - minLng) *
                111 *
                Math.cos((midLat * Math.PI) / 180);
            if (km2 > 0) areaBonus = Math.min(200, Math.log10(km2) * 50);
        }
    }

    const exactNameBonus = name === q ? 500 : 0;

    return photonRankBonus + typeBonus + areaBonus + exactNameBonus;
}

/**
 * Re-rank a Photon result list for play-area search. Stable sort: ties
 * preserve Photon's order.
 */
function rankPlayAreaResults(
    features: OpenStreetMap[],
    query: string,
): OpenStreetMap[] {
    const scored = features.map((feature, originalIndex) => ({
        feature,
        score: scorePlayAreaResult(feature, originalIndex, query),
        originalIndex,
    }));
    scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.originalIndex - b.originalIndex;
    });
    return scored.map((s) => s.feature);
}

export const geocode = async (
    address: string,
    language: string,
    filter: boolean = true,
) => {
    const features = (
        await (
            await fetch(`${GEOCODER_API}?lang=${language}&q=${address}`)
        ).json()
    ).features as OpenStreetMap[];

    features.forEach((feature) => {
        feature.geometry.coordinates = convertToLatLong(
            feature.geometry.coordinates as number[],
        );
        if (!feature.properties.extent) return;
        feature.properties.extent = [
            feature.properties.extent[1],
            feature.properties.extent[0],
            feature.properties.extent[3],
            feature.properties.extent[2],
        ];
    });

    const deduped = _.uniqBy(
        features.filter((feature) => {
            return filter ? feature.properties.osm_type === "R" : true;
        }),
        (feature) => feature.properties.osm_id,
    );

    // Play-area search (filter=true) gets re-ranked so canonical
    // big-admin matches beat same-named villages. Unscoped forward
    // geocoding (filter=false, used by HiderView's manual-location
    // fallback) keeps Photon's native ordering — it usually wants the
    // most-specific match for an ad-hoc address, not the broadest
    // admin region with that name.
    if (filter) return rankPlayAreaResults(deduped, address);
    return deduped;
};

/**
 * Reverse geocoding: lat/lng → friendly place name. Used by LatLngPicker
 * (to show "near X" on question cards) and HiderView fallback paths.
 *
 * Wraps Photon's /reverse endpoint (same provider as forward geocode()
 * above). Module-level cache keyed by 4-decimal-rounded coords (~11 m)
 * so dragging a marker around doesn't fire a request per pixel.
 */
const REVERSE_CACHE = new Map<string, Promise<string | null>>();

export const reverseGeocode = (
    lat: number,
    lng: number,
): Promise<string | null> => {
    if (typeof lat !== "number" || typeof lng !== "number") {
        return Promise.resolve(null);
    }
    const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
    const hit = REVERSE_CACHE.get(key);
    if (hit) return hit;

    const url = `${GEOCODER_API.replace(
        /\/api\/?$/,
        "",
    )}/reverse?lat=${lat}&lon=${lng}&lang=en`;
    const promise = fetch(url, { headers: { Accept: "application/json" } })
        .then(async (resp) => {
            if (!resp.ok) return null;
            const data = await resp.json();
            const first = data?.features?.[0]?.properties ?? null;
            if (!first) return null;
            return (
                first.name ||
                first.suburb ||
                first.district ||
                first.locality ||
                first.city ||
                first.county ||
                first.state ||
                first.country ||
                null
            );
        })
        .catch(() => null);
    REVERSE_CACHE.set(key, promise);
    return promise;
};

/**
 * Forward geocoding with a simple shape: place name → {lat, lng,
 * displayName}. Used by HiderView's manual-location fallback. Wraps the
 * existing geocode() function and pulls out the first usable feature.
 */
export const forwardGeocodeOne = async (
    query: string,
): Promise<{ lat: number; lng: number; displayName: string } | null> => {
    const trimmed = query.trim();
    if (!trimmed) return null;
    try {
        // filter=false so we don't restrict to OSM relations only — for
        // free-form hider input (a station, a landmark) we want any match.
        const features = await geocode(trimmed, "en", false);
        if (!features?.length) return null;
        const first = features[0];
        const coords = first.geometry.coordinates as number[];
        if (!Array.isArray(coords) || coords.length < 2) return null;
        const [lat, lng] = coords;
        if (typeof lat !== "number" || typeof lng !== "number") return null;
        const p = first.properties as any;
        const label =
            p.name ??
            [p.city, p.country].filter(Boolean).join(", ") ??
            trimmed;
        return { lat, lng, displayName: label };
    } catch {
        return null;
    }
};
