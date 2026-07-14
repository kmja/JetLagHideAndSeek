import { describe, expect, test } from "vitest";

import {
    abbreviateStationName,
    shortenStationLabel,
} from "../src/lib/stationLabel";

describe("abbreviateStationName", () => {
    test("abbreviates common street-type suffixes", () => {
        expect(abbreviateStationName("145th Street")).toBe("145th St");
        expect(abbreviateStationName("Bedford Avenue")).toBe("Bedford Ave");
        expect(abbreviateStationName("Eastern Parkway")).toBe("Eastern Pkwy");
        expect(abbreviateStationName("Grand Boulevard")).toBe("Grand Blvd");
        expect(abbreviateStationName("Times Square")).toBe("Times Sq");
        expect(abbreviateStationName("Brooklyn Navy Yard Ferry Station")).toBe(
            "Brooklyn Navy Yard Ferry Stn",
        );
    });

    test("only touches whole words (no mid-word mangling)", () => {
        // "Streeter" must NOT become "Ster".
        expect(abbreviateStationName("Streeter Place")).toBe("Streeter Pl");
    });

    test("is a safe no-op on empty / non-street names", () => {
        expect(abbreviateStationName("")).toBe("");
        expect(abbreviateStationName("Roosevelt Island")).toBe(
            "Roosevelt Island",
        );
        expect(abbreviateStationName(undefined as unknown as string)).toBe("");
    });
});

describe("shortenStationLabel", () => {
    test("abbreviates then truncates to the max with an ellipsis", () => {
        // "Brooklyn Navy Yard Ferry Station" → abbr → still long → cut to 12.
        const s = shortenStationLabel(
            "Brooklyn Navy Yard Ferry Station",
            12,
        );
        expect(s.length).toBeLessThanOrEqual(12);
        expect(s.endsWith("…")).toBe(true);
        expect(s).toBe("Brooklyn Na…");
    });

    test("leaves a short (abbreviated) name untouched", () => {
        expect(shortenStationLabel("145th Street", 12)).toBe("145th St");
    });

    test("maxChars <= 0 disables truncation (abbreviation only)", () => {
        expect(
            shortenStationLabel("Brooklyn Navy Yard Ferry Station", 0),
        ).toBe("Brooklyn Navy Yard Ferry Stn");
    });

    test("trims a trailing space/hyphen before the ellipsis", () => {
        // "116th Street-Columbia University" → "116th St-Columbia University"
        // cut at 10 would land on "116th St-C"; ensure no dangling separator
        // when the cut lands right after a hyphen/space.
        const s = shortenStationLabel("116th Street - Foo", 10);
        expect(s.endsWith("-…")).toBe(false);
        expect(s.endsWith(" …")).toBe(false);
    });
});
