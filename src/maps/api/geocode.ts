import _ from "lodash";

import { GEOCODER_API } from "./constants";
import { convertToLatLong } from "./geo";
import type { OpenStreetMap } from "./types";

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

    return _.uniqBy(
        features.filter((feature) => {
            return filter ? feature.properties.osm_type === "R" : true;
        }),
        (feature) => feature.properties.osm_id,
    );
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
