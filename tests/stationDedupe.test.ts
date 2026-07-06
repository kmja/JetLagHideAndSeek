import { describe, expect, it } from "vitest";

import { normaliseName } from "@/lib/journey/stations";

describe("normaliseName — station-dedupe key (v674)", () => {
    it("collapses direction + street-order variants of the same intersection", () => {
        // Opposite streets / opposite directions of Nanaimo × East Hastings.
        expect(normaliseName("Nanaimo St (NB) at East Hastings St")).toBe(
            normaliseName("East Hastings St (EB) at Nanaimo St"),
        );
    });

    it("normalises Street/St and strips directional prefixes", () => {
        expect(normaliseName("North Nanaimo St (NB) at Dundas St")).toBe(
            normaliseName("Nanaimo Street (SB) at Dundas St"),
        );
    });

    it("keeps genuinely different intersections distinct", () => {
        expect(normaliseName("Nanaimo St at Cambridge St")).not.toBe(
            normaliseName("Nanaimo St at Dundas St"),
        );
    });

    it("strips brackets, diacritics, and mode words", () => {
        expect(normaliseName("Schous plass [Trikk]")).toBe(
            normaliseName("Schous Plass"),
        );
    });

    it("is order-independent for multi-word names", () => {
        expect(normaliseName("Main St at 1st Ave")).toBe(
            normaliseName("1st Ave at Main St"),
        );
    });
});
