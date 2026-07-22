import { describe, expect, it } from "vitest";

import { curseBonusFor, curseBonusMinutes } from "../src/lib/curseBonus";

describe("curse bonus registry", () => {
    it("maps the five bonus curses to rulebook minutes", () => {
        expect(curseBonusMinutes("Curse of the Mediocre Travel Agent", "small")).toBe(30);
        expect(curseBonusMinutes("Curse of the Mediocre Travel Agent", "medium")).toBe(45);
        expect(curseBonusMinutes("Curse of the Mediocre Travel Agent", "large")).toBe(60);

        expect(curseBonusMinutes("Curse of Water Weight", "small")).toBe(30);
        expect(curseBonusMinutes("Curse of Water Weight", "medium")).toBe(30);
        expect(curseBonusMinutes("Curse of Water Weight", "large")).toBe(60);

        expect(curseBonusMinutes("Curse of the Egg Partner", "medium")).toBe(45);
        expect(curseBonusMinutes("Curse of the Lemon Phylactery", "medium")).toBe(45);

        expect(curseBonusMinutes("Curse of the Endless Tumble", "small")).toBe(10);
        expect(curseBonusMinutes("Curse of the Endless Tumble", "medium")).toBe(20);
        expect(curseBonusMinutes("Curse of the Endless Tumble", "large")).toBe(30);
    });

    it("only Endless Tumble is mid-round-only (no end-of-round prompt)", () => {
        expect(curseBonusFor("Curse of the Endless Tumble")?.endPrompt).toBeNull();
        expect(curseBonusFor("Curse of the Egg Partner")?.endPrompt).toBeTruthy();
        expect(curseBonusFor("Curse of Water Weight")?.endPrompt).toBeTruthy();
    });

    it("non-bonus curses have no entry", () => {
        expect(curseBonusFor("Curse of the Drained Brain")).toBeNull();
        expect(curseBonusFor("Curse of the Bird Guide")).toBeNull();
        expect(curseBonusMinutes("Curse of the Cairn", "large")).toBe(0);
    });
});
