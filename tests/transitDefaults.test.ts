import { describe, expect, it } from "vitest";

import {
    TRAIN_HEAVY_STATION_COUNT,
    defaultTransitModes,
    inferTransitModes,
} from "../src/lib/playAreaSize";
import type { TransitCounts } from "../src/lib/playAreaSize";

const counts = (c: Partial<TransitCounts>): TransitCounts => ({
    subway: 0,
    train: 0,
    tram: 0,
    bus: 0,
    ferry: 0,
    ...c,
});

const set = (m: string[]) => [...m].sort();

describe("defaultTransitModes (presence-aware)", () => {
    it("falls back to the size heuristic when there's no station data", () => {
        expect(defaultTransitModes("small", null)).toEqual(
            inferTransitModes("small"),
        );
        expect(defaultTransitModes("medium", null)).toEqual(
            inferTransitModes("medium"),
        );
        // A warmed-but-empty area (all zero) is untrustworthy → size fallback.
        expect(defaultTransitModes("large", counts({}))).toEqual(
            inferTransitModes("large"),
        );
    });

    it("drops bus when a subway exists (rail-dense metro)", () => {
        const modes = defaultTransitModes(
            "large",
            counts({ subway: 40, train: 200, tram: 5, bus: 3000, ferry: 8 }),
        );
        expect(set(modes)).toEqual(set(["subway", "train", "tram", "ferry"]));
        expect(modes).not.toContain("bus");
    });

    it("drops bus when the train network is heavy (subway tagged as train)", () => {
        const modes = defaultTransitModes(
            "medium",
            counts({ train: TRAIN_HEAVY_STATION_COUNT, bus: 900 }),
        );
        expect(set(modes)).toEqual(set(["train"]));
        expect(modes).not.toContain("bus");
    });

    it("keeps bus in a rail-light area (few trains, no subway)", () => {
        const modes = defaultTransitModes(
            "medium",
            counts({ train: 3, tram: 12, bus: 500 }),
        );
        expect(set(modes)).toEqual(set(["train", "tram", "bus"]));
    });

    it("defaults to bus in a bus-only area", () => {
        expect(defaultTransitModes("medium", counts({ bus: 400 }))).toEqual([
            "bus",
        ]);
    });

    it("never defaults ferry unless ferry stops are present", () => {
        // Landlocked large area: rail present, no ferry.
        const inland = defaultTransitModes(
            "large",
            counts({ subway: 30, train: 100, bus: 2000 }),
        );
        expect(inland).not.toContain("ferry");
        // Coastal area with ferries → ferry defaulted on.
        const coastal = defaultTransitModes(
            "large",
            counts({ subway: 30, train: 100, ferry: 6, bus: 2000 }),
        );
        expect(coastal).toContain("ferry");
    });

    it("drops a mode that has no stops (tram-less small town)", () => {
        const modes = defaultTransitModes(
            "small",
            counts({ train: 2, bus: 60 }),
        );
        expect(set(modes)).toEqual(set(["train", "bus"]));
        expect(modes).not.toContain("tram");
        expect(modes).not.toContain("subway");
    });
});
