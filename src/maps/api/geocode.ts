import memoize from "lodash/memoize";
import uniq from "lodash/uniq";
import uniqBy from "lodash/uniqBy";

import { PHOTON_FORWARD_API, PHOTON_REVERSE_API } from "./constants";
import { convertToLatLong } from "./geo";
import type { OpenStreetMap } from "./types";

/**
 * Coarse place-type ranking used when re-sorting play-area search
 * results. Higher = more likely to be what the user means when they
 * type an ambiguous name like "Stockholm" or "Barcelona". Photon's
 * default ranking leans on Wikipedia importance, which doesn't help
 * when several Stockholms / Barcelonas / Birminghams share the
 * exact name — so we layer this on top.
 *
 * Design principle: **prefer the more specific localised place over
 * the larger administrative area of the same name.** Typing
 * "Barcelona" almost always means the city, not the province
 * containing it; typing "Stockholm" means Sweden's capital, not the
 * county or län it sits inside. Admin regions still surface in the
 * results — they just rank below same-named localities.
 *
 * Country is the special case: a query like "Sweden" or "Japan"
 * matches the country directly, and there are rarely conflicting
 * cities of the same name, so it gets a slightly elevated score so
 * it doesn't lose to a tiny US town named "Sweden".
 */
const PLACE_TYPE_SCORE: Record<string, number> = {
    // Countries beat localities: typing "Sweden" almost certainly
    // means the country, not the small US town of the same name.
    country: 1200,
    // Specific localities — what users typically search for when
    // they query a single name like "Stockholm" or "Barcelona".
    city: 1000,
    town: 900,
    municipality: 850,
    village: 800,
    suburb: 600,
    hamlet: 500,
    borough: 450,
    district: 400,
    neighbourhood: 300,
    quarter: 300,
    locality: 200,
    // Sub-country admin regions — surface but rank below same-named
    // localities (typing "Barcelona" means the city, not the
    // province; "Stockholm" means the capital, not Stockholms län).
    state: 500,
    region: 400,
    province: 300,
    county: 200,
    administrative: 100,
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

    // Photon's intrinsic ranking carries the Wikipedia-importance
    // signal, but for our play-area-picking use case it's
    // misleadingly aggressive — small US towns named "Stockholm"
    // can rank above the Swedish capital just because they're a
    // literal exact-name match at position 0. We keep Photon's
    // signal as a TIE-BREAKER (sqrt falloff so the gap between
    // position 0 and position 5 is much smaller than 1/(idx+1)
    // would give) and let area + exact-name + place-type dominate.
    const photonRankBonus = 80 / Math.sqrt(originalIndex + 1);

    // Read place-type scores from BOTH `type` and `osm_value` and
    // take the more specific (higher-scoring) of the two. Reason:
    //   - For `osm_key=place` features (Barcelona city) `osm_value`
    //     is informative ("city", "province"), so it wins.
    //   - For `osm_key=boundary` admin relations Photon reports
    //     `osm_value="administrative"` (uninformative) and puts the
    //     actual level in `type` ("city" for Stockholm Municipality,
    //     "county" for Stockholm County). So `type` wins there.
    // Picking the max lets both shapes be ranked correctly without
    // a special-case branch.
    const typeFromValue = PLACE_TYPE_SCORE[(p.osm_value ?? "").toLowerCase()] ?? 0;
    const typeFromType = PLACE_TYPE_SCORE[((p as { type?: string }).type ?? "").toLowerCase()] ?? 0;
    const typeBonus = Math.max(typeFromValue, typeFromType);

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
            // Area weight bumped from log10(km2)*50 → *100 so a
            // big-city-of-the-same-name decisively beats a tiny
            // hamlet of the same name. Capped at 600 so the area
            // bonus alone doesn't drown out the place-type signal
            // (a 100,000 km² province should still rank below a
            // 200 km² city of the same name).
            if (km2 > 0) areaBonus = Math.min(600, Math.log10(km2) * 100);
        }
    }

    // Strip common admin-area suffixes from BOTH sides before
    // comparing — otherwise "Stockholm Municipality" loses the
    // exact-name bonus to "Stockholm, Maine" and the Swedish
    // capital gets ranked below tiny US towns of the same name.
    // Mirrors the loading-overlay's display-time suffix strip so
    // the search ranking and the displayed label agree.
    const stripSuffix = (s: string) =>
        s.replace(
            /\s+(kommun|län|municipality|county|district|prefecture|province|borough)$/i,
            "",
        );
    const strippedName = stripSuffix(name);
    const strippedQ = stripSuffix(q);
    let exactNameBonus = 0;
    if (strippedName === strippedQ) {
        exactNameBonus = 500;
    } else if (strippedName.startsWith(strippedQ + " ")) {
        // Prefix match — query is a whole word at the start of
        // the name. Partial credit so "Stockholm Municipality"
        // still beats unrelated "Stockholm, NY" tied on
        // typeBonus when the query is just "Stockholm".
        exactNameBonus = 300;
    }

    return photonRankBonus + typeBonus + areaBonus + exactNameBonus;
}

/**
 * Re-rank a Photon result list for play-area search. Stable sort: ties
 * preserve Photon's order.
 *
 * Accepts the country of Photon's #1 raw result so that even when our
 * relation filter drops it (Photon's #1 is often a node, not the
 * admin relation we need), we can still surface relations in the same
 * country as that #1 result. This is what makes "Stockholm" return
 * the Swedish municipality even though Photon's literal #1 for
 * "Stockholm" is a Node (osm_type=N) that our filter rejects.
 */
function rankPlayAreaResults(
    features: OpenStreetMap[],
    query: string,
    famousCountry: string | null,
): OpenStreetMap[] {
    const scored = features.map((feature, originalIndex) => {
        const base = scorePlayAreaResult(feature, originalIndex, query);
        // Famous-country bonus — substantial, so a relation in the
        // famous-Stockholm country (Sweden) beats relations in
        // unrelated countries even if the latter rank higher in
        // Photon's surviving result set.
        const country = (
            feature.properties.country ?? ""
        ).toLowerCase();
        const famousBonus =
            famousCountry && country === famousCountry.toLowerCase()
                ? 700
                : 0;
        return {
            feature,
            score: base + famousBonus,
            originalIndex,
        };
    });
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
            await fetch(
                `${PHOTON_FORWARD_API}?lang=${language}&q=${encodeURIComponent(address)}`,
            )
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

    // Capture Photon's #1 raw result's country BEFORE we filter.
    // Photon's top result for a well-known city is often a Node
    // (osm_type=N) that our relation filter drops — but its
    // country is the strongest "famous-city" signal we have, so
    // we forward it into the scoring pass so the corresponding
    // admin relation in that country wins the re-rank.
    const famousCountry =
        filter && features[0]?.properties?.country
            ? features[0].properties.country
            : null;

    const deduped = uniqBy(
        features.filter((feature) => {
            if (!filter) return true;
            // Play-area search needs OSM relations (so the rest of
            // the app can fetch a boundary polygon from them).
            if (feature.properties.osm_type !== "R") return false;
            // And the relation has to be a *place* or an admin
            // *boundary* — not a tourism attraction, sports stadium,
            // airport, or other point-of-interest that happens to be
            // tagged as a relation. Photon's relation results
            // include all of those by default; play-area-picking is
            // strictly cities / countries / admin regions.
            const key = (feature.properties.osm_key ?? "").toLowerCase();
            return key === "place" || key === "boundary";
        }),
        (feature) => feature.properties.osm_id,
    );

    // Play-area search (filter=true) gets re-ranked so canonical
    // big-admin matches beat same-named villages. Unscoped forward
    // geocoding (filter=false, used by HiderView's manual-location
    // fallback) keeps Photon's native ordering — it usually wants the
    // most-specific match for an ad-hoc address, not the broadest
    // admin region with that name.
    if (filter) return rankPlayAreaResults(deduped, address, famousCountry);
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

    const url = `${PHOTON_REVERSE_API}?lat=${lat}&lon=${lng}&lang=en`;
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
 * Reverse geocoding tuned for the play-area picker. Returns an
 * ORDERED candidate list, most-specific → least-specific, so the
 * caller can iterate and try each against the forward geocoder
 * until one actually yields OSM admin relations. This handles the
 * common case where the user's town name (e.g. "Falun") has no
 * matching OSM relation but the surrounding municipality
 * ("Falu kommun") or county ("Dalarna") does.
 *
 * Order: city/town → municipality → county → state → country.
 * Each candidate (except the country itself) gets the country
 * appended for forward-search disambiguation; for big multi-state
 * countries the state also gets appended (US Springfield problem).
 *
 * Returns `null` only when no admin levels could be extracted from
 * Photon's reverse response.
 */
export const reverseGeocodeCity = (
    lat: number,
    lng: number,
): Promise<string[] | null> => {
    if (typeof lat !== "number" || typeof lng !== "number") {
        return Promise.resolve(null);
    }
    const url = `${PHOTON_REVERSE_API}?lat=${lat}&lon=${lng}&lang=en`;
    return fetch(url, { headers: { Accept: "application/json" } })
        .then(async (resp) => {
            if (!resp.ok) return null;
            const data = await resp.json();
            const first = data?.features?.[0]?.properties ?? null;
            if (!first) return null;
            const country = first.country as string | undefined;
            const state = first.state as string | undefined;

            // Build ordered candidates, dedup'd.
            const places: string[] = [];
            const push = (s: unknown) => {
                if (typeof s !== "string" || !s) return;
                if (!places.includes(s)) places.push(s);
            };
            push(first.city);
            push(first.town);
            push(first.municipality);
            push(first.county);
            push(first.state);
            push(first.country);
            // Photon sometimes only fills `name` for very granular
            // results (e.g. a single building). Keep it as a last
            // resort but after all admin levels.
            push(first.name);
            if (places.length === 0) return null;

            // Disambiguate against same-named places elsewhere in the
            // world by appending the country (and state, where it
            // meaningfully helps — e.g. "Springfield, Illinois, United
            // States" vs the dozens of other Springfields). Photon's
            // forward search then lands the matching admin relation
            // reliably. Without this the bare name "Stockholm" can
            // surface a US town first depending on Photon's intrinsic
            // popularity ranking, which is the opposite of what the
            // user wants when they're physically in Sweden.
            const needsStateQualifier =
                country !== undefined &&
                /^(United States|USA|US|Canada|Australia|Brazil|Mexico|India|China|Germany|France|Spain|Italy|Russia|Argentina|United Kingdom|UK)$/i.test(
                    country,
                );
            const qualify = (place: string): string => {
                // Don't tag the country onto itself.
                if (place === country) return place;
                const parts = [place];
                if (
                    needsStateQualifier &&
                    state &&
                    state !== place &&
                    place !== country
                ) {
                    parts.push(state);
                }
                if (country && country !== place) parts.push(country);
                return parts.join(", ");
            };
            return places.map(qualify);
        })
        .catch(() => null);
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
