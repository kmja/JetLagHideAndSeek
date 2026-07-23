import { describe, expect, it } from "vitest";

import { safeJsonDecode } from "../src/lib/persist";

describe("safeJsonDecode", () => {
    it("parses valid JSON", () => {
        expect(safeJsonDecode<number[]>([])("[1,2,3]")).toEqual([1, 2, 3]);
    });

    it("returns the fallback on a truncated/corrupt write (no throw)", () => {
        const decode = safeJsonDecode<number[]>([]);
        // A quota-truncated array write — bare JSON.parse would throw.
        expect(decode('[1,2,3')).toEqual([]);
        expect(decode("")).toEqual([]);
        expect(decode("not json at all")).toEqual([]);
    });

    it("passes the parsed value through a validate() when supplied", () => {
        const decode = safeJsonDecode<string>("medium", (v) =>
            v === "small" || v === "large" ? v : "medium",
        );
        expect(decode('"large"')).toBe("large");
        // valid JSON, wrong shape → validate() coerces to the fallback
        expect(decode('"garbage"')).toBe("medium");
        // corrupt JSON → fallback (validate never runs)
        expect(decode("{")).toBe("medium");
    });
});
