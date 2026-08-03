import * as turf from "@turf/turf";
import { describe, expect, it } from "vitest";

import {
    computeMetroReachCellsFromLines,
    type MetroLine,
} from "../src/maps/questions/metroReach";

/** A straight vertical metro line at longitude `lng`, from `latA` to `latB`. */
function vline(name: string, lng: number, latA = -0.05, latB = 0.05): MetroLine {
    const seg: [number, number][] = [
        [lng, latA],
        [lng, latB],
    ];
    return { name, coords: seg, segments: [seg] };
}
function hline(name: string, lat: number, lngA = -0.05, lngB = 0.05): MetroLine {
    const seg: [number, number][] = [
        [lngA, lat],
        [lngB, lat],
    ];
    return { name, coords: seg, segments: [seg] };
}

/** sum-of-cell-areas / reach-circle-area — 1.0 = a clean, disjoint full cover. */
function coverRatio(diag: string): number {
    const m = /sum\/circle=([\d.]+)/.exec(diag);
    return m ? Number(m[1]) : NaN;
}

function findCell(
    cells: ReturnType<
        typeof computeMetroReachCellsFromLines
    >["result"]["cells"],
    name: string,
) {
    return cells.find((c) => c.name === name);
}

describe("computeMetroReachCellsFromLines (iso-contour partition)", () => {
    it("two parallel lines split down the true midline, clean full cover", () => {
        const { result, diag } = computeMetroReachCellsFromLines(
            [vline("A", -0.02), vline("B", 0.02)],
            0,
            0,
            5,
            "kilometers",
        );
        // Two regions, one per line.
        expect(result.cells.length).toBe(2);
        const A = findCell(result.cells, "A")!;
        const B = findCell(result.cells, "B")!;
        expect(A).toBeTruthy();
        expect(B).toBeTruthy();

        // Clean disjoint full cover of the circle (no overlaps that would push it
        // well over 1, no big gaps that would drop it well under).
        const ratio = coverRatio(diag);
        expect(ratio).toBeGreaterThan(0.95);
        expect(ratio).toBeLessThan(1.05);

        // A point clearly on A's side is in A (and not B); symmetric for B.
        expect(turf.booleanPointInPolygon([-0.035, 0], A.cell)).toBe(true);
        expect(turf.booleanPointInPolygon([-0.035, 0], B.cell)).toBe(false);
        expect(turf.booleanPointInPolygon([0.035, 0], B.cell)).toBe(true);

        // The boundary sits on the MIDLINE (lng 0), not offset: a point just west
        // of centre is nearer A, just east is nearer B.
        expect(turf.booleanPointInPolygon([-0.006, 0], A.cell)).toBe(true);
        expect(turf.booleanPointInPolygon([0.006, 0], B.cell)).toBe(true);
    });

    it("a single line fills the whole reach circle", () => {
        const { result } = computeMetroReachCellsFromLines(
            [vline("only", 0)],
            0,
            0,
            5,
            "kilometers",
        );
        expect(result.cells.length).toBe(1);
        expect(result.cells[0].name).toBe("only");
    });

    it("three lines (a junction) still tile cleanly with no giant overlap", () => {
        // A vertical + a horizontal + a diagonal-ish vertical => a genuine 3-way
        // meeting near the centre exercising the junction fan.
        const { result, diag } = computeMetroReachCellsFromLines(
            [vline("V", -0.025), hline("H", 0.025), vline("W", 0.03)],
            0,
            0,
            5,
            "kilometers",
        );
        expect(result.cells.length).toBeGreaterThanOrEqual(2);
        const ratio = coverRatio(diag);
        expect(ratio).toBeGreaterThan(0.9);
        expect(ratio).toBeLessThan(1.1);
        // No single region should swallow essentially the whole circle.
        expect(diag).toContain("giants=0");
    });
});
