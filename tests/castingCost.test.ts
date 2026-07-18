import { describe, expect, it } from "vitest";

import {
    curseBlockedDuringEndgame,
    canPayDiscardCost,
    curseCostDeliverableIsImage,
    curseCostRequiresPhoto,
    curseCostRequiresRockCount,
    curseCostRequiresVideo,
    curseRequiresImage,
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

    it("detects photo casting costs (Zoologist / Luxury Car / Ransom Note), not film", () => {
        expect(curseCostRequiresPhoto("A photo of an animal.")).toBe(true);
        expect(curseCostRequiresPhoto("A photo of a car.")).toBe(true);
        expect(
            curseCostRequiresPhoto(
                "Spell out “ransom note” as a ransom note (without using this card).",
            ),
        ).toBe(true);
        expect(curseCostRequiresPhoto("Film a bird.")).toBe(false);
        expect(curseCostRequiresPhoto("Discard two cards.")).toBe(false);
        expect(curseCostRequiresPhoto(null)).toBe(false);
    });

    it("detects film casting costs (Bird Guide), not photo", () => {
        expect(curseCostRequiresVideo("Film a bird.")).toBe(true);
        expect(curseCostRequiresVideo("A photo of an animal.")).toBe(false);
        expect(curseCostRequiresVideo("Build a rock tower.")).toBe(false);
        expect(curseCostRequiresVideo(null)).toBe(false);
    });

    it("detects rock-tower casting costs (Cairn)", () => {
        expect(curseCostRequiresRockCount("Build a rock tower.")).toBe(true);
        expect(curseCostRequiresRockCount("Film a bird.")).toBe(false);
        expect(curseCostRequiresRockCount("A photo of an animal.")).toBe(false);
        expect(curseCostRequiresRockCount(null)).toBe(false);
    });

    it("detects image-DELIVERABLE curses (Unguided Tourist / Labyrinth)", () => {
        const unguided =
            "Send the seekers an unzoomed Google Street View image from a street within 150 meters of where they are now.";
        const labyrinth =
            "Spend up to 10 min creating a solvable maze and send a photo of it to the seekers.";
        // The deliverable image is in the DESCRIPTION, not the casting cost.
        expect(curseCostDeliverableIsImage(unguided)).toBe(true);
        expect(curseCostDeliverableIsImage(labyrinth)).toBe(true);
        expect(
            curseCostDeliverableIsImage("The seekers must roll a die."),
        ).toBe(false);
        expect(curseCostDeliverableIsImage(null)).toBe(false);

        // The unified gate fires on either the cost photo OR the deliverable.
        expect(
            curseRequiresImage("Seekers must be outside.", unguided),
        ).toBe(true);
        expect(curseRequiresImage("A photo of a car.", "whatever")).toBe(true);
        expect(
            curseRequiresImage("Discard two cards.", "The seekers must wait."),
        ).toBe(false);
    });

    it("v970: detects cards that cannot be played during the endgame", () => {
        expect(
            curseBlockedDuringEndgame(
                "…you are awarded an extra 30 min. This curse cannot be played during the endgame.",
            ),
        ).toBe(true);
        expect(
            curseBlockedDuringEndgame(
                "This card cannot be played during the endgame.",
            ),
        ).toBe(true);
        expect(
            curseBlockedDuringEndgame("The seekers must acquire an egg."),
        ).toBe(false);
        expect(curseBlockedDuringEndgame(null)).toBe(false);
    });
});
