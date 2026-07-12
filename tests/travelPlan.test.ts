import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { Env } from "../overpass-cache/src/envTypes";
import {
    haversineMeters,
    WALK_CIRCUITY,
    walkingJourney,
} from "../overpass-cache/src/travel/adapters/walking";
import {
    canServe,
    parseResRobotTrip,
} from "../overpass-cache/src/travel/adapters/trafiklab";
import { parseEnturTrip } from "../overpass-cache/src/travel/adapters/entur";
import { parseDigitransitPlan } from "../overpass-cache/src/travel/adapters/digitransit";
import { parseTflJourney } from "../overpass-cache/src/travel/adapters/tfl";
import { parseSwissConnections } from "../overpass-cache/src/travel/adapters/swiss";
import { parseFptfJourneys } from "../overpass-cache/src/travel/adapters/germany";
import { parseNavitiaJourneys } from "../overpass-cache/src/travel/adapters/navitia";
import { parseRejseplanenTrip } from "../overpass-cache/src/travel/adapters/denmark";
import { parseEfaTrip } from "../overpass-cache/src/travel/adapters/nsw";
import { parseMotisPlan } from "../overpass-cache/src/travel/adapters/transitous";
import { parseOtpPlan } from "../overpass-cache/src/travel/adapters/otp";
import { parseOdsayPath } from "../overpass-cache/src/travel/adapters/korea";
import { parseNsTrip } from "../overpass-cache/src/travel/adapters/netherlands";
import {
    dispatchPlan,
    journeyModesAllowed,
    selectAdapters,
} from "../overpass-cache/src/travel/router";
import type {
    Journey,
    PlanRequest,
    TravelPlace,
} from "../overpass-cache/src/travel/types";

const STOCKHOLM = { lat: 59.3293, lng: 18.0686 };
const OSLO = { lat: 59.9139, lng: 10.7522 };
const HELSINKI = { lat: 60.1699, lng: 24.9384 };
const LONDON = { lat: 51.5072, lng: -0.1276 };
const ZURICH = { lat: 47.3769, lng: 8.5417 };
const BERLIN = { lat: 52.52, lng: 13.405 };
const TOKYO = { lat: 35.6812, lng: 139.7671 };

/** Empty env → no Trafiklab key, so the Trafiklab adapter defers and
 *  everything resolves to walking with zero network access. */
const NO_KEY_ENV = {} as unknown as Env;

describe("haversineMeters", () => {
    test("one degree of latitude is ~111 km", () => {
        const d = haversineMeters({ lat: 0, lng: 0 }, { lat: 1, lng: 0 });
        expect(d).toBeGreaterThan(111_000);
        expect(d).toBeLessThan(111_400);
    });

    test("zero distance for identical points", () => {
        expect(haversineMeters(STOCKHOLM, STOCKHOLM)).toBe(0);
    });
});

describe("walkingJourney", () => {
    test("single walk leg, no transfers, forward-in-time", () => {
        const dest: TravelPlace = { lat: 59.34, lng: 18.08, name: "Somewhere" };
        const depart = 1_700_000_000_000;
        const j = walkingJourney(STOCKHOLM, dest, depart);

        expect(j.legs).toHaveLength(1);
        expect(j.legs[0].mode).toBe("walk");
        expect(j.transfers).toBe(0);
        expect(j.departAt).toBe(depart);
        expect(j.arriveAt).toBeGreaterThan(depart);
        expect(j.durationMin).toBeGreaterThanOrEqual(1);
        expect(j.legs[0].to.name).toBe("Somewhere");
    });

    test("distance reflects the circuity factor", () => {
        const dest: TravelPlace = { lat: 59.34, lng: 18.08 };
        const j = walkingJourney(STOCKHOLM, dest, 0);
        const straight = haversineMeters(STOCKHOLM, dest);
        expect(j.legs[0].distanceMeters).toBe(
            Math.round(straight * WALK_CIRCUITY),
        );
    });
});

describe("adapter dispatch selection", () => {
    // The universal fallbacks are appended to EVERY origin, after the
    // free regional/navitia tiers: self-hosted MOTIS (env-gated, but
    // canServe is always true) → public Transitous → walking.
    const U = ["motis-self-hosted", "transitous", "walking"];

    test("Trafiklab serves Sweden, defers elsewhere", () => {
        expect(canServe(STOCKHOLM.lat, STOCKHOLM.lng)).toBe(true);
        expect(canServe(TOKYO.lat, TOKYO.lng)).toBe(false);
    });

    // European cities: country adapter → navitia → universal tail.
    test("Stockholm: trafiklab → navitia → universal", () => {
        expect(
            selectAdapters(STOCKHOLM.lat, STOCKHOLM.lng).map((a) => a.id),
        ).toEqual(["trafiklab", "navitia", ...U]);
    });

    test("Oslo: entur → navitia → universal", () => {
        expect(selectAdapters(OSLO.lat, OSLO.lng).map((a) => a.id)).toEqual([
            "entur",
            "navitia",
            ...U,
        ]);
    });

    test("Helsinki: digitransit → navitia → universal", () => {
        expect(
            selectAdapters(HELSINKI.lat, HELSINKI.lng).map((a) => a.id),
        ).toEqual(["digitransit", "navitia", ...U]);
    });

    test("London: tfl → navitia → universal", () => {
        expect(selectAdapters(LONDON.lat, LONDON.lng).map((a) => a.id)).toEqual(
            ["tfl", "navitia", ...U],
        );
    });

    test("Berlin: germany → navitia → universal", () => {
        expect(selectAdapters(BERLIN.lat, BERLIN.lng).map((a) => a.id)).toEqual(
            ["germany", "navitia", ...U],
        );
    });

    test("Swiss and Germany country adapters are disjoint at the border", () => {
        // The first entry is the country adapter that fires.
        expect(selectAdapters(ZURICH.lat, ZURICH.lng).map((a) => a.id)[0]).toBe(
            "swiss",
        );
        expect(selectAdapters(48.1374, 11.5755).map((a) => a.id)[0]).toBe(
            "germany",
        );
    });

    test("Paris: IDFM PRIM (france) first, then broad navitia, then universal", () => {
        // PRIM is the authoritative Île-de-France source + a separate
        // free quota pool, so it's ordered ahead of the broad navitia.io
        // fallback for the IdF bbox.
        expect(selectAdapters(48.8566, 2.3522).map((a) => a.id)).toEqual([
            "france",
            "navitia",
            ...U,
        ]);
    });

    test("Copenhagen: denmark first (ahead of trafiklab in the Øresund overlap)", () => {
        expect(selectAdapters(55.6761, 12.5683).map((a) => a.id)).toEqual([
            "denmark",
            "trafiklab",
            "navitia",
            ...U,
        ]);
    });

    test("Sydney: official nsw first, La Trobe AU as a fallback, then universal", () => {
        // La Trobe AU OTP is keyless but academic-hosted, so it's
        // ordered AFTER the official TfNSW EFA — Sydney still hits
        // nsw.ts first when a key is configured; the AU OTP only
        // serves if NSW defers or fails.
        expect(selectAdapters(-33.8688, 151.2093).map((a) => a.id)).toEqual([
            "nsw",
            "australia",
            ...U,
        ]);
    });

    test("Tokyo: no free regional adapter, universal fallbacks then walking", () => {
        expect(selectAdapters(TOKYO.lat, TOKYO.lng).map((a) => a.id)).toEqual(
            U,
        );
    });

    // New free regional adapters fire first in their region.
    test("Tallinn → estonia", () => {
        expect(selectAdapters(59.437, 24.7536).map((a) => a.id)[0]).toBe(
            "estonia",
        );
    });
    test("Vienna → austria (after germany in the chain, but first in AT)", () => {
        expect(selectAdapters(48.2082, 16.3738).map((a) => a.id)[0]).toBe(
            "austria",
        );
    });
    test("Dublin → ireland", () => {
        expect(selectAdapters(53.3498, -6.2603).map((a) => a.id)[0]).toBe(
            "ireland",
        );
    });
    test("Barcelona → barcelona", () => {
        expect(selectAdapters(41.3874, 2.1686).map((a) => a.id)[0]).toBe(
            "barcelona",
        );
    });
    test("Amsterdam → netherlands", () => {
        expect(selectAdapters(52.3676, 4.9041).map((a) => a.id)[0]).toBe(
            "netherlands",
        );
    });
    test("Seoul → korea (isolated)", () => {
        expect(selectAdapters(37.5665, 126.978).map((a) => a.id)).toEqual([
            "korea",
            ...U,
        ]);
    });

    test("walking is always last; universal MOTIS fallbacks always present", () => {
        for (const [lat, lng] of [
            [STOCKHOLM.lat, STOCKHOLM.lng],
            [TOKYO.lat, TOKYO.lng],
            [-33.8688, 151.2093],
            [40.7128, -74.006], // NYC
            [1.3521, 103.8198], // Singapore
        ] as const) {
            const ids = selectAdapters(lat, lng).map((a) => a.id);
            expect(ids[ids.length - 1]).toBe("walking");
            expect(ids).toContain("transitous");
        }
    });
});

describe("dispatchPlan falls back to walking without a key", () => {
    // These tests exercise the REAL dispatcher, whose keyless adapters
    // (transitous, entur, …) genuinely fetch their upstreams. Stub fetch
    // to reject so the tests are HERMETIC: in an environment with
    // internet (the Cloudflare build) Transitous otherwise answers with
    // a real journey and "expect walking" flakes — which is exactly what
    // broke the first gated deploy. With every upstream unreachable, the
    // dispatcher must degrade to the walking backstop.
    beforeEach(() => {
        vi.stubGlobal(
            "fetch",
            vi.fn(() =>
                Promise.reject(new Error("network disabled in test")),
            ),
        );
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    test("Stockholm with no key resolves to a walking journey", async () => {
        const req: PlanRequest = {
            origin: STOCKHOLM,
            destination: { lat: 59.86, lng: 17.64, name: "Uppsala" },
        };
        const { source, journey } = await dispatchPlan(
            req,
            Date.now(),
            NO_KEY_ENV,
        );
        expect(source).toBe("walking");
        expect(journey).not.toBeNull();
        expect(journey!.legs[0].mode).toBe("walk");
    });

    test("Tokyo resolves to a walking journey", async () => {
        const req: PlanRequest = {
            origin: TOKYO,
            destination: { lat: 35.69, lng: 139.7, name: "Shinjuku" },
        };
        const { source, journey } = await dispatchPlan(
            req,
            Date.now(),
            NO_KEY_ENV,
        );
        expect(source).toBe("walking");
        expect(journey).not.toBeNull();
    });
});

describe("parseResRobotTrip", () => {
    const FIXTURE = {
        Trip: [
            {
                transferCount: 0,
                LegList: {
                    Leg: [
                        {
                            type: "WALK",
                            name: "Walk",
                            dist: 320,
                            Origin: {
                                name: "Start",
                                lat: 59.33,
                                lon: 18.06,
                                date: "2026-06-21",
                                time: "12:00:00",
                            },
                            Destination: {
                                name: "Stockholm Centralstation",
                                lat: 59.33,
                                lon: 18.058,
                                date: "2026-06-21",
                                time: "12:05:00",
                            },
                        },
                        {
                            type: "JNY",
                            name: "Tåg 43",
                            direction: "Uppsala",
                            Product: [
                                {
                                    name: "Tåg 43",
                                    catOut: "Tåg",
                                    catOutL: "Regionaltåg",
                                },
                            ],
                            Origin: {
                                name: "Stockholm Centralstation",
                                lat: 59.33,
                                lon: 18.058,
                                date: "2026-06-21",
                                time: "12:10:00",
                            },
                            Destination: {
                                name: "Uppsala C",
                                lat: 59.858,
                                lon: 17.646,
                                date: "2026-06-21",
                                time: "12:48:00",
                            },
                        },
                    ],
                },
            },
        ],
    };

    const destFallback: TravelPlace = {
        lat: 59.858,
        lng: 17.646,
        name: "Uppsala C",
    };

    test("normalises a two-leg trip", () => {
        const j = parseResRobotTrip(FIXTURE, destFallback);
        expect(j).not.toBeNull();
        expect(j!.legs).toHaveLength(2);

        expect(j!.legs[0].mode).toBe("walk");
        expect(j!.legs[0].distanceMeters).toBe(320);

        expect(j!.legs[1].mode).toBe("train");
        expect(j!.legs[1].line).toBe("Tåg 43");
        expect(j!.legs[1].direction).toBe("Uppsala");
        expect(j!.legs[1].to.name).toBe("Uppsala C");

        expect(j!.transfers).toBe(0);
        expect(j!.durationMin).toBe(48);
        expect(j!.arriveAt).toBeGreaterThan(j!.departAt);
    });

    test("returns null on an empty trip list", () => {
        expect(parseResRobotTrip({ Trip: [] }, destFallback)).toBeNull();
        expect(parseResRobotTrip({}, destFallback)).toBeNull();
        expect(parseResRobotTrip(null, destFallback)).toBeNull();
    });
});

describe("parseEnturTrip", () => {
    const FIXTURE = {
        data: {
            trip: {
                tripPatterns: [
                    {
                        expectedStartTime: "2026-06-21T12:00:00+02:00",
                        expectedEndTime: "2026-06-21T12:25:00+02:00",
                        legs: [
                            {
                                mode: "foot",
                                distance: 250,
                                expectedStartTime: "2026-06-21T12:00:00+02:00",
                                expectedEndTime: "2026-06-21T12:04:00+02:00",
                                fromPlace: {
                                    name: "Start",
                                    latitude: 59.91,
                                    longitude: 10.75,
                                },
                                toPlace: {
                                    name: "Jernbanetorget",
                                    latitude: 59.911,
                                    longitude: 10.752,
                                },
                            },
                            {
                                mode: "metro",
                                expectedStartTime: "2026-06-21T12:05:00+02:00",
                                expectedEndTime: "2026-06-21T12:25:00+02:00",
                                fromPlace: {
                                    name: "Jernbanetorget",
                                    latitude: 59.911,
                                    longitude: 10.752,
                                },
                                toPlace: {
                                    name: "Majorstuen",
                                    latitude: 59.929,
                                    longitude: 10.715,
                                },
                                line: { publicCode: "5", name: "T-banen 5" },
                                fromEstimatedCall: {
                                    destinationDisplay: { frontText: "Vestli" },
                                },
                            },
                        ],
                    },
                ],
            },
        },
    };

    const dest: TravelPlace = { lat: 59.929, lng: 10.715, name: "Majorstuen" };

    test("normalises a foot+metro itinerary", () => {
        const j = parseEnturTrip(FIXTURE, dest);
        expect(j).not.toBeNull();
        expect(j!.legs).toHaveLength(2);
        expect(j!.legs[0].mode).toBe("walk");
        expect(j!.legs[1].mode).toBe("subway");
        expect(j!.legs[1].line).toBe("5");
        expect(j!.legs[1].direction).toBe("Vestli");
        expect(j!.transfers).toBe(0);
        expect(j!.durationMin).toBe(25);
    });

    test("returns null when no patterns", () => {
        expect(
            parseEnturTrip({ data: { trip: { tripPatterns: [] } } }, dest),
        ).toBeNull();
        expect(parseEnturTrip({}, dest)).toBeNull();
    });
});

describe("parseDigitransitPlan", () => {
    // Digitransit returns epoch seconds in `startTime`/`endTime`.
    const T_START = 1_750_000_000; // some 2025-ish second timestamp
    const T_END = T_START + 22 * 60;

    const FIXTURE = {
        data: {
            plan: {
                itineraries: [
                    {
                        startTime: T_START,
                        endTime: T_END,
                        legs: [
                            {
                                mode: "WALK",
                                distance: 180,
                                startTime: T_START,
                                endTime: T_START + 3 * 60,
                                from: { name: "Start", lat: 60.17, lon: 24.94 },
                                to: {
                                    name: "Rautatientori",
                                    lat: 60.171,
                                    lon: 24.942,
                                },
                            },
                            {
                                mode: "SUBWAY",
                                startTime: T_START + 4 * 60,
                                endTime: T_END,
                                from: {
                                    name: "Rautatientori",
                                    lat: 60.171,
                                    lon: 24.942,
                                },
                                to: {
                                    name: "Itäkeskus",
                                    lat: 60.211,
                                    lon: 25.082,
                                },
                                route: { shortName: "M2", longName: "Metro" },
                                headsign: "Mellunmäki",
                            },
                        ],
                    },
                ],
            },
        },
    };

    const dest: TravelPlace = { lat: 60.211, lng: 25.082, name: "Itäkeskus" };

    test("handles second-resolution timestamps + mode mapping", () => {
        const j = parseDigitransitPlan(FIXTURE, dest);
        expect(j).not.toBeNull();
        expect(j!.legs).toHaveLength(2);
        expect(j!.legs[1].mode).toBe("subway");
        expect(j!.legs[1].line).toBe("M2");
        expect(j!.legs[1].direction).toBe("Mellunmäki");
        // Round-trip times should be in ms (parser multiplies seconds × 1000).
        expect(j!.departAt).toBe(T_START * 1000);
        expect(j!.arriveAt).toBe(T_END * 1000);
        expect(j!.durationMin).toBe(22);
    });

    test("returns null on empty itineraries", () => {
        expect(
            parseDigitransitPlan({ data: { plan: { itineraries: [] } } }, dest),
        ).toBeNull();
    });
});

describe("parseTflJourney", () => {
    const FIXTURE = {
        journeys: [
            {
                startDateTime: "2026-06-21T12:00:00",
                arrivalDateTime: "2026-06-21T12:35:00",
                legs: [
                    {
                        mode: { id: "walking", name: "walking" },
                        departureTime: "2026-06-21T12:00:00",
                        arrivalTime: "2026-06-21T12:08:00",
                        departurePoint: {
                            commonName: "Start",
                            lat: 51.507,
                            lon: -0.128,
                        },
                        arrivalPoint: {
                            commonName: "Victoria Stn",
                            lat: 51.495,
                            lon: -0.143,
                        },
                        distance: 1200,
                    },
                    {
                        mode: { id: "tube", name: "tube" },
                        departureTime: "2026-06-21T12:12:00",
                        arrivalTime: "2026-06-21T12:35:00",
                        departurePoint: {
                            commonName: "Victoria Stn",
                            lat: 51.495,
                            lon: -0.143,
                        },
                        arrivalPoint: {
                            commonName: "Walthamstow Central",
                            lat: 51.583,
                            lon: -0.019,
                        },
                        routeOptions: [
                            {
                                name: "Victoria Line",
                                directions: ["Walthamstow"],
                            },
                        ],
                    },
                ],
            },
        ],
    };

    const dest: TravelPlace = {
        lat: 51.583,
        lng: -0.019,
        name: "Walthamstow Central",
    };

    test("normalises walking + tube", () => {
        const j = parseTflJourney(FIXTURE, dest);
        expect(j).not.toBeNull();
        expect(j!.legs).toHaveLength(2);
        expect(j!.legs[0].mode).toBe("walk");
        expect(j!.legs[1].mode).toBe("subway");
        expect(j!.legs[1].line).toBe("Victoria Line");
        expect(j!.legs[1].direction).toBe("Walthamstow");
        expect(j!.durationMin).toBe(35);
    });

    test("returns null on empty journeys", () => {
        expect(parseTflJourney({ journeys: [] }, dest)).toBeNull();
    });
});

describe("parseSwissConnections", () => {
    // Swiss API uses Unix-second timestamps + ISO strings.
    const T_DEP = 1_750_000_000;
    const T_ARR = T_DEP + 12 * 60;
    const FIXTURE = {
        connections: [
            {
                duration: "00d00:12:00",
                sections: [
                    {
                        journey: {
                            category: "S",
                            number: "6",
                            name: "S6",
                            to: "Uetikon am See",
                        },
                        departure: {
                            station: {
                                name: "Zürich HB",
                                coordinate: { x: 47.3779, y: 8.5403 },
                            },
                            departureTimestamp: T_DEP,
                        },
                        arrival: {
                            station: {
                                name: "Stadelhofen",
                                coordinate: { x: 47.3667, y: 8.5478 },
                            },
                            arrivalTimestamp: T_DEP + 4 * 60,
                        },
                    },
                    {
                        walk: { duration: 480 },
                        departure: {
                            station: {
                                name: "Stadelhofen",
                                coordinate: { x: 47.3667, y: 8.5478 },
                            },
                            departureTimestamp: T_DEP + 4 * 60,
                        },
                        arrival: {
                            station: {
                                name: "Opernhaus",
                                coordinate: { x: 47.3651, y: 8.5469 },
                            },
                            arrivalTimestamp: T_ARR,
                        },
                    },
                ],
            },
        ],
    };

    const dest: TravelPlace = { lat: 47.3651, lng: 8.5469, name: "Opernhaus" };

    test("normalises S-Bahn + walk", () => {
        const j = parseSwissConnections(FIXTURE, dest);
        expect(j).not.toBeNull();
        expect(j!.legs).toHaveLength(2);
        expect(j!.legs[0].mode).toBe("train");
        expect(j!.legs[0].line).toBe("S6");
        expect(j!.legs[0].direction).toBe("Uetikon am See");
        expect(j!.legs[1].mode).toBe("walk");
        expect(j!.durationMin).toBe(12);
        expect(j!.departAt).toBe(T_DEP * 1000);
        expect(j!.arriveAt).toBe(T_ARR * 1000);
    });

    test("returns null when no connections", () => {
        expect(parseSwissConnections({ connections: [] }, dest)).toBeNull();
    });
});

describe("parseFptfJourneys (Germany / transport.rest)", () => {
    const FIXTURE = {
        journeys: [
            {
                legs: [
                    {
                        walking: true,
                        distance: 240,
                        departure: "2026-06-21T12:00:00+02:00",
                        arrival: "2026-06-21T12:03:00+02:00",
                        origin: {
                            name: "Start",
                            location: { latitude: 52.52, longitude: 13.405 },
                        },
                        destination: {
                            name: "S+U Berlin Hauptbahnhof",
                            location: { latitude: 52.525, longitude: 13.369 },
                        },
                    },
                    {
                        departure: "2026-06-21T12:08:00+02:00",
                        arrival: "2026-06-21T12:22:00+02:00",
                        direction: "S Ostbahnhof",
                        line: {
                            name: "S5",
                            mode: "train",
                            product: "suburban",
                        },
                        origin: {
                            name: "S+U Berlin Hauptbahnhof",
                            location: { latitude: 52.525, longitude: 13.369 },
                        },
                        destination: {
                            name: "S+U Alexanderplatz",
                            location: { latitude: 52.521, longitude: 13.411 },
                        },
                    },
                    {
                        departure: "2026-06-21T12:24:00+02:00",
                        arrival: "2026-06-21T12:30:00+02:00",
                        direction: "Hönow",
                        line: { name: "U5", mode: "train", product: "subway" },
                        origin: {
                            name: "S+U Alexanderplatz",
                            location: { latitude: 52.521, longitude: 13.411 },
                        },
                        destination: {
                            name: "U Frankfurter Tor",
                            location: { latitude: 52.516, longitude: 13.454 },
                        },
                    },
                ],
            },
        ],
    };

    const dest: TravelPlace = {
        lat: 52.516,
        lng: 13.454,
        name: "U Frankfurter Tor",
    };

    test("normalises walk + S-Bahn + U-Bahn, product-aware modes", () => {
        const j = parseFptfJourneys(FIXTURE, dest);
        expect(j).not.toBeNull();
        expect(j!.legs).toHaveLength(3);
        expect(j!.legs[0].mode).toBe("walk");
        expect(j!.legs[0].distanceMeters).toBe(240);
        // suburban → train; subway → subway (product wins over coarse mode).
        expect(j!.legs[1].mode).toBe("train");
        expect(j!.legs[1].line).toBe("S5");
        expect(j!.legs[2].mode).toBe("subway");
        expect(j!.legs[2].line).toBe("U5");
        expect(j!.transfers).toBe(1); // two transit legs
        expect(j!.durationMin).toBe(30);
    });

    test("returns null on empty journeys", () => {
        expect(parseFptfJourneys({ journeys: [] }, dest)).toBeNull();
        expect(parseFptfJourneys({}, dest)).toBeNull();
    });
});

describe("parseNavitiaJourneys (navitia / Paris)", () => {
    const FIXTURE = {
        journeys: [
            {
                sections: [
                    {
                        type: "street_network",
                        mode: "walking",
                        departure_date_time: "20260621T120000",
                        arrival_date_time: "20260621T120400",
                        from: {
                            name: "Start",
                            address: {
                                name: "Start",
                                coord: { lat: "48.8566", lon: "2.3522" },
                            },
                        },
                        to: {
                            name: "Châtelet",
                            stop_point: {
                                name: "Châtelet",
                                coord: { lat: "48.8585", lon: "2.3470" },
                            },
                        },
                    },
                    {
                        type: "waiting",
                        departure_date_time: "20260621T120400",
                        arrival_date_time: "20260621T120600",
                    },
                    {
                        type: "public_transport",
                        departure_date_time: "20260621T120600",
                        arrival_date_time: "20260621T121800",
                        from: {
                            stop_point: {
                                name: "Châtelet",
                                coord: { lat: "48.8585", lon: "2.3470" },
                            },
                        },
                        to: {
                            stop_point: {
                                name: "Gare du Nord",
                                coord: { lat: "48.8809", lon: "2.3553" },
                            },
                        },
                        display_informations: {
                            physical_mode: "Metro",
                            commercial_mode: "métro",
                            code: "4",
                            direction: "Porte de Clignancourt",
                        },
                    },
                ],
            },
        ],
    };

    const dest: TravelPlace = {
        lat: 48.8809,
        lng: 2.3553,
        name: "Gare du Nord",
    };

    test("normalises walk + metro, skips the waiting section", () => {
        const j = parseNavitiaJourneys(FIXTURE, dest);
        expect(j).not.toBeNull();
        // waiting section dropped → 2 legs, not 3.
        expect(j!.legs).toHaveLength(2);
        expect(j!.legs[0].mode).toBe("walk");
        expect(j!.legs[1].mode).toBe("subway");
        expect(j!.legs[1].line).toBe("4");
        expect(j!.legs[1].direction).toBe("Porte de Clignancourt");
        expect(j!.legs[1].to.name).toBe("Gare du Nord");
        expect(j!.transfers).toBe(0);
        expect(j!.durationMin).toBe(18);
    });

    test("returns null on empty journeys", () => {
        expect(parseNavitiaJourneys({ journeys: [] }, dest)).toBeNull();
        expect(parseNavitiaJourneys({}, dest)).toBeNull();
    });
});

describe("parseRejseplanenTrip (Denmark / HAFAS)", () => {
    // Rejseplanen uses dd.MM.yy dates, HH:MM times, microdegree X/Y,
    // and Leg can be a single object or an array.
    const FIXTURE = {
        TripList: {
            Trip: [
                {
                    Leg: [
                        {
                            type: "WALK",
                            name: "Walk",
                            Origin: {
                                name: "Start",
                                x: "12568300",
                                y: "55676100",
                                date: "21.06.26",
                                time: "12:00",
                            },
                            Destination: {
                                name: "København H",
                                x: "12565100",
                                y: "55672600",
                                date: "21.06.26",
                                time: "12:04",
                            },
                        },
                        {
                            type: "S",
                            name: "S-tog A",
                            direction: "Hillerød",
                            Origin: {
                                name: "København H",
                                x: "12565100",
                                y: "55672600",
                                date: "21.06.26",
                                time: "12:10",
                            },
                            Destination: {
                                name: "Nørreport",
                                x: "12571400",
                                y: "55683200",
                                date: "21.06.26",
                                time: "12:14",
                            },
                        },
                    ],
                },
            ],
        },
    };

    const dest: TravelPlace = { lat: 55.6832, lng: 12.5714, name: "Nørreport" };

    test("normalises walk + S-tog, microdeg coords, dd.MM.yy dates", () => {
        const j = parseRejseplanenTrip(FIXTURE, dest);
        expect(j).not.toBeNull();
        expect(j!.legs).toHaveLength(2);
        expect(j!.legs[0].mode).toBe("walk");
        expect(j!.legs[1].mode).toBe("train");
        expect(j!.legs[1].line).toBe("S-tog A");
        expect(j!.legs[1].direction).toBe("Hillerød");
        // microdegree → degree conversion on the endpoint coords.
        expect(j!.legs[1].to.lat).toBeCloseTo(55.6832, 3);
        expect(j!.legs[1].to.lng).toBeCloseTo(12.5714, 3);
        expect(j!.transfers).toBe(0);
        expect(j!.durationMin).toBe(14);
    });

    test("handles a single Leg object (not array)", () => {
        const single = {
            TripList: {
                Trip: {
                    Leg: {
                        type: "M",
                        name: "Metro M1",
                        Origin: { name: "A", date: "21.06.26", time: "09:00" },
                        Destination: {
                            name: "B",
                            date: "21.06.26",
                            time: "09:12",
                        },
                    },
                },
            },
        };
        const j = parseRejseplanenTrip(single, dest);
        expect(j).not.toBeNull();
        expect(j!.legs).toHaveLength(1);
        expect(j!.legs[0].mode).toBe("subway");
        expect(j!.durationMin).toBe(12);
    });

    test("returns null when no trips", () => {
        expect(
            parseRejseplanenTrip({ TripList: { Trip: [] } }, dest),
        ).toBeNull();
        expect(parseRejseplanenTrip({}, dest)).toBeNull();
    });
});

describe("parseEfaTrip (NSW / TfNSW rapidJSON)", () => {
    const FIXTURE = {
        journeys: [
            {
                legs: [
                    {
                        distance: 300,
                        origin: {
                            disassembledName: "Start",
                            coord: [-33.8688, 151.2093],
                            departureTimePlanned: "2026-06-21T02:00:00Z",
                        },
                        destination: {
                            disassembledName: "Town Hall Station",
                            coord: [-33.8731, 151.2069],
                            arrivalTimePlanned: "2026-06-21T02:05:00Z",
                        },
                        transportation: {
                            product: { class: 100, name: "footpath" },
                        },
                    },
                    {
                        origin: {
                            disassembledName: "Town Hall Station",
                            coord: [-33.8731, 151.2069],
                            departureTimeEstimated: "2026-06-21T02:09:00Z",
                        },
                        destination: {
                            disassembledName: "Chatswood Station",
                            coord: [-33.7969, 151.1803],
                            arrivalTimeEstimated: "2026-06-21T02:27:00Z",
                        },
                        transportation: {
                            product: {
                                class: 1,
                                name: "Sydney Trains Network",
                            },
                            disassembledName: "T1",
                            destination: { name: "Berowra" },
                        },
                    },
                ],
            },
        ],
    };

    const dest: TravelPlace = {
        lat: -33.7969,
        lng: 151.1803,
        name: "Chatswood Station",
    };

    test("normalises footpath + train, class→mode, [lat,lng] coords", () => {
        const j = parseEfaTrip(FIXTURE, dest);
        expect(j).not.toBeNull();
        expect(j!.legs).toHaveLength(2);
        expect(j!.legs[0].mode).toBe("walk");
        expect(j!.legs[0].distanceMeters).toBe(300);
        expect(j!.legs[1].mode).toBe("train");
        expect(j!.legs[1].line).toBe("T1");
        expect(j!.legs[1].direction).toBe("Berowra");
        expect(j!.legs[1].to.lat).toBeCloseTo(-33.7969, 3);
        expect(j!.transfers).toBe(0);
        expect(j!.durationMin).toBe(27);
    });

    test("returns null on empty journeys", () => {
        expect(parseEfaTrip({ journeys: [] }, dest)).toBeNull();
        expect(parseEfaTrip({}, dest)).toBeNull();
    });
});

describe("parseMotisPlan (Transitous / NYC)", () => {
    // MOTIS v2 legs are OTP-shaped: ISO startTime/endTime, from/to
    // {name,lat,lon}, mode, routeShortName, headsign.
    const FIXTURE = {
        itineraries: [
            {
                legs: [
                    {
                        mode: "WALK",
                        distance: 210,
                        startTime: "2026-06-21T12:00:00-04:00",
                        endTime: "2026-06-21T12:04:00-04:00",
                        from: { name: "Start", lat: 40.7128, lon: -74.006 },
                        to: {
                            name: "Fulton St",
                            lat: 40.7099,
                            lon: -74.0083,
                        },
                    },
                    {
                        mode: "SUBWAY",
                        startTime: "2026-06-21T12:08:00-04:00",
                        endTime: "2026-06-21T12:23:00-04:00",
                        from: {
                            name: "Fulton St",
                            lat: 40.7099,
                            lon: -74.0083,
                        },
                        to: {
                            name: "Times Sq-42 St",
                            lat: 40.7559,
                            lon: -73.9871,
                        },
                        routeShortName: "A",
                        headsign: "Inwood-207 St",
                    },
                ],
            },
        ],
    };

    const dest: TravelPlace = {
        lat: 40.7559,
        lng: -73.9871,
        name: "Times Sq-42 St",
    };

    test("normalises walk + subway", () => {
        const j = parseMotisPlan(FIXTURE, dest);
        expect(j).not.toBeNull();
        expect(j!.legs).toHaveLength(2);
        expect(j!.legs[0].mode).toBe("walk");
        expect(j!.legs[0].distanceMeters).toBe(210);
        expect(j!.legs[1].mode).toBe("subway");
        expect(j!.legs[1].line).toBe("A");
        expect(j!.legs[1].direction).toBe("Inwood-207 St");
        expect(j!.legs[1].to.name).toBe("Times Sq-42 St");
        expect(j!.legs[1].to.lng).toBeCloseTo(-73.9871, 3);
        expect(j!.transfers).toBe(0);
        expect(j!.durationMin).toBe(23);
    });

    test("RAIL/REGIONAL_RAIL map to train", () => {
        const j = parseMotisPlan(
            {
                itineraries: [
                    {
                        legs: [
                            {
                                mode: "REGIONAL_RAIL",
                                startTime: "2026-06-21T12:00:00Z",
                                endTime: "2026-06-21T12:30:00Z",
                                from: { name: "A", lat: 1, lon: 2 },
                                to: { name: "B", lat: 3, lon: 4 },
                                routeShortName: "RE1",
                            },
                        ],
                    },
                ],
            },
            dest,
        );
        expect(j!.legs[0].mode).toBe("train");
        expect(j!.legs[0].line).toBe("RE1");
    });

    test("returns null on empty itineraries", () => {
        expect(parseMotisPlan({ itineraries: [] }, dest)).toBeNull();
        expect(parseMotisPlan({}, dest)).toBeNull();
    });

    // MOTIS often ranks a WALK-ONLY "direct" itinerary first; taking
    // itineraries[0] blindly surfaced a bogus walking plan even though a
    // transit itinerary followed. Prefer the transit-bearing one.
    test("prefers a transit itinerary over a walk-only first itinerary", () => {
        const walkFirst = {
            itineraries: [
                {
                    legs: [
                        {
                            mode: "WALK",
                            distance: 3200,
                            startTime: "2026-06-21T12:00:00Z",
                            endTime: "2026-06-21T12:40:00Z",
                            from: { name: "Start", lat: 1, lon: 2 },
                            to: { name: "End", lat: 3, lon: 4 },
                        },
                    ],
                },
                {
                    legs: [
                        {
                            mode: "SUBWAY",
                            startTime: "2026-06-21T12:02:00Z",
                            endTime: "2026-06-21T12:14:00Z",
                            from: { name: "Start", lat: 1, lon: 2 },
                            to: { name: "End", lat: 3, lon: 4 },
                            routeShortName: "A",
                        },
                    ],
                },
            ],
        };
        const j = parseMotisPlan(walkFirst, dest);
        expect(j!.legs).toHaveLength(1);
        expect(j!.legs[0].mode).toBe("subway");
    });

    // When the player has banned a mode, a banned-mode "best" itinerary
    // must not shadow an allowed transit one MOTIS ranked lower.
    test("honours the allowed-mode set across itineraries", () => {
        const busThenSubway = {
            itineraries: [
                {
                    legs: [
                        {
                            mode: "BUS",
                            startTime: "2026-06-21T12:00:00Z",
                            endTime: "2026-06-21T12:20:00Z",
                            from: { name: "Start", lat: 1, lon: 2 },
                            to: { name: "End", lat: 3, lon: 4 },
                            routeShortName: "M15",
                        },
                    ],
                },
                {
                    legs: [
                        {
                            mode: "SUBWAY",
                            startTime: "2026-06-21T12:03:00Z",
                            endTime: "2026-06-21T12:18:00Z",
                            from: { name: "Start", lat: 1, lon: 2 },
                            to: { name: "End", lat: 3, lon: 4 },
                            routeShortName: "6",
                        },
                    ],
                },
            ],
        };
        const j = parseMotisPlan(busThenSubway, dest, ["subway", "train"]);
        expect(j!.legs[0].mode).toBe("subway");
    });
});

describe("parseOtpPlan (generic OpenTripPlanner REST)", () => {
    // OTP REST `/plan` → plan.itineraries[].legs[]; epoch-ms times,
    // from/to {name,lat,lon}, mode, routeShortName, headsign.
    const T = 1_750_000_000_000; // epoch ms
    const FIXTURE = {
        plan: {
            itineraries: [
                {
                    legs: [
                        {
                            mode: "WALK",
                            distance: 190,
                            startTime: T,
                            endTime: T + 3 * 60_000,
                            from: { name: "Start", lat: 45.07, lon: 7.69 },
                            to: {
                                name: "Porta Nuova",
                                lat: 45.062,
                                lon: 7.678,
                            },
                        },
                        {
                            mode: "SUBWAY",
                            startTime: T + 5 * 60_000,
                            endTime: T + 17 * 60_000,
                            from: {
                                name: "Porta Nuova",
                                lat: 45.062,
                                lon: 7.678,
                            },
                            to: { name: "Fermi", lat: 45.071, lon: 7.626 },
                            routeShortName: "M1",
                            headsign: "Fermi",
                        },
                    ],
                },
            ],
        },
    };

    const dest: TravelPlace = { lat: 45.071, lng: 7.626, name: "Fermi" };

    test("normalises walk + subway from epoch-ms times", () => {
        const j = parseOtpPlan(FIXTURE, dest);
        expect(j).not.toBeNull();
        expect(j!.legs).toHaveLength(2);
        expect(j!.legs[0].mode).toBe("walk");
        expect(j!.legs[0].distanceMeters).toBe(190);
        expect(j!.legs[1].mode).toBe("subway");
        expect(j!.legs[1].line).toBe("M1");
        expect(j!.legs[1].direction).toBe("Fermi");
        expect(j!.departAt).toBe(T);
        expect(j!.arriveAt).toBe(T + 17 * 60_000);
        expect(j!.durationMin).toBe(17);
        expect(j!.transfers).toBe(0);
    });

    test("tolerates second-resolution times", () => {
        const sec = {
            plan: {
                itineraries: [
                    {
                        legs: [
                            {
                                mode: "RAIL",
                                startTime: 1_750_000_000,
                                endTime: 1_750_000_000 + 600,
                                from: { name: "A", lat: 1, lon: 2 },
                                to: { name: "B", lat: 3, lon: 4 },
                                route: "RE5",
                            },
                        ],
                    },
                ],
            },
        };
        const j = parseOtpPlan(sec, dest);
        expect(j!.legs[0].mode).toBe("train");
        expect(j!.legs[0].line).toBe("RE5");
        expect(j!.durationMin).toBe(10);
    });

    test("returns null on empty plan", () => {
        expect(parseOtpPlan({ plan: { itineraries: [] } }, dest)).toBeNull();
        expect(parseOtpPlan({}, dest)).toBeNull();
    });
});

describe("parseOdsayPath (South Korea / Seoul)", () => {
    // ODsay gives per-subPath DURATIONS (sectionTime, minutes), no
    // absolute clock — the parser accumulates from departAt.
    const DEP = 1_750_000_000_000;
    const FIXTURE = {
        result: {
            path: [
                {
                    subPath: [
                        {
                            trafficType: 3, // walk
                            distance: 200,
                            sectionTime: 3,
                            startName: "Start",
                            endName: "Seoul Stn",
                            startX: 126.97,
                            startY: 37.554,
                            endX: 126.972,
                            endY: 37.556,
                        },
                        {
                            trafficType: 1, // subway
                            distance: 8000,
                            sectionTime: 16,
                            startName: "Seoul Stn",
                            endName: "Gangnam",
                            startX: 126.972,
                            startY: 37.556,
                            endX: 127.0276,
                            endY: 37.4979,
                            lane: [{ name: "Line 2" }],
                        },
                    ],
                },
            ],
        },
    };
    const dest: TravelPlace = { lat: 37.4979, lng: 127.0276, name: "Gangnam" };

    test("normalises walk + subway, accumulates times", () => {
        const j = parseOdsayPath(FIXTURE, DEP, dest);
        expect(j).not.toBeNull();
        expect(j!.legs).toHaveLength(2);
        expect(j!.legs[0].mode).toBe("walk");
        expect(j!.legs[0].departAt).toBe(DEP);
        expect(j!.legs[0].arriveAt).toBe(DEP + 3 * 60_000);
        expect(j!.legs[1].mode).toBe("subway");
        expect(j!.legs[1].line).toBe("Line 2");
        expect(j!.durationMin).toBe(19);
        expect(j!.transfers).toBe(0);
    });

    test("returns null on empty path", () => {
        expect(parseOdsayPath({ result: { path: [] } }, DEP, dest)).toBeNull();
        expect(parseOdsayPath({}, DEP, dest)).toBeNull();
    });
});

describe("parseNsTrip (Netherlands / NS)", () => {
    const FIXTURE = {
        trips: [
            {
                legs: [
                    {
                        travelType: "WALK",
                        origin: {
                            name: "Start",
                            lat: 52.3676,
                            lng: 4.9041,
                            plannedDateTime: "2026-06-21T12:00:00+0200",
                        },
                        destination: {
                            name: "Amsterdam Centraal",
                            lat: 52.3789,
                            lng: 4.9003,
                            plannedDateTime: "2026-06-21T12:06:00+0200",
                        },
                    },
                    {
                        direction: "Rotterdam Centraal",
                        product: {
                            displayName: "Intercity",
                            categoryCode: "IC",
                            number: "1163",
                        },
                        origin: {
                            name: "Amsterdam Centraal",
                            lat: 52.3789,
                            lng: 4.9003,
                            plannedDateTime: "2026-06-21T12:15:00+0200",
                        },
                        destination: {
                            name: "Rotterdam Centraal",
                            lat: 51.9249,
                            lng: 4.4699,
                            plannedDateTime: "2026-06-21T13:00:00+0200",
                        },
                    },
                ],
            },
        ],
    };
    const dest: TravelPlace = {
        lat: 51.9249,
        lng: 4.4699,
        name: "Rotterdam Centraal",
    };

    test("normalises walk (no product) + IC train", () => {
        const j = parseNsTrip(FIXTURE, dest);
        expect(j).not.toBeNull();
        expect(j!.legs).toHaveLength(2);
        expect(j!.legs[0].mode).toBe("walk");
        expect(j!.legs[1].mode).toBe("train");
        expect(j!.legs[1].line).toBe("Intercity");
        expect(j!.legs[1].direction).toBe("Rotterdam Centraal");
        expect(j!.durationMin).toBe(60);
    });

    test("returns null on empty trips", () => {
        expect(parseNsTrip({ trips: [] }, dest)).toBeNull();
        expect(parseNsTrip({}, dest)).toBeNull();
    });
});

describe("journeyModesAllowed (banned-mode gate)", () => {
    const leg = (mode: Journey["legs"][number]["mode"]) => ({
        mode,
        from: { lat: 0, lng: 0 },
        to: { lat: 1, lng: 1 },
        departAt: 0,
        arriveAt: 60_000,
    });
    const journey = (
        ...modes: Journey["legs"][number]["mode"][]
    ): Journey => ({
        departAt: 0,
        arriveAt: 60_000,
        durationMin: 1,
        transfers: Math.max(0, modes.length - 1),
        legs: modes.map(leg),
    });

    test("undefined / empty modes = unconstrained (always allowed)", () => {
        expect(journeyModesAllowed(journey("bus"), undefined)).toBe(true);
        expect(journeyModesAllowed(journey("bus"), [])).toBe(true);
    });

    test("rejects a journey that rides a banned concrete mode", () => {
        // Bus banned (allow-set without bus) → a bus leg is infeasible.
        const allowed = ["tram", "train", "subway", "ferry"] as const;
        expect(journeyModesAllowed(journey("bus"), [...allowed])).toBe(false);
        expect(
            journeyModesAllowed(journey("walk", "train", "bus"), [...allowed]),
        ).toBe(false);
    });

    test("accepts a journey whose transit legs are all allowed", () => {
        const allowed = ["tram", "train", "subway", "ferry"] as const;
        expect(
            journeyModesAllowed(journey("walk", "train", "walk"), [...allowed]),
        ).toBe(true);
    });

    test("walking-only and unknown 'transit' legs are always allowed", () => {
        const allowed = ["train"] as const;
        expect(journeyModesAllowed(journey("walk"), [...allowed])).toBe(true);
        // A generic 'transit' leg (mode undetermined upstream) is not
        // proven to violate the constraint, so it passes.
        expect(journeyModesAllowed(journey("transit"), [...allowed])).toBe(
            true,
        );
    });

    test("full allow-set is a no-op (every mode permitted)", () => {
        const all = ["bus", "tram", "train", "subway", "ferry"] as const;
        expect(journeyModesAllowed(journey("bus", "tram"), [...all])).toBe(
            true,
        );
    });
});
