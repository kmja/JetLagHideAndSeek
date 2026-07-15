import { describe, expect, it } from "vitest";

import {
    type Card,
    shuffledDeck,
    tallyTimeBonusMinutes,
    timeBonusPieces,
    uniqueCardTemplates,
} from "@/lib/hiderDeck";
import {
    CURSE_DRAINED_BRAIN,
    CURSE_SPOTTY_MEMORY,
    CURSE_URBAN_EXPLORER,
    computeAskingRestrictions,
} from "@/lib/curseEnforcement";
import type { ReceivedCurse } from "@/lib/seekerInbound";

/** Minimal ReceivedCurse for the enforcement tests. */
function curse(
    name: string,
    extra: Partial<ReceivedCurse> = {},
): ReceivedCurse {
    return {
        name,
        receivedAt: 0,
        acknowledged: false,
        ...extra,
    } as ReceivedCurse;
}

describe("hider deck composition (rulebook counts)", () => {
    it("has 55 time-bonus + 21 powerup cards plus curses", () => {
        const deck = shuffledDeck();
        const timeBonus = deck.filter((c) => c.kind === "time-bonus");
        const powerups = deck.filter((c) => c.kind === "powerup");
        const curses = deck.filter((c) => c.kind === "curse");
        expect(timeBonus.length).toBe(55);
        expect(powerups.length).toBe(21);
        expect(curses.length).toBeGreaterThan(0);
        expect(deck.length).toBe(
            timeBonus.length + powerups.length + curses.length,
        );
    });

    it("ships all seven powerup kinds", () => {
        const kinds = new Set(
            uniqueCardTemplates()
                .filter((c) => c.kind === "powerup")
                .map((c) => (c as Card & { powerup: string }).powerup),
        );
        for (const k of [
            "veto",
            "randomize",
            "discard1draw2",
            "discard2draw3",
            "draw1expand",
            "duplicate",
            "move",
        ]) {
            expect(kinds.has(k)).toBe(true);
        }
    });
});

describe("time-bonus tally (played + passive Duplicate)", () => {
    it("sums every time-bonus card's minutes at the game size", () => {
        const tb = shuffledDeck()
            .filter((c) => c.kind === "time-bonus")
            .slice(0, 3);
        const pieces = timeBonusPieces(tb, "medium");
        const expectedPieces = tb
            .map((c) => (c as any).minutes.medium as number)
            .filter((m) => m > 0);
        expect(pieces.slice().sort()).toEqual(expectedPieces.slice().sort());
        expect(tallyTimeBonusMinutes(tb, "medium")).toBe(
            expectedPieces.reduce((a, b) => a + b, 0),
        );
    });

    it("a held Duplicate copies the LARGEST bonus in hand", () => {
        const tb = shuffledDeck()
            .filter((c) => c.kind === "time-bonus")
            .slice(0, 2);
        const dup = shuffledDeck().find(
            (c) => c.kind === "powerup" && (c as any).powerup === "duplicate",
        )!;
        const base = tallyTimeBonusMinutes(tb, "large");
        const withDup = tallyTimeBonusMinutes([...tb, dup], "large");
        const maxBonus = Math.max(
            ...tb.map((c) => (c as any).minutes.large as number),
        );
        expect(withDup).toBe(base + maxBonus);
    });

    it("a Duplicate with no time bonus in hand is worth nothing", () => {
        const dup = shuffledDeck().find(
            (c) => c.kind === "powerup" && (c as any).powerup === "duplicate",
        )!;
        expect(tallyTimeBonusMinutes([dup], "small")).toBe(0);
        expect(timeBonusPieces([dup], "small")).toEqual([]);
    });
});

describe("curse asking-restrictions (seeker-side enforcement)", () => {
    const noOpts = { onTransit: false, spottyCategory: null };

    it("Drained Brain disables exactly its chosen categories", () => {
        const r = computeAskingRestrictions(
            [curse(CURSE_DRAINED_BRAIN, {
                disabledCategories: ["matching", "measuring", "radius"],
            } as Partial<ReceivedCurse>)],
            noOpts,
        );
        expect(r.disabledCategories.has("matching")).toBe(true);
        expect(r.disabledCategories.has("measuring")).toBe(true);
        expect(r.disabledCategories.has("radius")).toBe(true);
        expect(r.disabledCategories.has("photo")).toBe(false);
        expect(r.blockedAll).toBe(false);
    });

    it("Urban Explorer blocks ALL asking only while on transit", () => {
        const off = computeAskingRestrictions(
            [curse(CURSE_URBAN_EXPLORER)],
            { onTransit: false, spottyCategory: null },
        );
        expect(off.blockedAll).toBe(false);
        const on = computeAskingRestrictions(
            [curse(CURSE_URBAN_EXPLORER)],
            { onTransit: true, spottyCategory: null },
        );
        expect(on.blockedAll).toBe(true);
    });

    it("Spotty Memory blocks asking until rolled, then disables one category", () => {
        const unrolled = computeAskingRestrictions(
            [curse(CURSE_SPOTTY_MEMORY)],
            { onTransit: false, spottyCategory: null },
        );
        expect(unrolled.needsSpottyRoll).toBe(true);
        expect(unrolled.blockedAll).toBe(true);

        const rolled = computeAskingRestrictions(
            [curse(CURSE_SPOTTY_MEMORY)],
            { onTransit: false, spottyCategory: "tentacles" },
        );
        expect(rolled.needsSpottyRoll).toBe(false);
        expect(rolled.blockedAll).toBe(false);
        expect(rolled.disabledCategories.has("tentacles")).toBe(true);
    });

    it("a dismissed curse imposes no restriction", () => {
        const r = computeAskingRestrictions(
            [curse(CURSE_URBAN_EXPLORER, { dismissed: true })],
            { onTransit: true, spottyCategory: null },
        );
        expect(r.blockedAll).toBe(false);
    });
});
