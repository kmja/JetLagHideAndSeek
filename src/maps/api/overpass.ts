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
    OVERPASS_API_TERTIARY,
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
    /** User-visible label for THIS query's piece row in the loading
     *  overlay (e.g. "Stockholm Municipality"). Only meaningful when
     *  `reportProgress` is true. The same label is reused for both
     *  primary and fallback mirror attempts so the row updates in
     *  place if we fail over. */
    progressLabel?: string,
) => {
    const encodedQuery = encodeURIComponent(query);
    const primaryUrl = `${OVERPASS_API}?data=${encodedQuery}`;
    const fallbackUrl = `${OVERPASS_API_FALLBACK}?data=${encodedQuery}`;
    const tertiaryUrl = `${OVERPASS_API_TERTIARY}?data=${encodedQuery}`;

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
                progressLabel,
            );
        } catch (e) {
            console.warn(`Overpass fetch failed for ${url}:`, e);
            return null;
        }
    };

    // Failover chain: primary → private.coffee → kumi.systems. We
    // keep the toast pending so the user sees one continuous
    // "Loading map data..." rather than a stop-and-start. Each
    // mirror gets a fresh per-attempt timeout (see fetchTimeoutMs
    // override below — lowered from the original 130s to 45s so a
    // silent mirror doesn't pin the whole pipeline waiting for a
    // response that never comes).
    let response = await tryFetch(primaryUrl);
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
            response = fallbackResponse;
        }
    }
    if (!response || !response.ok) {
        const tertiaryResponse = await tryFetch(tertiaryUrl);
        if (tertiaryResponse && tertiaryResponse.ok) {
            try {
                const cache = await determineCache(cacheType);
                await cache.put(primaryUrl, tertiaryResponse.clone());
            } catch {
                /* no-op */
            }
            response = tertiaryResponse;
        } else if (tertiaryResponse) {
            response = tertiaryResponse;
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
    /** User-visible label for this fetch's piece row in the loading
     *  overlay (e.g. "Stockholm Municipality"). Only meaningful when
     *  `reportProgress` is true. */
    progressLabel?: string,
): Promise<any> => {
    const osmTypeMap: { [key: string]: string } = {
        W: "way",
        R: "relation",
        N: "node",
    };
    const osmType = osmTypeMap[osmTypeLetter];
    // `out geom` (with tags) — `osmtogeojson` relies on the
    // relation's `type=boundary` / `boundary=administrative`
    // tags AND each member way's `role=outer|inner` to assemble
    // a MultiPolygon. Stripping tags via `out skel geom` made the
    // library fall back to raw LineString features, which then
    // crashed `turf.union` with "Input geometry is not a valid
    // Polygon or MultiPolygon" downstream in
    // `determineMapBoundaries`. The bandwidth savings (~20-40 %)
    // weren't worth the broken polygon assembly.
    //
    // `[timeout:120]` gives Overpass headroom server-side for
    // countries — the default 25 s would otherwise time out
    // before the boundary geometry is assembled.
    const query = `[out:json][timeout:120];${osmType}(${osmId});out geom;`;
    // Per-attempt client timeout. Was 130 s (matching the server
    // [timeout:120] + slack), but in practice a mirror that hasn't
    // sent headers within ~30 s is silently hung — and waiting the
    // full 130 s blocks failover to a healthy mirror. 45 s keeps
    // headroom for legitimate slow boundaries (Sweden ~30 s)
    // while letting us fail over from a stuck primary in
    // reasonable time. The chain has three mirrors now
    // (overpass-api.de → private.coffee → kumi.systems), so worst
    // case is 3 × 45 s = 135 s before we surface the error.
    const data = await getOverpassData(
        query,
        silent ? undefined : "Loading map data...",
        CacheType.PERMANENT_CACHE,
        45_000,
        reportProgress,
        progressLabel,
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

/**
 * Max parallel Overpass boundary fetches inside
 * `determineMapBoundaries`. Set to 4 so we stay well below the
 * browser's ~6-per-origin connection limit AND the public
 * Overpass mirrors' rate-limit threshold (the cause of the
 * cascade of "failed" rows on multi-area games observed in the
 * wild). The primary boundary is first in the queue, so it
 * always grabs a slot immediately; the rest stream in 3 at a
 * time alongside it.
 */
const BOUNDARY_FETCH_CONCURRENCY = 4;

/**
 * Tiny promise pool — runs `worker` over `items` with at most
 * `limit` in flight at any one time, preserving result order.
 * No dependency required; we spawn N runner loops that each
 * pull the next index off a shared counter.
 */
async function mapWithConcurrency<T, R>(
    items: T[],
    limit: number,
    worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    const workers = new Array(Math.min(limit, items.length))
        .fill(0)
        .map(async () => {
            while (true) {
                const i = next++;
                if (i >= items.length) return;
                results[i] = await worker(items[i], i);
            }
        });
    await Promise.all(workers);
    return results;
}

export const determineMapBoundaries = async () => {
    const primary = mapGeoLocation.get();
    const extras = additionalMapGeoLocations.get();
    const totalPieces = 1 + extras.length;
    // Shared helper — strips a few common admin-area suffixes that
    // read as noise on the loading card. We keep the rest of the
    // name verbatim — "Stockholm Municipality" → "Stockholm", but
    // "Île-de-France" is left untouched.
    const stripAdminSuffix = (s: string) =>
        s.replace(
            /\s+(kommun|län|municipality|county|district|prefecture|province)$/i,
            "",
        );
    // Prefer the wizard's friendly displayName (which already
    // strips admin suffixes like "kommun" / "län" / "Municipality")
    // over the raw OSM `name` field. Falls back to the OSM name,
    // then a generic label if neither is set.
    const friendlyName =
        playArea.get()?.displayName?.split(",")[0]?.trim() ||
        (primary?.properties as { name?: string })?.name ||
        "play area";
    const areaName = stripAdminSuffix(friendlyName);

    // Per-piece labels so each adjacent area gets its own row in
    // the loading overlay. The primary piece keeps the friendlier
    // wizard displayName; adjacents fall back to their raw OSM name
    // (which is the only thing we have at this point).
    const labelFor = (loc: typeof primary, isPrimary: boolean): string => {
        if (isPrimary) return areaName;
        const raw = (loc?.properties as { name?: string })?.name;
        return raw ? stripAdminSuffix(raw) : "Adjacent area";
    };

    // Open the global loading overlay. The LoadingOverlay component
    // renders bytes-downloaded, current phase, and elapsed time.
    // Caller of determineMapBoundaries doesn't need to manage this —
    // we open + close around the full pipeline.
    //
    // Concurrency cap below: we don't fan all 14 areas out at once,
    // we run BOUNDARY_FETCH_CONCURRENCY in flight at a time. That
    // matches the phase text — "4 at a time" — to what the user
    // actually sees in the per-piece list (most rows queue, four
    // stream).
    startLoading(
        `Loading ${areaName}`,
        totalPieces > 1
            ? `Fetching ${totalPieces} areas (${Math.min(
                  totalPieces,
                  BOUNDARY_FETCH_CONCURRENCY,
              )} at a time)…`
            : "Fetching boundary…",
    );

    try {
        // Fan-out fetch all play-area component polygons in parallel.
        // `silent: true` suppresses toast.promise spam (we have the
        // global overlay instead). Each piece now reports its OWN
        // byte progress AND its own labeled row in the loading
        // overlay — the loadingPieces atom holds one entry per URL
        // so the user sees a list like:
        //   • Stockholm — 2.1 / ~9 MB
        //   • Solna     — done
        //   • Sundbyberg — waiting…
        // even while one big primary is still server-computing.
        //
        // We cap concurrency at BOUNDARY_FETCH_CONCURRENCY (4) rather
        // than letting every adjacent fan out at once. Browsers limit
        // HTTP/1.1 connections to ~6 per origin, and Overpass mirrors
        // are a single origin each, so 14+ simultaneous fetches just
        // queue up at the network layer AND trigger the public
        // mirror's rate limit (the cause of the cascade of "failed"
        // rows users were seeing on multi-area games like Manchester +
        // 13 adjacents). 4 keeps us under the rate limit AND leaves
        // browser connection slots free for the rest of the app.
        const entries = [
            { location: primary, added: true, base: true },
            ...extras.map((e) => ({ ...e, base: false })),
        ];
        const fetchEntry = async (entry: (typeof entries)[number]) => ({
            added: entry.added,
            data: await determineGeoJSON(
                entry.location.properties.osm_id.toString(),
                entry.location.properties.osm_type,
                /* silent */ true,
                /* reportProgress */ true,
                labelFor(entry.location, entry.base),
            ),
        });
        const mapGeoDatum = await mapWithConcurrency(
            entries,
            BOUNDARY_FETCH_CONCURRENCY,
            fetchEntry,
        );

        // Retry pass for empty-result pieces. The user-visible
        // symptom this fixes: occasionally a multi-area load
        // completes "successfully" but with one or more adjacent
        // areas silently missing — usually because the Overpass
        // public mirror rate-limited that one fetch and getOverpassData
        // returned `{ elements: [] }` rather than throwing. The fix
        // is to detect any feature-empty entries after the initial
        // pass and re-fetch JUST those after a small delay, giving
        // the rate-limit window time to relax.
        for (let attempt = 1; attempt <= 2; attempt++) {
            const failedIdx: number[] = [];
            mapGeoDatum.forEach((result, i) => {
                if (
                    !result?.data?.features ||
                    result.data.features.length === 0
                ) {
                    failedIdx.push(i);
                }
            });
            if (failedIdx.length === 0) break;
            // Don't burn retries on a totally-broken initial pass
            // (every piece empty) — that's a hard failure, not a
            // rate-limit blip. Let the outer flow surface it.
            if (failedIdx.length === entries.length) break;
            setPhase(
                `Retrying ${failedIdx.length} area${failedIdx.length === 1 ? "" : "s"}…`,
            );
            await new Promise((r) => setTimeout(r, attempt * 3000));
            const retried = await mapWithConcurrency(
                failedIdx.map((i) => entries[i]),
                BOUNDARY_FETCH_CONCURRENCY,
                fetchEntry,
            );
            retried.forEach((result, j) => {
                const i = failedIdx[j];
                // Only replace if the retry actually returned features —
                // a second empty result is worse than no replacement.
                if (
                    result?.data?.features &&
                    result.data.features.length > 0
                ) {
                    mapGeoDatum[i] = result;
                }
            });
        }

        // Parse phase. osmtogeojson already ran inside
        // determineGeoJSON; what's expensive next is the union /
        // difference / simplify steps over the combined polygon.
        setPhase("Combining boundary polygons…");
        // Give the browser a frame to paint the new phase label
        // before we hit the heavy turf work, otherwise the UI
        // freezes mid-phase and the user thinks we've stalled.
        await new Promise((r) => requestAnimationFrame(r));

        // Skip anything that isn't a closed polygon/multipolygon
        // before the union — a single unclosed way (rare but it
        // happens on OSM relations with missing role tags) would
        // otherwise crash turf.union with "Input geometry is not
        // a valid Polygon or MultiPolygon".
        const isPolygonal = (f: any) =>
            f?.geometry?.type === "Polygon" ||
            f?.geometry?.type === "MultiPolygon";
        const addedFeatures = mapGeoDatum
            .filter((x) => x.added)
            .flatMap((x) => x.data.features)
            .filter(isPolygonal);
        if (addedFeatures.length === 0) {
            throw new Error(
                "Boundary fetch returned no usable polygon features.",
            );
        }
        let mapGeoData = turf.featureCollection([
            safeUnion(
                turf.featureCollection(addedFeatures) as any,
            ),
        ]);

        const differences = mapGeoDatum
            .filter((x) => !x.added)
            .map((x) => x.data);

        if (differences.length > 0) {
            setPhase("Subtracting excluded areas…");
            await new Promise((r) => requestAnimationFrame(r));
            const subtractFeatures = differences
                .flatMap((x) => x.features)
                .filter(isPolygonal);
            if (subtractFeatures.length > 0) {
                const diff = turf.difference(
                    turf.featureCollection([
                        mapGeoData.features[0],
                        ...subtractFeatures,
                    ]),
                );
                // turf.difference returns null when the result
                // is empty (subtractions covered the whole base).
                // Preserve the original boundary in that case
                // rather than throwing.
                if (diff) {
                    mapGeoData = turf.featureCollection([diff]);
                }
            }
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
