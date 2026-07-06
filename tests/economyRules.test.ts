import { describe, expect, it } from "vitest";

import {
    CURSE_DRAINED_BRAIN,
    CURSE_SPOTTY_MEMORY,
    CURSE_URBAN_EXPLORER,
    curseBlocksAsking,
} from "@/lib/curseEnforcement";
import { type Card, tallyTimeBonusMinutes } from "@/lib/hiderDeck";

const bonus = (id: string, min: number): Card => ({
    id,
    kind: "time-bonus",
    name: `Time bonus · ${min}`,
    description: "",
    minutes: { small: min, medium: min, large: min },
});

const duplicate = (id: string): Card => ({
    id,
    kind: "powerup",
    name: "Duplicate",
    description: "",
    powerup: "duplicate",
});

const otherPowerup = (id: string): Card => ({
    id,
    kind: "powerup",
    name: "Veto",
    description: "",
    powerup: "veto",
});

describe("tallyTimeBonusMinutes — Duplicate passive doubling (rulebook p379)", () => {
    it("sums plain time bonuses with no Duplicate", () => {
        expect(
            tallyTimeBonusMinutes([bonus("a", 5), bonus("b", 10)], "large"),
        ).toBe(15);
    });

    it("a held Duplicate copies the LARGEST time bonus", () => {
        // 5 + 10 + (duplicate copies the 10) = 25
        expect(
            tallyTimeBonusMinutes(
                [bonus("a", 5), bonus("b", 10), duplicate("d")],
                "large",
            ),
        ).toBe(25);
    });

    it("each held Duplicate independently copies the largest bonus", () => {
        // 10 + 10 + 10 (two duplicates each copy the 10) = 30
        expect(
            tallyTimeBonusMinutes(
                [bonus("a", 10), duplicate("d1"), duplicate("d2")],
                "large",
            ),
        ).toBe(30);
    });

    it("a Duplicate held with no time bonus to copy is worth nothing", () => {
        expect(tallyTimeBonusMinutes([duplicate("d")], "large")).toBe(0);
    });

    it("non-Duplicate powerups don't contribute", () => {
        expect(
            tallyTimeBonusMinutes([bonus("a", 6), otherPowerup("v")], "large"),
        ).toBe(6);
    });

    it("scales by game size", () => {
        const hand = [
            {
                id: "a",
                kind: "time-bonus" as const,
                name: "tb",
                description: "",
                minutes: { small: 2, medium: 3, large: 5 },
            },
            duplicate("d"),
        ];
        expect(tallyTimeBonusMinutes(hand, "small")).toBe(4); // 2 + 2
        expect(tallyTimeBonusMinutes(hand, "medium")).toBe(6); // 3 + 3
        expect(tallyTimeBonusMinutes(hand, "large")).toBe(10); // 5 + 5
    });
});

describe("curseBlocksAsking — one-active-blocker set (rulebook p386)", () => {
    it("recognises the three app-enforced ask-blockers", () => {
        expect(curseBlocksAsking(CURSE_DRAINED_BRAIN)).toBe(true);
        expect(curseBlocksAsking(CURSE_SPOTTY_MEMORY)).toBe(true);
        expect(curseBlocksAsking(CURSE_URBAN_EXPLORER)).toBe(true);
    });

    it("does not classify non-ask-blocking curses", () => {
        expect(curseBlocksAsking("Curse of the Luxury Car")).toBe(false);
        expect(curseBlocksAsking("Curse of the Bridge Troll")).toBe(false);
        expect(curseBlocksAsking("")).toBe(false);
    });
});
