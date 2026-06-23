import { describe, expect, test } from "vitest";

import {
    buildAdjacentAdminQuery,
    buildMunicipalityBandQuery,
    buildTopologicalAdjacencyQuery,
    withinLevelWindow,
} from "@/maps/api/playAreaExtensions";

const stub = (admin_level: string | undefined, id = 1) => ({
    type: "relation" as const,
    id,
    tags: admin_level ? { admin_level } : {},
});

describe("topological-adjacency Overpass query (v427)", () => {
    test("walks relation → member ways → relations referencing those ways", () => {
        const q = buildTopologicalAdjacencyQuery(54391);
        expect(q).toContain("relation(54391);");
        // Member-ways step (the primary's boundary segments).
        expect(q).toContain("way(r);");
        // Relations referencing those ways = primary + neighbours.
        expect(q).toContain("rel(bw);");
        // Tags + bbox only — full geometry would be expensive and
        // we don't need it for the candidate picker.
        expect(q).toContain("out tags bb;");
        // NOT level-restricted any more — that was the whole point.
        expect(q).not.toContain('"admin_level"');
    });

    test("primary id is encoded literally so the cache key is stable per primary", () => {
        expect(buildTopologicalAdjacencyQuery(40009)).toContain(
            "relation(40009);",
        );
        expect(buildTopologicalAdjacencyQuery(7423)).toContain(
            "relation(7423);",
        );
    });
});

describe("deprecated admin-level queries (retained for prewarm)", () => {
    test("same-level query targets the primary's admin_level", () => {
        const q = buildAdjacentAdminQuery("7", 59.33, 18.07, 25);
        expect(q).toContain('relation["admin_level"="7"]["type"="boundary"]');
        expect(q).toContain("(around:25000,59.33,18.07)");
        expect(q).toContain("out tags bb;");
    });

    test("municipality-band fallback matches the city band (levels 7-8), not counties", () => {
        const q = buildMunicipalityBandQuery(40.7128, -74.006, 25);
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

describe("withinLevelWindow — generalised granularity gate", () => {
    test("NYC (level 5): keeps boroughs (county level 6), drops community districts + parent state", () => {
        // NYC consolidated city is admin_level 5; window is [5, 7].
        expect(withinLevelWindow(stub("6"), 5)).toBe(true); // borough/county
        expect(withinLevelWindow(stub("7"), 5)).toBe(true); // borough (alt tagging)
        expect(withinLevelWindow(stub("8"), 5)).toBe(false); // NJ city / CD
        expect(withinLevelWindow(stub("9"), 5)).toBe(false); // community district
        expect(withinLevelWindow(stub("4"), 5)).toBe(false); // parent state
        expect(withinLevelWindow(stub("2"), 5)).toBe(false); // country
    });

    test("Stockholm (kommun level 7): keeps same-level peers like Solna, drops the parent county", () => {
        // window is [7, 9].
        expect(withinLevelWindow(stub("7"), 7)).toBe(true); // Solna (peer kommun)
        expect(withinLevelWindow(stub("6"), 7)).toBe(false); // parent län/county
        expect(withinLevelWindow(stub("4"), 7)).toBe(false); // region
        expect(withinLevelWindow(stub("8"), 7)).toBe(true); // edge of window
        expect(withinLevelWindow(stub("10"), 7)).toBe(false); // ward — too fine
    });

    test("no-op when the primary has no usable admin_level", () => {
        expect(withinLevelWindow(stub("8"), null)).toBe(true);
        expect(withinLevelWindow(stub(undefined), null)).toBe(true);
    });

    test("candidate without an admin_level is dropped once a window exists", () => {
        expect(withinLevelWindow(stub(undefined), 7)).toBe(false);
        expect(withinLevelWindow(stub("not-a-number"), 7)).toBe(false);
    });
});
