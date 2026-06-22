import { describe, expect, test } from "vitest";

import {
    buildAdjacentAdminQuery,
    buildMunicipalityBandQuery,
    buildTopologicalAdjacencyQuery,
} from "@/maps/api/playAreaExtensions";

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
