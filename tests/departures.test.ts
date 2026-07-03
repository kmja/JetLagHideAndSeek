import { describe, expect, test } from "vitest";

import {
    canServe as trafiklabCanServe,
    parseNearestStop as parseResRobotNearestStop,
    parseResRobotBoard,
} from "../overpass-cache/src/departures/adapters/trafiklab";
import {
    parseMotisStoptimes,
    parseNearestStop as parseMotisNearestStop,
} from "../overpass-cache/src/departures/adapters/transitous";
import {
    parseFptfDepartures,
    parseNearestStop as parseFptfNearestStop,
} from "../overpass-cache/src/departures/adapters/germany";
import { parseEnturBoard } from "../overpass-cache/src/departures/adapters/entur";
import {
    parseNearestStation as parseSwissNearestStation,
    parseSwissBoard,
} from "../overpass-cache/src/departures/adapters/swiss";

/* ─────────────────────── ResRobot (Sweden) ─────────────────────── */

describe("ResRobot departures — nearest stop", () => {
    test("pulls the first StopLocation id + name", () => {
        const json = {
            stopLocationOrCoordLocation: [
                {
                    StopLocation: {
                        id: "A=1@O=Slussen@L=740098000@",
                        extId: "740098000",
                        name: "Slussen",
                        lat: 59.32,
                        lon: 18.07,
                    },
                },
            ],
        };
        expect(parseResRobotNearestStop(json)).toEqual({
            id: "A=1@O=Slussen@L=740098000@",
            name: "Slussen",
        });
    });

    test("falls back to extId when id is absent", () => {
        const json = {
            stopLocationOrCoordLocation: [
                { StopLocation: { extId: "740000001", name: "X" } },
            ],
        };
        expect(parseResRobotNearestStop(json)).toEqual({
            id: "740000001",
            name: "X",
        });
    });

    test("returns null on an empty list", () => {
        expect(
            parseResRobotNearestStop({ stopLocationOrCoordLocation: [] }),
        ).toBeNull();
        expect(parseResRobotNearestStop({})).toBeNull();
    });
});

describe("ResRobot departures — board parser", () => {
    test("parses departures, prefers real-time, classifies mode, sorts", () => {
        const json = {
            Departure: [
                {
                    name: "Buss 4",
                    direction: "Radiohuset",
                    date: "2026-07-03",
                    time: "14:35:00",
                    rtDate: "2026-07-03",
                    rtTime: "14:37:00",
                    Product: [{ name: "Buss 4", catOut: "BLT", catOutL: "Bus" }],
                },
                {
                    name: "Tunnelbana 13",
                    direction: "Norsborg",
                    date: "2026-07-03",
                    time: "14:31:00",
                    Product: [{ name: "13", catOutL: "Tunnelbana" }],
                },
            ],
        };
        const out = parseResRobotBoard(json);
        expect(out).toHaveLength(2);
        // Sorted soonest-first: the 14:31 metro comes before the 14:37 bus.
        expect(out[0].mode).toBe("subway");
        expect(out[0].line).toBe("13");
        expect(out[0].headsign).toBe("Norsborg");
        expect(out[0].realtime).toBeUndefined();
        // The bus uses its real-time 14:37, not the scheduled 14:35.
        expect(out[1].mode).toBe("bus");
        expect(out[1].realtime).toBe(true);
        expect(out[1].time).toBeGreaterThan(out[0].time);
    });

    test("skips entries with no parseable time; empty on garbage", () => {
        expect(
            parseResRobotBoard({ Departure: [{ name: "X" }] }),
        ).toHaveLength(0);
        expect(parseResRobotBoard({})).toHaveLength(0);
        expect(parseResRobotBoard(null)).toHaveLength(0);
    });

    test("canServe gates to the Sweden bbox", () => {
        expect(trafiklabCanServe(59.33, 18.07)).toBe(true); // Stockholm
        expect(trafiklabCanServe(51.5, -0.13)).toBe(false); // London
    });
});

/* ─────────────────────── MOTIS / Transitous ─────────────────────── */

describe("MOTIS departures — nearest stop", () => {
    test("keeps the first STOP-typed match", () => {
        const json = [
            { type: "ADDRESS", id: "addr1", name: "5 Main St" },
            { type: "STOP", id: "de-DELFI_stop_1", name: "Hauptbahnhof" },
            { type: "STOP", id: "stop2", name: "Other" },
        ];
        expect(parseMotisNearestStop(json)).toEqual({
            id: "de-DELFI_stop_1",
            name: "Hauptbahnhof",
        });
    });

    test("returns null when no STOP match exists", () => {
        expect(
            parseMotisNearestStop([{ type: "ADDRESS", id: "a", name: "b" }]),
        ).toBeNull();
        expect(parseMotisNearestStop({})).toBeNull();
    });
});

describe("MOTIS departures — stoptimes parser", () => {
    test("parses stopTimes, prefers real-time departure, sorts", () => {
        const json = {
            stopTimes: [
                {
                    place: {
                        name: "Hauptbahnhof",
                        departure: "2026-07-03T12:10:00Z",
                        scheduledDeparture: "2026-07-03T12:08:00Z",
                    },
                    mode: "BUS",
                    realTime: true,
                    headsign: "Airport",
                    routeShortName: "X1",
                },
                {
                    place: {
                        name: "Hauptbahnhof",
                        scheduledDeparture: "2026-07-03T12:05:00Z",
                    },
                    mode: "SUBWAY",
                    headsign: "Centrum",
                    routeShortName: "U2",
                },
            ],
        };
        const out = parseMotisStoptimes(json);
        expect(out).toHaveLength(2);
        // Sorted: the 12:05 metro before the 12:10 bus.
        expect(out[0].mode).toBe("subway");
        expect(out[0].line).toBe("U2");
        expect(out[0].realtime).toBeUndefined();
        expect(out[1].mode).toBe("bus");
        expect(out[1].line).toBe("X1");
        expect(out[1].headsign).toBe("Airport");
        expect(out[1].realtime).toBe(true);
        expect(out[1].time).toBe(Date.parse("2026-07-03T12:10:00Z"));
    });

    test("falls back to scheduled when no realtime; empty on garbage", () => {
        const json = {
            stopTimes: [
                {
                    place: { scheduledDeparture: "2026-07-03T09:00:00Z" },
                    mode: "RAIL",
                    routeShortName: "RE1",
                },
            ],
        };
        const out = parseMotisStoptimes(json);
        expect(out).toHaveLength(1);
        expect(out[0].mode).toBe("train");
        expect(out[0].realtime).toBeUndefined();
        expect(parseMotisStoptimes({})).toHaveLength(0);
        expect(parseMotisStoptimes(null)).toHaveLength(0);
    });
});

/* ─────────────────────── Germany / DACH (FPTF) ─────────────────────── */

describe("transport.rest departures", () => {
    test("nearest stop keeps the first type:stop entry", () => {
        const json = [
            { type: "stop", id: "8011160", name: "Berlin Hbf" },
            { type: "stop", id: "8010255", name: "Other" },
        ];
        expect(parseFptfNearestStop(json)).toEqual({
            id: "8011160",
            name: "Berlin Hbf",
        });
        expect(parseFptfNearestStop([{ type: "location" }])).toBeNull();
        expect(parseFptfNearestStop({})).toBeNull();
    });

    test("parses FPTF departures, prefers realtime `when`, classifies", () => {
        const json = {
            departures: [
                {
                    when: "2026-07-03T14:32:00+02:00",
                    plannedWhen: "2026-07-03T14:30:00+02:00",
                    delay: 120,
                    direction: "Flughafen",
                    line: { name: "S9", product: "suburban", mode: "train" },
                },
                {
                    when: null,
                    plannedWhen: "2026-07-03T14:25:00+02:00",
                    delay: null,
                    direction: "Alexanderplatz",
                    line: { name: "U2", product: "subway", mode: "train" },
                },
            ],
        };
        const out = parseFptfDepartures(json);
        expect(out).toHaveLength(2);
        // Sorted soonest-first: the 14:25 U-Bahn before the 14:32 S-Bahn.
        expect(out[0].mode).toBe("subway");
        expect(out[0].line).toBe("U2");
        expect(out[0].realtime).toBeUndefined();
        expect(out[1].mode).toBe("train");
        expect(out[1].realtime).toBe(true);
        expect(out[1].headsign).toBe("Flughafen");
    });

    test("empty on garbage", () => {
        expect(parseFptfDepartures({})).toHaveLength(0);
        expect(parseFptfDepartures(null)).toHaveLength(0);
    });
});

/* ─────────────────────── Entur (Norway) ─────────────────────── */

describe("Entur departures", () => {
    test("parses nearest → estimatedCalls, prefers expected time", () => {
        const json = {
            data: {
                nearest: {
                    edges: [
                        {
                            node: {
                                place: {
                                    name: "Jernbanetorget",
                                    estimatedCalls: [
                                        {
                                            expectedDepartureTime:
                                                "2026-07-03T10:05:00+02:00",
                                            aimedDepartureTime:
                                                "2026-07-03T10:03:00+02:00",
                                            realtime: true,
                                            destinationDisplay: {
                                                frontText: "Bergkrystallen",
                                            },
                                            serviceJourney: {
                                                line: {
                                                    publicCode: "1",
                                                    transportMode: "metro",
                                                },
                                            },
                                        },
                                    ],
                                },
                            },
                        },
                    ],
                },
            },
        };
        const board = parseEnturBoard(json);
        expect(board?.stopName).toBe("Jernbanetorget");
        expect(board?.departures).toHaveLength(1);
        expect(board?.departures[0].mode).toBe("subway");
        expect(board?.departures[0].line).toBe("1");
        expect(board?.departures[0].headsign).toBe("Bergkrystallen");
        expect(board?.departures[0].realtime).toBe(true);
        expect(board?.departures[0].time).toBe(
            Date.parse("2026-07-03T10:05:00+02:00"),
        );
    });

    test("null when no stop resolved", () => {
        expect(parseEnturBoard({ data: { nearest: { edges: [] } } })).toBeNull();
        expect(parseEnturBoard({})).toBeNull();
    });
});

/* ─────────────────────── Switzerland ─────────────────────── */

describe("Swiss departures", () => {
    test("nearest station keeps the first station", () => {
        const json = {
            stations: [
                { id: "8503000", name: "Zürich HB" },
                { id: "8503001", name: "Other" },
            ],
        };
        expect(parseSwissNearestStation(json)).toEqual({
            id: "8503000",
            name: "Zürich HB",
        });
        expect(parseSwissNearestStation({ stations: [] })).toBeNull();
    });

    test("parses stationboard, prefers timestamp, classifies + sorts", () => {
        const json = {
            stationboard: [
                {
                    category: "T",
                    number: "11",
                    name: "T 11",
                    to: "Rehalp",
                    stop: {
                        departure: "2026-07-03T12:10:00+0200",
                        departureTimestamp: 1783073400,
                    },
                },
                {
                    category: "IC",
                    number: "1",
                    name: "IC 1",
                    to: "Genève",
                    stop: {
                        departure: "2026-07-03T12:04:00+0200",
                        departureTimestamp: 1783073040,
                    },
                },
            ],
        };
        const out = parseSwissBoard(json);
        expect(out).toHaveLength(2);
        // Sorted: the earlier IC before the tram.
        expect(out[0].mode).toBe("train");
        expect(out[0].line).toBe("IC 1");
        expect(out[0].headsign).toBe("Genève");
        expect(out[0].time).toBe(1783073040 * 1000);
        expect(out[1].mode).toBe("tram");
        expect(parseSwissBoard({})).toHaveLength(0);
    });
});
