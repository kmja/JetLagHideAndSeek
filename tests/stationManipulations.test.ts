import { describe, it, expect } from "vitest";

import {
    inferStationMode,
    mergeDuplicateStation,
} from "../src/maps/geo-utils/stationManipulations";

describe("mergeDuplicateStation", () => {
    it("merges duplicates in the eastern hemisphere", () => {
        const places: StationPlace[] = [
            {
                type: "Feature",
                geometry: { type: "Point", coordinates: [120, 10] },
                properties: { id: "1", name: "Station East" },
            },
            {
                type: "Feature",
                geometry: { type: "Point", coordinates: [122, 12] },
                properties: { id: "2", name: "Station East" },
            },
        ];
        const radius = 10000; // super wide radius to ensure all locations are in
        const units: turf.Units = "kilometers";

        const result = mergeDuplicateStation(places, radius, units);
        expect(result).toHaveLength(1);
        expect(result[0].geometry.coordinates).toEqual([121, 11]); // average
    });

    it("merges duplicates in the western hemisphere", () => {
        const places: StationPlace[] = [
            {
                type: "Feature",
                geometry: { type: "Point", coordinates: [-80, 25] },
                properties: { id: "1", name: "Station West" },
            },
            {
                type: "Feature",
                geometry: { type: "Point", coordinates: [-82, 23] },
                properties: { id: "2", name: "Station West" },
            },
        ];
        const radius = 10000; // super wide radius to ensure all locations are in
        const units: turf.Units = "kilometers";

        const result = mergeDuplicateStation(places, radius, units);
        expect(result).toHaveLength(1);
        expect(result[0].geometry.coordinates).toEqual([-81, 24]);
    });

    it("merges duplicates in the southern hemisphere", () => {
        const places: StationPlace[] = [
            {
                type: "Feature",
                geometry: { type: "Point", coordinates: [30, -20] },
                properties: { id: "1", name: "Station South" },
            },
            {
                type: "Feature",
                geometry: { type: "Point", coordinates: [32, -22] },
                properties: { id: "2", name: "Station South" },
            },
        ];
        const radius = 10000; // super wide radius to ensure all locations are in
        const units: turf.Units = "kilometers";

        const result = mergeDuplicateStation(places, radius, units);
        expect(result).toHaveLength(1);
        expect(result[0].geometry.coordinates).toEqual([31, -21]);
    });

    it("handles 3 or more duplicates", () => {
        const places: StationPlace[] = [
            {
                type: "Feature",
                geometry: { type: "Point", coordinates: [10, 10] },
                properties: { id: "1", name: "Station Multi" },
            },
            {
                type: "Feature",
                geometry: { type: "Point", coordinates: [20, 20] },
                properties: { id: "2", name: "Station Multi" },
            },
            {
                type: "Feature",
                geometry: { type: "Point", coordinates: [30, 30] },
                properties: { id: "3", name: "Station Multi" },
            },
        ];
        const radius = 10000; // super wide radius to ensure all locations are in
        const units: turf.Units = "kilometers";

        const result = mergeDuplicateStation(places, radius, units);
        expect(result).toHaveLength(1);
        expect(result[0].geometry.coordinates).toEqual([20, 20]); // average of 10,20,30
    });

    it("returns all places unchanged when all names are unique", () => {
        const places: StationPlace[] = [
            {
                type: "Feature",
                geometry: { type: "Point", coordinates: [10, 50] },
                properties: { id: "A", name: "Unique A" },
            },
            {
                type: "Feature",
                geometry: { type: "Point", coordinates: [20, -30] },
                properties: { id: "B", name: "Unique B" },
            },
            {
                type: "Feature",
                geometry: { type: "Point", coordinates: [-40, 60] },
                properties: { id: "C", name: "Unique C" },
            },
        ];
        const radius = 10000; // super wide radius to ensure all locations are in
        const units: turf.Units = "kilometers";

        const result = mergeDuplicateStation(places, radius, units);
        expect(result).toHaveLength(3);

        // Make sure the coordinates are preserved exactly
        expect(result.map((r) => r.geometry.coordinates)).toEqual([
            [10, 50],
            [20, -30],
            [-40, 60],
        ]);
    });

    it("merges 6 Jan van Galenstraat stations into 2 clusters under the 800 m same-name floor", () => {
        const places: StationPlace[] = [
            {
                // West station 1:      https://www.openstreetmap.org/node/3306520727
                type: "Feature",
                geometry: {
                    type: "Point",
                    coordinates: [4.8350051, 52.3732337],
                },
                properties: {
                    id: "node/3306520727",
                    name: "Jan van Galenstraat",
                },
            },
            {
                // West station 2:      https://www.openstreetmap.org/node/434662863
                type: "Feature",
                geometry: {
                    type: "Point",
                    coordinates: [4.8359077, 52.3730297],
                },
                properties: {
                    id: "node/434662863",
                    name: "Jan van Galenstraat",
                },
            },
            {
                // Center station 1:    https://www.openstreetmap.org/node/434700014
                type: "Feature",
                geometry: {
                    type: "Point",
                    coordinates: [4.8485891, 52.3733319],
                },
                properties: {
                    id: "node/434700014",
                    name: "Jan van Galenstraat",
                },
            },
            {
                // Center station 2:    https://www.openstreetmap.org/node/3300515588
                type: "Feature",
                geometry: {
                    type: "Point",
                    coordinates: [4.8487242, 52.3729826],
                },
                properties: {
                    id: "node/3300515588",
                    name: "Jan van Galenstraat",
                },
            },
            {
                // East station 1:      https://www.openstreetmap.org/node/434397634
                type: "Feature",
                geometry: {
                    type: "Point",
                    coordinates: [4.8584711, 52.3751323],
                },
                properties: {
                    id: "node/434397634",
                    name: "Jan van Galenstraat",
                },
            },
            {
                // East station 2:      https://www.openstreetmap.org/node/434397635
                type: "Feature",
                geometry: {
                    type: "Point",
                    coordinates: [4.8586427, 52.3743002],
                },
                properties: {
                    id: "node/434397635",
                    name: "Jan van Galenstraat",
                },
            },
        ];
        const radius = 0.5;
        const units: turf.Units = "kilometers";

        const result = mergeDuplicateStation(places, radius, units);
        // Same-name merging uses max(radius, 800 m) — the floor exists so
        // a hub's spread-out same-named nodes (Oslo Nationaltheatret)
        // still collapse. Here radius=0.5 km → threshold 800 m: the
        // centre and east pairs sit ~670 m apart so they chain into ONE
        // cluster; the west pair is >800 m from the centre and stays its
        // own. (Pre-floor this expected 3 distinct pair-clusters.)
        expect(result).toHaveLength(2);
    });

    // v1115: the hider's old `sortAndDedupe` bus-90m proximity collapse is now
    // part of this ONE shared dedup (both roles). These pin the behaviour.
    it("collapses two differently-named bus stops within 90 m (directional pair)", () => {
        const places: StationPlace[] = [
            {
                type: "Feature",
                geometry: { type: "Point", coordinates: [4.835, 52.373] },
                properties: {
                    id: "1",
                    name: "Main St NB at Oak",
                    highway: "bus_stop",
                },
            },
            {
                type: "Feature",
                geometry: { type: "Point", coordinates: [4.8357, 52.37327] },
                properties: {
                    id: "2",
                    name: "Oak Ave EB at Main",
                    highway: "bus_stop",
                },
            },
        ];
        // ~57 m apart, different names → only the proximity rule can merge them.
        expect(mergeDuplicateStation(places, 0.5, "kilometers")).toHaveLength(1);
    });

    it("keeps two bus stops more than 90 m apart distinct", () => {
        const places: StationPlace[] = [
            {
                type: "Feature",
                geometry: { type: "Point", coordinates: [4.835, 52.373] },
                properties: { id: "1", name: "Stop A", highway: "bus_stop" },
            },
            {
                type: "Feature",
                geometry: { type: "Point", coordinates: [4.838, 52.373] },
                properties: { id: "2", name: "Stop B", highway: "bus_stop" },
            },
        ];
        // ~200 m apart → distinct hiding zones.
        expect(mergeDuplicateStation(places, 0.5, "kilometers")).toHaveLength(2);
    });

    it("does not collapse a bus stop and a nearby non-bus stop (bus-only rule)", () => {
        const places: StationPlace[] = [
            {
                type: "Feature",
                geometry: { type: "Point", coordinates: [4.835, 52.373] },
                properties: { id: "1", name: "Bus stop", highway: "bus_stop" },
            },
            {
                type: "Feature",
                geometry: { type: "Point", coordinates: [4.8354, 52.3732] },
                properties: {
                    id: "2",
                    name: "Rail halt",
                    railway: "station",
                },
            },
        ];
        // ~34 m apart, but the proximity collapse is bus↔bus only, and the
        // names differ — a train station and a nearby bus stop are distinct
        // hiding zones (both stay selectable).
        expect(mergeDuplicateStation(places, 0.5, "kilometers")).toHaveLength(2);
    });

    it("keeps 'North Station' and 'South Station' distinct within the 800 m same-name floor", () => {
        // The unification deliberately keeps the CONSERVATIVE normaliser (bare
        // cardinals are NOT stripped) — a more aggressive one would collapse
        // both to an empty key and wrongly merge them at the 800 m floor.
        const places: StationPlace[] = [
            {
                type: "Feature",
                geometry: { type: "Point", coordinates: [4.835, 52.373] },
                properties: {
                    id: "1",
                    name: "North Station",
                    railway: "station",
                },
            },
            {
                type: "Feature",
                geometry: { type: "Point", coordinates: [4.836, 52.373] },
                properties: {
                    id: "2",
                    name: "South Station",
                    railway: "station",
                },
            },
        ];
        // ~68 m apart, well within the 800 m floor — must NOT merge.
        expect(mergeDuplicateStation(places, 0.5, "kilometers")).toHaveLength(2);
    });

    it("unions transit modes across same-name nodes", () => {
        const places: StationPlace[] = [
            {
                type: "Feature",
                geometry: { type: "Point", coordinates: [4.835, 52.373] },
                properties: {
                    id: "1",
                    name: "Central",
                    station: "subway",
                },
            },
            {
                type: "Feature",
                geometry: { type: "Point", coordinates: [4.8354, 52.3732] },
                properties: {
                    id: "2",
                    name: "Central",
                    highway: "bus_stop",
                },
            },
        ];
        const result = mergeDuplicateStation(places, 0.5, "kilometers");
        expect(result).toHaveLength(1);
        const modes = (result[0].properties as { modes?: string[] }).modes;
        expect(modes).toEqual(expect.arrayContaining(["subway", "bus"]));
    });
});

import { checkIfStationsShareZones } from "../src/maps/geo-utils/stationManipulations";
import type { Location } from "../src/maps/geo-utils/stationManipulations";
import * as turf from "@turf/turf";
import type { StationPlace } from "@/maps/api";

describe("checkIfStationsShareZones", () => {
    it("returns true that Jan van Galenstraat subway station and nearby tram station share zones with km as unit", () => {
        // Subway station:      https://www.openstreetmap.org/node/250224485
        const station1: Location = {
            coordinates: [4.8352937, 52.3726582],
        };
        // Nearby tram station: https://www.openstreetmap.org/node/3306520727
        const station2: Location = {
            coordinates: [4.8350051, 52.3732337],
        };
        const radius: number = 0.5; //km
        const units: turf.Units = "kilometers";
        const result = checkIfStationsShareZones(
            station1,
            station2,
            radius,
            units,
        );
        expect(result).true;
    });

    it("returns false that Jan van Galenstraat subway station and far away tram station share zones with km as unit", () => {
        // Subway station:      https://www.openstreetmap.org/node/250224485
        const station1: Location = {
            coordinates: [4.8352937, 52.3726582],
        };
        // Far away tram station: https://www.openstreetmap.org/node/3300515588
        const station2: Location = {
            coordinates: [4.8487242, 52.3729826],
        };
        const radius: number = 0.5; //km
        const units: turf.Units = "kilometers";
        const result = checkIfStationsShareZones(
            station1,
            station2,
            radius,
            units,
        );
        expect(result).false;
    });

    it("returns false that Jan van Galenstraat subway station and far away tram station share zones with miles as unit", () => {
        // Subway station:      https://www.openstreetmap.org/node/250224485
        const station1: Location = {
            coordinates: [4.8352937, 52.3726582],
        };
        // Far away tram station: https://www.openstreetmap.org/node/3300515588
        const station2: Location = {
            coordinates: [4.8487242, 52.3729826],
        };
        const radius: number = 0.5; //km
        const units: turf.Units = "miles";
        const result = checkIfStationsShareZones(
            station1,
            station2,
            radius,
            units,
        );
        expect(result).false;
    });
});

describe("inferStationMode — the canonical station classifier (v1120)", () => {
    // The prewarm-element filter (`inferMode` in stations.ts) now DELEGATES to
    // this, so these pin the edge cases the two used to DISAGREE on.
    it("classifies a light_rail node (was dropped by the old prewarm filter)", () => {
        expect(inferStationMode({ railway: "light_rail" })).toBe("light_rail");
    });
    it("prefers bus over train on a multi-tag node (bus checked first)", () => {
        // A node tagged BOTH railway=station and bus=yes: the old prewarm
        // filter said train, the dedup said bus — now both say bus.
        expect(inferStationMode({ railway: "station", bus: "yes" })).toBe(
            "bus",
        );
    });
    it("recognises the legacy platform=ferry tag", () => {
        expect(inferStationMode({ platform: "ferry" })).toBe("ferry");
    });
    it("classifies the standard modes", () => {
        expect(inferStationMode({ station: "subway" })).toBe("subway");
        expect(inferStationMode({ railway: "tram_stop" })).toBe("tram");
        expect(inferStationMode({ railway: "station" })).toBe("train");
        expect(inferStationMode({ amenity: "ferry_terminal" })).toBe("ferry");
        expect(inferStationMode({ highway: "bus_stop" })).toBe("bus");
        expect(inferStationMode({ shop: "bakery" })).toBeNull();
    });
});
