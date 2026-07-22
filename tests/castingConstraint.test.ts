import { describe, expect, it } from "vitest";

import {
    bridgeTrollMinKm,
    evaluateBridgeTroll,
    haversineKm,
} from "@/lib/castingConstraint";

describe("bridgeTrollMinKm", () => {
    it("is 2 / 10 / 50 km by size", () => {
        expect(bridgeTrollMinKm("small")).toBe(2);
        expect(bridgeTrollMinKm("medium")).toBe(10);
        expect(bridgeTrollMinKm("large")).toBe(50);
    });
});

describe("haversineKm", () => {
    it("is ~0 for the same point", () => {
        expect(haversineKm({ lat: 59.3, lng: 18.06 }, { lat: 59.3, lng: 18.06 })).toBeCloseTo(0, 5);
    });
    it("is ~111 km per degree of latitude", () => {
        expect(haversineKm({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeCloseTo(111.19, 0);
    });
});

describe("evaluateBridgeTroll", () => {
    const hider = { lat: 59.33, lng: 18.06 }; // Stockholm

    it("is unknown with no hider fix or no seekers", () => {
        expect(evaluateBridgeTroll("medium", null, [{ lat: 59.4, lng: 18.1 }]).status).toBe(
            "unknown",
        );
        expect(evaluateBridgeTroll("medium", hider, []).status).toBe("unknown");
    });

    it("blocks when the nearest seeker is closer than the threshold", () => {
        // A seeker ~1 km away, medium game needs >= 10 km.
        const near = { lat: 59.34, lng: 18.06 };
        const r = evaluateBridgeTroll("medium", hider, [near]);
        expect(r.status).toBe("blocked");
        expect(r.minKm).toBe(10);
        expect(r.nearestKm).toBeLessThan(10);
    });

    it("allows when every seeker is beyond the threshold", () => {
        // ~1.1 deg lat north ≈ 122 km away, small game needs >= 2 km.
        const far = { lat: 60.43, lng: 18.06 };
        const r = evaluateBridgeTroll("small", hider, [far]);
        expect(r.status).toBe("ok");
        expect(r.nearestKm).toBeGreaterThan(2);
    });

    it("uses the NEAREST seeker (blocks if any is too close)", () => {
        const near = { lat: 59.34, lng: 18.06 }; // ~1 km
        const far = { lat: 60.43, lng: 18.06 }; // ~122 km
        expect(evaluateBridgeTroll("medium", hider, [far, near]).status).toBe(
            "blocked",
        );
    });
});
