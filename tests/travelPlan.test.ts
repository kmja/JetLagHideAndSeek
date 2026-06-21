import { describe, expect, test } from "vitest";

import type { Env } from "../overpass-cache/src/envTypes";
import {
    haversineMeters,
    WALK_CIRCUITY,
    walkingJourney,
} from "../overpass-cache/src/travel/adapters/walking";
import { canServe, parseResRobotTrip } from "../overpass-cache/src/travel/adapters/trafiklab";
import { dispatchPlan, selectAdapters } from "../overpass-cache/src/travel/router";
import type { PlanRequest, TravelPlace } from "../overpass-cache/src/travel/types";

const STOCKHOLM = { lat: 59.3293, lng: 18.0686 };
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
