import { beforeEach, describe, expect, it } from "vitest";

import {
    hiderInbox,
    type InboxEntry,
    priorAnsweredCount,
    questionIdentity,
} from "@/lib/hiderRole";

const entry = (
    key: number,
    id: string,
    data: Record<string, unknown>,
    replied: boolean,
): InboxEntry => ({
    key,
    id,
    data,
    arrivedAt: Date.now() - 60_000,
    repliedAt: replied ? Date.now() : undefined,
});

describe("questionIdentity", () => {
    it("keys matching/measuring/photo on the subtype `type` field", () => {
        expect(questionIdentity("matching", { type: "aquarium" })).toBe(
            "matching:aquarium",
        );
        expect(questionIdentity("measuring", { type: "river" })).toBe(
            "measuring:river",
        );
        expect(questionIdentity("photo", { type: "bench" })).toBe(
            "photo:bench",
        );
    });

    it("keys tentacles on `locationType`", () => {
        expect(
            questionIdentity("tentacles", { locationType: "stadium" }),
        ).toBe("tentacles:stadium");
    });

    it("keys radius on radius + unit (custom is its own slot)", () => {
        expect(
            questionIdentity("radius", { radius: 1, unit: "kilometers" }),
        ).toBe("radius:1kilometers");
        expect(questionIdentity("radius", { useCustom: true })).toBe(
            "radius:custom",
        );
    });

    it("keys thermometer on the target preset signature", () => {
        expect(
            questionIdentity("thermometer", { targetSig: "5km" }),
        ).toBe("thermometer:5km");
    });
});

describe("priorAnsweredCount", () => {
    beforeEach(() => {
        hiderInbox.set([]);
    });

    it("ignores unanswered entries (they don't count as a paid repeat yet)", () => {
        hiderInbox.set([
            entry(1, "matching", { type: "aquarium" }, false),
            entry(2, "matching", { type: "aquarium" }, true),
        ]);
        expect(priorAnsweredCount(99, "matching:aquarium")).toBe(1);
    });

    it("excludes the question whose key matches (so we only count PRIORS)", () => {
        hiderInbox.set([
            entry(1, "matching", { type: "aquarium" }, true),
            entry(2, "matching", { type: "aquarium" }, true),
            entry(3, "matching", { type: "aquarium" }, false), // the new one
        ]);
        // Counting priors for key=3 → 2 prior answers → 3× cycle.
        expect(priorAnsweredCount(3, "matching:aquarium")).toBe(2);
    });

    it("filters by identity (different subtype → different question)", () => {
        hiderInbox.set([
            entry(1, "matching", { type: "aquarium" }, true),
            entry(2, "matching", { type: "museum" }, true),
        ]);
        expect(priorAnsweredCount(99, "matching:aquarium")).toBe(1);
        expect(priorAnsweredCount(99, "matching:museum")).toBe(1);
        expect(priorAnsweredCount(99, "matching:library")).toBe(0);
    });
});

describe("randomize repeat-cost accounting (v673, rulebook p376)", () => {
    beforeEach(() => {
        hiderInbox.set([]);
    });

    // After a Randomize, `markHandled` re-keys the answered inbox entry
    // to the SUBSTITUTE's identity (it merges the substitute's `type` /
    // `locationType` / `radius` into the entry's `data`). So a museum
    // matching randomized into a park matching leaves an answered entry
    // whose `data.type === "park"`.
    it("counts the SUBSTITUTE as asked, not the original", () => {
        hiderInbox.set([
            // museum → randomized to park; entry now carries the substitute.
            entry(
                1,
                "matching",
                { type: "park", randomized: true, randomizedFrom: "Museum" },
                true,
            ),
        ]);
        // Re-asking the SUBSTITUTE (park) is a repeat → 1 prior answer.
        expect(priorAnsweredCount(99, "matching:park")).toBe(1);
        // Re-asking the ORIGINAL (museum) is fresh → 0 priors (it was
        // never really asked; re-askable at its original cost).
        expect(priorAnsweredCount(99, "matching:museum")).toBe(0);
    });

    it("works for a radar preset swap", () => {
        // 1 km radar randomized to a 5 km radar → answered entry is 5 km.
        hiderInbox.set([
            entry(
                1,
                "radius",
                { radius: 5, unit: "kilometers", randomized: true },
                true,
            ),
        ]);
        expect(priorAnsweredCount(99, "radius:5kilometers")).toBe(1);
        expect(priorAnsweredCount(99, "radius:1kilometers")).toBe(0);
    });
});
