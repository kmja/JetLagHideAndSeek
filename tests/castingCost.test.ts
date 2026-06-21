import { describe, expect, it } from "vitest";

import {
    canPayDiscardCost,
    eligibleForDiscardCost,
    parseDiscardCost,
} from "@/lib/castingCost";
import type { Card } from "@/lib/hiderDeck";

const curse = (id: string): Card => ({
    id,
    kind: "curse",
    name: `Curse ${id}`,
    description: "",
    castingCost: null,
});
const powerup = (id: string): Card => ({
    id,
    kind: "powerup",
    name: `Powerup ${id}`,
    description: "",
    powerup: "veto",
});
const timeBonus = (id: string): Card => ({
    id,
    kind: "time-bonus",
    name: `Time ${id}`,
    description: "",
    minutes: { small: 2, medium: 3, large: 5 },
});

describe("parseDiscardCost", () => {
    it("returns null for no cost or non-discard costs", () => {
        expect(parseDiscardCost(null)).toBeNull();
        expect(parseDiscardCost("Roll a die. If it's a 5 or a 6, …")).toBeNull();
        expect(parseDiscardCost("A photo of a car.")).toBeNull();
        expect(parseDiscardCost("Seekers must be outside.")).toBeNull();
    });

    it("parses single-card discards", () => {
        expect(parseDiscardCost("Discard a card.")).toMatchObject({
            count: 1,
            kind: "any",
            whole: false,
        });
    });

    it("parses two-card discards in both phrasings", () => {
        expect(parseDiscardCost("Discard 2 cards.")).toMatchObject({
            count: 2,
            kind: "any",
        });
        expect(parseDiscardCost("Discard two cards.")).toMatchObject({
            count: 2,
            kind: "any",
        });
    });

    it("parses typed discards", () => {
        expect(parseDiscardCost("Discard a powerup.")).toMatchObject({
            kind: "powerup",
            count: 1,
        });
        expect(parseDiscardCost("Discard a time bonus.")).toMatchObject({
            kind: "time-bonus",
            count: 1,
        });
    });

    it("parses whole-hand discards", () => {
        expect(parseDiscardCost("Discard your hand.")).toMatchObject({
            whole: true,
        });
    });
});

describe("eligibility + payability", () => {
    const hand: Card[] = [
        curse("self"),
        curse("c2"),
        powerup("p1"),
        timeBonus("t1"),
    ];

    it("excludes the casting curse itself", () => {
        const cost = parseDiscardCost("Discard a card.")!;
        const eligible = eligibleForDiscardCost(hand, cost, "self");
        expect(eligible.map((c) => c.id)).toEqual(["c2", "p1", "t1"]);
    });

    it("filters by kind for typed costs", () => {
        const pc = parseDiscardCost("Discard a powerup.")!;
        expect(eligibleForDiscardCost(hand, pc, "self").map((c) => c.id)).toEqual(
            ["p1"],
        );
        const tc = parseDiscardCost("Discard a time bonus.")!;
        expect(eligibleForDiscardCost(hand, tc, "self").map((c) => c.id)).toEqual(
            ["t1"],
        );
    });

    it("gates payability on having enough eligible cards", () => {
        const two = parseDiscardCost("Discard 2 cards.")!;
        expect(canPayDiscardCost(hand, two, "self")).toBe(true);
        // Only the curse + one powerup in hand → can't pay "discard 2 cards".
        const thin: Card[] = [curse("self"), powerup("p1")];
        expect(canPayDiscardCost(thin, two, "self")).toBe(false);
        // …but a whole-hand discard is always payable.
        const whole = parseDiscardCost("Discard your hand.")!;
        expect(canPayDiscardCost(thin, whole, "self")).toBe(true);
        // And a powerup cost can't be paid with only a time bonus available.
        const pc = parseDiscardCost("Discard a powerup.")!;
        expect(
            canPayDiscardCost([curse("self"), timeBonus("t1")], pc, "self"),
        ).toBe(false);
    });
});
