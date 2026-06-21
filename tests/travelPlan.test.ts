import { describe, expect, test } from "vitest";

import type { Env } from "../overpass-cache/src/envTypes";
import {
    haversineMeters,
    WALK_CIRCUITY,
    walkingJourney,
} from "../overpass-cache/src/travel/adapters/walking";
import { canServe, parseResRobotTrip } from "../overpass-cache/src/travel/adapters/trafiklab";
import { parseEnturTrip } from "../overpass-cache/src/travel/adapters/entur";
import { parseDigitransitPlan } from "../overpass-cache/src/travel/adapters/digitransit";
import { parseTflJourney } from "../overpass-cache/src/travel/adapters/tfl";
import { dispatchPlan, selectAdapters } from "../overpass-cache/src/travel/router";
import type { PlanRequest, TravelPlace } from "../overpass-cache/src/travel/types";

const STOCKHOLM = { lat: 59.3293, lng: 18.0686 };
const OSLO = { lat: 59.9139, lng: 10.7522 };
const HELSINKI = { lat: 60.1699, lng: 24.9384 };
const LONDON = { lat: 51.5072, lng: -0.1276 };
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
        expect(j.legs[0].distanceMeters).toBe(Math.round(straight * WALK_CIRCUITY));
    });
});

describe("adapter dispatch selection", () => {
    test("Trafiklab serves Sweden, defers elsewhere", () => {
        expect(canServe(STOCKHOLM.lat, STOCKHOLM.lng)).toBe(true);
        expect(canServe(TOKYO.lat, TOKYO.lng)).toBe(false);
    });

    test("Stockholm tries Trafiklab first, then walking", () => {
        const ids = selectAdapters(STOCKHOLM.lat, STOCKHOLM.lng).map((a) => a.id);
        expect(ids).toEqual(["trafiklab", "walking"]);
    });

    test("Oslo tries Entur first, then walking", () => {
        const ids = selectAdapters(OSLO.lat, OSLO.lng).map((a) => a.id);
        expect(ids).toEqual(["entur", "walking"]);
    });

    test("Helsinki tries Digitransit first, then walking", () => {
        const ids = selectAdapters(HELSINKI.lat, HELSINKI.lng).map((a) => a.id);
        expect(ids).toEqual(["digitransit", "walking"]);
    });

    test("London tries TfL first, then walking", () => {
        const ids = selectAdapters(LONDON.lat, LONDON.lng).map((a) => a.id);
        expect(ids).toEqual(["tfl", "walking"]);
    });

    test("Tokyo falls straight to walking", () => {
        const ids = selectAdapters(TOKYO.lat, TOKYO.lng).map((a) => a.id);
        expect(ids).toEqual(["walking"]);
    });
});

describe("dispatchPlan falls back to walking without a key", () => {
    test("Stockholm with no key resolves to a walking journey", async () => {
        const req: PlanRequest = {
            origin: STOCKHOLM,
            destination: { lat: 59.86, lng: 17.64, name: "Uppsala" },
        };
        const { source, journey } = await dispatchPlan(req, Date.now(), NO_KEY_ENV);
        expect(source).toBe("walking");
        expect(journey).not.toBeNull();
        expect(journey!.legs[0].mode).toBe("walk");
    });

    test("Tokyo resolves to a walking journey", async () => {
        const req: PlanRequest = {
            origin: TOKYO,
            destination: { lat: 35.69, lng: 139.7, name: "Shinjuku" },
        };
        const { source, journey } = await dispatchPlan(req, Date.now(), NO_KEY_ENV);
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
                                { name: "Tåg 43", catOut: "Tåg", catOutL: "Regionaltåg" },
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

    const destFallback: TravelPlace = { lat: 59.858, lng: 17.646, name: "Uppsala C" };

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
                                fromPlace: { name: "Start", latitude: 59.91, longitude: 10.75 },
                                toPlace: { name: "Jernbanetorget", latitude: 59.911, longitude: 10.752 },
                            },
                            {
                                mode: "metro",
                                expectedStartTime: "2026-06-21T12:05:00+02:00",
                                expectedEndTime: "2026-06-21T12:25:00+02:00",
                                fromPlace: { name: "Jernbanetorget", latitude: 59.911, longitude: 10.752 },
                                toPlace: { name: "Majorstuen", latitude: 59.929, longitude: 10.715 },
                                line: { publicCode: "5", name: "T-banen 5" },
                                fromEstimatedCall: { destinationDisplay: { frontText: "Vestli" } },
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
        expect(parseEnturTrip({ data: { trip: { tripPatterns: [] } } }, dest)).toBeNull();
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
                                to: { name: "Rautatientori", lat: 60.171, lon: 24.942 },
                            },
                            {
                                mode: "SUBWAY",
                                startTime: T_START + 4 * 60,
                                endTime: T_END,
                                from: { name: "Rautatientori", lat: 60.171, lon: 24.942 },
                                to: { name: "Itäkeskus", lat: 60.211, lon: 25.082 },
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
        expect(parseDigitransitPlan({ data: { plan: { itineraries: [] } } }, dest)).toBeNull();
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
                        departurePoint: { commonName: "Start", lat: 51.507, lon: -0.128 },
                        arrivalPoint: { commonName: "Victoria Stn", lat: 51.495, lon: -0.143 },
                        distance: 1200,
                    },
                    {
                        mode: { id: "tube", name: "tube" },
                        departureTime: "2026-06-21T12:12:00",
                        arrivalTime: "2026-06-21T12:35:00",
                        departurePoint: { commonName: "Victoria Stn", lat: 51.495, lon: -0.143 },
                        arrivalPoint: { commonName: "Walthamstow Central", lat: 51.583, lon: -0.019 },
                        routeOptions: [{ name: "Victoria Line", directions: ["Walthamstow"] }],
                    },
                ],
            },
        ],
    };

    const dest: TravelPlace = { lat: 51.583, lng: -0.019, name: "Walthamstow Central" };

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
