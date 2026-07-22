import { describe, expect, it } from "vitest";

import {
    bridgeTrollMinKm,
    evaluateBridgeTroll,
    evaluateTravelAgent,
    haversineKm,
    travelAgentRadiusKm,
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

describe("travelAgentRadiusKm", () => {
    it("is 0.5 / 0.5 / 1 km by size", () => {
        expect(travelAgentRadiusKm("small")).toBe(0.5);
        expect(travelAgentRadiusKm("medium")).toBe(0.5);
        expect(travelAgentRadiusKm("large")).toBe(1);
    });
});

describe("evaluateTravelAgent", () => {
    const hider = { lat: 59.33, lng: 18.06 }; // Stockholm
    // Seekers ~11 km north of the hider.
    const seekers = { lat: 59.43, lng: 18.06 };

    it("is unknown with no destination or no seeker reference", () => {
        expect(
            evaluateTravelAgent("medium", hider, seekers, null).status,
        ).toBe("unknown");
        expect(
            evaluateTravelAgent("medium", hider, null, seekers).status,
        ).toBe("unknown");
    });

    it("blocks a destination outside the seekers' radius", () => {
        // ~2 km east of the seekers — medium radius is 0.5 km.
        const dest = { lat: 59.43, lng: 18.095 };
        const r = evaluateTravelAgent("medium", hider, seekers, dest);
        expect(r.status).toBe("blocked");
        expect(r.reason).toBe("too-far-from-seekers");
    });

    it("blocks a destination closer to the hider than the seekers are", () => {
        // Within 0.5 km of the seekers but nudged SOUTH (toward the hider).
        const dest = { lat: 59.427, lng: 18.06 };
        const r = evaluateTravelAgent("medium", hider, seekers, dest);
        expect(r.status).toBe("blocked");
        expect(r.reason).toBe("too-close-to-hider");
        expect(r.destToHiderKm).toBeLessThan(r.seekerToHiderKm!);
    });

    it("allows a destination near the seekers and farther from the hider", () => {
        // Within 0.5 km of the seekers, nudged NORTH (away from the hider).
        const dest = { lat: 59.433, lng: 18.06 };
        const r = evaluateTravelAgent("medium", hider, seekers, dest);
        expect(r.status).toBe("ok");
        expect(r.destToHiderKm).toBeGreaterThan(r.seekerToHiderKm!);
    });

    it("checks the NEAREST seeker, not just the first (multi-seeker)", () => {
        // A far seeker (would false-block) + a near seeker. A pin near the
        // near seeker must be allowed — the team is together.
        const farSeeker = { lat: 59.5, lng: 18.2 }; // ~10 km away
        const nearSeeker = { lat: 59.433, lng: 18.06 };
        const dest = { lat: 59.4335, lng: 18.06 }; // ~55 m from nearSeeker
        const r = evaluateTravelAgent(
            "medium",
            hider,
            [farSeeker, nearSeeker],
            dest,
        );
        expect(r.status).toBe("ok");
        expect(r.destToSeekersKm).toBeLessThan(0.5);
    });

    it("enforces only proximity when the hider has no fix", () => {
        const nearNorth = { lat: 59.433, lng: 18.06 };
        expect(
            evaluateTravelAgent("medium", null, seekers, nearNorth).status,
        ).toBe("ok");
        const nearSouth = { lat: 59.427, lng: 18.06 };
        // Closer to the (unknown) hider, but with no fix we can't check it → ok.
        expect(
            evaluateTravelAgent("medium", null, seekers, nearSouth).status,
        ).toBe("ok");
    });
});
