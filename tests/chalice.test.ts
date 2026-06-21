import { beforeEach, describe, expect, it } from "vitest";

import {
    activateOverflowingChalice,
    chaliceDrawsRemaining,
    ensureDeckReady,
    pendingDraw,
    presentDraw,
    resetHiderRoundState,
} from "@/lib/hiderRole";

/**
 * Curse of the Overflowing Chalice: for the next three question
 * rewards, the hider draws one extra card (keep count unchanged).
 * The boost is consumed inside `presentDraw`, the single chokepoint
 * every question reward passes through.
 */
describe("Overflowing Chalice draw boost", () => {
    beforeEach(() => {
        resetHiderRoundState();
        ensureDeckReady();
    });

    it("arms three charges and resets to zero on a new round", () => {
        expect(chaliceDrawsRemaining.get()).toBe(0);
        activateOverflowingChalice();
        expect(chaliceDrawsRemaining.get()).toBe(3);
        resetHiderRoundState();
        expect(chaliceDrawsRemaining.get()).toBe(0);
    });

    it("draws one extra card while armed, consuming a charge", () => {
        activateOverflowingChalice();
        // Matching base budget is draw 3 / keep 1. Armed → draw 4 / keep 1,
        // so keep < drawn and the pick is stashed on pendingDraw.
        const autoResolved = presentDraw(3, 1, "matching", 1);
        expect(autoResolved).toBe(false);
        expect(pendingDraw.get()?.cards.length).toBe(4);
        expect(pendingDraw.get()?.keep).toBe(1);
        expect(chaliceDrawsRemaining.get()).toBe(2);
    });

    it("falls back to the base budget once charges run out", () => {
        activateOverflowingChalice();
        // Burn all three charges on photo draws (base 1/1 → armed 2/1).
        for (let i = 0; i < 3; i++) {
            pendingDraw.set(null);
            presentDraw(1, 1, "photo", i);
        }
        expect(chaliceDrawsRemaining.get()).toBe(0);
        // Fourth photo draw is back to 1/1 → auto-resolves into the hand.
        pendingDraw.set(null);
        const autoResolved = presentDraw(1, 1, "photo", 99);
        expect(autoResolved).toBe(true);
        expect(pendingDraw.get()).toBeNull();
    });
});
