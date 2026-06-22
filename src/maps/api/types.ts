import type { Feature, Point, Polygon } from "geojson";

import type { Question } from "@/maps/schema";

/** Leaflet-flavoured tuple kept as a local type so the leaflet
 *  dep can be dropped entirely. The wire shape is unchanged. */
export type LatLngTuple = [number, number];

export interface OpenStreetMap {
    type: string;
    geometry: OpenStreetMapGeometry;
    properties: OpenStreetMapProperties;
}

export interface OpenStreetMapGeometry {
    type: string;
    coordinates: LatLngTuple;
}

export interface OpenStreetMapProperties {
    osm_type: "W" | "R" | "N";
    osm_id: number;
    extent?: number[];
    country?: string;
    state?: string;
    osm_key: string;
    countrycode: string;
    osm_value: string;
    name: string;
    type: string;
    isHidingZone?: boolean;
    questions?: Question[];
}

export interface AdditionalMapGeoLocations {
    added: boolean;
    location: OpenStreetMap;
    base: boolean;
}

export enum QuestionSpecificLocation {
    McDonalds = '["brand:wikidata"="Q38076"]',
    Seven11 = '["brand:wikidata"="Q259340"]',
}

export enum CacheType {
    // `-v2` suffix (v429): the previous namespace can hold entries
    // poisoned by the gzip Content-Encoding caching bug (an overpass
    // response cached with `Content-Encoding: gzip` over an already-
    // decoded body, which then fails to re-parse). Bumping the cache
    // name orphans those entries so every client immediately reads the
    // freshly-fixed namespace instead of waiting for TTL expiry. The
    // old caches are garbage-collected by the browser over time.
    CACHE = "jlhs-map-generator-cache-v2",
    ZONE_CACHE = "jlhs-map-generator-zone-cache-v2",
    PERMANENT_CACHE = "jlhs-map-generator-permanent-cache-v2",
}

export interface CustomStation {
    id: string;
    name?: string;
    lat: number;
    lng: number;
}

export interface StationPlaceProperties {
    id: string;
    [key: string]: string | undefined;
}

export type StationPlace = Feature<Point, StationPlaceProperties>;
export type StationCircle = Feature<Polygon, StationPlace>;

export type {
    APILocations,
    EncompassingTentacleQuestionSchema,
    HomeGameMatchingQuestions,
    HomeGameMeasuringQuestions,
} from "@/maps/schema";
