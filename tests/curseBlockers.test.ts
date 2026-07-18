import { describe, expect, it } from "vitest";

import {
    blockingCurseExpired,
    curseBlocksAsking,
    cursePreventsAskingOrTransit,
    spottyCategoryForRoll,
} from "@/lib/curseEnforcement";
import { curseDiceCount } from "@/lib/curseMeta";

/**
 * v970 (rulebook audit B) — the widened one-active-blocking-curse pool
 * (rulebook p386: no more than one active curse preventing the seekers from
 * asking questions or taking transit), timed-blocker expiry, the Jammed
 * Door 2d6 count, and the v969 Spotty Memory small-game reroll.
 */
describe("blocking-curse pool (v970)", () => {
    it("keeps the three UI-enforced ask-blockers in the pool", () => {
        for (const name of [
            "Curse of the Drained Brain",
            "Curse of Spotty Memory",
            "Curse of the Urban Explorer",
        ]) {
            expect(curseBlocksAsking(name)).toBe(true);
            expect(
                cursePreventsAskingOrTransit({ name, description: "" }),
            ).toBe(true);
        }
    });

    it("pools the task blockers and transit/movement blockers", () => {
        for (const name of [
            "Curse of the Egg Partner",
            "Curse of the Lemon Phylactery",
            "Curse of the Bridge Troll",
            "Curse of the Jammed Door",
            "Curse of the U-Turn",
            "Curse of the Gambler's Feet",
            "Curse of the Right Turn",
            "Curse of the Hidden Hangman",
        ]) {
            expect(
                cursePreventsAskingOrTransit({ name, description: "" }),
            ).toBe(true);
        }
    });

    it("leaves non-blocking curses out of the pool", () => {
        expect(
            cursePreventsAskingOrTransit({
                name: "Curse of the Overflowing Chalice",
                description:
                    "For the next three questions, you may draw an additional card.",
            }),
        ).toBe(false);
    });

    it("falls back to the description for unknown curses", () => {
        expect(
            cursePreventsAskingOrTransit({
                name: "Curse of the Demo",
                description:
                    "The seekers must hop on one leg before asking another question.",
            }),
        ).toBe(true);
    });

    it("auto-expires only the TIMED blockers", () => {
        const cast = 1_000_000;
        // Jammed Door: 60 min in medium games.
        expect(
            blockingCurseExpired(
                "Curse of the Jammed Door",
                cast,
                "medium",
                cast + 61 * 60_000,
            ),
        ).toBe(true);
        expect(
            blockingCurseExpired(
                "Curse of the Jammed Door",
                cast,
                "medium",
                cast + 59 * 60_000,
            ),
        ).toBe(false);
        // A task blocker has no timer — never auto-expires.
        expect(
            blockingCurseExpired(
                "Curse of the Egg Partner",
                cast,
                "medium",
                cast + 24 * 3_600_000,
            ),
        ).toBe(false);
        expect(
            blockingCurseExpired("Curse of the Jammed Door", null, "medium", 0),
        ).toBe(false);
    });
});

describe("curseDiceCount (v970)", () => {
    it("Jammed Door rolls two d6; others roll one", () => {
        expect(
            curseDiceCount({
                name: "Curse of the Jammed Door",
                description: "",
            }),
        ).toBe(2);
        expect(
            curseDiceCount({
                name: "Curse of the Gambler's Feet",
                description: "Roll a die before you take any steps.",
            }),
        ).toBe(1);
        expect(
            curseDiceCount({
                name: "Curse of the Demo",
                description: "Seekers must roll two d6 dice at every door.",
            }),
        ).toBe(2);
    });
});

describe("spottyCategoryForRoll (v969 A7)", () => {
    it("small games: 1-5 map to the five categories, 6 is a reroll", () => {
        expect(spottyCategoryForRoll(6, "small")).toBeNull();
        const seen = new Set(
            [1, 2, 3, 4, 5].map((r) => spottyCategoryForRoll(r, "small")),
        );
        expect(seen.size).toBe(5);
        expect(seen.has("tentacles")).toBe(false);
        expect(seen.has(null)).toBe(false);
    });

    it("medium/large keep the fixed 6-face mapping", () => {
        expect(spottyCategoryForRoll(5, "medium")).toBe("tentacles");
        expect(spottyCategoryForRoll(6, "large")).toBe("photo");
    });
});
