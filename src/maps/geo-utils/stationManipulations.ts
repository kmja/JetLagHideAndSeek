import * as turf from "@turf/turf";

import type { StationPlace } from "@/maps/api";

/**
 * Normalise a station name for duplicate detection: strip diacritics,
 * lowercase, drop bracketed/parenthetical qualifiers and common
 * station/mode/direction words, and collapse to bare alphanumerics. So
 * "Schous plass [Trikk]", "Schous plass (T-bane)" and "Schous Plass
 * stasjon" all reduce to "schous plass".
 */
function normalizeStationName(raw: string | undefined | null): string {
    if (!raw) return "";
    return raw
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "") // strip diacritics
        .toLowerCase()
        .replace(/[[(][^\])]*[\])]/g, " ") // drop [..] / (..)
        .replace(
            /\b(stasjon|stasjonen|station|stazione|estacion|estacao|bahnhof|gare|stoppested|holdeplass|platform|plattform|spor|track|gleis|bus|buss|trikk|tram|sporvogn|t-bane|tbane|metro|subway|undergrunn|ferje|ferge|ferry|kai|brygge|nb|sb|eb|wb|northbound|southbound|eastbound|westbound)\b/g,
            " ",
        )
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

/** Cheap equirectangular metres between two [lng,lat] points — accurate
 *  enough at the sub-kilometre scale this clustering works on, and far
 *  cheaper than `turf.distance` across an O(n²) pass. */
function approxMeters(a: number[], b: number[]): number {
    const R = 6_371_000;
    const latMid = (((a[1] + b[1]) / 2) * Math.PI) / 180;
    const x = (((b[0] - a[0]) * Math.PI) / 180) * Math.cos(latMid);
    const y = ((b[1] - a[1]) * Math.PI) / 180;
    return Math.sqrt(x * x + y * y) * R;
}

/**
 * Merge duplicate stations into one (averaged centre). Two stations are
 * the same hub ONLY when they share a NORMALISED name (diacritics,
 * bracketed qualifiers, and mode/direction words stripped — so
 * "Schous plass", "Schous plass [Trikk]" and "Schous Plass stasjon" all
 * match) AND they're reasonably near (within `max(radius, 800 m)` — big
 * enough that a hub's spread-out same-named nodes still collapse).
 *
 * Crucially this is name-based, never proximity-alone: two DIFFERENTLY-
 * named stations that merely sit close together (a train station and a
 * separate bus stop 100 m apart) are distinct hiding zones and BOTH stay
 * selectable — merging by distance risks hiding a real station the hider
 * went to. Clusters form by union-find so a chain of same-named
 * near-duplicates collapses to a single station.
 *
 * @param places  Array of unmerged station point features
 * @param radius  Hiding-zone radius
 * @param units   turf.Units of `radius`
 */
export function mergeDuplicateStation(
    places: StationPlace[],
    radius: number,
    units: turf.Units,
): StationPlace[] {
    const n = places.length;
    if (n <= 1) return places;

    const radiusM = turf.convertLength(radius, units, "meters");
    // Same-named nodes merge when within this distance. A big transit hub
    // (e.g. Oslo's Nationaltheatret: metro + tram + bus + train nodes)
    // spreads its same-named nodes a few hundred metres apart, so a small
    // hiding radius alone wouldn't collapse them. Union-find still chains,
    // so a hub spread over more than this via intermediate nodes merges
    // too. Differently-named stations are never affected.
    const sameNameMergeM = Math.max(radiusM, 800);
    const coords = places.map((p) => p.geometry.coordinates);
    const names = places.map((p) => normalizeStationName(p.properties?.name));

    // Union-find over the stations.
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (x: number): number => {
        while (parent[x] !== x) {
            parent[x] = parent[parent[x]];
            x = parent[x];
        }
        return x;
    };
    const union = (a: number, b: number) => {
        parent[find(a)] = find(b);
    };

    for (let i = 0; i < n; i++) {
        if (names[i] === "") continue; // unnamed nodes never merge
        for (let j = i + 1; j < n; j++) {
            // Same normalised name + reasonably near → duplicate stop.
            if (names[i] !== names[j]) continue;
            if (approxMeters(coords[i], coords[j]) <= sameNameMergeM)
                union(i, j);
        }
    }

    // Group by cluster root, then average each cluster to one station.
    const groups = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
        const r = find(i);
        const g = groups.get(r);
        if (g) g.push(i);
        else groups.set(r, [i]);
    }

    const merged: StationPlace[] = [];
    for (const idxs of groups.values()) {
        const first = places[idxs[0]];
        const avgLng =
            idxs.reduce((s, i) => s + coords[i][0], 0) / idxs.length;
        const avgLat =
            idxs.reduce((s, i) => s + coords[i][1], 0) / idxs.length;
        // Keep the first non-empty original name in the cluster.
        const name =
            idxs
                .map((i) => places[i].properties?.name)
                .find((nm) => nm && String(nm).trim()) ??
            first.properties?.name;
        merged.push({
            ...first,
            properties: { ...first.properties, name },
            geometry: { type: "Point", coordinates: [avgLng, avgLat] },
        } as StationPlace);
    }
    return merged;
}

// Location object definition
export type Location = {
    name?: string;
    type?: string;
    coordinates: number[]; // [longitude, latitude]
};

/**
 * Check if two stations share a zone in a way that both centers are inside the others radius.
 * Both stations must lie within the given radius of each other.
 *
 * Matches:
 *      (...{Z1..Z2)...}
 * Does not match:
 *      (....Z1....) {....Z2....}
 * @param station1 First station location.
 * @param station2 Second station location.
 * @param radius   The zone radius around each station.
 * @param units    The unit for the radius ("miles","kilometers", "meters").
 * @returns        True if both stations share a zone, otherwise false.
 */
export function checkIfStationsShareZones(
    station1: Location,
    station2: Location,
    radius: number,
    units: turf.Units,
): boolean {
    // Convert to turf points
    const point1 = turf.point([
        station1.coordinates[0],
        station1.coordinates[1],
    ]);
    const point2 = turf.point([
        station2.coordinates[0],
        station2.coordinates[1],
    ]);

    // Distance of the 2 center points
    const d = turf.distance(point1, point2, { units });

    // If the distance of the 2 center points is smaller or equal of the radius, the 2 zones overlap.
    return d <= radius;
}
