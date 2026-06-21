import { describe, expect, test } from "vitest";

import { haversineMeters } from "@/lib/geo";

describe("haversineMeters", () => {
    test("one degree of latitude is ~111 km", () => {
        const d = haversineMeters(0, 0, 1, 0);
        expect(d).toBeGreaterThan(111_000);
        expect(d).toBeLessThan(111_400);
    });

    test("zero distance for identical points", () => {
        expect(haversineMeters(59.33, 18.07, 59.33, 18.07)).toBe(0);
    });

    test("symmetric", () => {
        const ab = haversineMeters(59.33, 18.07, 59.86, 17.64);
        const ba = haversineMeters(59.86, 17.64, 59.33, 18.07);
        expect(Math.abs(ab - ba)).toBeLessThan(1e-6);
    });

    test("Stockholm→Uppsala is ~60-70 km", () => {
        const d = haversineMeters(59.3293, 18.0686, 59.8586, 17.6389);
        expect(d).toBeGreaterThan(60_000);
        expect(d).toBeLessThan(70_000);
    });
});
