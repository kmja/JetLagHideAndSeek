import { describe, expect, it } from "vitest";

import {
    formatKm,
    formatKmh,
    formatMeters,
    gameDistanceKm,
    gameRadius,
    imperialMilesForMeters,
} from "@/lib/units";
import { thermometerPresets } from "@/lib/thermometerPresets";

/**
 * v972: the unit system + curated conversions. The Jet Lag creators round
 * to clean numbers, so the canonical game distances map to tidy imperial
 * values rather than raw × 0.621371.
 */
describe("curated distance conversions", () => {
    it("maps the canonical game distances to clean imperial values", () => {
        expect(formatMeters(500, "imperial")).toBe("0.25 mi");
        expect(formatMeters(1000, "imperial")).toBe("0.5 mi");
        expect(formatMeters(2000, "imperial")).toBe("1 mi");
        expect(formatKm(5, "imperial")).toBe("3 mi");
        expect(formatKm(10, "imperial")).toBe("6 mi");
        expect(formatKm(15, "imperial")).toBe("10 mi");
        expect(formatKm(40, "imperial")).toBe("25 mi");
        expect(formatKm(80, "imperial")).toBe("50 mi");
        expect(formatKm(160, "imperial")).toBe("100 mi");
        expect(formatKm(75, "imperial")).toBe("45 mi");
    });

    it("small distances render in feet", () => {
        expect(formatMeters(3, "imperial")).toBe("10 ft");
        expect(formatMeters(30, "imperial")).toBe("100 ft");
        expect(formatMeters(150, "imperial")).toBe("500 ft");
        expect(formatMeters(300, "imperial")).toBe("1000 ft");
    });

    it("metric keeps metric", () => {
        expect(formatMeters(500, "metric")).toBe("500 m");
        expect(formatKm(2, "metric")).toBe("2 km");
        expect(formatKm(160, "metric")).toBe("160 km");
    });

    it("converts speeds with clean rounding", () => {
        expect(formatKmh(250, "imperial")).toBe("150 mph");
        expect(formatKmh(200, "imperial")).toBe("125 mph");
        expect(formatKmh(250, "metric")).toBe("250 km/h");
    });

    it("gameRadius returns the paired value + unit for the presets", () => {
        expect(gameRadius(500, "imperial")).toEqual({
            radius: 0.25,
            unit: "miles",
        });
        expect(gameRadius(2000, "imperial")).toEqual({
            radius: 1,
            unit: "miles",
        });
        expect(gameRadius(500, "metric")).toEqual({
            radius: 500,
            unit: "meters",
        });
        expect(gameRadius(5000, "metric")).toEqual({
            radius: 5,
            unit: "kilometers",
        });
    });

    it("imperialMilesForMeters returns the curated miles", () => {
        expect(imperialMilesForMeters(160000)).toBe(100);
        expect(imperialMilesForMeters(25000)).toBe(15);
    });

    it("gameDistanceKm gives the tracker threshold matching the label", () => {
        // 1 km tier → 0.5 mi → 0.804 km threshold in imperial.
        expect(gameDistanceKm(1000, "imperial")).toBeCloseTo(0.804672, 4);
        expect(gameDistanceKm(1000, "metric")).toBe(1);
    });
});

describe("thermometer presets follow the unit system", () => {
    it("labels + km thresholds convert for imperial", () => {
        const imp = thermometerPresets("imperial");
        const km1 = imp.find((p) => p.sig === "1km")!;
        expect(km1.label).toBe("0.5 mi");
        expect(km1.km).toBeCloseTo(0.804672, 4);
        const km75 = imp.find((p) => p.sig === "75km")!;
        expect(km75.label).toBe("45 mi");
    });

    it("sigs stay stable across systems", () => {
        const metric = thermometerPresets("metric").map((p) => p.sig);
        const imperial = thermometerPresets("imperial").map((p) => p.sig);
        expect(metric).toEqual(imperial);
    });
});
