/**
 * Curated list of major cities to pre-warm into the R2 cache.
 *
 * The weekly cron iterates this list in random order, processing
 * `PREWARM_BATCH_SIZE` entries per run and skipping anything that's
 * already fresh (< CACHE_TTL_DAYS old). Over the course of a few
 * weeks the whole list cycles through, so a real user picking any
 * of these as a play area hits a warm cache on first load.
 *
 * Entries are OSM relation IDs because that's the only thing the
 * seeker app actually fetches (no nodes, no ways — admin
 * boundaries are always relations). To add a city: look it up on
 * openstreetmap.org, copy the relation id from the URL (e.g.
 * `https://www.openstreetmap.org/relation/398021` -> 398021),
 * and add it here.
 *
 * Entries are best-effort — if any of these IDs are stale or
 * wrong, the worker just logs the prewarm failure and moves on;
 * the rest of the cache pipeline is unaffected.
 */

export interface CityEntry {
    name: string;
    /** OSM relation id (numeric, no prefix). */
    relationId: number;
}

export const POPULAR_CITIES: CityEntry[] = [
    // North America
    { name: "New York City", relationId: 175905 },
    { name: "Los Angeles", relationId: 207359 },
    { name: "Chicago", relationId: 122604 },
    { name: "San Francisco", relationId: 111968 },
    { name: "Toronto", relationId: 324211 },
    { name: "Vancouver", relationId: 1852574 },
    { name: "Montreal", relationId: 8508732 },
    { name: "Mexico City", relationId: 1376330 },

    // Europe — Nordic
    { name: "Stockholm", relationId: 398021 },
    { name: "Copenhagen", relationId: 2192363 },
    { name: "Oslo", relationId: 406091 },
    { name: "Helsinki", relationId: 34914 },
    { name: "Gothenburg", relationId: 935611 },
    { name: "Malmö", relationId: 935619 },

    // Europe — UK + Ireland
    { name: "London", relationId: 65606 },
    { name: "Manchester", relationId: 88084 },
    { name: "Edinburgh", relationId: 1920901 },
    { name: "Dublin", relationId: 1109531 },

    // Europe — DACH + Benelux + France
    { name: "Berlin", relationId: 62422 },
    { name: "Hamburg", relationId: 62782 },
    { name: "Munich", relationId: 62428 },
    { name: "Frankfurt", relationId: 62400 },
    { name: "Vienna", relationId: 109166 },
    { name: "Zurich", relationId: 1682248 },
    { name: "Amsterdam", relationId: 47811 },
    { name: "Brussels", relationId: 54094 },
    { name: "Paris", relationId: 7444 },
    { name: "Lyon", relationId: 120965 },

    // Europe — South + East
    { name: "Madrid", relationId: 5326784 },
    { name: "Barcelona", relationId: 347950 },
    { name: "Rome", relationId: 41485 },
    { name: "Milan", relationId: 44915 },
    { name: "Lisbon", relationId: 5400890 },
    { name: "Warsaw", relationId: 336075 },
    { name: "Prague", relationId: 435514 },
    { name: "Budapest", relationId: 37244 },
    { name: "Athens", relationId: 8261138 },

    // Asia
    { name: "Tokyo", relationId: 1543125 },
    { name: "Osaka", relationId: 357794 },
    { name: "Seoul", relationId: 2297418 },
    { name: "Hong Kong", relationId: 913110 },
    { name: "Singapore", relationId: 536780 },
    { name: "Bangkok", relationId: 92277 },
    { name: "Taipei", relationId: 1293250 },

    // Middle East
    { name: "Istanbul", relationId: 223474 },
    { name: "Dubai", relationId: 4479752 },

    // Oceania
    { name: "Sydney", relationId: 5750005 },
    { name: "Melbourne", relationId: 4246124 },
    { name: "Auckland", relationId: 9220551 },

    // South America
    { name: "São Paulo", relationId: 298285 },
    { name: "Buenos Aires", relationId: 1224652 },
    { name: "Santiago", relationId: 3287969 },
];
