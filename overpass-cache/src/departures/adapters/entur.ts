/**
 * Entur (Norway) departure-board adapter.
 *
 * Entur's keyless JourneyPlanner v3 GraphQL resolves the nearest stop
 * AND its next departures in a single query via `nearest(...)` →
 * `StopPlace.estimatedCalls`. Same endpoint + `canServe` box + client
 * headers as the trip planner's `entur.ts`.
 *
 * Not live-testable from the sandbox — the PARSER is fixture-tested and
 * a wrong request degrades to an empty board.
 */

import { canServe as enturCanServe } from "../../travel/adapters/entur";
import type { Departure, TravelMode } from "../types";

const ENTUR_GRAPHQL_URL = "https://api.entur.io/journey-planner/v3/graphql";
const UPSTREAM_TIMEOUT_MS = 8_000;
const CLIENT_NAME = "jetlag-hide-and-seek/v1 (https://hideandseek.game)";

export const canServe = enturCanServe;

const BOARD_QUERY = `
query Board($lat: Float!, $lon: Float!, $n: Int!, $start: DateTime!) {
  nearest(
    latitude: $lat
    longitude: $lon
    maximumDistance: 600
    filterByPlaceTypes: [stopPlace]
    first: 1
  ) {
    edges {
      node {
        place {
          __typename
          ... on StopPlace {
            id
            name
            estimatedCalls(numberOfDepartures: $n, startTime: $start) {
              expectedDepartureTime
              aimedDepartureTime
              realtime
              destinationDisplay { frontText }
              serviceJourney { line { publicCode transportMode } }
            }
          }
        }
      }
    }
  }
}
`;

export async function fetchBoard(
    lat: number,
    lng: number,
    when: number,
    max: number,
    signal?: AbortSignal,
): Promise<{ stopName?: string; departures: Departure[] } | null> {
    const variables = {
        lat,
        lon: lng,
        n: max,
        start: new Date(when).toISOString(),
    };
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
    let resp: Response;
    try {
        resp = await fetch(ENTUR_GRAPHQL_URL, {
            method: "POST",
            signal: ctrl.signal,
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
                "ET-Client-Name": CLIENT_NAME,
            },
            body: JSON.stringify({ query: BOARD_QUERY, variables }),
        });
    } catch (e) {
        console.warn("Entur departures fetch failed:", e);
        return null;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
    }
    if (!resp.ok) {
        console.warn("Entur departures non-OK:", resp.status, resp.statusText);
        return null;
    }
    let json: unknown;
    try {
        json = await resp.json();
    } catch {
        return null;
    }
    return parseEnturBoard(json);
}

/* ─────────────────────── Pure parser ─────────────────────── */

/**
 * Normalise Entur's `nearest → StopPlace.estimatedCalls` response into
 * our board. Returns null when no stop resolved. Exported for tests.
 */
export function parseEnturBoard(
    json: unknown,
): { stopName?: string; departures: Departure[] } | null {
    const edges = (
        json as {
            data?: { nearest?: { edges?: unknown[] } };
        }
    )?.data?.nearest?.edges;
    if (!Array.isArray(edges) || edges.length === 0) return null;
    const place = (edges[0] as { node?: { place?: unknown } })?.node?.place as
        | {
              name?: string;
              estimatedCalls?: unknown[];
          }
        | undefined;
    if (!place) return null;

    const calls = Array.isArray(place.estimatedCalls)
        ? place.estimatedCalls
        : [];
    const departures: Departure[] = [];
    for (const c of calls) {
        const call = c as {
            expectedDepartureTime?: string;
            aimedDepartureTime?: string;
            realtime?: boolean;
            destinationDisplay?: { frontText?: string };
            serviceJourney?: {
                line?: { publicCode?: string; transportMode?: string };
            };
        };
        const expected = parseISO(call.expectedDepartureTime);
        const time = expected ?? parseISO(call.aimedDepartureTime);
        if (time == null) continue;
        const d: Departure = {
            time,
            mode: classifyMode(call.serviceJourney?.line?.transportMode),
        };
        if (call.realtime && expected != null) d.realtime = true;
        const line = call.serviceJourney?.line?.publicCode;
        if (line) d.line = line;
        const dir = call.destinationDisplay?.frontText;
        if (dir) d.headsign = dir;
        departures.push(d);
    }
    departures.sort((a, b) => a.time - b.time);
    return { stopName: place.name, departures };
}

/** Entur transportMode: bus, tram, metro, rail, water, air, … */
function classifyMode(mode?: string): TravelMode | "transit" {
    switch ((mode ?? "").toLowerCase()) {
        case "bus":
            return "bus";
        case "tram":
            return "tram";
        case "metro":
            return "subway";
        case "rail":
            return "train";
        case "water":
            return "ferry";
        default:
            return "transit";
    }
}

function parseISO(s?: string): number | null {
    if (!s) return null;
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
}
