import { describe, expect, test } from "vitest";

import {
    buildAdjacentAdminQuery,
    buildMunicipalityBandQuery,
} from "@/maps/api/playAreaExtensions";

describe("adjacent-area Overpass queries", () => {
    test("same-level query targets the primary's admin_level", () => {
        const q = buildAdjacentAdminQuery("7", 59.33, 18.07, 25);
        expect(q).toContain('relation["admin_level"="7"]["type"="boundary"]');
        expect(q).toContain("(around:25000,59.33,18.07)");
        expect(q).toContain("out tags bb;");
    });

    test("municipality-band fallback matches the city band (levels 7-8), not counties", () => {
        // The NYC fix: a consolidated city (admin_level 5) has no
        // same-level siblings, so we fall back to the 7-8 band.
        const q = buildMunicipalityBandQuery(40.7128, -74.006, 25);
        // Regex matches 7 or 8 only — NOT 6 (so NYC's county-boroughs,
        // already inside the primary, aren't offered).
        expect(q).toContain('relation["admin_level"~"^[78]$"]');
        expect(q).not.toContain('"admin_level"~"^[678]$"');
        expect(q).toContain("(around:25000,40.7128,-74.006)");
        expect(q).toContain("out tags bb;");
    });

    test("radius is applied in metres", () => {
        expect(buildMunicipalityBandQuery(0, 0, 10)).toContain(
            "(around:10000,0,0)",
        );
    });
});
