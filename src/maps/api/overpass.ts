import * as turf from "@turf/turf";
import type { FeatureCollection, MultiPolygon } from "geojson";
import _ from "lodash";
import osmtogeojson from "osmtogeojson";
import { toast } from "react-toastify";

import {
    additionalMapGeoLocations,
    mapGeoLocation,
    polyGeoJSON,
} from "@/lib/context";
import { playArea } from "@/lib/gameSetup";
import {
    finishLoading,
    setPhase,
    startLoading,
} from "@/lib/loadingProgress";
import { safeUnion } from "@/maps/geo-utils";

import { cacheFetch, determineCache } from "./cache";
import {
    LOCATION_FIRST_TAG,
    OVERPASS_API,
    OVERPASS_API_FALLBACK,
} from "./constants";
import type {
    EncompassingTentacleQuestionSchema,
    HomeGameMatchingQuestions,
    HomeGameMeasuringQuestions,
    QuestionSpecificLocation,
} from "./types";
import { CacheType } from "./types";

export const getOverpassData = async (
    query: string,
    loadingText?: string,
    cacheType: CacheType = CacheType.CACHE,
    /** Client-side fetch timeout in ms. Defaults to whatever
     *  `cacheFetch` uses (25 s at time of writing). Pass a higher value
     *  when the Overpass query itself has a long server timeout (e.g.
     *  `[timeout:180]` on a city-wide bus-route fetch) — otherwise the
     *  client aborts before the server replies and we silently get
     *  `{ elements: [] }`. */
    fetchTimeoutMs?: number,
    /** When true, the network read streams through the global
     *  loadingProgress atom so the LoadingOverlay can show byte
     *  counts. The caller still owns startLoading/finishLoading. */
    reportProgress: boolean = false,
) => {
    const encodedQuery = encodeURIComponent(query);
    const primaryUrl = `${OVERPASS_API}?data=${encodedQuery}`;
    const fallbackUrl = `${OVERPASS_API_FALLBACK}?data=${encodedQuery}`;

    // Try a mirror. Returns Response on success, null if the request
    // threw (timeout, network error, CORS). Non-ok responses are
    // returned as-is so the caller can distinguish them.
    const tryFetch = async (url: string): Promise<Response | null> => {
        try {
            return await cacheFetch(
                url,
                loadingText,
                cacheType,
                fetchTimeoutMs,
                reportProgress,
            );
        } catch (e) {
            console.warn(`Overpass fetch failed for ${url}:`, e);
            return null;
        }
    };

    let response = await tryFetch(primaryUrl);

    // Failover to the fallback mirror on timeout, network error, or 5xx.
    // We keep the toast pending so the user sees one continuous "Loading
    // map data..." rather than a stop-and-start.
    if (!response || !response.ok) {
        const fallbackResponse = await tryFetch(fallbackUrl);
        if (fallbackResponse && fallbackResponse.ok) {
            // Cache the successful fallback body under the primary URL
            // so subsequent identical requests don't repeat the failover.
            try {
                const cache = await determineCache(cacheType);
                await cache.put(primaryUrl, fallbackResponse.clone());
            } catch {
                /* Cache API not available — non-fatal. */
            }
            response = fallbackResponse;
        } else if (fallbackResponse) {
            // Fallback responded but with a non-ok status — surface it.
            response = fallbackResponse;
        }
    }

    if (!response || !response.ok) {
        const statusInfo = response
            ? `${response.status} ${response.statusText}`
            : "network timeout or error";
        toast.error(
            `Could not load data from Overpass (${statusInfo}). Try again in a minute — the public mirrors are sometimes overloaded.`,
            { toastId: "overpass-error" },
        );
        return { elements: [] };
    }

    const data = await response.json();
    return data;
};

export const determineGeoJSON = async (
    osmId: string,
    osmTypeLetter: "W" | "R" | "N",
    /** Suppress the per-fetch "Loading map data..." toast. Used by
     *  callers that fan this function out in parallel (like
     *  `determineMapBoundaries` below) and want a single toast for
     *  the whole batch instead of N stacking ones. */
    silent: boolean = false,
    /** Report download progress to the global loadingProgress atom
     *  (used by determineMapBoundaries which owns the overlay). */
    reportProgress: boolean = false,
): Promise<any> => {
    const osmTypeMap: { [key: string]: string } = {
        W: "way",
        R: "relation",
        N: "node",
    };
    const osmType = osmTypeMap[osmTypeLetter];
    // `out skel geom` strips OSM tags from the response — for a
    // boundary we only need the geometry. Saves ~20-40% on the
    // wire for big admin relations (Sweden, France, …) where the
    // tag dumps on member ways are substantial. `[timeout:120]`
    // gives Overpass headroom on the server side for countries —
    // the default 25 s would otherwise time out before the
    // boundary geometry is assembled.
    const query = `[out:json][timeout:120];${osmType}(${osmId});out skel geom;`;
    // Client-side timeout matches the server's, plus a small margin.
    // Without this bump the default 25 s in cacheFetch aborts the
    // request well before the server returns Sweden's relation.
    const data = await getOverpassData(
        query,
        silent ? undefined : "Loading map data...",
        CacheType.PERMANENT_CACHE,
        130_000,
        reportProgress,
    );
    const geo = osmtogeojson(data);
    return {
        ...geo,
        features: geo.features.filter(
            (feature: any) => feature.geometry.type !== "Point",
        ),
    };
};

export const findTentacleLocations = async (
    question: EncompassingTentacleQuestionSchema,
    text: string = "Determining tentacle locations...",
) => {
    const query = `
[out:json][timeout:25];
nwr["${LOCATION_FIRST_TAG[question.locationType]}"="${question.locationType}"](around:${turf.convertLength(
        question.radius,
        question.unit,
        "meters",
    )}, ${question.lat}, ${question.lng});
out center;
    `;
    const data = await getOverpassData(query, text);
    const elements = data.elements;
    const response = turf.points([]);
    elements.forEach((element: any) => {
        if (!element.tags["name"] && !element.tags["name:en"]) return;
        if (element.lat && element.lon) {
            const name = element.tags["name:en"] ?? element.tags["name"];
            if (
                response.features.find(
                    (feature: any) => feature.properties.name === name,
                )
            )
                return;
            response.features.push(
                turf.point([element.lon, element.lat], { name }),
            );
        }
        if (!element.center || !element.center.lon || !element.center.lat)
            return;
        const name = element.tags["name:en"] ?? element.tags["name"];
        if (
            response.features.find(
                (feature: any) => feature.properties.name === name,
            )
        )
            return;
        response.features.push(
            turf.point([element.center.lon, element.center.lat], { name }),
        );
    });
    return response;
};

export const findAdminBoundary = async (
    latitude: number,
    longitude: number,
    adminLevel: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10,
) => {
    const query = `
[out:json];
is_in(${latitude}, ${longitude})->.a;
rel(pivot.a)["admin_level"="${adminLevel}"];
out geom;
    `;
    const data = await getOverpassData(query, "Determining matching zone...");
    const geo = osmtogeojson(data);
    return geo.features?.[0];
};

export const fetchCoastline = async () => {
    const response = await cacheFetch(
        import.meta.env.BASE_URL + "/coastline50.geojson",
        "Fetching coastline data...",
        CacheType.PERMANENT_CACHE,
    );
    const data = await response.json();
    return data;
};

export const trainLineNodeFinder = async (node: string): Promise<number[]> => {
    const nodeId = node.split("/")[1];
    const tagQuery = `
[out:json];
node(${nodeId});
wr(bn);
out tags;
`;
    const tagData = await getOverpassData(tagQuery, "Finding train line...");
    const query = `
[out:json];
(
${tagData.elements
    .map((element: any) => {
        if (
            !element.tags.name &&
            !element.tags["name:en"] &&
            !element.tags.network
        )
            return "";
        let query = "";
        if (element.tags.name) query += `wr["name"="${element.tags.name}"];`;
        if (element.tags["name:en"])
            query += `wr["name:en"="${element.tags["name:en"]}"];`;
        if (element.tags["network"])
            query += `wr["network"="${element.tags["network"]}"];`;
        return query;
    })
    .join("\n")}
);
out geom;
`;
    const data = await getOverpassData(query, "Finding train lines...");
    const geoJSON = osmtogeojson(data);
    const nodes: number[] = [];
    geoJSON.features.forEach((feature: any) => {
        if (feature && feature.id && feature.id.startsWith("node")) {
            nodes.push(parseInt(feature.id.split("/")[1]));
        }
    });
    data.elements.forEach((element: any) => {
        if (element && element.type === "node") {
            nodes.push(element.id);
        } else if (element && element.type === "way") {
            nodes.push(...element.nodes);
        }
    });
    const uniqNodes = _.uniq(nodes);
    return uniqNodes;
};

export const findPlacesInZone = async (
    filter: string,
    loadingText?: string,
    searchType:
        | "node"
        | "way"
        | "relation"
        | "nwr"
        | "nw"
        | "wr"
        | "nr"
        | "area" = "nwr",
    outType: "center" | "geom" = "center",
    alternatives: string[] = [],
    timeoutDuration: number = 0,
) => {
    let query = "";
    const $polyGeoJSON = polyGeoJSON.get();
    if ($polyGeoJSON) {
        query = `
[out:json]${timeoutDuration != 0 ? `[timeout:${timeoutDuration}]` : ""};
(
${searchType}${filter}(poly:"${turf
            .getCoords($polyGeoJSON.features)
            .flatMap((polygon) => polygon.geometry.coordinates)
            .flat()
            .map((coord) => [coord[1], coord[0]].join(" "))
            .join(" ")}");
${
    alternatives.length > 0
        ? alternatives
              .map(
                  (alternative) =>
                      `${searchType}${alternative}(poly:"${turf
                          .getCoords($polyGeoJSON.features)
                          .flatMap((polygon) => polygon.geometry.coordinates)
                          .flat()
                          .map((coord) => [coord[1], coord[0]].join(" "))
                          .join(" ")}");`,
              )
              .join("\n")
        : ""
}
);
out ${outType};
`;
    } else {
        const primaryLocation = mapGeoLocation.get();
        const additionalLocations = additionalMapGeoLocations
            .get()
            .filter((entry) => entry.added)
            .map((entry) => entry.location);
        const allLocations = [primaryLocation, ...additionalLocations];
        const relationToAreaBlocks = allLocations
            .map((loc, idx) => {
                const regionVar = `.region${idx}`;
                return `relation(${loc.properties.osm_id});map_to_area->${regionVar};`;
            })
            .join("\n");
        const searchBlocks = allLocations
            .map((_, idx) => {
                const regionVar = `area.region${idx}`;
                const altQueries =
                    alternatives.length > 0
                        ? alternatives
                              .map(
                                  (alt) => `${searchType}${alt}(${regionVar});`,
                              )
                              .join("\n")
                        : "";
                return `
            ${searchType}${filter}(${regionVar});
            ${altQueries}
          `;
            })
            .join("\n");
        query = `
        [out:json]${timeoutDuration !== 0 ? `[timeout:${timeoutDuration}]` : ""};
        ${relationToAreaBlocks}
        (
        ${searchBlocks}
        );
        out ${outType};
        `;
    }
    const data = await getOverpassData(
        query,
        loadingText,
        CacheType.ZONE_CACHE,
    );
    const subtractedEntries = additionalMapGeoLocations
        .get()
        .filter((e) => !e.added);
    const subtractedPolygons = subtractedEntries.map((entry) => entry.location);
    if (subtractedPolygons.length > 0 && data && data.elements) {
        const turfPolys = await Promise.all(
            subtractedPolygons.map(
                async (location) =>
                    turf.combine(
                        await determineGeoJSON(
                            location.properties.osm_id.toString(),
                            location.properties.osm_type,
                        ),
                    ).features[0],
            ),
        );
        data.elements = data.elements.filter((el: any) => {
            const lon = el.center ? el.center.lon : el.lon;
            const lat = el.center ? el.center.lat : el.lat;
            if (typeof lon !== "number" || typeof lat !== "number")
                return false;
            const pt = turf.point([lon, lat]);
            return !turfPolys.some((poly) =>
                turf.booleanPointInPolygon(pt, poly as any),
            );
        });
    }
    return data;
};

export const findPlacesSpecificInZone = async (
    location: `${QuestionSpecificLocation}`,
) => {
    const locations = (
        await findPlacesInZone(
            location,
            `Finding ${
                location === '["brand:wikidata"="Q38076"]'
                    ? "McDonald's"
                    : "7-Elevens"
            }...`,
        )
    ).elements;
    return turf.featureCollection(
        locations.map((x: any) =>
            turf.point([
                x.center ? x.center.lon : x.lon,
                x.center ? x.center.lat : x.lat,
            ]),
        ),
    );
};

export const nearestToQuestion = async (
    question: HomeGameMatchingQuestions | HomeGameMeasuringQuestions,
) => {
    let radius = 30;
    let instances: any = { features: [] };
    while (instances.features.length === 0) {
        instances = await findTentacleLocations(
            {
                lat: question.lat,
                lng: question.lng,
                radius: radius,
                unit: "miles",
                location: false,
                locationType: question.type,
                drag: false,
                color: "black",
                collapsed: false,
            },
            "Finding matching locations...",
        );
        radius += 30;
    }
    const questionPoint = turf.point([question.lng, question.lat]);
    return turf.nearestPoint(questionPoint, instances as any);
};

export const determineMapBoundaries = async () => {
    const primary = mapGeoLocation.get();
    const extras = additionalMapGeoLocations.get();
    const totalPieces = 1 + extras.length;
    // Prefer the wizard's friendly displayName (which already
    // strips admin suffixes like "kommun" / "län" / "Municipality")
    // over the raw OSM `name` field. Falls back to the OSM name,
    // then a generic label if neither is set.
    const friendlyName =
        playArea.get()?.displayName?.split(",")[0]?.trim() ||
        (primary?.properties as { name?: string })?.name ||
        "play area";
    // Strip a few common admin-area suffixes that read as noise on
    // the loading card. We keep the rest of the name verbatim —
    // "Stockholm Municipality" → "Stockholm", but "Île-de-France"
    // is left untouched.
    const areaName = friendlyName.replace(
        /\s+(kommun|län|municipality|county|district|prefecture|province)$/i,
        "",
    );

    // Open the global loading overlay. The LoadingOverlay component
    // renders bytes-downloaded, current phase, and elapsed time.
    // Caller of determineMapBoundaries doesn't need to manage this —
    // we open + close around the full pipeline.
    startLoading(
        `Loading ${areaName}`,
        totalPieces > 1
            ? `Fetching boundaries (1/${totalPieces})…`
            : "Fetching boundary…",
    );

    try {
        // Fan-out fetch all play-area component polygons in parallel.
        // `silent: true` suppresses toast.promise spam (we have the
        // global overlay instead); only the FIRST piece reports byte
        // progress to the overlay — otherwise N parallel streams
        // would clobber each other's byte counts.
        const piecePromises = [
            { location: primary, added: true, base: true },
            ...extras,
        ].map(async (location, idx) => ({
            added: location.added,
            data: await determineGeoJSON(
                location.location.properties.osm_id.toString(),
                location.location.properties.osm_type,
                /* silent */ true,
                /* reportProgress */ idx === 0,
            ),
        }));

        const mapGeoDatum = await Promise.all(piecePromises);

        // Parse phase. osmtogeojson already ran inside
        // determineGeoJSON; what's expensive next is the union /
        // difference / simplify steps over the combined polygon.
        setPhase("Combining boundary polygons…");
        // Give the browser a frame to paint the new phase label
        // before we hit the heavy turf work, otherwise the UI
        // freezes mid-phase and the user thinks we've stalled.
        await new Promise((r) => requestAnimationFrame(r));

        let mapGeoData = turf.featureCollection([
            safeUnion(
                turf.featureCollection(
                    mapGeoDatum
                        .filter((x) => x.added)
                        .flatMap((x) => x.data.features),
                ) as any,
            ),
        ]);

        const differences = mapGeoDatum
            .filter((x) => !x.added)
            .map((x) => x.data);

        if (differences.length > 0) {
            setPhase("Subtracting excluded areas…");
            await new Promise((r) => requestAnimationFrame(r));
            mapGeoData = turf.featureCollection([
                turf.difference(
                    turf.featureCollection([
                        mapGeoData.features[0],
                        ...differences.flatMap((x) => x.features),
                    ]),
                )!,
            ]);
        }

        if (turf.coordAll(mapGeoData).length > 10000) {
            setPhase("Simplifying geometry…");
            await new Promise((r) => requestAnimationFrame(r));
            turf.simplify(mapGeoData, {
                tolerance: 0.0005,
                highQuality: true,
                mutate: true,
            });
        }

        setPhase("Rendering…");
        await new Promise((r) => requestAnimationFrame(r));
        return turf.combine(mapGeoData) as FeatureCollection<MultiPolygon>;
    } finally {
        finishLoading();
    }
};
